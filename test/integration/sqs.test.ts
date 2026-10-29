import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/infrastructure/database";
import { SqsMessaging } from "../../src/infrastructure/messaging/sqs";
import { Migration20261029000100 } from "../../src/migrations/001_initial";
import { WageringService } from "../../src/application/wagering-service";
import { IdempotencyConflictError } from "../../src/domain/errors";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { assertWalletLedgerInvariant, getSafeTestDatabaseUrl } from "../helpers/postgres";

const databaseUrl = getSafeTestDatabaseUrl();
const queueUrl = process.env.TEST_SQS_TRANSACTION_QUEUE_URL;
const crashQueueUrl = process.env.TEST_SQS_CRASH_QUEUE_URL;
const describeIfInfrastructure = describe.skipIf(!databaseUrl || !queueUrl || !crashQueueUrl);
let orm: MikroORM<PostgreSqlDriver> | undefined;
let service: WageringService | undefined;
let client: SQSClient | undefined;

describeIfInfrastructure("PostgreSQL and LocalStack SQS integration", () => {
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
    client = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  });

  afterAll(async () => {
    client?.destroy();
    await orm?.close(true);
  });

  it("uses a durable inbox before acknowledging a redelivered SQS request", async () => {
    if (!service || !client || !queueUrl) throw new Error("SQS test infrastructure was not initialized");
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "20.00", currency: "BRL" },
    });
    const data = {
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: "sqs-round",
      gameId: "sqs-game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "5.00", currency: "BRL" },
    };
    const messageId = randomUUID();
    const body = JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data,
    });

    await client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID(),
    }));
    const first = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 30,
    }));
    const firstMessage = first.Messages?.[0];
    if (!firstMessage?.ReceiptHandle) throw new Error("First SQS message was not received");
    const firstResult = await service.submit(data, { consumerName: "wager-transactions", messageId });
    await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: firstMessage.ReceiptHandle }));

    await client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID(),
    }));
    const second = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 30,
    }));
    const secondMessage = second.Messages?.[0];
    if (!secondMessage?.ReceiptHandle) throw new Error("Redelivered SQS message was not received");
    const replay = await service.submit(data, { consumerName: "wager-transactions", messageId });
    await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: secondMessage.ReceiptHandle }));

    expect(firstResult.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.idempotentReplay).toBe(true);
    await expect(service.submit(
      { ...data, money: { amount: "6.00", currency: "BRL" } },
      { consumerName: "wager-transactions", messageId },
    )).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await service.getWallet(wallet.id))?.balance.amount).toBe("15.00");
    expect((await service.reconcile(wallet.id))?.consistent).toBe(true);
  });

  it("recovers a committed operation when a real consumer process dies before acknowledging SQS", async () => {
    if (!service || !client || !crashQueueUrl || !orm || !databaseUrl) {
      throw new Error("Crash-recovery infrastructure was not initialized");
    }
    const playerId = randomUUID();
    const providerId = randomUUID();
    const wallet = await service.createWallet({
      playerId,
      initialBalance: { amount: "20.00", currency: "BRL" },
    });
    const data = {
      providerId,
      externalTransactionId: "commit-before-ack",
      idempotencyKey: `${providerId}:commit-before-ack`,
      playerId,
      walletId: wallet.id,
      roundId: "crash-recovery-round",
      gameId: "game",
      kind: WagerTransactionKind.Bet,
      money: { amount: "5.00", currency: "BRL" },
    };
    const messageId = randomUUID();
    await client.send(new SendMessageCommand({
      QueueUrl: crashQueueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data,
      }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID(),
    }));

    const directory = await mkdtemp(join(tmpdir(), "wagering-sqs-crash-"));
    const firstReady = join(directory, "first-ready");
    const committedBeforeAck = join(directory, "committed-before-ack");
    const secondReady = join(directory, "second-ready");
    const ackCompleted = join(directory, "ack-completed");
    const workers: Array<{ child: ChildProcess; result: Promise<number | null> }> = [];
    try {
      const firstWorker = startConsumerWorker(databaseUrl, crashQueueUrl, firstReady, {
        stopBeforeAckMarker: committedBeforeAck,
      });
      workers.push(firstWorker);
      await waitForFile(firstReady, 15_000);
      await waitForFile(committedBeforeAck, 15_000);
      firstWorker.child.kill("SIGKILL");
      await firstWorker.result;

      const secondWorker = startConsumerWorker(databaseUrl, crashQueueUrl, secondReady, {
        ackCompleteMarker: ackCompleted,
      });
      workers.push(secondWorker);
      await waitForFile(secondReady, 15_000);
      await waitForFile(ackCompleted, 20_000);
      secondWorker.child.kill("SIGTERM");
      await secondWorker.result;

      const result = await service.getProviderTransaction(providerId, data.externalTransactionId);
      expect(result?.status).toBe(WagerTransactionStatus.Processed);
      expect((await service.getWallet(wallet.id))?.balance.amount).toBe("15.00");
      expect(await assertWalletLedgerInvariant(new Database(orm), wallet.id)).toEqual({
        entries: 2,
        balance: "15.00",
      });
      const [inbox] = await new Database(orm).query<Record<string, unknown> & {
        count: string;
        processed_count: string;
      }>(
        `SELECT count(*)::text AS count, count(processed_at)::text AS processed_count
         FROM inbox_messages WHERE consumer_name = 'wager-transactions' AND message_id = $1`,
        [messageId],
      );
      expect(inbox?.count).toBe("1");
      expect(inbox?.processed_count).toBe("1");
      const [ledger] = await new Database(orm).query<Record<string, unknown> & { count: string }>(
        `SELECT count(*)::text AS count FROM wallet_ledger_entries
         WHERE transaction_id = $1`,
        [result?.transactionId],
      );
      expect(ledger?.count).toBe("1");
      const [outbox] = await new Database(orm).query<Record<string, unknown> & { count: string }>(
        `SELECT count(*)::text AS count FROM outbox_messages
         WHERE payload->'data'->>'transactionId' = $1`,
        [result?.transactionId],
      );
      expect(outbox?.count).toBe("2");
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
      }
      await Promise.allSettled(workers.map((worker) => worker.result));
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

if (!databaseUrl || !queueUrl || !crashQueueUrl) {
  console.warn("Skipping PostgreSQL/SQS integration tests: configure the test database and both disposable FIFO test queues.");
}

function startConsumerWorker(
  testDatabaseUrl: string,
  testQueueUrl: string,
  readyFile: string,
  markers: { stopBeforeAckMarker?: string; ackCompleteMarker?: string },
): { child: ChildProcess; result: Promise<number | null> } {
  const workerPath = join(process.cwd(), "test/integration/sqs-consumer-worker.ts");
  const child = spawn(process.execPath, [workerPath, readyFile], {
    env: {
      ...process.env,
      APP_ROLE: "worker",
      TEST_DATABASE_URL: testDatabaseUrl,
      DATABASE_URL: testDatabaseUrl,
      SQS_TRANSACTION_QUEUE_URL: testQueueUrl,
      ...(markers.stopBeforeAckMarker ? { TEST_STOP_BEFORE_ACK_MARKER: markers.stopBeforeAckMarker } : {}),
      ...(markers.ackCompleteMarker ? { TEST_ACK_COMPLETE_MARKER: markers.ackCompleteMarker } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, result };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for consumer worker marker ${path}`);
}
