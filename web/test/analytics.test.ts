import { describe, expect, it } from 'vitest';
import type { GlobalPolicy, StoredEntry } from '@flow-e/mcp/core';
import {
  AGENT_SLOTS,
  OTHER_AGENTS,
  MINUTES_PER_APPROVAL,
  addDays,
  buildDashboard,
  buildValueReport,
  forAgent,
  median,
  parseAgent,
  parsePeriod,
  periodDays,
  periodEntries,
  spendGroups,
  stopCategory,
  valueSummary,
  workSaved,
  workingDays,
  type DashboardInput,
} from '@/server/analytics';

/** Monday 26 Oct 2026, 10:00 in Zurich (CET, UTC+1 since the switch on 25 Oct). */
const NOW = Date.parse('2026-10-26T09:00:00Z');
const TZ = 'Europe/Zurich';
const MINUTE = 60_000;

const AGENTS = [
  { id: 'lab', name: 'Lab', dailyBudget: 2_000_000 },
  { id: 'office', name: 'Office', dailyBudget: 50_000 },
];

let seq = 0;
function entry(
  type: string,
  agentId: string,
  at: string,
  data: Record<string, unknown>,
): StoredEntry {
  seq += 1;
  return {
    seq,
    id: `rcpt_${String(seq)}`,
    type,
    agent_id: agentId,
    created_at: at,
    data: JSON.stringify(data),
    prev_hash: '',
    hash: '',
    signature: '',
  };
}

function decision(
  id: string,
  agentId: string,
  at: string,
  decisionValue: 'approved' | 'review' | 'declined',
  amount: number,
  opts: { rule?: string; merchant?: string } = {},
): StoredEntry {
  return entry('payment.decision', agentId, at, {
    payment_id: id,
    request: {
      merchant: opts.merchant ?? 'Example Reagents AG',
      amount,
      currency: 'CHF',
      category: '5169',
      country: 'CH',
    },
    decision: decisionValue,
    rule: opts.rule ?? (decisionValue === 'approved' ? null : 'APPROVAL_THRESHOLD'),
    reason: 'test',
    amount_base: amount,
    base_currency: 'CHF',
    cancellable_until: null,
  });
}

const resolved = (id: string, agentId: string, at: string, status: 'approved' | 'declined') =>
  entry('payment.resolved', agentId, at, { payment_id: id, status, by: 'Approver', note: null });
const cancelled = (id: string, agentId: string, at: string) =>
  entry('payment.cancelled', agentId, at, { payment_id: id, by: 'Approver', note: null });

/** A request declined before the currency rule ran: no base amount in the ledger. */
function foreignDecline(
  id: string,
  at: string,
  amount: number,
  currency: string,
  rule: string,
): StoredEntry {
  return entry('payment.decision', 'lab', at, {
    payment_id: id,
    request: { merchant: 'X', amount, currency, category: '5169', country: 'DE' },
    decision: 'declined',
    rule,
    reason: 'test',
    amount_base: null,
    base_currency: 'CHF',
    cancellable_until: null,
  });
}

const POLICY: GlobalPolicy = {
  baseCurrency: 'CHF',
  fx: { EUR: '0.93' },
  blockedCountries: [],
  blockedSuppliers: [],
  timezone: TZ,
  businessHours: { days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1080 },
};

function input(entries: StoredEntry[], over: Partial<DashboardInput> = {}): DashboardInput {
  return { entries, agents: AGENTS, timezone: TZ, now: NOW, period: '7d', agentId: null, ...over };
}

describe('periods and calendar days', () => {
  it('parses search params, falling back to 30 days and to all agents', () => {
    expect(parsePeriod('today')).toBe('today');
    expect(parsePeriod('90d')).toBe('90d');
    expect(parsePeriod('365d')).toBe('30d');
    expect(parsePeriod(undefined)).toBe('30d');
    expect(parseAgent('lab', AGENTS)).toBe('lab');
    expect(parseAgent('nobody', AGENTS)).toBeNull();
    expect(parseAgent(['lab'], AGENTS)).toBeNull();
  });

  it('counts calendar days in the time zone, across month ends and the DST switch', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(periodDays('today', NOW, TZ)).toEqual(['2026-10-26']);
    const week = periodDays('7d', NOW, TZ);
    expect(week).toHaveLength(7);
    expect(week[0]).toBe('2026-10-20');
    expect(week.at(-1)).toBe('2026-10-26');
    expect(periodDays('90d', NOW, TZ)).toHaveLength(90);
    // 23:30 UTC on the 25th is already the 26th in Zurich, but still the 25th in New York.
    const late = Date.parse('2026-10-25T23:30:00Z');
    expect(periodDays('today', late, TZ)).toEqual(['2026-10-26']);
    expect(periodDays('today', late, 'America/New_York')).toEqual(['2026-10-25']);
  });

  it('median of an odd and an even list, and of nothing', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe('the dashboard', () => {
  it('is empty and calm on an empty ledger', () => {
    const d = buildDashboard(input([]));
    expect(d.requests).toBe(0);
    expect(d.approved).toEqual({ count: 0, amount: 0 });
    expect(d.autoApprovedShare).toBeNull();
    expect(d.approvals.medianMs).toBeNull();
    expect(d.days).toHaveLength(7);
    expect(d.days.every((p) => p.total === 0)).toBe(true);
    expect(d.todayBudget).toEqual({ approved: 0, pending: 0, budget: 2_050_000 });
    expect(d.recent).toEqual([]);
  });

  it('puts payments on the local day, not the UTC day', () => {
    // 23:30 UTC on 19 Oct is 01:30 on 20 Oct in Zurich (CEST): inside the 7-day period.
    const inside = decision('p1', 'lab', '2026-10-19T23:30:00.000Z', 'approved', 1000);
    // 21:30 UTC on 19 Oct is 23:30 on 19 Oct in Zurich: one day before the period.
    const outside = decision('p2', 'lab', '2026-10-19T21:30:00.000Z', 'approved', 5000);
    const d = buildDashboard(input([outside, inside]));
    expect(d.approved).toEqual({ count: 1, amount: 1000 });
    expect(d.days[0]).toMatchObject({ date: '2026-10-20', total: 1000, approved: 1 });
  });

  it('folds human actions into the status before summing', () => {
    const e = [
      decision('a', 'lab', '2026-10-22T08:00:00.000Z', 'approved', 10_000),
      decision('r1', 'lab', '2026-10-22T09:00:00.000Z', 'review', 600_000),
      resolved('r1', 'lab', '2026-10-22T09:30:00.000Z', 'approved'),
      decision('r2', 'lab', '2026-10-23T09:00:00.000Z', 'review', 700_000),
      resolved('r2', 'lab', '2026-10-23T11:00:00.000Z', 'declined'),
      decision('c', 'office', '2026-10-23T10:00:00.000Z', 'approved', 4_000),
      cancelled('c', 'office', '2026-10-23T10:05:00.000Z'),
      decision('x', 'office', '2026-10-24T08:00:00.000Z', 'declined', 90_000, {
        rule: 'PER_PAYMENT_LIMIT',
      }),
      decision('w', 'lab', '2026-10-26T08:30:00.000Z', 'review', 550_000),
    ];
    const d = buildDashboard(input(e));
    // Approved: a + r1 (approved by a human). Not r2 (declined), c (cancelled), w (waiting).
    expect(d.approved).toEqual({ count: 2, amount: 610_000 });
    expect(d.requests).toBe(6);
    expect(d.autoApproved).toBe(2);
    expect(d.autoApprovedShare).toBeCloseTo(2 / 6);
    expect(d.declined).toEqual({ count: 1, amount: 90_000, unconverted: 0 });
    expect(d.declinesByRule).toEqual([
      {
        label: 'Per-payment limit',
        rules: ['PER_PAYMENT_LIMIT'],
        count: 1,
        amount: 90_000,
        unconverted: 0,
      },
    ]);
    expect(d.cancelled).toEqual({ count: 1, amount: 4_000 });
    expect(d.pending).toEqual({ count: 1, amount: 550_000 });
    expect(d.approvals).toEqual({
      decided: 2,
      approved: 1,
      declined: 1,
      medianMs: Math.round((30 * MINUTE + 120 * MINUTE) / 2),
    });
    // The engine said review for three, whatever the human did later.
    expect(d.days.reduce((s, p) => s + p.review, 0)).toBe(3);
    expect(d.days.find((p) => p.date === '2026-10-22')?.byAgent).toEqual({ lab: 610_000 });
    expect(d.topSuppliers).toEqual([
      { merchant: 'Example Reagents AG', count: 2, amount: 610_000 },
    ]);
    expect(d.activeAgents).toBe(2);
    // Today: w is waiting for approval and counts against the budget, like the engine does.
    expect(d.todayBudget).toEqual({ approved: 0, pending: 550_000, budget: 2_050_000 });
    expect(d.recent[0]).toMatchObject({ kind: 'decision', paymentId: 'w', status: 'review' });
    expect(d.recent.find((a) => a.kind === 'cancelled')).toMatchObject({
      paymentId: 'c',
      by: 'Approver',
    });
  });

  it('filters by agent everywhere, including budgets and activity', () => {
    const e = [
      decision('a', 'lab', '2026-10-26T08:00:00.000Z', 'approved', 10_000),
      decision('b', 'office', '2026-10-26T08:10:00.000Z', 'approved', 3_000),
      decision('c', 'office', '2026-10-26T08:20:00.000Z', 'declined', 99_000, {
        rule: 'DAILY_BUDGET',
      }),
      entry('control.kill_switch', '*', '2026-10-26T08:30:00.000Z', { on: true, by: 'Approver' }),
    ];
    const d = buildDashboard(input(e, { agentId: 'office', period: 'today' }));
    expect(d.approved).toEqual({ count: 1, amount: 3_000 });
    expect(d.declined.count).toBe(1);
    expect(d.totalAgents).toBe(1);
    expect(d.budgetToday.map((b) => b.agentId)).toEqual(['office']);
    expect(d.todayBudget).toEqual({ approved: 3_000, pending: 0, budget: 50_000 });
    // The kill switch concerns every agent, so it shows under any filter.
    expect(d.recent.map((a) => a.kind)).toEqual(['kill_switch', 'decision', 'decision']);
    expect(d.recent.some((a) => a.agentId === 'lab')).toBe(false);
  });

  it('counts a human decision in the period it happened, and keeps old requests out', () => {
    const e = [
      decision('old', 'lab', '2026-10-25T16:00:00.000Z', 'review', 600_000),
      resolved('old', 'lab', '2026-10-26T07:30:00.000Z', 'approved'),
    ];
    const today = buildDashboard(input(e, { period: 'today' }));
    expect(today.requests).toBe(0);
    expect(today.approved.count).toBe(0);
    expect(today.approvals.decided).toBe(1);
    expect(today.recent.map((a) => a.kind)).toEqual(['resolved']);
  });

  it('charts today by local hour', () => {
    const e = [decision('a', 'lab', '2026-10-26T08:15:00.000Z', 'approved', 10_000)];
    const d = buildDashboard(input(e, { period: 'today' }));
    expect(d.unit).toBe('hour');
    expect(d.days).toHaveLength(24);
    expect(d.days.find((p) => p.total > 0)).toMatchObject({ date: '09', total: 10_000 });
  });

  it('counts a request stopped before the amount rule at its base-currency amount', () => {
    const stopped = entry('payment.decision', 'lab', '2026-10-26T08:00:00.000Z', {
      payment_id: 'k',
      request: { merchant: 'X', amount: 12_000, currency: 'CHF', category: '5169', country: 'CH' },
      decision: 'declined',
      rule: 'KILL_SWITCH',
      reason: 'test',
      amount_base: null,
      base_currency: 'CHF',
      cancellable_until: null,
    });
    const eur = entry('payment.decision', 'lab', '2026-10-26T08:01:00.000Z', {
      payment_id: 'e',
      request: { merchant: 'X', amount: 5_000, currency: 'EUR', category: '5169', country: 'DE' },
      decision: 'declined',
      rule: 'KYA_CREDENTIAL',
      reason: 'test',
      amount_base: null,
      base_currency: 'CHF',
      cancellable_until: null,
    });
    // No policy passed: the EUR request has no rate here, so it is counted but not summed.
    const d = buildDashboard(input([stopped, eur], { period: 'today' }));
    expect(d.declined).toEqual({ count: 2, amount: 12_000, unconverted: 1 });
  });

  it('converts a foreign-currency decline through the mandate fx table, rounding up', () => {
    const e = [
      // 10.01 EUR at 0.93 = 9.3093 CHF: rounded up to 9.31, like the engine.
      foreignDecline('e', '2026-10-26T08:00:00.000Z', 1_001, 'EUR', 'CURRENCY'),
      // No rate for JPY: counted, never silently summed or dropped.
      foreignDecline('j', '2026-10-26T08:01:00.000Z', 5_000, 'JPY', 'CURRENCY'),
      foreignDecline('k', '2026-10-26T08:02:00.000Z', 7_000, 'JPY', 'KILL_SWITCH'),
      decision('c', 'lab', '2026-10-26T08:03:00.000Z', 'declined', 300_000, {
        rule: 'CURRENCY',
      }),
    ];
    const d = buildDashboard(input(e, { period: 'today', policy: POLICY }));
    expect(d.declined).toEqual({ count: 4, amount: 300_931, unconverted: 2 });
    expect(d.declinesByRule).toEqual([
      {
        label: 'Currency not allowed',
        rules: ['CURRENCY'],
        count: 3,
        amount: 300_931,
        unconverted: 1,
      },
      {
        label: 'Kill switch or frozen agent',
        rules: ['KILL_SWITCH'],
        count: 1,
        amount: 0,
        unconverted: 1,
      },
    ]);
  });

  it('does not convert with a mandate whose base currency changed since the request', () => {
    const e = [foreignDecline('e', '2026-10-26T08:00:00.000Z', 1_000, 'EUR', 'CURRENCY')];
    const d = buildDashboard(
      input(e, { period: 'today', policy: { ...POLICY, baseCurrency: 'EUR' } }),
    );
    expect(d.declined).toEqual({ count: 1, amount: 0, unconverted: 1 });
  });

  it('exports only the entries of the visible period and agent', () => {
    const e = [
      decision('old', 'lab', '2026-09-01T08:00:00.000Z', 'approved', 1),
      decision('a', 'lab', '2026-10-26T08:00:00.000Z', 'review', 600_000),
      resolved('a', 'lab', '2026-10-26T08:10:00.000Z', 'approved'),
      decision('b', 'office', '2026-10-26T08:20:00.000Z', 'approved', 3_000),
      entry('config.updated', '*', '2026-10-26T08:30:00.000Z', { by: 'x' }),
    ];
    const ids = (list: StoredEntry[]) => list.map((x) => x.seq);
    const all = periodEntries(input(e, { period: '7d' }));
    expect(ids(all)).toEqual([e[1], e[2], e[3]].map((x) => x?.seq));
    const lab = periodEntries(input(e, { period: '90d', agentId: 'lab' }));
    expect(ids(lab)).toEqual([e[0], e[1], e[2]].map((x) => x?.seq));
  });
});

describe('agent series and filters', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `a${String(i)}`, name: `Agent ${String(i)}` }));

  it('gives the first eight agents their own colour slot', () => {
    const g = spendGroups(many(8), null);
    expect(g.map((x) => x.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(g.every((x) => x.agentIds.length === 1)).toBe(true);
  });

  it('groups agents past the colour slots as one "Other agents" series', () => {
    const g = spendGroups(many(11), null);
    expect(g).toHaveLength(AGENT_SLOTS + 1);
    expect(g.at(-1)).toEqual({
      key: OTHER_AGENTS,
      label: 'Other agents (3)',
      slot: null,
      agentIds: ['a8', 'a9', 'a10'],
    });
    // Every series looks different: distinct slots, and only one without a slot.
    const slots = g.map((x) => x.slot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('keeps a single extra agent as its own grey series', () => {
    const g = spendGroups(many(9), null);
    expect(g.at(-1)).toEqual({ key: 'a8', label: 'Agent 8', slot: null, agentIds: ['a8'] });
  });

  it('shows only the filtered agent, keeping its colour slot', () => {
    expect(spendGroups(many(11), 'a3')).toEqual([
      { key: 'a3', label: 'Agent 3', slot: 3, agentIds: ['a3'] },
    ]);
    expect(spendGroups(many(11), 'a9')[0]?.slot).toBeNull();
  });

  it('filters approval and cooling-off items by agent', () => {
    const items = [{ agentId: 'lab' }, { agentId: 'office' }, { agentId: 'lab' }];
    expect(forAgent(items, null)).toHaveLength(3);
    expect(forAgent(items, 'office')).toEqual([{ agentId: 'office' }]);
    expect(forAgent(items, 'nobody')).toEqual([]);
  });
});

describe('the value report', () => {
  const fmt = (minor: number) => `CHF ${(minor / 100).toFixed(2)}`;

  /** A review flagged by the fair-price rule: `difference` above the usual price. */
  function overpriced(id: string, at: string, amount: number, difference: number): StoredEntry {
    return entry('payment.decision', 'lab', at, {
      payment_id: id,
      request: { merchant: 'Pricey AG', amount, currency: 'CHF', category: '5169', country: 'CH' },
      decision: 'review',
      rule: 'FAIR_PRICE',
      reason: 'test',
      amount_base: amount,
      base_currency: 'CHF',
      cancellable_until: null,
      trace: [
        {
          rule: 'FAIR_PRICE',
          outcome: 'review',
          data: { matched: true, differenceBase: difference },
        },
      ],
    });
  }

  it('sorts decline rules into plain categories, new budget rules included', () => {
    expect(stopCategory('SUPPLIER')).toBe('blocked');
    expect(stopCategory('COUNTRY')).toBe('blocked');
    expect(stopCategory('DAILY_BUDGET')).toBe('limit');
    expect(stopCategory('PER_PAYMENT_LIMIT')).toBe('limit');
    expect(stopCategory('MONTHLY_BUDGET')).toBe('limit');
    expect(stopCategory('PROJECT_BUDGET')).toBe('limit');
    expect(stopCategory('SPLIT_DETECTION')).toBe('split');
    expect(stopCategory('CATEGORY')).toBe('category');
    expect(stopCategory('KILL_SWITCH')).toBe('stopped');
    expect(stopCategory('AGENT_STATUS')).toBe('stopped');
    expect(stopCategory('KYA_CREDENTIAL')).toBe('credential');
    expect(stopCategory('BUSINESS_HOURS')).toBe('other');
    expect(stopCategory(null)).toBe('other');
  });

  it('counts working days, Monday to Friday, never fewer than one', () => {
    // Tue 20 Oct to Mon 26 Oct 2026: Tue, Wed, Thu, Fri, Mon.
    expect(workingDays('2026-10-20', '2026-10-26')).toBe(5);
    expect(workingDays('2026-10-24', '2026-10-25')).toBe(1);
    expect(workingDays('2026-10-26', '2026-10-26')).toBe(1);
  });

  it('is calm on an empty ledger', () => {
    const r = buildValueReport(buildDashboard(input([])));
    expect(r).toMatchObject({ requests: 0, autoDecided: 0, sentToHuman: 0, minutesSaved: 0 });
    expect(r.stopped.byCategory).toEqual([]);
    expect(r.agents.every((a) => a.perWorkingDay === 0 && !a.oftenNearDaily)).toBe(true);
    expect(valueSummary(r, 'the last 7 days', fmt)).toBe(
      'In the last 7 days no agent asked Flow-E for a payment.',
    );
  });

  it('adds up what Flow-E decided, stopped and avoided', () => {
    const e = [
      decision('a', 'lab', '2026-10-22T08:00:00.000Z', 'approved', 10_000),
      decision('r1', 'lab', '2026-10-22T09:00:00.000Z', 'review', 600_000),
      resolved('r1', 'lab', '2026-10-22T09:30:00.000Z', 'approved'),
      decision('s1', 'lab', '2026-10-22T10:00:00.000Z', 'declined', 5_000, { rule: 'SUPPLIER' }),
      decision('s2', 'lab', '2026-10-22T10:05:00.000Z', 'declined', 6_000, { rule: 'COUNTRY' }),
      decision('d1', 'office', '2026-10-23T10:00:00.000Z', 'declined', 90_000, {
        rule: 'DAILY_BUDGET',
      }),
      decision('k1', 'office', '2026-10-23T11:00:00.000Z', 'declined', 1_000, {
        rule: 'KILL_SWITCH',
      }),
      overpriced('fp', '2026-10-23T12:00:00.000Z', 31_000, 21_000),
      resolved('fp', 'lab', '2026-10-23T12:30:00.000Z', 'declined'),
    ];
    const r = buildValueReport(buildDashboard(input(e)));
    expect(r.requests).toBe(7);
    expect(r.sentToHuman).toBe(2);
    expect(r.autoDecided).toBe(5);
    expect(r.minutesPerApproval).toBe(MINUTES_PER_APPROVAL);
    expect(r.minutesSaved).toBe(5 * MINUTES_PER_APPROVAL);
    expect(r.stopped.count).toBe(4);
    expect(r.stopped.byCategory.map((c) => [c.category, c.count, c.amount])).toEqual([
      ['blocked', 2, 11_000],
      ['limit', 1, 90_000],
      ['stopped', 1, 1_000],
    ]);
    expect(r.overpaymentAvoided).toEqual({ count: 1, over: 21_000 });
    expect(valueSummary(r, 'the last 7 days', fmt)).toBe(
      'In the last 7 days Flow-E decided 5 of 7 requests on its own, stopped 4 risky purchases and avoided CHF 210.00 of overpayment.',
    );
  });

  it('writes the sentence without the parts that are zero', () => {
    const e = [decision('a', 'lab', '2026-10-26T08:00:00.000Z', 'approved', 10_000)];
    const r = buildValueReport(buildDashboard(input(e, { period: 'today' })));
    expect(valueSummary(r, 'today', fmt)).toBe('Today Flow-E decided 1 of 1 request on its own.');
  });

  it('averages approved spend per working day and flags agents near their daily budget', () => {
    // Office (daily budget 500.00) spends 450.00 on each of five working days: 90% of budget.
    const days = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'];
    const e = [
      ...days.map((d, i) =>
        decision(`o${String(i)}`, 'office', `${d}T08:00:00.000Z`, 'approved', 45_000),
      ),
      decision('l1', 'lab', '2026-10-22T08:00:00.000Z', 'approved', 100_000),
    ];
    const r = buildValueReport(buildDashboard(input(e)));
    expect(r.workingDays).toBe(5);
    const office = r.agents.find((a) => a.agentId === 'office');
    const lab = r.agents.find((a) => a.agentId === 'lab');
    expect(office).toMatchObject({
      approved: 225_000,
      perWorkingDay: 45_000,
      oftenNearDaily: true,
    });
    expect(office?.dailyShare).toBeCloseTo(0.9);
    expect(lab).toMatchObject({ approved: 100_000, perWorkingDay: 20_000, oftenNearDaily: false });
  });

  it('follows the agent filter', () => {
    const e = [
      decision('l', 'lab', '2026-10-22T08:00:00.000Z', 'declined', 5_000, { rule: 'CATEGORY' }),
      decision('o', 'office', '2026-10-22T09:00:00.000Z', 'declined', 5_000, {
        rule: 'SPLIT_DETECTION',
      }),
    ];
    const r = buildValueReport(buildDashboard(input(e, { agentId: 'office' })));
    expect(r.requests).toBe(1);
    expect(r.stopped.byCategory.map((c) => c.category)).toEqual(['split']);
    expect(r.agents.map((a) => a.agentId)).toEqual(['office']);
  });

  it('writes approval work in minutes or hours', () => {
    expect(workSaved(0)).toBe('≈ 0 min');
    expect(workSaved(48)).toBe('≈ 48 min');
    expect(workSaved(256)).toBe('≈ 4.3 h');
    expect(workSaved(1_560)).toBe('≈ 26 h');
  });
});
