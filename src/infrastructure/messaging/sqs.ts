import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit, Optional } from "@nestjs/common";
import { WageringService, type SubmitWagerInput } from "../../application/wagering-service";
import { WagerTransactionKind } from "../../domain/wager-transaction";
import { ProcessMetrics } from "../process-metrics";
import { DomainError } from "../../domain/errors";
import { TransientInfrastructureError } from "../../domain/errors";

interface WagerEnvelope {
  messageId: string;
  type: "WagerTransactionRequested";
  occurredAt: string;
  data: SubmitWagerInput;
}

@Injectable()
export class SqsMessaging implements OnApplicationShutdown {
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
  readonly transactionQueueUrl = process.env.SQS_TRANSACTION_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-transactions.fifo";
  readonly eventQueueUrl = process.env.SQS_EVENT_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-events.fifo";
  readonly dlqQueueUrl = process.env.SQS_DLQ_QUEUE_URL ??
    "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";

  async enqueueWager(data: SubmitWagerInput): Promise<string> {
    const messageId = randomUUID();
    const envelope: WagerEnvelope = {
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data,
    };
    try {
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.transactionQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: data.walletId,
        MessageDeduplicationId: messageId,
      }));
    } catch (error) {
      throw new TransientInfrastructureError("SQS", error);
    }
    return messageId;
  }

  async publishEvent(event: Record<string, unknown>, aggregateId: string, eventId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.eventQueueUrl,
      MessageBody: JSON.stringify(event),
      MessageGroupId: aggregateId,
      MessageDeduplicationId: eventId,
    }));
  }

  async isReady(): Promise<boolean> {
    const result = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: this.transactionQueueUrl,
      AttributeNames: ["QueueArn"],
    }));
    return Boolean(result.Attributes?.QueueArn);
  }

  async receive(signal?: AbortSignal) {
    return this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.transactionQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 60,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      MessageAttributeNames: ["All"],
    }), { abortSignal: signal });
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.transactionQueueUrl,
      ReceiptHandle: receiptHandle,
    }));
  }

  async retry(receiptHandle: string, receiveCount: number): Promise<void> {
    const delay = Math.min(300, 2 ** Math.min(receiveCount, 8));
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.transactionQueueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: delay,
    }));
  }

  async moveToDlq(body: string, receiptHandle: string): Promise<void> {
    const deadLetterId = randomUUID();
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.dlqQueueUrl,
      MessageBody: body,
      MessageGroupId: "invalid-envelope",
      MessageDeduplicationId: deadLetterId,
    }));
    await this.acknowledge(receiptHandle);
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.destroy();
  }
}

@Injectable()
export class SqsTransactionConsumer implements OnModuleInit, OnApplicationShutdown {
  private stopping = false;
  private readonly abortController = new AbortController();
  private active = 0;

  constructor(
    private readonly messaging: SqsMessaging,
    private readonly wagering: WageringService,
    @Optional() @Inject(ProcessMetrics) private readonly metrics?: ProcessMetrics,
  ) {}

  onModuleInit(): void {
    if (process.env.APP_ROLE === "worker" || process.env.APP_ROLE === "all") {
      void this.run();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    while (this.active > 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.messaging.receive(this.abortController.signal);
        const messages = response.Messages ?? [];
        await Promise.all(messages.map((message) => this.handle(message)));
      } catch (error) {
        if (!this.stopping) {
          console.error(JSON.stringify({ level: "error", event: "sqs_receive_failed", error: errorMessage(error) }));
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    }
  }

  private async handle(message: {
    Body?: string;
    ReceiptHandle?: string;
    MessageId?: string;
    Attributes?: Record<string, string>;
  }): Promise<void> {
    if (!message.ReceiptHandle) {
      console.error(JSON.stringify({ level: "error", event: "sqs_message_missing_receipt_handle" }));
      return;
    }
    if (!message.Body) {
      await this.messaging.moveToDlq("", message.ReceiptHandle);
      this.metrics?.increment("dlq");
      return;
    }
    this.active += 1;
    let envelope: WagerEnvelope | undefined;
    let transactionId: string | undefined;
    try {
      const decoded: unknown = JSON.parse(message.Body);
      if (!isWagerEnvelope(decoded)) {
        await this.messaging.moveToDlq(message.Body, message.ReceiptHandle);
        this.metrics?.increment("dlq");
        return;
      }
      envelope = decoded;
      const result = await this.wagering.submit(envelope.data, {
        consumerName: "wager-transactions",
        messageId: envelope.messageId,
      });
      transactionId = result.transactionId;
      await this.messaging.acknowledge(message.ReceiptHandle);
    } catch (error) {
      const receives = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      if (receives >= 5 || error instanceof DomainError || error instanceof RangeError ||
        error instanceof TypeError || error instanceof SyntaxError) {
        try {
          await this.messaging.moveToDlq(message.Body, message.ReceiptHandle);
          this.metrics?.increment("dlq");
        } catch (dlqError) {
          console.error(JSON.stringify({ level: "error", event: "sqs_dlq_transfer_failed", error: errorMessage(dlqError) }));
          await this.messaging.retry(message.ReceiptHandle, receives);
        }
      } else {
        await this.messaging.retry(message.ReceiptHandle, receives);
        this.metrics?.increment("retries");
      }
      console.error(JSON.stringify({
        level: "error",
        event: "sqs_transaction_processing_failed",
        correlationId: envelope?.messageId ?? message.MessageId ?? null,
        messageId: envelope?.messageId ?? message.MessageId ?? null,
        transactionId: transactionId ?? null,
        walletId: envelope?.data.walletId ?? null,
        providerId: envelope?.data.providerId ?? null,
        attempt: receives,
        error: errorMessage(error),
      }));
    } finally {
      this.active -= 1;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isWagerEnvelope(value: unknown): value is WagerEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== "WagerTransactionRequested" || typeof envelope.messageId !== "string" ||
    envelope.messageId.length === 0 || typeof envelope.occurredAt !== "string" ||
    Number.isNaN(Date.parse(envelope.occurredAt)) || typeof envelope.data !== "object" || envelope.data === null) {
    return false;
  }
  const data = envelope.data as Record<string, unknown>;
  const requiredStrings = [
    "providerId",
    "externalTransactionId",
    "idempotencyKey",
    "playerId",
    "walletId",
    "roundId",
    "gameId",
  ];
  if (!requiredStrings.every((key) => typeof data[key] === "string" && data[key].length > 0)) return false;
  if (!Object.values(WagerTransactionKind).includes(data.kind as WagerTransactionKind) ||
    data.kind === WagerTransactionKind.Opening) return false;
  if (data.kind === WagerTransactionKind.Refund || data.kind === WagerTransactionKind.Rollback) {
    if (typeof data.referenceExternalTransactionId !== "string" || !data.referenceExternalTransactionId) return false;
  }
  if (typeof data.money !== "object" || data.money === null) return false;
  const money = data.money as Record<string, unknown>;
  return typeof money.amount === "string" && /^(0|[1-9]\d*)\.\d{2}$/.test(money.amount) &&
    typeof money.currency === "string" && /^[A-Z]{3}$/.test(money.currency);
}
