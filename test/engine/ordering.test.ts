import { describe, expect, it } from 'vitest';
import { RULE_ORDER } from '../../src/engine/types.js';
import { MINUTE, NOW, credential, entry, run } from './fixtures.js';

describe('rule ordering', () => {
  it('kill switch beats a frozen agent', () => {
    expect(run({ context: { killSwitch: true }, agent: { status: 'frozen' } }).rule).toBe(
      'KILL_SWITCH',
    );
  });

  it('a frozen agent beats every other problem', () => {
    const r = run({
      agent: { status: 'frozen', credential: null },
      request: { amount: -1, currency: 'XYZ', country: 'RU', merchant: 'Shadow Chemicals Ltd' },
    });
    expect(r.rule).toBe('AGENT_STATUS');
  });

  it('an invalid credential beats a bad amount', () => {
    const r = run({ agent: { credential: credential({ scope: [] }) }, request: { amount: 0 } });
    expect(r.rule).toBe('KYA_CREDENTIAL');
  });

  it('a blocked country beats an unknown supplier and a wrong category', () => {
    const r = run({ request: { country: 'KP', merchant: 'Unknown Co', category: '0000' } });
    expect(r.rule).toBe('COUNTRY');
  });

  it('a hard decline beats a review flag', () => {
    // Above the approval threshold (review) but from a blocked country (decline).
    expect(run({ request: { amount: 600_000, country: 'IR' } }).decision).toBe('declined');
  });

  it('the per-payment limit is checked before the daily budget', () => {
    const ledger = [entry({ amountBase: 1_900_000 })];
    expect(run({ context: { ledger }, request: { amount: 900_000 } }).rule).toBe(
      'PER_PAYMENT_LIMIT',
    );
  });

  it('velocity is checked before split detection', () => {
    const ledger = Array.from({ length: 6 }, () =>
      entry({ amountBase: 450_000, status: 'declined', createdAt: NOW - 10_000 }),
    ).concat(entry({ amountBase: 450_000, createdAt: NOW - 2 * MINUTE }));
    expect(run({ context: { ledger }, request: { amount: 400_000 } }).rule).toBe('VELOCITY');
  });

  it('split detection is checked before the fair price, and the fair price before review', () => {
    const policy = {
      referencePrices: [{ item: 'Buffer solution, 10 L', match: [], priceBase: 10_000 }],
      priceCheck: { abovePercent: 20, belowPercent: null, above: 'review' as const },
    };
    const ledger = [entry({ amountBase: 450_000, createdAt: NOW - 2 * MINUTE })];
    expect(run({ policy, context: { ledger }, request: { amount: 400_000 } }).rule).toBe(
      'SPLIT_DETECTION',
    );
    const r = run({ policy, mandate: { businessHoursOnly: true }, request: { amount: 600_000 } });
    expect(r.rule).toBe('FAIR_PRICE');
    expect(r.reason).toMatch(/above the usual.*above the approval threshold/);
  });

  it('review only happens once every hard rule passed, and lists every review reason', () => {
    const saturday = Date.parse('2026-10-24T10:00:00Z');
    const r = run({
      mandate: { businessHoursOnly: true },
      request: { amount: 600_000 },
      context: { now: saturday },
    });
    expect(r).toMatchObject({ decision: 'review', rule: 'BUSINESS_HOURS' });
    expect(r.reason).toMatch(/Outside business hours.*above the approval threshold/);
  });

  it('traces every rule in order, marking those after a decline as skipped', () => {
    const r = run({ request: { currency: 'USD' } });
    expect(r.trace.map((t) => t.rule)).toEqual([...RULE_ORDER]);
    const at = RULE_ORDER.indexOf('CURRENCY');
    expect(r.trace[at]?.outcome).toBe('decline');
    expect(r.trace.slice(at + 1).every((t) => t.outcome === 'skip')).toBe(true);
    expect(r.trace.slice(0, at).every((t) => t.outcome === 'pass')).toBe(true);
  });
});

describe('fail closed', () => {
  it('declines with "internal error" when the signature check throws', () => {
    const r = run({
      context: {
        kya: {
          issuer: 'local-issuer:test',
          requiredScope: 'payments:request',
          verifySignature: () => {
            throw new Error('secret key material should never leak');
          },
        },
      },
    });
    expect(r).toMatchObject({ decision: 'declined', rule: 'INTERNAL', reason: 'internal error' });
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect(r.trace.at(-1)).toEqual({
      rule: 'INTERNAL',
      outcome: 'decline',
      detail: 'internal error',
    });
  });

  it('declines when the time zone is broken', () => {
    expect(run({ policy: { timezone: 'Mars/Olympus' } }).reason).toBe('internal error');
  });

  it('declines when an fx rate is malformed', () => {
    expect(run({ policy: { fx: { EUR: 'abc' } }, request: { currency: 'EUR' } }).rule).toBe(
      'INTERNAL',
    );
  });

  it('declines when the request itself is malformed', () => {
    const bad = { merchant: undefined } as unknown as { merchant: string };
    expect(run({ request: bad }).decision).toBe('declined');
  });

  it('never approves when the ledger view throws', () => {
    const ledger = new Proxy([], {
      get() {
        throw new Error('db gone');
      },
    });
    expect(run({ context: { ledger } }).decision).toBe('declined');
  });
});
