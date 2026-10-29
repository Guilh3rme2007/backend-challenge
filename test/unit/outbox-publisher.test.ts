import { describe, expect, it } from "bun:test";
import { Database } from "../../src/infrastructure/database";
import { OutboxPublisher } from "../../src/infrastructure/outbox-publisher";
import { SqsMessaging } from "../../src/infrastructure/messaging/sqs";

describe("OutboxPublisher", () => {
  it("wakes its polling loop and finishes promptly during shutdown", async () => {
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = "worker";

    try {
      const database = {
        transaction: async () => [],
      } as unknown as Database;
      const publisher = new OutboxPublisher(database, {} as unknown as SqsMessaging);
      publisher.onModuleInit();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        publisher.onApplicationShutdown().then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 100);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      expect(stopped).toBe(true);
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });
});
