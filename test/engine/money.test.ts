import { describe, expect, it } from 'vitest';
import { FxError, parseRate, toBaseMinor } from '../../src/engine/fx.js';
import { AmountError, currencyDecimals, formatMoney, parseAmount } from '../../src/engine/money.js';
import { formatClock, localTime, parseClock } from '../../src/engine/time.js';
import { normalizeName } from '../../src/engine/normalize.js';
import { policy } from './fixtures.js';

describe('parseAmount', () => {
  it.each([
    ['12.50', 'CHF', 1250],
    ['12.5', 'CHF', 1250],
    [12.5, 'CHF', 1250],
    ['0.1', 'CHF', 10],
    [0.3, 'EUR', 30],
    ['1000', 'JPY', 1000],
    ['1.234', 'KWD', 1234],
    ['12.345678', 'USDC', 12_345_678],
    ['  7 ', 'CHF', 700],
    ['0', 'CHF', 0],
  ] as const)('%s %s → %i', (input, currency, minor) => {
    expect(parseAmount(input, currency)).toBe(minor);
  });

  it('avoids float error: 0.1 + 0.2 never becomes 0.30000000000000004', () => {
    expect(parseAmount('0.1', 'CHF') + parseAmount('0.2', 'CHF')).toBe(parseAmount('0.3', 'CHF'));
  });

  it.each([
    ['12.505', 'CHF', /2 decimal places/],
    ['1.5', 'JPY', /0 decimal places/],
    ['-5', 'CHF', /not a valid amount/],
    ['1e3', 'CHF', /not a valid amount/],
    ['12,50', 'CHF', /not a valid amount/],
    ['', 'CHF', /not a valid amount/],
    ['99999999999999999', 'CHF', /too large/],
  ] as const)('rejects %s %s', (input, currency, message) => {
    expect(() => parseAmount(input, currency)).toThrow(message);
  });

  it('rejects non-finite numbers', () => {
    expect(() => parseAmount(Number.POSITIVE_INFINITY, 'CHF')).toThrow(AmountError);
  });

  it('honours decimal overrides', () => {
    expect(currencyDecimals('USDC', { USDC: 2 })).toBe(2);
    expect(parseAmount('1.25', 'USDC', { USDC: 2 })).toBe(125);
  });
});

describe('formatMoney', () => {
  it.each([
    [123456, 'CHF', 'CHF 1234.56'],
    [5, 'CHF', 'CHF 0.05'],
    [-150, 'EUR', 'EUR -1.50'],
    [1000, 'JPY', 'JPY 1000'],
    [1_500_000, 'USDC', 'USDC 1.500000'],
  ] as const)('%i %s → %s', (minor, currency, text) => {
    expect(formatMoney(minor, currency)).toBe(text);
  });
});

describe('fx', () => {
  const p = policy();
  it('parses rates as exact fractions', () => {
    expect(parseRate(0.93)).toEqual({ num: 93n, den: 100n });
    expect(parseRate('1.0825')).toEqual({ num: 10825n, den: 10000n });
    expect(parseRate(2)).toEqual({ num: 2n, den: 1n });
  });
  it.each(['0', '-1', 'abc', '1e-7'])('rejects rate %s', (rate) => {
    expect(() => parseRate(rate)).toThrow(FxError);
  });
  it('leaves base-currency amounts alone', () => {
    expect(toBaseMinor(12_345, 'CHF', p)).toBe(12_345);
  });
  it('converts EUR to CHF exactly', () => {
    expect(toBaseMinor(100_000, 'EUR', p)).toBe(93_000);
  });
  it('rounds up so limits never under-count (EUR 0.01 → CHF 0.01)', () => {
    expect(toBaseMinor(1, 'EUR', p)).toBe(1);
    expect(toBaseMinor(3, 'EUR', p)).toBe(3); // 2.79 → 3
  });
  it('handles different minor units (USDC has 6 decimals)', () => {
    expect(toBaseMinor(10_000_000, 'USDC', p)).toBe(800); // USDC 10 → CHF 8.00
    expect(toBaseMinor(1, 'USDC', p)).toBe(1); // dust rounds up
  });
  it('throws when there is no rate', () => {
    expect(() => toBaseMinor(100, 'GBP', p)).toThrow(/No exchange rate for GBP/);
  });
  it('does not treat inherited object keys as rates', () => {
    expect(() => toBaseMinor(100, 'constructor', p)).toThrow(FxError);
  });
  it('throws when the result is too large', () => {
    const rich = policy({ fx: { EUR: '1000000000' } });
    expect(() => toBaseMinor(Number.MAX_SAFE_INTEGER, 'EUR', rich)).toThrow(/too large/);
  });
});

describe('time', () => {
  it('reads the local date, weekday and minutes in a time zone', () => {
    expect(localTime(Date.parse('2026-10-21T10:00:00Z'), 'Europe/Zurich')).toEqual({
      date: '2026-10-21',
      weekday: 3,
      minutes: 720,
    });
    expect(localTime(Date.parse('2026-10-25T23:30:00Z'), 'UTC')).toEqual({
      date: '2026-10-25',
      weekday: 7,
      minutes: 1410,
    });
  });
  it('parses and formats HH:MM', () => {
    expect(parseClock('08:30')).toBe(510);
    expect(formatClock(510)).toBe('08:30');
    expect(() => parseClock('24:00')).toThrow(/HH:MM/);
  });
});

describe('normalizeName', () => {
  it('ignores case, outer spaces, repeated spaces and full-width forms', () => {
    expect(normalizeName('  Alpine\tReagents   AG ')).toBe('alpine reagents ag');
    expect(normalizeName('ＡＬＰＩＮＥ')).toBe('alpine');
  });
});
