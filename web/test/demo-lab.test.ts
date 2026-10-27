import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG } from '@flow-e/mcp/core';
import { DEMO_LAB_AGENT, DEMO_LAB_NAME, createDemoLab, demoLabPrompt } from '@/server/demo-lab';
import { DAVE, ORIGIN, world, type World } from './org-helpers';

describe('demo lab organisation', () => {
  let w: World;
  let orgId: string;
  beforeAll(async () => {
    w = await world();
    orgId = await createDemoLab(w.store, DAVE);
  });
  afterAll(async () => {
    await w.close();
  });

  it('is a fictional lab owned by its creator, with an empty ledger', async () => {
    const view = await w.store.view(orgId, DAVE);
    expect(view.name).toBe(DEMO_LAB_NAME);
    expect(view.role).toBe('owner');
    expect(view.agents.map((a) => a.id)).toEqual([DEMO_LAB_AGENT]);
    expect(view.payments).toHaveLength(0);
  });

  it('decides the catalog the way the demo script says', async () => {
    const { key } = await w.store.createKey(orgId, DAVE, DEMO_LAB_AGENT, { expiresInDays: 30 });
    const auth = await w.store.authenticateAgent(key);
    if (!auth) throw new Error('key did not authenticate');
    const decide = async (n: number) => {
      const c = CATALOG[n - 1];
      if (!c) throw new Error(`no catalog item ${String(n)}`);
      const r = await w.store.requestPayment(
        auth,
        {
          merchant: c.supplier,
          amount: c.price,
          currency: c.currency,
          category: c.category,
          country: c.country,
        },
        ORIGIN,
      );
      return r.decision;
    };
    expect(await decide(1)).toBe('declined'); // blocked supplier
    expect(await decide(2)).toBe('approved');
    expect(await decide(3)).toBe('review'); // CHF 6,500, above CHF 5,000
    expect(await decide(4)).toBe('declined'); // CHF 9,000, above the per-payment limit
    expect(await decide(5)).toBe('declined'); // not an approved supplier
    expect(await decide(6)).toBe('approved');
  });

  it('gives Claude a prompt with the whole catalog', () => {
    const prompt = demoLabPrompt();
    expect(prompt).toContain('flow-e tools');
    for (const c of CATALOG) expect(prompt).toContain(c.supplier);
  });
});
