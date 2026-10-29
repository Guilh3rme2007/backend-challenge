import { expect } from "bun:test";
import { Money } from "../../src/domain/money";
import { Database, type SqlExecutor } from "../../src/infrastructure/database";

export function getSafeTestDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(
      `Refusing integration tests against non-local PostgreSQL host "${parsed.hostname}". ` +
      "Use the dedicated docker-compose.test.yml stack.",
    );
  }
  if (!/(^|[-_])test$/i.test(databaseName)) {
    throw new Error(
      `Refusing integration tests against database "${databaseName}". ` +
      "Use a disposable database whose name ends with _test, such as wagering_test.",
    );
  }
  return url;
}

export async function assertWalletLedgerInvariant(database: Database, walletId: string): Promise<{
  entries: number;
  balance: string;
}> {
  const [wallet] = await database.query<Record<string, unknown> & {
    id: string;
    balance: string;
    currency: string;
  }>(
    "SELECT id, balance::text AS balance, currency FROM wallets WHERE id = $1",
    [walletId],
  );
  expect(wallet).toBeDefined();
  if (!wallet) throw new Error(`Wallet ${walletId} does not exist`);

  const entries = await database.query<Record<string, unknown> & {
    transaction_id: string;
    direction: "DEBIT" | "CREDIT";
    amount: string;
    currency: string;
    balance_before: string;
    balance_after: string;
    kind: string;
    status: string;
  }>(
    `SELECT ledger.transaction_id, ledger.direction, ledger.amount::text AS amount, ledger.currency,
            ledger.balance_before::text AS balance_before, ledger.balance_after::text AS balance_after,
            transactions.kind, transactions.status
     FROM wallet_ledger_entries AS ledger
     LEFT JOIN wager_transactions AS transactions ON transactions.id = ledger.transaction_id
     WHERE ledger.wallet_id = $1
     ORDER BY ledger.created_at, ledger.id`,
    [walletId],
  );
  expect(new Set(entries.map((entry) => entry.transaction_id)).size).toBe(entries.length);

  let reconstructed = Money.zero(wallet.currency.trim());
  for (const entry of entries) {
    expect(entry.kind).toBeDefined();
    expect(entry.status).toBe("PROCESSED");
    expect(["LOSS", "REJECTED"]).not.toContain(entry.kind);
    const amount = Money.from({ amount: entry.amount, currency: entry.currency.trim() });
    const before = Money.from({ amount: entry.balance_before, currency: entry.currency.trim() });
    const after = Money.from({ amount: entry.balance_after, currency: entry.currency.trim() });
    expect(entry.currency.trim()).toBe(wallet.currency.trim());
    expect((entry.direction === "CREDIT" ? before.add(amount) : before.subtract(amount)).toString()).toBe(after.toString());
    expect(before.isNegative()).toBe(false);
    expect(after.isNegative()).toBe(false);
    reconstructed = entry.direction === "CREDIT" ? reconstructed.add(amount) : reconstructed.subtract(amount);
  }

  const materialized = Money.from({ amount: wallet.balance, currency: wallet.currency.trim() });
  expect(materialized.isNegative()).toBe(false);
  expect(reconstructed.toString()).toBe(materialized.toString());
  return { entries: entries.length, balance: materialized.toString() };
}

export class FaultInjectingDatabase extends Database {
  constructor(
    orm: ConstructorParameters<typeof Database>[0],
    private readonly failAfter: RegExp,
  ) {
    super(orm);
  }

  override transaction<T>(
    work: (executor: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return super.transaction((executor) => work({
      execute: async <R extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        const rows = await executor.execute<R>(sql, params);
        this.failAfter.lastIndex = 0;
        if (this.failAfter.test(sql)) {
          throw new Error(`Injected failure after SQL matching ${this.failAfter}`);
        }
        return rows;
      },
    }));
  }
}
