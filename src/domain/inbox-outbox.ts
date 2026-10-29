export interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export type ReceiveInboxProps = Omit<InboxState, "processedAt">;

export class InboxMessage {
  readonly state: Readonly<InboxState>;

  private constructor(state: InboxState) {
    this.state = Object.freeze({ ...state });
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props);
  }

  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage(state);
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): InboxMessage {
    return InboxMessage.rehydrate({ ...this.state, processedAt: at });
  }
}

export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export type EnqueueOutboxProps = Pick<OutboxState, "id" | "aggregateId" | "eventType" | "payload" | "occurredAt">;

export class OutboxMessage {
  readonly state: Readonly<OutboxState>;

  private constructor(state: OutboxState) {
    this.state = Object.freeze({ ...state, payload: Object.freeze({ ...state.payload }) });
  }

  static enqueue(props: EnqueueOutboxProps): OutboxMessage {
    return new OutboxMessage({ ...props, attempts: 0 });
  }

  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this.state.publishedAt;
  }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now);
  }

  markPublished(at: Date): OutboxMessage {
    if (!this.isPending()) throw new RangeError("Outbox message has already been published");
    return OutboxMessage.rehydrate({ ...this.state, publishedAt: at });
  }

  scheduleRetry(now: Date): OutboxMessage {
    const attempts = this.state.attempts + 1;
    const delayMs = Math.min(60_000, 500 * 2 ** Math.min(attempts, 7));
    return OutboxMessage.rehydrate({ ...this.state, attempts, nextAttemptAt: new Date(now.getTime() + delayMs) });
  }
}
