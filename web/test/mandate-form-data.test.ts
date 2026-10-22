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

  it('explains a malformed exchange-rate line', () => {
    const f = new FormData();
    f.set('fx_lines', 'EUR');
    expect(() => rawFromForm(f, { base_currency: 'CHF' })).toThrow(FormProblem);
  });
});
