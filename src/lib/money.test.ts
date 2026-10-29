import { describe, expect, it } from "vitest";
import { formatMoney, minorUnitExponent, parseMoney } from "./money";

describe("money", () => {
  it("knows each currency's minor unit", () => {
    // The reason this is not a hard-coded /100: these three disagree.
    expect(minorUnitExponent("GBP")).toBe(2);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
  });

  it("formats an amount in its own currency's units", () => {
    // Intl separates a currency code from the number with a non-breaking
    // space, so the comparisons normalise whitespace rather than embedding
    // U+00A0 in a test and leaving the next reader to wonder.
    const spaces = (text: string) => text.replace(/\s/g, " ");

    expect(formatMoney(4500, "GBP")).toBe("£45.00");
    // 4500 yen is 4500 yen, not 45: the exponent is 0.
    expect(spaces(formatMoney(4500, "JPY", "en-US"))).toBe("¥4,500");
    // And 4500 fils is 4.500 dinars, because the exponent is 3.
    expect(spaces(formatMoney(4500, "KWD", "en-US"))).toBe("KWD 4.500");
  });

  it("parses an amount exactly, without a float round trip", () => {
    // 19.99 * 100 is 1998.9999999999998, which is how a penny goes missing.
    expect(parseMoney("19.99", "GBP")).toBe(1999);
    expect(parseMoney("45", "GBP")).toBe(4500);
    expect(parseMoney("0.07", "GBP")).toBe(7);
    expect(parseMoney("4500", "JPY")).toBe(4500);
    expect(parseMoney("4.500", "KWD")).toBe(4500);
    expect(parseMoney("45,50", "GBP")).toBe(4550);
    expect(parseMoney("-10.00", "GBP")).toBe(-1000);
  });

  it("refuses more precision than the currency has", () => {
    // Silently rounding would make the stored amount differ from what was
    // typed, which is the one thing money handling must never do.
    expect(() => parseMoney("19.999", "GBP")).toThrow(/2 decimal places/);
    expect(() => parseMoney("4500.5", "JPY")).toThrow(/0 decimal places/);
    expect(() => parseMoney("forty five", "GBP")).toThrow(/not an amount/);
    expect(() => parseMoney("", "GBP")).toThrow(/not an amount/);
  });

  it("round-trips", () => {
    for (const [amount, currency] of [
      [4500, "GBP"],
      [1, "GBP"],
      [0, "GBP"],
      [4500, "JPY"],
      [4500, "KWD"],
    ] as const) {
      const exponent = minorUnitExponent(currency);
      const text = (amount / 10 ** exponent).toFixed(exponent);
      expect(parseMoney(text, currency), `${amount} ${currency}`).toBe(amount);
    }
  });
});
