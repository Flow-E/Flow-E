import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MINUTES_PER_APPROVAL, parseMinutes, workSaved } from '@/server/analytics';
import { budgetOutlook } from '@/server/budget-outlook';
import { valueReportData } from '@/server/value-report';
import { ALICE, BOB, ORIGIN, request, world, type World } from './org-helpers';

const MINUTE = 60_000;

/**
 * A fixed ledger with known numbers. Wednesday 21 Oct 2026 (day 21 of the month), one agent:
 * daily budget CHF 100,000, per payment CHF 50,000, approval above CHF 500, monthly budget
 * CHF 1,500, project "Grant SNF-1" with CHF 3,000 in total, pipette tips usually CHF 100.
 *
 * 1. CHF 100 glassware, project  → approved
 * 2. CHF 300 glassware, project  → approved
 * 3. CHF 800                     → to a person (above the threshold), still waiting
 * 4. CHF 200 pipette tips        → to a person (twice the usual price), declined by Bob
 * 5. CHF 60,000                  → declined (over the per-payment limit)
 *
 * Invoices: CHF 150 for payment 1 (mismatch, CHF 50 too much); one with no authorization.
 */
describe('value report on a fixed ledger', () => {
  let w: World;
  let data: ReturnType<typeof valueReportData>;
  let config: Awaited<ReturnType<World['store']['view']>>['config'];
  let entries: Awaited<ReturnType<World['store']['view']>>['entries'];

  beforeAll(async () => {
    w = await world();
    const view = await w.store.view(w.orgId, ALICE);
    const raw = structuredClone(view.raw) as Record<string, unknown> & {
      agents: Record<string, Record<string, unknown>>;
    };
    raw.reference_prices = [{ item: 'Pipette tips', match: ['pipette tips'], price: '100' }];
    raw.projects = { 'snf-1': { name: 'Grant SNF-1', budget: '3000', period: 'total' } };
    const buyer = raw.agents.buyer;
    if (!buyer) throw new Error('no buyer');
    buyer.monthly_budget = '1500';
    await w.store.updateConfig(w.orgId, ALICE, raw);

    const ask = async (r: Record<string, unknown>) => {
      w.clock.now += MINUTE;
      return w.store.requestPayment(w.auth, r as ReturnType<typeof request>, ORIGIN);
    };
    const first = await ask({
      ...request('100', 'Example Labware AG'),
      item: 'Glassware',
      project: 'snf-1',
    });
    await ask({ ...request('300'), item: 'Glassware', project: 'snf-1' });
    await ask(request('800'));
    const tips = await ask({ ...request('200'), item: 'Pipette tips' });
    await ask(request('60000'));
    expect(tips.decision).toBe('review');
    await w.store.resolve(w.orgId, BOB, tips.payment_id, 'declined', 'Too expensive');

    await w.store.addInvoice(w.orgId, BOB, {
      supplier: 'Example Labware AG',
      number: 'INV-1',
      invoiceDate: '2026-10-21',
      amount: '150.00',
      currency: 'CHF',
      reference: first.payment_id,
    });
    await w.store.addInvoice(w.orgId, BOB, {
      supplier: 'Example Unknown AG',
      number: 'X-9',
      invoiceDate: '2026-10-21',
      amount: '75.00',
      currency: 'CHF',
    });

    const after = await w.store.view(w.orgId, ALICE);
    config = after.config;
    entries = after.entries;
    data = valueReportData({
      entries,
      config,
      agents: [{ id: 'buyer', name: 'Lab buyer', dailyBudget: 10_000_000 }],
      timezone: after.timezone,
      now: w.clock.now,
      period: '30d',
      minutesPerApproval: 5,
    });
  });
  afterAll(async () => {
    await w.close();
  });

  it('counts decisions, the time estimate and its assumption', () => {
    expect(data.report).toMatchObject({
      requests: 5,
      autoDecided: 3,
      sentToHuman: 2,
      minutesPerApproval: 5,
      minutesSaved: 15,
    });
    expect(workSaved(data.report.minutesSaved)).toBe('≈ 15 min');
  });

  it('groups declines by reason and sums the overpayment avoided', () => {
    expect(data.report.stopped).toMatchObject({ count: 1, amount: 6_000_000 });
    expect(data.report.stopped.byCategory).toEqual([
      expect.objectContaining({ category: 'limit', count: 1, amount: 6_000_000 }),
    ]);
    // Pipette tips at CHF 200 against a usual CHF 100, declined by a person.
    expect(data.report.overpaymentAvoided).toEqual({ count: 1, over: 10_000 });
  });

  it('counts invoice mismatches caught and the amount billed above the authorization', () => {
    expect(data.report.invoices).toEqual({
      recorded: 2,
      matched: 0,
      mismatch: 1,
      unmatched: 1,
      duplicate: 0,
      overBilled: [{ currency: 'CHF', amount: 5_000 }],
    });
  });

  it('projects the run-out day of the monthly and project budgets', () => {
    const [month, grant] = data.outlook;
    // Approved CHF 400 + waiting CHF 800 = CHF 1,200 in 21 days: CHF 57.14 a day; the CHF 300
    // left lasts 5 more whole days.
    expect(month).toMatchObject({
      kind: 'month',
      label: 'Lab buyer',
      budget: 150_000,
      used: 120_000,
      remaining: 30_000,
      perDay: 5_714,
      runsOut: '2026-10-26',
      windowEnds: '2026-10-31',
    });
    // CHF 400 in the last 30 days: CHF 13.33 a day; CHF 2,600 left lasts 195 days.
    expect(grant).toMatchObject({
      kind: 'project',
      label: 'Grant SNF-1',
      budget: 300_000,
      used: 40_000,
      perDay: 1_333,
      runsOut: '2027-05-04',
      windowEnds: null,
    });
    expect(month?.method).toMatch(/21 days so far/);
  });

  it('a budget that lasts its window has no run-out day, and a used-up one runs out today', () => {
    const lasting = budgetOutlook({
      entries,
      config: {
        ...config,
        policy: {
          ...config.policy,
          projects: [
            {
              id: 'p',
              name: 'Short',
              budgetBase: 300_000,
              period: 'total',
              agents: [],
              ends: '2026-11-15',
            },
          ],
        },
        agents: {},
      },
      now: w.clock.now,
    });
    expect(lasting).toEqual([
      expect.objectContaining({ label: 'Short', used: 0, perDay: 0, runsOut: null }),
    ]);
    const used = budgetOutlook({
      entries,
      config: {
        ...config,
        agents: {
          buyer: {
            ...(config.agents.buyer ?? ({} as never)),
            mandate: { ...(config.agents.buyer?.mandate ?? ({} as never)), monthlyBudget: 100_000 },
          },
        },
        policy: { ...config.policy, projects: [] },
      },
      now: w.clock.now,
    });
    expect(used[0]).toMatchObject({ remaining: 0, runsOut: '2026-10-21' });
  });

  it('only accepts a sensible number of minutes', () => {
    expect(parseMinutes('7')).toBe(7);
    expect(parseMinutes('0')).toBe(0);
    expect(parseMinutes(['12'])).toBe(12);
    for (const bad of [undefined, '', '-1', '2.5', '121', 'abc', '9999']) {
      expect(parseMinutes(bad)).toBe(MINUTES_PER_APPROVAL);
    }
    expect(MINUTES_PER_APPROVAL).toBe(5);
  });
});
