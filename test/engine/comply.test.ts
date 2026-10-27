import { describe, expect, it } from 'vitest';
import { RULE_ORDER, type Comply } from '../../src/engine/types.js';
import { MINUTE, NOW, entry, run, traceOf } from './fixtures.js';

const known = { ledger: [entry()] };
const comply = (r: { howToComply?: Comply[] }) => r.howToComply ?? [];

describe('how_to_comply: one hint per kind of no', () => {
  it('stop: kill switch, agent not active, credential', () => {
    expect(comply(run({ context: { killSwitch: true } }))).toEqual([
      { action: 'stop', reason: 'kill_switch' },
    ]);
    expect(comply(run({ agent: { status: 'frozen' } }))).toEqual([
      { action: 'stop', reason: 'agent_frozen' },
    ]);
    expect(comply(run({ agent: { credential: null } }))).toEqual([
      { action: 'stop', reason: 'credential' },
    ]);
  });

  it('fix the request, use another currency, choose another supplier or category', () => {
    expect(comply(run({ request: { amount: 0 } }))).toEqual([
      { action: 'fix_request', field: 'amount' },
    ]);
    expect(comply(run({ request: { currency: 'USD' } }))).toEqual([
      { action: 'use_currency', currencies: ['CHF', 'EUR'] },
    ]);
    expect(comply(run({ request: { merchant: 'Elsewhere AG' } }))).toEqual([
      { action: 'choose_supplier', approved_suppliers: ['Alpine Reagents AG', 'Basel Labware AG'] },
    ]);
    expect(comply(run({ request: { country: 'RU' } }))).toEqual([
      { action: 'choose_supplier', avoid_country: 'RU' },
    ]);
    expect(comply(run({ request: { category: '5021' } }))).toEqual([
      { action: 'choose_category', categories: ['5169', '5047'] },
    ]);
  });

  it('stay within the per-payment limit, never by splitting', () => {
    expect(comply(run({ request: { amount: 900_000 } }))).toEqual([
      {
        action: 'stay_within_limit',
        max_amount: 'CHF 8000.00',
        max_amount_minor: 800_000,
        currency: 'CHF',
        split_allowed: false,
      },
    ]);
  });

  it('wait for the daily budget, with what is left and when it resets', () => {
    const ledger = [entry({ amountBase: 1_950_000, createdAt: NOW - 60 * MINUTE })];
    expect(comply(run({ context: { ledger } }))).toEqual([
      {
        action: 'wait_for_budget',
        budget: 'daily',
        remaining: 'CHF 500.00',
        remaining_minor: 50_000,
        currency: 'CHF',
        resets_on: '2026-10-22',
      },
    ]);
  });

  it('wait a minute after too many requests', () => {
    const ledger = Array.from({ length: 6 }, () => entry({ createdAt: NOW - 10_000 }));
    expect(comply(run({ context: { ledger } }))).toEqual([{ action: 'wait', seconds: 60 }]);
  });

  it('every review reason has its own entry, in rule order', () => {
    const saturday = Date.parse('2026-10-24T10:00:00Z');
    const r = run({
      mandate: { businessHoursOnly: true },
      request: { amount: 600_000 },
      context: { now: saturday, ledger: [entry({ createdAt: saturday - 3 * 60 * MINUTE })] },
    });
    expect(comply(r).map((c) => c.reason)).toEqual([
      'outside_business_hours',
      'approval_threshold',
    ]);
    expect(comply(r)[1]).toMatchObject({ approved_without_a_person_up_to_minor: 500_000 });
  });

  it('gives no hints when approved', () => {
    expect(run({ context: known }).howToComply).toBeUndefined();
  });
});

describe('split detection, softened', () => {
  it('names the related requests, and sends the payment to a person', () => {
    const first = entry({ amountBase: 450_000, createdAt: NOW - 2 * MINUTE });
    const r = run({ context: { ledger: [first] }, request: { amount: 400_000 } });
    expect(r).toMatchObject({ decision: 'review', rule: 'SPLIT_DETECTION' });
    expect(r.reason).toContain(first.id);
    expect(comply(r)[0]).toEqual({
      action: 'wait_for_human',
      reason: 'possible_split',
      related_payments: [first.id],
    });
  });

  it('still declines a split that also breaks the daily budget or the velocity limit', () => {
    const big = entry({ amountBase: 1_700_000, createdAt: NOW - 2 * MINUTE });
    expect(run({ context: { ledger: [big] }, request: { amount: 400_000 } }).rule).toBe(
      'DAILY_BUDGET',
    );
    const burst = Array.from({ length: 6 }, () =>
      entry({ amountBase: 100_000, createdAt: NOW - 10_000 }),
    );
    expect(run({ context: { ledger: burst }, request: { amount: 400_000 } }).rule).toBe('VELOCITY');
  });
});

describe('project end dates', () => {
  const grant = {
    id: 'snf-123',
    name: 'Grant SNF-123',
    budgetBase: 5_000_000,
    period: 'total' as const,
    agents: [],
    ends: '2026-10-20',
  };
  const open = { ...grant, id: 'ops', name: 'Operations', ends: '2026-12-31' };

  it('declines a project that has ended, and offers only open projects', () => {
    const r = run({ policy: { projects: [grant, open] }, request: { project: 'snf-123' } });
    expect(r).toMatchObject({ decision: 'declined', rule: 'PROJECT_BUDGET' });
    expect(r.reason).toBe('Project "Grant SNF-123" ended on 2026-10-20.');
    expect(comply(r)).toEqual([
      { action: 'name_project', projects: [{ id: 'ops', name: 'Operations' }] },
    ]);
  });

  it('accepts the last day itself', () => {
    const r = run({
      policy: { projects: [{ ...grant, ends: '2026-10-21' }] },
      request: { project: 'snf-123' },
      context: known,
    });
    expect(traceOf(r, 'PROJECT_BUDGET').outcome).toBe('pass');
  });
});

describe('rule order: monthly and project budgets', () => {
  it('daily budget, then monthly, then project, then velocity', () => {
    const at = (rule: string) => RULE_ORDER.indexOf(rule as (typeof RULE_ORDER)[number]);
    expect(at('DAILY_BUDGET')).toBeLessThan(at('MONTHLY_BUDGET'));
    expect(at('MONTHLY_BUDGET')).toBeLessThan(at('PROJECT_BUDGET'));
    expect(at('PROJECT_BUDGET')).toBeLessThan(at('VELOCITY'));
  });

  it('a request over both the monthly and the project budget is declined by the monthly one', () => {
    const r = run({
      mandate: { monthlyBudget: 100_000 },
      policy: {
        projects: [{ id: 'p', name: 'P', budgetBase: 100_000, period: 'month', agents: [] }],
      },
      request: { project: 'p', amount: 150_000 },
      context: known,
    });
    expect(r.rule).toBe('MONTHLY_BUDGET');
    expect(traceOf(r, 'PROJECT_BUDGET').outcome).toBe('skip');
  });
});

describe('usual prices per supplier and currency', () => {
  const check = { abovePercent: 20, belowPercent: null, above: 'review' as const };

  it('converts a usual price in another currency through the fx table, rounding up', () => {
    // EUR 1,000 at 0.93 = CHF 930: CHF 1,200 is 29% above.
    const r = run({
      policy: {
        priceCheck: check,
        referencePrices: [{ item: 'Buffer', match: [], priceMinor: 100_000, currency: 'EUR' }],
      },
      context: known,
    });
    expect(traceOf(r, 'FAIR_PRICE').data).toMatchObject({ expectedBase: 93_000 });
    expect(r.rule).toBe('FAIR_PRICE');
  });

  it("prefers this supplier's price and ignores another supplier's", () => {
    const refs = [
      { item: 'Buffer', match: [], priceMinor: 50_000, currency: 'CHF' },
      {
        item: 'Buffer',
        match: [],
        priceMinor: 118_000,
        currency: 'CHF',
        supplier: 'Alpine Reagents AG',
      },
      { item: 'Buffer', match: [], priceMinor: 10_000, currency: 'CHF', supplier: 'Elsewhere AG' },
    ];
    const r = run({ policy: { priceCheck: check, referencePrices: refs }, context: known });
    expect(traceOf(r, 'FAIR_PRICE').data).toMatchObject({ expectedBase: 118_000 });
    expect(r.decision).toBe('approved');
  });
});
