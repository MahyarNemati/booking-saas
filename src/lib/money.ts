/**
 * Money, in minor units.
 *
 * Amounts are integers of the currency's smallest unit throughout — 4500 is
 * £45.00 — because a price that cannot be represented exactly is a price that
 * will eventually be wrong, and because that is what Stripe takes.
 *
 * Formatting goes through Intl rather than string concatenation, so a currency
 * with no minor unit (JPY) or three of them (KWD, BHD) comes out right. The
 * exponent is read from Intl too, which is the part a hand-rolled
 * `amount / 100` gets wrong.
 */

export function minorUnitExponent(currency: string): number {
  // resolvedOptions knows each currency's exponent, so there is no table here
  // to go stale.
  const { maximumFractionDigits } = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions();
  // Two is the overwhelmingly common case and the right guess for a currency
  // this runtime's ICU data does not carry.
  return maximumFractionDigits ?? 2;
}

export function formatMoney(
  amountMinor: number,
  currency: string,
  locale = "en-GB",
): string {
  const exponent = minorUnitExponent(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    amountMinor / 10 ** exponent,
  );
}

/** Parses "45.00" into minor units, exactly, without a float round trip. */
export function parseMoney(text: string, currency: string): number {
  const exponent = minorUnitExponent(currency);
  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`${JSON.stringify(text)} is not an amount`);
  const sign = match[1] ?? "";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > exponent) {
    throw new Error(
      `${currency} has ${exponent} decimal places, got ${fraction.length}`,
    );
  }
  // Padded rather than multiplied: 19.99 * 100 is 1998.9999999999998.
  const padded = fraction.padEnd(exponent, "0");
  const minor = Number(`${whole}${padded}`);
  return sign === "-" ? -minor : minor;
}
