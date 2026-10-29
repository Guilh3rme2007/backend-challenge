import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/infrastructure/database";
import { Migration20261029000100 } from "../../src/migrations/001_initial";
import { OutboxPublisher } from "../../src/infrastructure/outbox-publisher";
import { SqsMessaging } from "../../src/infrastructure/messaging/sqs";
import { WageringService } from "../../src/application/wagering-service";
import { getSafeTestDatabaseUrl } from "../helpers/postgres";

const databaseUrl = getSafeTestDatabaseUrl();
const describeIfInfrastructure = describe.skipIf(!databaseUrl || !process.env.SQS_ENDPOINT);
const originalAppRole = process.env.APP_ROLE;
let orm: MikroORM<PostgreSqlDriver> | undefined;
let publishers: OutboxPublisher[] = [];
let messagingAdapters: SqsMessaging[] = [];

describeIfInfrastructure("PostgreSQL transactional outbox with LocalStack SQS", () => {
  let database: Database;
  let service: WageringService;

  beforeAll(async () => {
    process.env.APP_ROLE = "worker";
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
    for (let index = 0; index < 2; index += 1) {
      const messaging = new SqsMessaging();
      messagingAdapters.push(messaging);
      publishers.push(new OutboxPublisher(database, messaging));
    }
  });

  afterAll(async () => {
    await Promise.all(publishers.map((publisher) => publisher.onApplicationShutdown()));
    await Promise.all(messagingAdapters.map((messaging) => messaging.onApplicationShutdown()));
    await orm?.close(true);
    if (originalAppRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalAppRole;
  });

  it("claims and publishes all wallet-opening events with two independent publishers", async () => {
    const wallet = await service.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: "20.00", currency: "BRL" },
    });
    const events = await database.query<Record<string, unknown> & { id: string; event_type: string }>(
      `SELECT id, event_type FROM outbox_messages
       WHERE aggregate_id = $1
          OR aggregate_id = (SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING')
       ORDER BY event_type`,
      [wallet.id],
    );
    expect(events.map((event) => event.event_type).sort()).toEqual([
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
    ]);

    for (const publisher of publishers) publisher.onModuleInit();
    const deadline = Date.now() + 15_000;
    let publishedCount = 0;
    while (Date.now() < deadline) {
      const [row] = await database.query<Record<string, unknown> & { count: string }>(
        `SELECT count(*)::text AS count FROM outbox_messages
         WHERE id = ANY($1::uuid[]) AND published_at IS NOT NULL`,
        [events.map((event) => event.id)],
      );
      publishedCount = Number(row?.count ?? 0);
      if (publishedCount === events.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(publishedCount).toBe(events.length);
  });
});

if (!databaseUrl || !process.env.SQS_ENDPOINT) {
  console.warn("Skipping outbox/LocalStack integration test: set safe TEST_DATABASE_URL and SQS_ENDPOINT.");
}
