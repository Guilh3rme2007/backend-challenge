import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InsufficientFundsError, InvalidTransactionStateError } from "../../src/domain/errors";
import { InboxMessage, OutboxMessage } from "../../src/domain/inbox-outbox";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/ledger-entry";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";

describe("Wallet", () => {
  const initial = Money.from({ amount: "100.00", currency: "BRL" });

  it("opens at version one with zero or positive balances and changes version only after balance changes", () => {
    const zeroWallet = Wallet.open({ id: "zero", playerId: "player", initialBalance: Money.zero("BRL") });
    expect(zeroWallet.balance.isZero()).toBe(true);
    expect(zeroWallet.version).toBe(1);
    const wallet = Wallet.open({ id: "wallet", playerId: "player", initialBalance: initial });
    expect(wallet.version).toBe(1);
    wallet.debit(Money.from({ amount: "20.00", currency: "BRL" }));
    expect(wallet.balance.toString()).toBe("80.00");
    expect(wallet.version).toBe(2);
    wallet.credit(Money.from({ amount: "5.00", currency: "BRL" }));
    expect(wallet.balance.toString()).toBe("85.00");
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects negative opening balances and non-positive movements", () => {
    expect(() => Wallet.open({ id: "negative", playerId: "player", initialBalance: Money.fromMinorUnits(-1n, "BRL") }))
      .toThrow(InsufficientFundsError);
    const wallet = Wallet.open({ id: "wallet", playerId: "player", initialBalance: initial });
    expect(() => wallet.debit(Money.zero("BRL"))).toThrow(RangeError);
    expect(() => wallet.credit(Money.zero("BRL"))).toThrow(RangeError);
    expect(wallet.version).toBe(1);
  });

  it("rehydrates persisted state without replaying balance transitions", () => {
    const wallet = Wallet.rehydrate({
      id: "rehydrated",
      playerId: "player",
      currency: "BRL",
      balance: Money.from({ amount: "12.34", currency: "BRL" }),
      version: 7,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(wallet.balance.toJSON()).toEqual({ amount: "12.34", currency: "BRL" });
    expect(wallet.version).toBe(7);
  });

  it("rejects debits that would overdraw the wallet", () => {
    const wallet = Wallet.open({ id: "wallet", playerId: "player", initialBalance: initial });
    expect(() => wallet.debit(Money.from({ amount: "100.01", currency: "BRL" }))).toThrow(InsufficientFundsError);
  });

  it("rejects operations in a different currency", () => {
    const wallet = Wallet.open({ id: "wallet", playerId: "player", initialBalance: initial });
    expect(() => wallet.credit(Money.from({ amount: "1.00", currency: "USD" }))).toThrow(CurrencyMismatchError);
  });
});

describe("WagerTransaction", () => {
  function makeTransaction() {
    return WagerTransaction.create({
      id: "transaction",
      providerId: "provider",
      externalTransactionId: "external",
      idempotencyKey: "key",
      payloadHash: "a".repeat(64),
      walletId: "wallet",
      playerId: "player",
      roundId: "round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "1.00", currency: "BRL" }),
    });
  }

  it("moves through pending to a terminal processed state", () => {
    const transaction = makeTransaction();
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    transaction.markProcessed(undefined, new Date());
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject("INVALID_TRANSACTION")).toThrow(InvalidTransactionStateError);
  });

  it("requires references for refunds and rollbacks and allows pending-reference recovery", () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(() => WagerTransaction.create({ ...makeTransaction().props, id: kind, kind })).toThrow();
    }
    const refund = WagerTransaction.create({
      ...makeTransaction().props,
      id: "refund",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet",
    });
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    refund.markProcessed("reference-id", new Date());
    expect(refund.referenceTransactionId).toBe("reference-id");
    expect(refund.isTerminal()).toBe(true);
    expect(() => refund.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it("does not allow public OPENING operations", () => {
    expect(() => WagerTransaction.create({
      ...makeTransaction().props,
      kind: WagerTransactionKind.Opening,
    })).toThrow("OPENING is internal only");
  });

  it("exposes the correct ledger direction for wager kinds", () => {
    const transaction = makeTransaction();
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.matchesPayload("a".repeat(64))).toBe(true);
    const loss = WagerTransaction.create({ ...transaction.props, id: "loss", kind: WagerTransactionKind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(loss.requiresReference()).toBe(false);
    expect(loss.matchesPayload("b".repeat(64))).toBe(false);
  });
});

describe("WalletLedgerEntry", () => {
  it("validates the balance equation and rejects an unbalanced entry", () => {
    const amount = Money.from({ amount: "5.00", currency: "BRL" });
    const entry = WalletLedgerEntry.create({
      id: "ledger",
      walletId: "wallet",
      transactionId: "transaction",
      direction: LedgerDirection.Debit,
      money: amount,
      balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "5.00", currency: "BRL" }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({
      ...entry.props,
      balanceAfter: Money.from({ amount: "6.00", currency: "BRL" }),
    })).toThrow("Ledger entry does not balance");
  });
});

describe("InboxMessage and OutboxMessage", () => {
  it("tracks inbox processing without mutating the received record", () => {
    const inbox = InboxMessage.receive({
      messageId: "message",
      consumerName: "consumer",
      payloadHash: "a".repeat(64),
      receivedAt: new Date(),
    });
    const processed = inbox.markProcessed(new Date());
    expect(inbox.isProcessed()).toBe(false);
    expect(processed.isProcessed()).toBe(true);
  });

  it("schedules outbox retries and marks publication immutably", () => {
    const created = new Date();
    const outbox = OutboxMessage.enqueue({
      id: "event",
      aggregateId: "aggregate",
      eventType: "Example",
      payload: { eventId: "event" },
      occurredAt: created,
    });
    expect(outbox.attempts).toBe(0);
    const retry = outbox.scheduleRetry(created);
    expect(retry.attempts).toBe(1);
    expect(retry.nextAttemptAt?.getTime()).toBeGreaterThan(created.getTime());
    const published = retry.markPublished(new Date(created.getTime() + 10_000));
    expect(published.isPending()).toBe(false);
    expect(outbox.isPending()).toBe(true);
  });
});
