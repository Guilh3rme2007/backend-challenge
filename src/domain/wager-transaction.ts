import { InvalidTransactionStateError, type FailureCode } from "./errors";
import { LedgerDirection } from "./ledger-entry";
import { Money } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export type WagerTransactionProps = WagerTransactionState;

export class WagerTransaction {
  readonly props: Readonly<WagerTransactionState>;
  private currentStatus: WagerTransactionStatus;
  private linkedReferenceId?: string;
  private currentFailureCode?: FailureCode;
  private completionTime?: Date;

  private constructor(props: WagerTransactionState) {
    this.props = Object.freeze({ ...props });
    this.currentStatus = props.status ?? WagerTransactionStatus.Pending;
    this.linkedReferenceId = props.referenceTransactionId;
    this.currentFailureCode = props.failureCode;
    this.completionTime = props.processedAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) throw new RangeError("OPENING is internal only");
    if ((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId) {
      throw new RangeError(`${props.kind} requires a reference`);
    }
    if (!props.money.isPositive()) throw new RangeError("Transaction amount must be positive");
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      createdAt: props.createdAt ?? new Date(),
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id(): string { return this.props.id; }
  get kind(): WagerTransactionKind { return this.props.kind; }
  get money(): Money { return this.props.money; }
  get status(): WagerTransactionStatus { return this.currentStatus; }
  get referenceTransactionId(): string | undefined { return this.linkedReferenceId; }
  get failureCode(): FailureCode | undefined { return this.currentFailureCode; }
  get processedAt(): Date | undefined { return this.completionTime; }
  get referenceExternalTransactionId(): string | undefined { return this.props.referenceExternalTransactionId; }

  markProcessed(referenceId: string | undefined, at: Date): void {
    this.assertNonTerminal();
    this.linkedReferenceId = referenceId;
    this.completionTime = at;
    this.currentStatus = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertNonTerminal();
    this.currentStatus = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNonTerminal();
    this.currentFailureCode = code;
    this.currentStatus = WagerTransactionStatus.Rejected;
    this.completionTime = new Date();
  }

  fail(code: FailureCode): void {
    this.assertNonTerminal();
    this.currentFailureCode = code;
    this.currentStatus = WagerTransactionStatus.Failed;
    this.completionTime = new Date();
  }

  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this.currentStatus);
  }

  affectsBalance(): boolean {
    return this.currentStatus !== WagerTransactionStatus.Rejected && this.props.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.props.kind === WagerTransactionKind.Refund || this.props.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.props.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (this.props.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.props.kind === WagerTransactionKind.Win || this.props.kind === WagerTransactionKind.Refund ||
      this.props.kind === WagerTransactionKind.Opening) return LedgerDirection.Credit;
    if (this.props.kind !== WagerTransactionKind.Rollback || !reference) return undefined;
    return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
  }

  private assertNonTerminal(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.currentStatus);
  }
}
