import { currencyDecimals } from './money.js';
import type { GlobalPolicy } from './types.js';

/**
 * Static FX for v1. A rate is an exact fraction parsed from its decimal text, so 0.93 is 93/100
 * and never a float. Conversion rounds up: a limit check must never under-count spend.
 */

export class FxError extends Error {
  override name = 'FxError';
}

export interface Rate {
  num: bigint;
  den: bigint;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export function parseRate(rate: string | number): Rate {
  const text = typeof rate === 'number' ? String(rate) : rate.trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new FxError(`"${text}" is not a valid exchange rate.`);
  const [, whole = '0', fraction = ''] = match;
  const den = 10n ** BigInt(fraction.length);
  const num = BigInt(whole) * den + BigInt(fraction || '0');
  if (num === 0n) throw new FxError('An exchange rate must be above 0.');
  return { num, den };
}

export function hasRate(currency: string, policy: GlobalPolicy): boolean {
  return currency === policy.baseCurrency || Object.hasOwn(policy.fx, currency);
}

/** Convert integer minor units of `currency` to base-currency minor units, rounding up. */
export function toBaseMinor(amount: number, currency: string, policy: GlobalPolicy): number {
  if (currency === policy.baseCurrency) return amount;
  const raw = Object.hasOwn(policy.fx, currency) ? policy.fx[currency] : undefined;
  if (raw === undefined) throw new FxError(`No exchange rate for ${currency}.`);
  const { num, den } = parseRate(raw);
  const fromDigits = currencyDecimals(currency, policy.currencyDecimals);
  const toDigits = currencyDecimals(policy.baseCurrency, policy.currencyDecimals);
  const numerator = BigInt(amount) * num * 10n ** BigInt(toDigits);
  const denominator = den * 10n ** BigInt(fromDigits);
  const result = (numerator + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new FxError('Converted amount is too large.');
  return Number(result);
}
