import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { WageringService } from "../../src/application/wagering-service";
import { Database } from "../../src/infrastructure/database";
import { SqsMessaging, SqsTransactionConsumer } from "../../src/infrastructure/messaging/sqs";
import { Migration20261029000100 } from "../../src/migrations/001_initial";

async function main(): Promise<void> {
  const [readyFile] = process.argv.slice(2);
  if (!readyFile || !process.env.TEST_DATABASE_URL) throw new Error("Missing test worker arguments");
  const orm = await MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: process.env.TEST_DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 1, max: 5 },
    migrations: {
      migrationsList: [{ name: "Migration20261029000100", class: Migration20261029000100 }],
    },
  });
  const messaging = new SqsMessaging();
  const receive = messaging.receive.bind(messaging);
  messaging.receive = async (signal) => {
    const result = await receive(signal);
    for (const message of result.Messages ?? []) {
      if (message.ReceiptHandle) await messaging.retry(message.ReceiptHandle, 1);
    }
    return result;
  };

  const stopBeforeAck = process.env.TEST_STOP_BEFORE_ACK_MARKER;
  const ackComplete = process.env.TEST_ACK_COMPLETE_MARKER;
  const acknowledge = messaging.acknowledge.bind(messaging);
  messaging.acknowledge = async (receiptHandle) => {
    if (stopBeforeAck) {
      await writeFile(stopBeforeAck, "financial transaction committed; ack intentionally withheld");
      while (true) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await acknowledge(receiptHandle);
    if (ackComplete) await writeFile(ackComplete, "SQS message acknowledged");
  };

  const consumer = new SqsTransactionConsumer(messaging, new WageringService(new Database(orm)));
  process.env.APP_ROLE = "worker";
  consumer.onModuleInit();
  await writeFile(readyFile, "ready");

  if (process.env.TEST_STOP_BEFORE_ACK_MARKER) {
    while (!existsSync(process.env.TEST_STOP_BEFORE_ACK_MARKER)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
