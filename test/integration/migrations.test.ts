import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { WageringService } from "../../src/application/wagering-service";
import { Database } from "../../src/infrastructure/database";
import { Migration20261029000100 } from "../../src/migrations/001_initial";
import { getSafeTestDatabaseUrl } from "../helpers/postgres";

const databaseUrl = getSafeTestDatabaseUrl();
const describeIfDatabase = describe.skipIf(!databaseUrl);

describeIfDatabase("PostgreSQL migration constraints", () => {
  let orm: MikroORM<PostgreSqlDriver>;
  let database: Database;
  let service: WageringService;

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
    database = new Database(orm);
    service = new WageringService(database);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it("creates every required table and can safely reapply migrations", async () => {
    await orm.getMigrator().up();
    const tables = await database.query<Record<string, unknown> & { table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    const names = new Set(tables.map((row) => row.table_name));
    for (const name of ["wallets", "wager_transactions", "wallet_ledger_entries", "inbox_messages", "outbox_messages"]) {
      expect(names.has(name)).toBe(true);
    }

    const indexes = await database.query<Record<string, unknown> & { indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()",
    );
    expect(indexes.some((row) => row.indexname === "wager_transactions_single_reversal_idx")).toBe(true);
  });

  it("enforces wallet uniqueness and non-negative balances with direct SQL", async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "0.00", currency: "BRL" },
    });

    await expect(database.transaction(async (db) => {
      await db.execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, 'BRL', 0, 1, now(), now())`,
        [randomUUID(), playerId],
      );
    })).rejects.toThrow();

    await expect(database.transaction(async (db) => {
      await db.execute("UPDATE wallets SET balance = -1 WHERE id = $1", [wallet.id]);
    })).rejects.toThrow();

    expect((await service.getWallet(wallet.id))?.balance.amount).toBe("0.00");
  });
});

if (!databaseUrl) {
  console.warn("Skipping PostgreSQL migration tests: set TEST_DATABASE_URL to a disposable database ending in _test.");
}
