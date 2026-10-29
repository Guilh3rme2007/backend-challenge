import { CurrencyMismatchError, InsufficientFundsError } from "./errors";
import { Money } from "./money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private currentBalance: Money,
    private currentVersion: number,
    readonly createdAt: Date,
    private lastUpdatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InsufficientFundsError();
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  debit(amount: Money, at = new Date()): { before: Money; after: Money } {
    this.assertCurrency(amount);
    if (!amount.isPositive()) throw new RangeError("Debit amount must be positive");
    if (this.currentBalance.isLessThan(amount)) throw new InsufficientFundsError();
    return this.changeBalance(this.currentBalance.subtract(amount), at);
  }

  credit(amount: Money, at = new Date()): { before: Money; after: Money } {
    this.assertCurrency(amount);
    if (!amount.isPositive()) throw new RangeError("Credit amount must be positive");
    return this.changeBalance(this.currentBalance.add(amount), at);
  }

  private changeBalance(next: Money, at: Date): { before: Money; after: Money } {
    const before = this.currentBalance;
    this.currentBalance = next;
    this.currentVersion += 1;
    this.lastUpdatedAt = at;
    return { before, after: next };
  }

  private assertCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, amount.currency);
    }
  }
}
