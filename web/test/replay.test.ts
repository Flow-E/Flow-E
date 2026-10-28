import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfigObject } from '@flow-e/mcp/core';
import { replay } from '@/server/replay';
import { ALICE, ORIGIN, request, world, type World } from './org-helpers';

const HOUR = 3_600_000;

describe('what-if replay', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    // Three requests over three hours: CHF 100 and 300 approved, CHF 800 to a person.
    for (const amount of ['100', '300', '800']) {
      await w.store.requestPayment(w.auth, request(amount), ORIGIN);
      w.clock.now += HOUR;
    }
  });
  afterEach(async () => {
    await w.close();
  });

  async function proposed(
    edit: (agent: Record<string, unknown>, raw: Record<string, unknown>) => void,
  ) {
    const view = await w.store.view(w.orgId, ALICE);
    const raw = structuredClone(view.raw) as { agents: Record<string, Record<string, unknown>> };
    const agent = raw.agents.buyer;
    if (!agent) throw new Error('no buyer');
    edit(agent, raw);
    return { view, config: parseConfigObject(raw) };
  }

  function deepFreeze<T>(x: T): T {
    if (x && typeof x === 'object') {
      for (const v of Object.values(x)) deepFreeze(v);
      Object.freeze(x);
    }
    return x;
  }

  it('decides everything the same way with unchanged rules', async () => {
    const { view, config } = await proposed(() => undefined);
    const r = replay({ entries: view.entries, proposed: config, now: w.clock.now });
    expect(r.requests).toBe(3);
    expect(r.changes).toHaveLength(0);
    expect(r.after).toEqual(r.before);
    expect(r.before).toMatchObject({ approved: 2, review: 1, declined: 0, approvedAmount: 40_000 });
  });

  it('shows what a lower approval threshold would send to a person', async () => {
    const { view, config } = await proposed((a) => {
      a.approval_above = '200';
    });
    const r = replay({ entries: view.entries, proposed: config, now: w.clock.now });
    expect(r.after).toMatchObject({ approved: 1, review: 2, approvedAmount: 10_000 });
    expect(r.changes).toEqual([
      expect.objectContaining({ amountBase: 30_000, before: 'approved', after: 'review' }),
    ]);
  });

  it('counts declines from a tighter budget in order, as the engine would have', async () => {
    const { view, config } = await proposed((a) => {
      a.daily_budget = '350';
    });
    const r = replay({ entries: view.entries, proposed: config, now: w.clock.now });
    // 100 fits; 300 would push the day to 400; 800 is over the limit too.
    expect(r.after).toMatchObject({ approved: 1, review: 0, declined: 2 });
    expect(r.changes.map((c) => c.reason)).toEqual([
      expect.stringMatching(/today's remaining budget/),
      expect.stringMatching(/today's remaining budget/),
    ]);
  });

  it('only replays the chosen number of days', async () => {
    const { view, config } = await proposed(() => undefined);
    expect(
      replay({ entries: view.entries, proposed: config, now: w.clock.now + 40 * 24 * HOUR })
        .requests,
    ).toBe(0);
  });

  it('never writes: the ledger is unchanged and its entries are not touched', async () => {
    const { view, config } = await proposed((a) => {
      a.approval_above = '50';
      a.daily_budget = '150';
    });
    const before = await w.store.view(w.orgId, ALICE);
    const entries = deepFreeze(structuredClone(view.entries));
    const r = replay({ entries, proposed: config, now: w.clock.now });
    expect(r.changes.length).toBeGreaterThan(0);
    const after = await w.store.view(w.orgId, ALICE);
    expect(after.entries).toEqual(before.entries);
    expect(after.raw).toEqual(before.raw);
  });

  it('counts requests decided before the fair-price check as inexact, only when prices are set', async () => {
    const { view, config } = await proposed((_a, raw) => {
      raw.reference_prices = [{ item: 'Pipette tips', match: ['tips'], price: '50' }];
    });
    // Pretend the first request was decided before the fair-price check existed.
    let first = true;
    const entries = view.entries.map((e) => {
      if (e.type !== 'payment.decision' || !first) return e;
      first = false;
      const data = JSON.parse(e.data) as { trace: { rule: string }[] };
      data.trace = data.trace.filter((t) => t.rule !== 'FAIR_PRICE');
      return { ...e, data: JSON.stringify(data) };
    });
    expect(replay({ entries, proposed: config, now: w.clock.now }).inexact).toBe(1);
    const plain = (await proposed(() => undefined)).config;
    expect(replay({ entries, proposed: plain, now: w.clock.now })).toMatchObject({
      inexact: 0,
      kept: 0,
    });
  });

  it('keeps decisions no mandate can change, such as the kill switch, and counts them', async () => {
    await w.store.setKillSwitch(w.orgId, ALICE, true);
    await w.store.requestPayment(w.auth, request('100'), ORIGIN).catch(() => undefined);
    const { view, config } = await proposed((a) => {
      a.approval_above = '10';
    });
    const r = replay({ entries: view.entries, proposed: config, now: w.clock.now + HOUR });
    expect(r.kept).toBe(1);
    expect(r.changes.every((c) => c.before !== 'declined')).toBe(true);
  });
});
