/**
 * Money helpers. Amounts are integer minor units everywhere inside the engine; decimal strings
 * exist only at the edges (config, tool input, display).
 */

const DEFAULT_DECIMALS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  USDC: 6,
};

export class AmountError extends Error {
  override name = 'AmountError';
}

export function currencyDecimals(
  currency: string,
  overrides?: Readonly<Record<string, number>>,
): number {
  return overrides?.[currency] ?? DEFAULT_DECIMALS[currency] ?? 2;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal amount ("12.50" or 12.5) into integer minor units. Rejects negatives,
 * exponents, and more decimal places than the currency has, rather than rounding.
 */
export function parseAmount(
  input: string | number,
  currency: string,
  overrides?: Readonly<Record<string, number>>,
): number {
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new AmountError('Amount must be a finite number.');
  }
  const text = typeof input === 'number' ? String(input) : input.trim();
  const match = DECIMAL.exec(text);
  if (!match) {
    throw new AmountError(`"${text}" is not a valid amount. Use a plain decimal such as 12.50.`);
  }
  const [, whole = '0', fraction = ''] = match;
  const decimals = currencyDecimals(currency, overrides);
  if (fraction.length > decimals) {
    throw new AmountError(
      `${currency} has ${decimals} decimal places; "${text}" has ${fraction.length}.`,
    );
  }
  const minor =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AmountError(`Amount "${text}" is too large.`);
  }
  return Number(minor);
}

/** Format integer minor units for people, e.g. 123456 CHF → "CHF 1234.56". */
export function formatMoney(
  minor: number,
  currency: string,
  overrides?: Readonly<Record<string, number>>,
): string {
  const decimals = currencyDecimals(currency, overrides);
  const sign = minor < 0 ? '-' : '';
  const abs = BigInt(Math.abs(minor));
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  const fraction = decimals > 0 ? '.' + (abs % scale).toString().padStart(decimals, '0') : '';
  return `${currency} ${sign}${whole}${fraction}`;
}
