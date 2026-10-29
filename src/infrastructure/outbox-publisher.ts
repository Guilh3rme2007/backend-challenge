import { randomUUID } from "node:crypto";
import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { Database } from "./database";
import { SqsMessaging } from "./messaging/sqs";
import { WageringService } from "../application/wagering-service";
import { Inject, Optional } from "@nestjs/common";
import { ProcessMetrics } from "./process-metrics";

type OutboxRow = Record<string, unknown> & {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
};

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly publisherId = randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private currentBatch?: Promise<void>;
  private loopTask?: Promise<void>;
  private wakeLoop?: () => void;

  constructor(
    private readonly database: Database,
    private readonly messaging: SqsMessaging,
    @Optional() @Inject(ProcessMetrics) private readonly metrics?: ProcessMetrics,
  ) {}

  onModuleInit(): void {
    if (process.env.APP_ROLE === "worker" || process.env.APP_ROLE === "all") {
      this.loopTask = this.loop();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeLoop?.();
    this.wakeLoop = undefined;
    await this.loopTask;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        this.currentBatch = this.publishBatch();
        await this.currentBatch;
      } catch (error) {
        this.metrics?.increment("outboxFailures");
        console.error(JSON.stringify({
          level: "error",
          event: "outbox_batch_failed",
          error: error instanceof Error ? error.message : "unknown error",
        }));
      }
      this.currentBatch = undefined;
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        this.wakeLoop = resolve;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.wakeLoop = undefined;
          resolve();
        }, 500);
      });
    }
  }

  private async publishBatch(): Promise<void> {
    const rows = await this.database.transaction(async (db) => {
      const claimed = await db.execute<OutboxRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND dead_lettered_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND (claimed_until IS NULL OR claimed_until < now())
           ORDER BY occurred_at
           LIMIT 25 FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_messages AS outbox
         SET claimed_by = $1, claimed_until = now() + interval '60 seconds'
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.id, outbox.aggregate_id, outbox.payload, outbox.attempts`,
        [this.publisherId],
      );
      return claimed;
    });

    await Promise.all(rows.map((row) => this.publishOne(row)));
  }

  private async publishOne(row: OutboxRow): Promise<void> {
    const payload = row.payload;
    const eventId = typeof payload.eventId === "string" ? payload.eventId : row.id;
    try {
      await this.messaging.publishEvent(payload, row.aggregate_id, eventId);
      await this.database.query(
        `UPDATE outbox_messages SET published_at = now(), claimed_by = NULL, claimed_until = NULL
         WHERE id = $1 AND claimed_by = $2`,
        [row.id, this.publisherId],
      );
    } catch (error) {
      const delay = Math.min(300_000, 1_000 * 2 ** Math.min(row.attempts + 1, 8)) +
        Math.floor(Math.random() * 1_000);
      await this.database.query(
        `UPDATE outbox_messages SET attempts = attempts + 1,
           next_attempt_at = CASE WHEN attempts + 1 >= 20 THEN NULL
             ELSE now() + ($3::text || ' milliseconds')::interval END,
           dead_lettered_at = CASE WHEN attempts + 1 >= 20 THEN now() ELSE NULL END,
           last_error = $4, claimed_by = NULL, claimed_until = NULL
         WHERE id = $1 AND claimed_by = $2`,
        [row.id, this.publisherId, String(delay), error instanceof Error ? error.name : "UnknownError"],
      );
      console.error(JSON.stringify({
        level: "error",
        event: "outbox_publish_failed",
        eventType: typeof payload.eventType === "string" ? payload.eventType : "unknown",
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }
}

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private currentRun?: Promise<void>;

  constructor(private readonly wagering: WageringService) {}

  onModuleInit(): void {
    if (process.env.APP_ROLE === "worker" || process.env.APP_ROLE === "all") {
      this.timer = setInterval(() => this.startRun(), 1_000);
      this.startRun();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.currentRun;
  }

  private startRun(): void {
    if (this.currentRun) return;
    this.currentRun = this.wagering.processPendingReferences()
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          level: "error",
          event: "pending_reference_worker_failed",
          error: error instanceof Error ? error.message : "unknown error",
        }));
      })
      .finally(() => {
        this.currentRun = undefined;
      });
  }
}
