import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/infrastructure/database";
import { Migration20261029000100 } from "../../src/migrations/001_initial";
import { WageringService } from "../../src/application/wagering-service";
import { IdempotencyConflictError } from "../../src/domain/errors";
import { WagerTransactionKind } from "../../src/domain/wager-transaction";
import { assertWalletLedgerInvariant, getSafeTestDatabaseUrl } from "../helpers/postgres";

const databaseUrl = getSafeTestDatabaseUrl();
const describeIfDatabase = describe.skipIf(!databaseUrl);
const orms: MikroORM<PostgreSqlDriver>[] = [];
const services: WageringService[] = [];

describeIfDatabase("multi-connection wagering concurrency", () => {
  beforeAll(async () => {
    for (let index = 0; index < 3; index += 1) {
      const orm = await MikroORM.init({
        driver: PostgreSqlDriver,
        clientUrl: databaseUrl,
        entities: [],
        discovery: { warnWhenNoEntities: false },
        pool: { min: 1, max: 5 },
        migrations: {
          migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }],
        },
      });
      orms.push(orm);
      services.push(new WageringService(new Database(orm)));
    }
    await orms[0]?.getMigrator().up();
  });

  afterAll(async () => {
    await Promise.all(orms.map((orm) => orm.close(true)));
  });

  it("serializes two 80-unit bets against a 100-unit wallet across independent ORM instances", async () => {
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await services[0]?.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    if (!wallet) throw new Error("Wallet was not created");
    const createBet = (externalTransactionId: string) => ({
      providerId,
      externalTransactionId,
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      playerId,
      walletId: wallet.id,
      roundId: "race-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "80.00", currency: "BRL" },
    });
    const results = await Promise.all([
      services[0]?.submit(createBet("bet-a")),
      services[1]?.submit(createBet("bet-b")),
    ]);
    expect(results.filter((result) => result?.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((result) => result?.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(1);
    expect((await services[2]?.getWallet(wallet.id))?.balance.amount).toBe("20.00");
    expect((await services[0]?.reconcile(wallet.id))?.consistent).toBe(true);
    expect(await assertWalletLedgerInvariant(new Database(orms[0]!), wallet.id)).toEqual({ entries: 2, balance: "20.00" });
  });

  it("deduplicates 50 parallel submissions across three independent instances", async () => {
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await services[0]?.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    if (!wallet) throw new Error("Wallet was not created");
    const request = {
      providerId,
      externalTransactionId: "same-operation",
      idempotencyKey: `${providerId}:same-operation`,
      playerId,
      walletId: wallet.id,
      roundId: "dedupe-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "10.00", currency: "BRL" },
    };
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      services[index % services.length]?.submit(request)));
    expect(results.every((result) => result?.status === "PROCESSED")).toBe(true);
    expect(results.filter((result) => result?.idempotentReplay === false)).toHaveLength(1);
    expect((await services[1]?.getWallet(wallet.id))?.balance.amount).toBe("90.00");
    expect((await services[2]?.reconcile(wallet.id))?.consistent).toBe(true);
    expect(await assertWalletLedgerInvariant(new Database(orms[0]!), wallet.id)).toEqual({ entries: 2, balance: "90.00" });
  });

  it("deduplicates the same operation across three independent OS processes", async () => {
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await services[0]?.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    if (!wallet || !databaseUrl) throw new Error("Wallet or test database was not available");
    const requests = Array.from({ length: 50 }, (_, index) => ({
      providerId,
      externalTransactionId: "multi-process-operation",
      idempotencyKey: `${providerId}:multi-process-operation`,
      playerId,
      walletId: wallet.id,
      roundId: "multi-process-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "10.00", currency: "BRL" },
      processGroup: index % 3,
    }));
    const directory = await mkdtemp(join(tmpdir(), "wagering-process-race-"));
    const releaseFile = join(directory, "release");
    const workers = [0, 1, 2].map((workerId) => {
      const readyFile = join(directory, `ready-${workerId}`);
      const workerRequests = requests
        .filter((request) => request.processGroup === workerId)
        .map(({ processGroup: _processGroup, ...request }) => request);
      return startSubmitWorker(workerRequests, readyFile, releaseFile);
    });

    try {
      await waitForFiles([0, 1, 2].map((workerId) => join(directory, `ready-${workerId}`)), 20_000);
      await writeFile(releaseFile, "release");
      const resultsByWorker = await Promise.all(workers.map((worker) => worker.result));
      for (const result of resultsByWorker) {
        expect(result.exitCode).toBe(0);
      }
      const results = resultsByWorker.flatMap((result) => JSON.parse(result.stdout) as Array<{
        status: string;
        idempotentReplay: boolean;
        transactionId: string;
      }>);
      expect(results).toHaveLength(50);
      expect(results.every((result) => result.status === "PROCESSED")).toBe(true);
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
      expect((await services[1]?.getWallet(wallet.id))?.balance.amount).toBe("90.00");
      expect(await assertWalletLedgerInvariant(new Database(orms[0]!), wallet.id)).toEqual({
        entries: 2,
        balance: "90.00",
      });
    } finally {
      await writeFile(releaseFile, "release");
      await Promise.all(workers.map((worker) => worker.result));
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("rejects concurrent payload divergence for one idempotency key", async () => {
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await services[0]?.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    if (!wallet) throw new Error("Wallet was not created");
    const request = {
      providerId,
      externalTransactionId: "divergent-operation",
      idempotencyKey: `${providerId}:divergent-operation`,
      playerId,
      walletId: wallet.id,
      roundId: "divergent-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
    };
    const results = await Promise.allSettled([
      services[0]!.submit({ ...request, money: { amount: "10.00", currency: "BRL" } }),
      services[1]!.submit({ ...request, money: { amount: "20.00", currency: "BRL" } }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    expect((await services[2]?.getWallet(wallet.id))?.balance.amount).toMatch(/^(80|90)\.00$/);
    const invariant = await assertWalletLedgerInvariant(new Database(orms[0]!), wallet.id);
    expect(invariant.entries).toBe(2);
  });

  it("processes different wallets in parallel without a global balance lock", async () => {
    const wallets = await Promise.all(services.map((service) => service.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    })));
    const providerId = randomUUID();
    const results = await Promise.all(wallets.map((wallet, index) => {
      const service = services[index];
      if (!service) throw new Error("Missing independent wagering service");
      return service.submit({
        providerId,
        externalTransactionId: `independent-wallet-${index}`,
        idempotencyKey: `${providerId}:independent-wallet-${index}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "independent-wallets-round",
        gameId: "game",
        kind: WagerTransactionKind.Bet,
        money: { amount: "40.00", currency: "BRL" },
      });
    }));

    expect(results.every((result) => result.status === "PROCESSED")).toBe(true);
    for (const [index, wallet] of wallets.entries()) {
      expect((await services[index]?.getWallet(wallet.id))?.balance.amount).toBe("60.00");
      expect((await services[index]?.reconcile(wallet.id))?.consistent).toBe(true);
      expect(await assertWalletLedgerInvariant(new Database(orms[index]!), wallet.id)).toEqual({
        entries: 2,
        balance: "60.00",
      });
    }
  });
});

if (!databaseUrl) {
  console.warn("Skipping concurrency tests: set TEST_DATABASE_URL to a disposable PostgreSQL database.");
}

function startSubmitWorker(
  requests: unknown[],
  readyPath: string,
  releasePath: string,
): { result: Promise<{ exitCode: number | null; stdout: string; stderr: string }> } {
  const workerPath = join(process.cwd(), "test/concurrency/worker-submit.ts");
  const child = spawn(process.execPath, [workerPath, JSON.stringify(requests), readyPath, releasePath], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
  return { result };
}

async function waitForFiles(paths: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await Promise.all(paths.map((path) =>
      access(path).then(() => true, () => false)));
    if (present.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for subprocess readiness files: ${paths.join(", ")}`);
}
