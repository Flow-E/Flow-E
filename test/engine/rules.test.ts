import { describe, expect, it } from 'vitest';
import { COOLING_OFF_MS } from '../../src/engine/rules.js';
import { MINUTE, NOW, credential, entry, run, traceOf } from './fixtures.js';

describe('baseline', () => {
  it('approves a request that satisfies every rule (known supplier, so no cooling-off)', () => {
    const r = run({ context: { ledger: [entry()] } });
    expect(r.decision).toBe('approved');
    expect(r.rule).toBeNull();
    expect(r.reason).toBe('All rules passed.');
    expect(r.amountBase).toBe(120_000);
    expect(r.trace).toHaveLength(15);
    expect(r.trace.every((t) => t.outcome === 'pass')).toBe(true);
    expect(r.cancellableUntil).toBeUndefined();
  });
});

describe('rule 1: kill switch and agent status', () => {
  it('passes when the kill switch is off', () => {
    expect(traceOf(run(), 'KILL_SWITCH').outcome).toBe('pass');
  });
  it('declines everything when the kill switch is on', () => {
    const r = run({ context: { killSwitch: true } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'KILL_SWITCH' });
    expect(r.reason).toMatch(/kill switch is on/);
  });
  it.each(['paused', 'frozen'] as const)('declines a %s agent', (status) => {
    const r = run({ agent: { status } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'AGENT_STATUS' });
    expect(r.reason).toBe(`Agent "lab-procurement" is ${status}.`);
  });
  it('passes an active agent', () => {
    expect(traceOf(run(), 'AGENT_STATUS').outcome).toBe('pass');
  });
});

describe('rule 2: Know Your Agent credential', () => {
  it('passes a valid credential and names the owner', () => {
    expect(traceOf(run(), 'KYA_CREDENTIAL').detail).toMatch(/M\. Keller/);
  });
  it('declines when no credential is presented', () => {
    const r = run({ agent: { credential: null } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'KYA_CREDENTIAL' });
    expect(r.reason).toMatch(/No Know Your Agent credential/);
  });
  it('declines a credential from another issuer', () => {
    const r = run({ agent: { credential: credential({ issuer: 'someone-else' }) } });
    expect(r.rule).toBe('KYA_CREDENTIAL');
    expect(r.reason).toMatch(/issued by "someone-else"/);
  });
  it('declines a tampered credential (bad signature)', () => {
    const c = { ...credential(), signature: 'tampered' };
    const r = run({ agent: { credential: c } });
    expect(r.rule).toBe('KYA_CREDENTIAL');
    expect(r.reason).toMatch(/signature is not valid/);
  });
  it('declines a credential issued to a different agent', () => {
    const r = run({ agent: { credential: credential({ agent_id: 'marketing-bot' }) } });
    expect(r.reason).toMatch(/belongs to agent "marketing-bot"/);
  });
  it('declines an expired credential', () => {
    const r = run({ agent: { credential: credential({ expires_at: '2026-10-21T09:59:59Z' }) } });
    expect(r.reason).toMatch(/expired at 2026-10-21T09:59:59Z/);
  });
  it('declines a credential at the exact expiry instant', () => {
    const r = run({ agent: { credential: credential({ expires_at: '2026-10-21T10:00:00Z' }) } });
    expect(r.rule).toBe('KYA_CREDENTIAL');
  });
  it('declines a credential that is not valid yet', () => {
    const r = run({ agent: { credential: credential({ issued_at: '2026-10-22T00:00:00Z' }) } });
    expect(r.reason).toMatch(/not valid before/);
  });
  it('declines a credential with unreadable dates', () => {
    const r = run({ agent: { credential: credential({ expires_at: 'next year' }) } });
    expect(r.reason).toMatch(/unreadable/);
  });
  it('declines a credential without the payment scope', () => {
    const r = run({ agent: { credential: credential({ scope: ['catalog:read'] }) } });
    expect(r.reason).toMatch(/does not include "payments:request"/);
  });
});

describe('rule 3: amount and currency', () => {
  it.each([0, -100, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'declines amount %s',
    (amount) => {
      const r = run({ request: { amount } });
      expect(r).toMatchObject({ decision: 'declined', rule: 'AMOUNT' });
    },
  );
  it('passes a positive integer amount', () => {
    expect(traceOf(run(), 'AMOUNT').outcome).toBe('pass');
  });
  it('declines a currency outside the allowed list', () => {
    const r = run({ request: { currency: 'USD' } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'CURRENCY' });
    expect(r.reason).toBe('Currency USD is not allowed. Allowed: CHF, EUR.');
  });
  it('declines an allowed currency that has no exchange rate', () => {
    const r = run({ mandate: { currencies: ['CHF', 'GBP'] }, request: { currency: 'GBP' } });
    expect(r.reason).toBe('No exchange rate is configured for GBP.');
  });
  it('accepts lower-case currency codes and converts to the base currency', () => {
    const r = run({
      request: { currency: 'eur', amount: 100_000 },
      context: { ledger: [entry()] },
    });
    expect(r.decision).toBe('approved');
    expect(r.amountBase).toBe(93_000);
    expect(traceOf(r, 'CURRENCY').detail).toBe('EUR 1000.00 is CHF 930.00 at the configured rate.');
  });
});

describe('rule 4: country', () => {
  it('passes an unblocked country, case-insensitively', () => {
    expect(traceOf(run({ request: { country: 'ch' } }), 'COUNTRY').outcome).toBe('pass');
  });
  it('declines a country on the always-blocked list, with the screening caveat', () => {
    const r = run({ request: { country: 'RU' } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'COUNTRY' });
    expect(r.reason).toMatch(/always-blocked list.*not sanctions screening/);
  });
  it('declines a country blocked for this agent only', () => {
    const r = run({ mandate: { blockedCountries: ['DE'] }, request: { country: 'de' } });
    expect(r.reason).toBe('Country DE is blocked for this agent.');
  });
  it('declines something that is not an ISO country code', () => {
    const r = run({ request: { country: 'Germany' } });
    expect(r.reason).toMatch(/not an ISO 3166-1 alpha-2/);
  });
});

describe('rule 5: supplier', () => {
  it('matches the allowlist ignoring case and spacing', () => {
    const r = run({ request: { merchant: '  alpine   REAGENTS ag ' } });
    expect(traceOf(r, 'SUPPLIER').outcome).toBe('pass');
  });
  it('declines a supplier not on the allowlist', () => {
    const r = run({ request: { merchant: 'Zurich Glass GmbH' } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'SUPPLIER' });
    expect(r.reason).toMatch(/not on this agent's approved supplier list/);
  });
  it('declines a supplier on the organisation blocklist, even in open mode', () => {
    const r = run({
      mandate: { suppliers: { mode: 'any', allow: [], block: [] } },
      request: { merchant: 'shadow chemicals ltd' },
    });
    expect(r.reason).toMatch(/organisation's blocklist/);
  });
  it('declines a supplier on the agent blocklist, even if also allowlisted', () => {
    const r = run({
      mandate: {
        suppliers: {
          mode: 'allowlist',
          allow: ['Alpine Reagents AG'],
          block: ['Alpine Reagents AG'],
        },
      },
    });
    expect(r.reason).toMatch(/blocked for this agent/);
  });
  it('passes any unblocked supplier in open mode', () => {
    const r = run({
      mandate: { suppliers: { mode: 'any', allow: [], block: [] } },
      request: { merchant: 'Zurich Glass GmbH' },
    });
    expect(traceOf(r, 'SUPPLIER').detail).toBe('Supplier "Zurich Glass GmbH" is not blocked.');
  });
  it('declines an empty supplier name', () => {
    expect(run({ request: { merchant: '   ' } }).reason).toBe('Supplier name is empty.');
  });
});

describe('rule 6: category', () => {
  it('passes an allowed category', () => {
    expect(traceOf(run(), 'CATEGORY').outcome).toBe('pass');
  });
  it('declines a category outside the list', () => {
    const r = run({ request: { category: '5812' } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'CATEGORY' });
    expect(r.reason).toBe('Category 5812 is not allowed. Allowed: 5169, 5047.');
  });
  it('declines a malformed category code', () => {
    expect(run({ request: { category: 'lab' } }).reason).toMatch(/not a four-digit/);
  });
});

describe('rule 7: per-payment limit', () => {
  const big = { approvalAbove: null, dailyBudget: 10_000_000 };
  it('passes exactly at the limit', () => {
    const r = run({ mandate: big, request: { amount: 800_000 } });
    expect(traceOf(r, 'PER_PAYMENT_LIMIT').outcome).toBe('pass');
  });
  it('declines one rappen above the limit and shows the numbers', () => {
    const r = run({ mandate: big, request: { amount: 800_001 } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'PER_PAYMENT_LIMIT' });
    expect(r.reason).toBe('CHF 8000.01 is above the per-payment limit of CHF 8000.00.');
    expect(traceOf(r, 'PER_PAYMENT_LIMIT').data).toEqual({
      amountBase: 800_001,
      limitBase: 800_000,
    });
  });
  it('compares in the base currency: EUR 8600 = CHF 7998 passes', () => {
    const r = run({ mandate: big, request: { currency: 'EUR', amount: 860_000 } });
    expect(r.amountBase).toBe(799_800);
    expect(traceOf(r, 'PER_PAYMENT_LIMIT').outcome).toBe('pass');
  });
  it('compares in the base currency: EUR 8603 = CHF 8000.79 is declined', () => {
    const r = run({ mandate: big, request: { currency: 'EUR', amount: 860_300 } });
    expect(r.rule).toBe('PER_PAYMENT_LIMIT');
    expect(r.amountBase).toBe(800_079);
  });
});

describe('rule 8: daily budget', () => {
  it('passes when approved spend plus this payment fits', () => {
    const ledger = [entry({ amountBase: 1_600_000 })];
    const r = run({ context: { ledger }, request: { amount: 400_000 } });
    expect(r.decision).toBe('approved');
    expect(traceOf(r, 'DAILY_BUDGET').data).toMatchObject({ remainingBase: 400_000 });
  });
  it('declines when it would exceed the budget, with the numbers', () => {
    const ledger = [entry({ amountBase: 1_600_000 })];
    const r = run({ context: { ledger }, request: { amount: 400_001 } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'DAILY_BUDGET' });
    expect(r.reason).toBe(
      "CHF 4000.01 exceeds today's remaining budget of CHF 4000.00 " +
        '(budget CHF 20000.00, approved CHF 16000.00, pending review CHF 0.00).',
    );
  });
  it('counts payments pending review against the budget', () => {
    const ledger = [
      entry({ amountBase: 1_000_000 }),
      entry({ amountBase: 700_000, status: 'review' }),
    ];
    const r = run({ context: { ledger }, request: { amount: 400_000 } });
    expect(r.rule).toBe('DAILY_BUDGET');
  });
  it('ignores declined and cancelled payments', () => {
    const ledger = [
      entry({ amountBase: 1_900_000, status: 'declined' }),
      entry({ amountBase: 1_900_000, status: 'cancelled' }),
    ];
    expect(run({ context: { ledger }, request: { amount: 400_000 } }).decision).toBe('approved');
  });
  it('uses the local calendar day of the configured time zone', () => {
    // 23:59 Zurich on the 20th is yesterday; 00:00 Zurich on the 21st is today.
    const yesterday = entry({
      amountBase: 1_900_000,
      createdAt: Date.parse('2026-10-20T21:59:00Z'),
    });
    const today = entry({ amountBase: 1_700_000, createdAt: Date.parse('2026-10-20T22:00:00Z') });
    expect(run({ context: { ledger: [yesterday] }, request: { amount: 400_000 } }).decision).toBe(
      'approved',
    );
    expect(run({ context: { ledger: [today] }, request: { amount: 400_000 } }).rule).toBe(
      'DAILY_BUDGET',
    );
  });
});

describe('rule 9: velocity', () => {
  const recent = (n: number, status: 'approved' | 'declined' = 'approved') =>
    Array.from({ length: n }, (_, i) =>
      entry({
        merchant: 'Basel Labware AG',
        amountBase: 100,
        status,
        createdAt: NOW - (i + 1) * 5_000,
      }),
    );
  it('passes below the per-minute limit', () => {
    expect(traceOf(run({ context: { ledger: recent(5) } }), 'VELOCITY').outcome).toBe('pass');
  });
  it('declines at the limit', () => {
    const r = run({ context: { ledger: recent(6) } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'VELOCITY' });
    expect(r.reason).toBe('6 payment requests in the last minute; the limit is 6.');
  });
  it('counts declined attempts too', () => {
    expect(run({ context: { ledger: recent(6, 'declined') } }).rule).toBe('VELOCITY');
  });
  it('only counts the last 60 seconds', () => {
    const old = recent(6).map((e) => ({ ...e, createdAt: e.createdAt - MINUTE }));
    expect(traceOf(run({ context: { ledger: old } }), 'VELOCITY').outcome).toBe('pass');
  });
});

describe('rule 10: split detection', () => {
  it('declines a second payment to the same supplier that sums above the limit', () => {
    const ledger = [entry({ amountBase: 450_000, createdAt: NOW - 5 * MINUTE })];
    const r = run({ context: { ledger }, request: { amount: 400_000 } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'SPLIT_DETECTION' });
    expect(r.reason).toMatch(/split payment.*total CHF 8500\.00.*CHF 8000\.00/);
  });
  it('matches the supplier name loosely', () => {
    const ledger = [
      entry({ merchant: 'ALPINE reagents AG', amountBase: 450_000, createdAt: NOW - MINUTE }),
    ];
    expect(run({ context: { ledger }, request: { amount: 400_000 } }).rule).toBe('SPLIT_DETECTION');
  });
  it('counts a pending review payment', () => {
    const ledger = [entry({ amountBase: 450_000, status: 'review', createdAt: NOW - MINUTE })];
    expect(run({ context: { ledger }, request: { amount: 400_000 } }).rule).toBe('SPLIT_DETECTION');
  });
  it('passes when the earlier payment is older than 10 minutes', () => {
    const ledger = [entry({ amountBase: 450_000, createdAt: NOW - 10 * MINUTE })];
    expect(
      traceOf(run({ context: { ledger }, request: { amount: 400_000 } }), 'SPLIT_DETECTION')
        .outcome,
    ).toBe('pass');
  });
  it('passes when the earlier payment went to another supplier', () => {
    const ledger = [
      entry({ merchant: 'Basel Labware AG', amountBase: 450_000, createdAt: NOW - MINUTE }),
    ];
    expect(run({ context: { ledger }, request: { amount: 400_000 } }).decision).toBe('approved');
  });
  it('passes when the earlier payment was declined', () => {
    const ledger = [entry({ amountBase: 450_000, status: 'declined', createdAt: NOW - MINUTE })];
    expect(
      traceOf(run({ context: { ledger }, request: { amount: 400_000 } }), 'SPLIT_DETECTION')
        .outcome,
    ).toBe('pass');
  });
  it('passes when the sum stays within the limit', () => {
    const ledger = [entry({ amountBase: 300_000, createdAt: NOW - MINUTE })];
    expect(run({ context: { ledger }, request: { amount: 400_000 } }).decision).toBe('approved');
  });
});

describe('rule 11: business hours', () => {
  const on = { businessHoursOnly: true };
  it('passes inside business hours (Wednesday 12:00 Zurich)', () => {
    const r = run({ mandate: on, context: { ledger: [entry()] } });
    expect(r.decision).toBe('approved');
    expect(traceOf(r, 'BUSINESS_HOURS').detail).toMatch(/Inside business hours \(08:00–18:00/);
  });
  it('sends a weekend payment to review', () => {
    const saturday = Date.parse('2026-10-24T10:00:00Z');
    const r = run({
      mandate: on,
      context: { now: saturday, ledger: [entry({ createdAt: saturday - 1e8 })] },
    });
    expect(r).toMatchObject({ decision: 'review', rule: 'BUSINESS_HOURS' });
  });
  it('sends a payment at 07:59 local time to review', () => {
    const early = Date.parse('2026-10-21T05:59:00Z');
    const r = run({
      mandate: on,
      context: { now: early, ledger: [entry({ createdAt: early - 1e8 })] },
    });
    expect(r.decision).toBe('review');
    expect(traceOf(r, 'BUSINESS_HOURS').data).toEqual({ localTime: '07:59', weekday: 3 });
  });
  it('treats the end time as exclusive (18:00 is outside)', () => {
    const six = Date.parse('2026-10-21T16:00:00Z');
    expect(run({ mandate: on, context: { now: six } }).decision).toBe('review');
  });
  it('is not enforced when the agent does not ask for it', () => {
    const saturday = Date.parse('2026-10-24T10:00:00Z');
    expect(traceOf(run({ context: { now: saturday } }), 'BUSINESS_HOURS').outcome).toBe('pass');
  });
});

describe('rule 12: human-approval threshold', () => {
  it('passes exactly at the threshold', () => {
    expect(run({ request: { amount: 500_000 }, context: { ledger: [entry()] } }).decision).toBe(
      'approved',
    );
  });
  it('sends a payment above the threshold to review', () => {
    const r = run({ request: { amount: 500_001 } });
    expect(r).toMatchObject({ decision: 'review', rule: 'APPROVAL_THRESHOLD' });
    expect(r.reason).toMatch(/CHF 5000\.01 is above the approval threshold of CHF 5000\.00/);
  });
  it('never asks for review when no threshold is set', () => {
    const r = run({ mandate: { approvalAbove: null }, request: { amount: 790_000 } });
    expect(traceOf(r, 'APPROVAL_THRESHOLD').detail).toBe('No human-approval threshold is set.');
  });
});

describe('rule 13: cooling-off', () => {
  it('marks the first approved payment to a new supplier cancellable for 10 minutes', () => {
    const r = run();
    expect(r.decision).toBe('approved');
    expect(r.cancellableUntil).toBe(NOW + COOLING_OFF_MS);
    expect(r.reason).toMatch(/cancellable until 2026-10-21T10:10:00\.000Z/);
    expect(traceOf(r, 'COOLING_OFF')).toMatchObject({
      outcome: 'note',
      data: { newSupplier: true },
    });
  });
  it('does not apply to a supplier that was paid before', () => {
    const r = run({ context: { ledger: [entry()] } });
    expect(r.cancellableUntil).toBeUndefined();
    expect(traceOf(r, 'COOLING_OFF').outcome).toBe('pass');
  });
  it('treats a supplier whose only earlier payment was declined as new', () => {
    expect(
      run({ context: { ledger: [entry({ status: 'declined' })] } }).cancellableUntil,
    ).toBeDefined();
  });
  it('notes, but does not start, the window when the payment goes to review', () => {
    const r = run({ request: { amount: 600_000 } });
    expect(r.decision).toBe('review');
    expect(r.cancellableUntil).toBeUndefined();
    expect(traceOf(r, 'COOLING_OFF').detail).toMatch(/Cooling-off will apply if a human approves/);
  });
});
