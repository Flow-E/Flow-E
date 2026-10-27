import { describe, expect, it } from 'vitest';
import type { PaymentRecord, StoredEntry } from '@flow-e/mcp/core';
import { approvalContext, fairPriceOf, reviewReasons, traceOf } from '@/server/approval-context';
import type { TraceStep } from '@/server/store';

/** Wednesday 21 Oct 2026, 12:00 in Zurich. */
const NOW = Date.parse('2026-10-21T10:00:00Z');
const TZ = 'Europe/Zurich';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let n = 0;
function pay(
  over: Partial<Omit<PaymentRecord, 'request'>> & {
    at?: number;
    merchant?: string;
    amount?: number;
    memo?: string;
    item?: string;
  } = {},
): PaymentRecord {
  const { at = NOW, merchant = 'Fictional Labware AG', amount = 10000, memo, item, ...rest } = over;
  n += 1;
  return {
    paymentId: `pay_${String(n)}`,
    receiptId: `rcpt_${String(n)}`,
    agentId: 'buyer',
    status: 'approved',
    engineDecision: 'approved',
    rule: null,
    reason: 'All rules passed.',
    request: {
      merchant,
      amount,
      currency: 'CHF',
      category: '5169',
      country: 'CH',
      ...(memo === undefined ? {} : { memo }),
      ...(item === undefined ? {} : { item }),
    },
    amountBase: amount,
    baseCurrency: 'CHF',
    createdAt: new Date(at).toISOString(),
    cancellableUntil: null,
    decidedBy: 'engine',
    updatedAt: null,
    note: null,
    ...rest,
  };
}

const THRESHOLD: TraceStep = {
  rule: 'APPROVAL_THRESHOLD',
  outcome: 'review',
  detail: 'CHF 800.00 is above the approval threshold of CHF 500.00; a human must approve.',
  data: { amountBase: 80000, thresholdBase: 50000 },
};
const FAIR: TraceStep = {
  rule: 'FAIR_PRICE',
  outcome: 'review',
  detail:
    'CHF 800.00 for 2 × Pipette tips is 33% above the usual CHF 600.00 (CHF 300.00 each) (tolerance 20%); a human must approve.',
  data: {
    matched: true,
    item: 'Pipette tips',
    quantity: 2,
    referenceBase: 30000,
    expectedBase: 60000,
    differenceBase: 20000,
    differencePercent: 33,
  },
};

describe('why Flow-E asked', () => {
  it('lists every review step in plain words, without the engine’s boilerplate', () => {
    const reasons = reviewReasons(
      [{ rule: 'AMOUNT', outcome: 'pass', detail: 'ok' }, THRESHOLD, FAIR],
      'fallback',
    );
    expect(reasons).toEqual([
      {
        rule: 'APPROVAL_THRESHOLD',
        title: 'Above the amount the agent may spend without a person',
        detail: 'CHF 800.00 is above the approval threshold of CHF 500.00.',
      },
      {
        rule: 'FAIR_PRICE',
        title: 'More expensive than the usual price',
        detail:
          'CHF 800.00 for 2 × Pipette tips is 33% above the usual CHF 600.00 (CHF 300.00 each) (tolerance 20%).',
      },
    ]);
  });

  it('names cheap prices and business hours, and falls back to the payment’s reason', () => {
    const cheap = { ...FAIR, data: { ...FAIR.data, differencePercent: -40 } };
    const hours: TraceStep = {
      rule: 'BUSINESS_HOURS',
      outcome: 'review',
      detail: 'Outside business hours (08:00–18:00 Europe/Zurich); a human must approve.',
    };
    expect(reviewReasons([cheap, hours], '').map((r) => r.title)).toEqual([
      'Much cheaper than the usual price',
      'Asked outside business hours',
    ]);
    expect(reviewReasons([], 'Needs a person.')).toEqual([
      { rule: '', title: 'Flow-E asked a person', detail: 'Needs a person.' },
    ]);
  });
});

describe('usual price', () => {
  it('comes from the fair-price step only when a reference matched', () => {
    expect(fairPriceOf([FAIR])).toEqual({
      item: 'Pipette tips',
      quantity: 2,
      expectedBase: 60000,
      differenceBase: 20000,
      differencePercent: 33,
    });
    expect(
      fairPriceOf([{ rule: 'FAIR_PRICE', outcome: 'pass', detail: 'x', data: { matched: false } }]),
    ).toBeNull();
    expect(fairPriceOf([THRESHOLD])).toBeNull();
    expect(
      fairPriceOf([{ ...FAIR, data: { matched: true, item: 'x', quantity: 'two' } }]),
    ).toBeNull();
  });
});

describe('approval context', () => {
  const me = pay({
    status: 'review',
    engineDecision: 'review',
    amount: 80000,
    memo: 'Pipette tips',
  });
  const history = [
    pay({ at: NOW - 2 * HOUR, amount: 30000 }), // same supplier, approved today
    pay({ at: NOW - 3 * DAY, amount: 20000 }), // same supplier, approved earlier
    pay({ at: NOW - 1 * HOUR, amount: 15000, status: 'review', merchant: 'Other AG' }), // waiting today
    pay({
      at: NOW - 30 * 60_000,
      amount: 5000,
      status: 'declined',
      merchant: 'Fictional Labware AG',
    }),
    pay({
      at: NOW - 5 * DAY,
      merchant: 'Third GmbH',
      memo: '2 boxes of pipette tips',
      amount: 61000,
    }),
    pay({ at: NOW - 2 * HOUR, amount: 99999, agentId: 'someone-else' }), // other agent's budget
    pay({ at: NOW - 6 * DAY, merchant: 'Unrelated AG', amount: 1 }),
    pay({
      at: NOW - 3 * HOUR,
      merchant: '  fictional   LABWARE ag ',
      amount: 4000,
      status: 'cancelled',
    }),
  ];
  const ctx = approvalContext({
    payment: me,
    payments: [me, ...history],
    trace: [THRESHOLD, FAIR],
    dailyBudget: 200000,
    timezone: TZ,
    now: NOW,
  });

  it('shows the day’s budget: approved + other waiting + this one, for this agent only', () => {
    expect(ctx.budget).toEqual({
      day: '2026-10-21',
      isToday: true,
      budget: 200000,
      approved: 30000,
      pending: 15000,
      thisPayment: 80000,
      total: 125000,
      overBy: 0,
    });
  });

  it('flags going over the budget', () => {
    const over = approvalContext({
      payment: me,
      payments: [me, ...history],
      trace: [],
      dailyBudget: 100000,
      timezone: TZ,
      now: NOW + DAY,
    });
    expect(over.budget?.overBy).toBe(25000);
    expect(over.budget?.isToday).toBe(false);
    expect(over.budget?.day).toBe('2026-10-21');
  });

  it('has no budget for an agent no longer in the mandate', () => {
    expect(
      approvalContext({
        payment: me,
        payments: [me],
        trace: [],
        dailyBudget: null,
        timezone: TZ,
        now: NOW,
      }).budget,
    ).toBeNull();
  });

  it('counts only approved payments in the supplier’s history (names compared like the engine)', () => {
    // Any agent of the organisation counts; declined and cancelled payments do not.
    expect(ctx.supplier).toEqual({
      approvedCount: 3,
      approvedTotal: 149999,
      lastApprovedAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    const fresh = pay({ status: 'review', merchant: 'Brand New AG' });
    expect(
      approvalContext({
        payment: fresh,
        payments: [fresh, ...history],
        trace: [],
        dailyBudget: 1,
        timezone: TZ,
        now: NOW,
      }).supplier,
    ).toEqual({ approvedCount: 0, approvedTotal: 0, lastApprovedAt: null });
  });

  it('lists the last three similar purchases, newest first: same supplier or same item', () => {
    expect(ctx.similar.map((s) => [s.amount, s.status, s.match])).toEqual([
      [5000, 'declined', 'supplier'],
      [30000, 'approved', 'supplier'],
      [99999, 'approved', 'supplier'],
    ]);
    const older = approvalContext({
      payment: me,
      payments: [me, ...history.slice(4)],
      trace: [FAIR],
      dailyBudget: 1,
      timezone: TZ,
      now: NOW,
    });
    // "2 boxes of pipette tips" matches the fair-price item; "Unrelated AG" does not.
    expect(older.similar.map((s) => [s.merchant, s.match])).toEqual([
      ['Fictional Labware AG', 'supplier'],
      ['  fictional   LABWARE ag ', 'supplier'],
      ['Third GmbH', 'item'],
    ]);
    expect(older.similar.some((s) => s.paymentId === me.paymentId)).toBe(false);
  });

  it('carries the fair-price facts and the reasons through', () => {
    expect(ctx.fairPrice?.expectedBase).toBe(60000);
    expect(ctx.reasons).toHaveLength(2);
    expect(ctx.baseCurrency).toBe('CHF');
  });
});

describe('trace of a payment', () => {
  it('reads the signed trace of the decision entry, and nothing else', () => {
    const row = (id: string, type: string, data: unknown): StoredEntry => ({
      seq: 1,
      id,
      type,
      agent_id: 'buyer',
      created_at: new Date(NOW).toISOString(),
      data: typeof data === 'string' ? data : JSON.stringify(data),
      prev_hash: '0'.repeat(64),
      hash: '1'.repeat(64),
      signature: 'x',
    });
    const entries = [
      row('r1', 'payment.decision', { trace: [THRESHOLD] }),
      row('r2', 'payment.resolved', { trace: [FAIR] }),
      row('r3', 'payment.decision', 'not json'),
    ];
    expect(traceOf(entries, 'r1')).toEqual([THRESHOLD]);
    expect(traceOf(entries, 'r2')).toEqual([]);
    expect(traceOf(entries, 'r3')).toEqual([]);
    expect(traceOf(entries, 'nope')).toEqual([]);
  });
});

describe('monthly and project budget effects', () => {
  const booked = (p: PaymentRecord, project: string): PaymentRecord => ({
    ...p,
    request: { ...p.request, project },
  });
  const PROJECTS = [
    {
      id: 'p-alpha',
      name: 'Project Alpha',
      budgetBase: 300000,
      period: 'total' as const,
      agents: [],
      ends: '2026-12-31',
    },
    { id: 'p-beta', name: 'Beta', budgetBase: 100000, period: 'month' as const, agents: [] },
  ];
  const me = booked(pay({ status: 'review', engineDecision: 'review', amount: 80000 }), 'p-alpha');
  const history = [
    pay({ at: NOW - 2 * DAY, amount: 40000 }), // this month, approved
    pay({ at: NOW - 3 * DAY, amount: 10000, status: 'review' }), // this month, waiting
    pay({ at: NOW - 30 * DAY, amount: 70000 }), // September: not this month
    pay({ at: NOW - DAY, amount: 99999, agentId: 'someone-else' }), // other agent
    // Project Alpha, booked by name and by another agent: shared budget, any spelling.
    booked(pay({ at: NOW - 40 * DAY, amount: 120000, agentId: 'someone-else' }), ' project ALPHA '),
    booked(pay({ at: NOW - DAY, amount: 50000, status: 'review' }), 'p-alpha'),
    booked(pay({ at: NOW - DAY, amount: 5000, status: 'declined' }), 'p-alpha'),
    booked(pay({ at: NOW - DAY, amount: 7000 }), 'p-beta'),
  ];
  const input = {
    payment: me,
    payments: [me, ...history],
    trace: [],
    dailyBudget: 1000000,
    monthlyBudget: 250000,
    projects: PROJECTS,
    timezone: TZ,
    now: NOW,
  };

  it('shows the month: this agent’s approved + other waiting + this one', () => {
    // Other agents and September do not count; this agent's project payments do.
    expect(approvalContext(input).monthly).toEqual({
      month: '2026-10',
      isThisMonth: true,
      budget: 250000,
      approved: 47000,
      pending: 60000,
      thisPayment: 80000,
      total: 187000,
      overBy: 0,
    });
    const tight = approvalContext({ ...input, monthlyBudget: 150000, now: NOW + 20 * DAY });
    expect(tight.monthly).toMatchObject({ overBy: 37000, isThisMonth: false });
    expect(approvalContext({ ...input, monthlyBudget: null }).monthly).toBeNull();
  });

  it('shows the project: every agent’s payments to it, by id or name, over its whole life', () => {
    expect(approvalContext(input).project).toEqual({
      found: true,
      id: 'p-alpha',
      name: 'Project Alpha',
      period: 'total',
      month: null,
      ends: '2026-12-31',
      ended: false,
      budget: 300000,
      approved: 120000,
      pending: 50000,
      thisPayment: 80000,
      total: 250000,
      overBy: 0,
    });
  });

  it('a monthly project counts this month only; over budget is flagged', () => {
    const beta = booked(pay({ status: 'review', engineDecision: 'review', amount: 95000 }), 'beta');
    const ctx = approvalContext({ ...input, payment: beta, payments: [beta, ...history] });
    expect(ctx.project).toMatchObject({
      found: true,
      id: 'p-beta',
      period: 'month',
      month: '2026-10',
      ends: null,
      approved: 7000,
      overBy: 2000,
    });
  });

  it('says when the project had ended, and when the name is not a project', () => {
    const late = { ...me, createdAt: '2027-01-02T10:00:00.000Z' };
    expect(approvalContext({ ...input, payment: late }).project).toMatchObject({
      ended: true,
      ends: '2026-12-31',
    });
    const unknown = booked(me, 'Gamma');
    expect(approvalContext({ ...input, payment: unknown }).project).toEqual({
      found: false,
      named: 'Gamma',
    });
    const none = { ...me, request: { ...me.request, project: undefined } };
    expect(approvalContext({ ...input, payment: none }).project).toBeNull();
  });
});
