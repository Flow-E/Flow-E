import { describe, expect, it } from 'vitest';
import type { StoredEntry } from '@flow-e/mcp/core';
import {
  addDays,
  buildDashboard,
  median,
  parseAgent,
  parsePeriod,
  periodDays,
  periodEntries,
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
    expect(d.declined).toEqual({ count: 1, amount: 90_000 });
    expect(d.declinesByRule).toEqual([
      { label: 'Per-payment limit', rules: ['PER_PAYMENT_LIMIT'], count: 1, amount: 90_000 },
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
    const d = buildDashboard(input([stopped, eur], { period: 'today' }));
    expect(d.declined).toEqual({ count: 2, amount: 12_000 });
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
