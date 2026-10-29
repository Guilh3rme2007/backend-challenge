import { randomUUID } from "node:crypto";
import { type LedgerDirection } from "./ledger-entry";
import { type MoneyProps } from "./money";
import { type WagerTransactionStatus } from "./wager-transaction";

export interface EventContext {
  eventId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(readonly props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze(props.data);
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.props.aggregateId,
      correlationId: this.props.correlationId,
      ...(this.props.causationId ? { causationId: this.props.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface WagerEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  static from(props: IntegrationEventProps<WagerEventData>): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  static from(props: IntegrationEventProps<WagerEventData>): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  static from(props: IntegrationEventProps<WagerEventData>): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  static from(props: IntegrationEventProps<WalletBalanceChangedData>): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}

export function newEventContext(correlationId?: string): EventContext {
  return { correlationId: correlationId ?? randomUUID(), occurredAt: new Date() };
}
