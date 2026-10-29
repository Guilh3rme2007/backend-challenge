import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const currencies = new Set(Intl.supportedValuesOf("currency"));
const amountPattern = /^(0|[1-9]\d*)\.\d{2}$/;
const MAX_MINOR_UNITS = 999_999_999_999_999_999n;

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (!currencies.has(currency)) {
      throw new InvalidMoneyError(`Unsupported ISO-4217 currency: ${currency}`);
    }
    if (!amountPattern.test(amount)) {
      throw new InvalidMoneyError("Amount must be a non-negative decimal string with exactly two places");
    }
    const [whole = "", fraction = ""] = amount.split(".");
    const minorUnits = BigInt(whole) * 100n + BigInt(fraction);
    if (minorUnits > MAX_MINOR_UNITS) {
      throw new InvalidMoneyError("Amount exceeds the supported precision");
    }
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    if (!currencies.has(currency) || minorUnits < -MAX_MINOR_UNITS || minorUnits > MAX_MINOR_UNITS) {
      throw new InvalidMoneyError("Invalid currency or amount precision");
    }
    return new Money(minorUnits, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const amount = `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
    return { amount: negative ? `-${amount}` : amount, currency: this.currency };
  }

  toString(): string {
    return this.toJSON().amount;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
