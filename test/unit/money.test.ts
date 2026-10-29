import { describe, expect, it } from "bun:test";
import { InvalidMoneyError, CurrencyMismatchError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";

describe("Money", () => {
  it("performs exact arithmetic and serializes with a fixed two-place scale", () => {
    expect(Money.from({ amount: "10.10", currency: "BRL" })
      .add(Money.from({ amount: "0.20", currency: "BRL" })).toString()).toBe("10.30");
    expect(Money.from({ amount: "10.00", currency: "BRL" })
      .subtract(Money.from({ amount: "0.01", currency: "BRL" })).toString()).toBe("9.99");
    const total = Money.from({ amount: "12.34", currency: "BRL" })
      .add(Money.from({ amount: "0.66", currency: "BRL" }));
    expect(total.toJSON()).toEqual({ amount: "13.00", currency: "BRL" });
    expect(total.subtract(Money.from({ amount: "1.25", currency: "BRL" })).toString()).toBe("11.75");
    expect(total.toJSON().amount).toMatch(/^\d+\.\d{2}$/);
  });

  it("supports sign queries and negation without floating-point arithmetic", () => {
    const positive = Money.from({ amount: "0.01", currency: "USD" });
    const negative = positive.negate();
    expect(positive.isPositive()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isLessThan(Money.zero("USD"))).toBe(true);
    expect(negative.toJSON().amount).toBe("-0.01");
    expect(Money.zero("USD").isZero()).toBe(true);
    expect(positive.equals(Money.from({ amount: "0.01", currency: "USD" }))).toBe(true);
    expect(positive.toString()).toBe("0.01");
  });

  it("rejects malformed, negative, scientific, over-scale and unknown-currency inputs", () => {
    for (const amount of ["", "NaN", "Infinity", "1e2", "1.0", "1.000", "-1.00", "01.00"]) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
    expect(() => Money.from({ amount: "1.00", currency: "ZZZ" })).toThrow(InvalidMoneyError);
  });

  it("rejects values whose arithmetic exceeds numeric(18,2) precision", () => {
    const max = Money.from({ amount: "9999999999999999.99", currency: "BRL" });
    expect(() => max.add(Money.from({ amount: "0.01", currency: "BRL" }))).toThrow(InvalidMoneyError);
  });

  it("rejects comparisons and arithmetic across currencies", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
