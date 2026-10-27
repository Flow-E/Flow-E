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

  async function proposed(edit: (agent: Record<string, unknown>) => void) {
    const view = await w.store.view(w.orgId, ALICE);
    const raw = structuredClone(view.raw) as { agents: Record<string, Record<string, unknown>> };
    const agent = raw.agents.buyer;
    if (!agent) throw new Error('no buyer');
    edit(agent);
    return { view, config: parseConfigObject(raw) };
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
});
