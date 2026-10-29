export type FailureCode =
  | "INSUFFICIENT_FUNDS"
  | "ROLLBACK_WOULD_OVERDRAW"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_NOT_PROCESSED"
  | "INVALID_REFERENCE"
  | "DUPLICATE_REVERSAL"
  | "TRANSACTION_ID_CONFLICT"
  | "WALLET_NOT_FOUND"
  | "WALLET_IDENTITY_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "INVALID_TRANSACTION";

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }

}

export class TransientInfrastructureError extends DomainError {
  constructor(dependency: string, cause: unknown) {
    super(`${dependency} is temporarily unavailable`, "TRANSIENT_INFRASTRUCTURE_FAILURE", { cause });
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_MONEY");
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} and ${right}`, "CURRENCY_MISMATCH");
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(readonly failureCode: FailureCode = "INSUFFICIENT_FUNDS") {
    super("Wallet has insufficient funds for this operation", failureCode);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(status: string) {
    super(`Cannot transition a transaction in state ${status}`, "INVALID_TRANSACTION_STATE");
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super("Idempotency key was already used with a different payload", "IDEMPOTENCY_CONFLICT");
  }
}

export class BusinessRejectionError extends DomainError {
  constructor(readonly failureCode: FailureCode, message: string) {
    super(message, failureCode);
  }
}
