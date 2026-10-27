import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FormProblem, mandateFields, rawFromForm } from '@/lib/mandate-form-data';
import { ALICE, world, type World } from './org-helpers';

/** A form as the browser would submit it from the mandate page's values. */
function formFrom(raw: Record<string, unknown>, edit: (f: FormData) => void = () => undefined) {
  const v = mandateFields(raw, String(raw.base_currency));
  const f = new FormData();
  f.set('timezone', v.timezone);
  f.set('fx_lines', v.fx.map(([c, r]) => `${c} ${r}`).join('\n'));
  f.set('blocked_countries', v.blocked_countries);
  f.set('blocked_suppliers', v.blocked_suppliers);
  for (const d of v.days) f.append('days', String(d));
  f.set('start', v.start);
  f.set('end', v.end);
  f.set('prices', v.prices);
  f.set('above_percent', v.above_percent);
  f.set('below_percent', v.below_percent);
  f.set('price_action', v.price_action);
  for (const a of v.agents) {
    f.append('agent', a.id);
    for (const [k, val] of Object.entries(a) as [string, string | boolean][]) {
      if (k === 'id') continue;
      if (typeof val === 'boolean') {
        if (val) f.set(`${a.id}.${k}`, 'on');
      } else {
        f.set(`${a.id}.${k}`, val);
      }
    }
  }
  edit(f);
  return f;
}

describe('the organisation mandate form', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it('saves unchanged without a ledger entry, and records only what changed', async () => {
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    const before = (await w.store.view(w.orgId, ALICE)).entries.length;
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(formFrom(raw), raw));
    expect((await w.store.view(w.orgId, ALICE)).entries).toHaveLength(before);

    const edited = formFrom(raw, (f) => {
      f.set('fx_lines', 'EUR 0.94');
      f.set('buyer.currencies', 'CHF, EUR');
    });
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(edited, raw));
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.config.policy.fx).toEqual({ EUR: '0.94' });
    expect(v.config.agents.buyer?.mandate.currencies).toEqual(['CHF', 'EUR']);
    expect(JSON.parse(v.entries.at(-1)?.data ?? '{}')).toMatchObject({
      changes: ['agents.buyer', 'fx'],
    });
  });

  it('saves usual prices from lines and shows them back the same way', async () => {
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    const lines =
      'Phosphate buffer solution, 10 L | 1150 | phosphate buffer\nNitrile gloves | 22 |  | box';
    const edited = formFrom(raw, (f) => {
      f.set('prices', lines);
      f.set('above_percent', '15');
      f.set('below_percent', '');
      f.set('price_action', 'decline');
    });
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(edited, raw));
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.config.policy.referencePrices).toEqual([
      {
        item: 'Phosphate buffer solution, 10 L',
        match: ['phosphate buffer'],
        priceMinor: 115_000,
        currency: 'CHF',
      },
      { item: 'Nitrile gloves', match: [], priceMinor: 2_200, currency: 'CHF', unit: 'box' },
    ]);
    expect(v.config.policy.priceCheck).toEqual({
      abovePercent: 15,
      belowPercent: null,
      above: 'decline',
    });
    const shown = mandateFields(v.raw, 'CHF');
    expect(shown.prices).toBe(lines);
    expect(shown).toMatchObject({
      above_percent: '15',
      below_percent: '',
      price_action: 'decline',
    });
  });

  it('explains a malformed usual-price line', () => {
    const f = new FormData();
    f.set('prices', 'Gloves without a price');
    expect(() => rawFromForm(f, { base_currency: 'CHF' })).toThrow(/Item \| price/);
  });

  it('explains a malformed exchange-rate line', () => {
    const f = new FormData();
    f.set('fx_lines', 'EUR');
    expect(() => rawFromForm(f, { base_currency: 'CHF' })).toThrow(FormProblem);
  });
});
