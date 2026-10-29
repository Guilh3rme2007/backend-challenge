import { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt?: Date;
}

export class WalletLedgerEntry {
  readonly createdAt: Date;

  readonly props: Readonly<LedgerEntryProps>;

  private constructor(props: LedgerEntryProps) {
    this.props = Object.freeze({ ...props });
    this.createdAt = props.createdAt ?? new Date();
  }

  static create(props: LedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) throw new RangeError("Ledger amount must be positive");
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) throw new RangeError("Ledger entry does not balance");
    return entry;
  }

  static rehydrate(props: LedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }

  isBalanced(): boolean {
    try {
      const expected = this.props.direction === LedgerDirection.Debit
        ? this.props.balanceBefore.subtract(this.props.money)
        : this.props.balanceBefore.add(this.props.money);
      return expected.equals(this.props.balanceAfter);
    } catch {
      return false;
    }
  }
}
