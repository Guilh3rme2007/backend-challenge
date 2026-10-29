import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/infrastructure/database";
import { Migration20261029000100 } from "../../src/migrations/001_initial";
import { WageringService } from "../../src/application/wagering-service";
import { IdempotencyConflictError } from "../../src/domain/errors";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { assertWalletLedgerInvariant, FaultInjectingDatabase, getSafeTestDatabaseUrl } from "../helpers/postgres";

const databaseUrl = getSafeTestDatabaseUrl();
const describeIfDatabase = describe.skipIf(!databaseUrl);
let orm: MikroORM<PostgreSqlDriver> | undefined;
let service: WageringService | undefined;

describeIfDatabase("PostgreSQL wagering integration", () => {
  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: databaseUrl,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      migrations: {
        migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }],
      },
    });
    await orm.getMigrator().up();
    service = new WageringService(new Database(orm));
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it("persists opening, idempotency, ledger and outbox atomically", async () => {
    if (!service) throw new Error("Integration service did not initialize");
    const playerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const request = {
      providerId: `provider-${randomUUID()}`,
      externalTransactionId: "bet-1",
      idempotencyKey: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    };
    const first = await service.submit(request);
    const replay = await service.submit(request);
    await service.submit({
      ...request,
      externalTransactionId: "win-1",
      idempotencyKey: `${request.providerId}:win-1`,
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
    });
    const replayAfterBalanceChange = await service.submit(request);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.balance.amount).toBe("75.00");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance).toEqual(first.balance);
    expect(replayAfterBalanceChange.idempotentReplay).toBe(true);
    expect(replayAfterBalanceChange.balance.amount).toBe("75.00");
    const restartedOrm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: databaseUrl,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      migrations: {
        migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }],
      },
    });
    try {
      const restartedService = new WageringService(new Database(restartedOrm));
      const replayAfterRestart = await restartedService.submit(request);
      expect(replayAfterRestart.idempotentReplay).toBe(true);
      expect(replayAfterRestart.transactionId).toBe(first.transactionId);
      expect(replayAfterRestart.balance).toEqual(first.balance);
    } finally {
      await restartedOrm.close(true);
    }
    await expect(service.submit({ ...request, money: { amount: "26.00", currency: "BRL" } }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    const reconciliation = await service.reconcile(wallet.id);
    expect(reconciliation?.consistent).toBe(true);
    expect(reconciliation?.checkedEntries).toBe(3);
    expect(await assertWalletLedgerInvariant(new Database(orm!), wallet.id)).toEqual({ entries: 3, balance: "125.00" });

    if (!orm) throw new Error("Integration ORM did not initialize");
    const database = new Database(orm);
    await expect(database.transaction(async (db) => {
      await db.execute("TRUNCATE TABLE wallet_ledger_entries");
    })).rejects.toThrow("wallet_ledger_entries is append-only");
    expect((await service.reconcile(wallet.id))?.checkedEntries).toBe(3);
  });

  it("applies BET, WIN, LOSS, REFUND and ROLLBACK with auditable balance changes", async () => {
    if (!service) throw new Error("Integration service did not initialize");
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const submit = (externalTransactionId: string, kind: WagerTransactionKind, amount: string, reference?: string) =>
      service?.submit({
        providerId,
        externalTransactionId,
        idempotencyKey: `${providerId}:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "rules-round",
        gameId: "rules-game",
        kind,
        money: { amount, currency: "BRL" },
        ...(reference ? { referenceExternalTransactionId: reference } : {}),
      });

    expect((await submit("bet", WagerTransactionKind.Bet, "25.00"))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await submit("win", WagerTransactionKind.Win, "40.00", "bet"))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await submit("loss", WagerTransactionKind.Loss, "10.00"))?.balance.amount).toBe("115.00");
    expect((await submit("refund", WagerTransactionKind.Refund, "25.00", "bet"))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await submit("rollback", WagerTransactionKind.Rollback, "40.00", "win"))?.status).toBe(WagerTransactionStatus.Processed);
    const duplicateRefund = await submit("refund-again", WagerTransactionKind.Refund, "25.00", "bet");
    expect(duplicateRefund?.failureCode).toBe("DUPLICATE_REVERSAL");
    expect((await service.getWallet(wallet.id))?.balance.amount).toBe("100.00");
    expect((await service.reconcile(wallet.id))?.checkedEntries).toBe(5);
    expect((await service.reconcile(wallet.id))?.consistent).toBe(true);
    expect(await assertWalletLedgerInvariant(new Database(orm!), wallet.id)).toEqual({ entries: 5, balance: "100.00" });
  });

  it("persists out-of-order reversals and rejects a rollback that would overdraw", async () => {
    if (!service || !orm) throw new Error("Integration service did not initialize");
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const refund = await service.submit({
      providerId,
      externalTransactionId: "refund-first",
      idempotencyKey: `${providerId}:refund-first`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Refund,
      money: { amount: "5.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-later",
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    await service.submit({
      providerId,
      externalTransactionId: "bet-later",
      idempotencyKey: `${providerId}:bet-later`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "5.00", currency: "BRL" },
    });
    const database = new Database(orm);
    await database.query(
      "UPDATE wager_transactions SET next_attempt_at = now() WHERE id = $1",
      [refund.transactionId],
    );
    await service.processPendingReferences();
    expect((await service.getTransaction(refund.transactionId))?.status).toBe(WagerTransactionStatus.Processed);

    const rollbackBeforeWin = await service.submit({
      providerId,
      externalTransactionId: "rollback-before-win",
      idempotencyKey: `${providerId}:rollback-before-win`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Rollback,
      money: { amount: "5.00", currency: "BRL" },
      referenceExternalTransactionId: "win-later",
    });
    expect(rollbackBeforeWin.status).toBe(WagerTransactionStatus.PendingReference);
    const lateWin = await service.submit({
      providerId,
      externalTransactionId: "win-later",
      idempotencyKey: `${providerId}:win-later`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Win,
      money: { amount: "5.00", currency: "BRL" },
    });
    expect(lateWin.status).toBe(WagerTransactionStatus.Processed);
    await database.query(
      "UPDATE wager_transactions SET next_attempt_at = now() WHERE id = $1",
      [rollbackBeforeWin.transactionId],
    );
    await service.processPendingReferences();
    expect((await service.getTransaction(rollbackBeforeWin.transactionId))?.status)
      .toBe(WagerTransactionStatus.Processed);

    const win = await service.submit({
      providerId,
      externalTransactionId: "win",
      idempotencyKey: `${providerId}:win`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Win,
      money: { amount: "20.00", currency: "BRL" },
    });
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    await service.submit({
      providerId,
      externalTransactionId: "spend",
      idempotencyKey: `${providerId}:spend`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    });
    const rollback = await service.submit({
      providerId,
      externalTransactionId: "rollback-win",
      idempotencyKey: `${providerId}:rollback-win`,
      playerId,
      walletId: wallet.id,
      roundId: "late-round",
      gameId: "game",
      kind: WagerTransactionKind.Rollback,
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: "win",
    });
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe("ROLLBACK_WOULD_OVERDRAW");
    expect((await service.reconcile(wallet.id))?.consistent).toBe(true);
    expect(await assertWalletLedgerInvariant(new Database(orm), wallet.id)).toEqual({ entries: 7, balance: "5.00" });
  });

  it("rejects a pending reference immediately when wallet identity does not match", async () => {
    if (!service) throw new Error("Integration service did not initialize");
    const providerId = randomUUID();
    const firstPlayerId = randomUUID();
    const secondPlayerId = randomUUID();
    const firstWallet = await service.createWallet({
      playerId: firstPlayerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const secondWallet = await service.createWallet({
      playerId: secondPlayerId,
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const pendingReference = await service.submit({
      providerId,
      externalTransactionId: "pending-refund",
      idempotencyKey: `${providerId}:pending-refund`,
      playerId: firstPlayerId,
      walletId: firstWallet.id,
      roundId: "reference-round",
      gameId: "game",
      kind: WagerTransactionKind.Refund,
      money: { amount: "5.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-not-yet-received",
    });
    expect(pendingReference.status).toBe(WagerTransactionStatus.PendingReference);

    const invalidRollback = await service.submit({
      providerId,
      externalTransactionId: "invalid-rollback",
      idempotencyKey: `${providerId}:invalid-rollback`,
      playerId: secondPlayerId,
      walletId: secondWallet.id,
      roundId: "reference-round",
      gameId: "game",
      kind: WagerTransactionKind.Rollback,
      money: { amount: "5.00", currency: "BRL" },
      referenceExternalTransactionId: "pending-refund",
    });
    expect(invalidRollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(invalidRollback.failureCode).toBe("INVALID_REFERENCE");
  });

  it("rolls back every financial write when failures are injected after transaction, wallet, ledger, or outbox writes", async () => {
    if (!service || !orm) throw new Error("Integration service did not initialize");
    const failurePoints = [
      /INSERT INTO wager_transactions/,
      /UPDATE wallets SET balance/,
      /INSERT INTO wallet_ledger_entries/,
      /INSERT INTO outbox_messages/,
    ];

    for (const [index, failAfter] of failurePoints.entries()) {
      const playerId = randomUUID();
      const providerId = randomUUID();
      const wallet = await service.createWallet({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const request = {
        providerId,
        externalTransactionId: `atomic-failure-${index}`,
        idempotencyKey: `${providerId}:atomic-failure-${index}`,
        playerId,
        walletId: wallet.id,
        roundId: "atomicity-round",
        gameId: "game",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      };
      const faultService = new WageringService(new FaultInjectingDatabase(orm, failAfter));
      await expect(faultService.submit(request)).rejects.toThrow("Injected failure");
      expect(await faultService.getProviderTransaction(providerId, request.externalTransactionId)).toBeUndefined();
      expect((await service.getWallet(wallet.id))?.balance.amount).toBe("100.00");
      expect(await assertWalletLedgerInvariant(new Database(orm), wallet.id)).toEqual({ entries: 1, balance: "100.00" });
      const [failedOutboxCount] = await new Database(orm).query<Record<string, unknown> & { count: string }>(
        "SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id = $1",
        [wallet.id],
      );
      expect(failedOutboxCount?.count).toBe("1");

      const committed = await service.submit(request);
      expect(committed.status).toBe(WagerTransactionStatus.Processed);
      expect(await assertWalletLedgerInvariant(new Database(orm), wallet.id)).toEqual({ entries: 2, balance: "70.00" });
      const [committedOutboxCount] = await new Database(orm).query<Record<string, unknown> & { count: string }>(
        "SELECT count(*)::text AS count FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1",
        [committed.transactionId],
      );
      expect(committedOutboxCount?.count).toBe("2");
    }
  });

  it("applies only one concurrent refund of a processed bet", async () => {
    if (!service || !orm) throw new Error("Integration service did not initialize");
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const bet = await service.submit({
      providerId,
      externalTransactionId: "refund-race-bet",
      idempotencyKey: `${providerId}:refund-race-bet`,
      playerId,
      walletId: wallet.id,
      roundId: "refund-race-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const results = await Promise.all(["refund-race-a", "refund-race-b"].map((externalTransactionId) =>
      service!.submit({
        providerId,
        externalTransactionId,
        idempotencyKey: `${providerId}:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "refund-race-round",
        gameId: "game",
        kind: WagerTransactionKind.Refund,
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: "refund-race-bet",
      })));

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === "DUPLICATE_REVERSAL")).toHaveLength(1);
    expect((await service.getWallet(wallet.id))?.balance.amount).toBe("100.00");
    expect(await assertWalletLedgerInvariant(new Database(orm), wallet.id)).toEqual({ entries: 3, balance: "100.00" });
  });
});

if (!databaseUrl) {
  console.warn("Skipping PostgreSQL integration tests: set TEST_DATABASE_URL to a disposable database.");
}
