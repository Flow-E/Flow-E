import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentChanges } from '@/lib/mandate-changes';
import {
  FormProblem,
  explainProblems,
  fieldKey,
  mandateFields,
  rawFromForm,
} from '@/lib/mandate-form-data';
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
  f.set('prices_shown', '1');
  v.prices.forEach((p, i) => {
    f.append('price.row', `r${String(i)}`);
    for (const [k, val] of Object.entries(p) as [string, string][]) {
      f.set(`price.r${String(i)}.${k}`, val);
    }
  });
  f.set('above_percent', v.above_percent);
  f.set('below_percent', v.below_percent);
  f.set('price_action', v.price_action);
  f.set('tolerance_percent', v.tolerance_percent);
  f.set('tolerance_min', v.tolerance_min);
  f.set('projects_shown', '1');
  v.projects.forEach((p, i) => {
    const k = `r${String(i)}`;
    f.append('project.row', k);
    f.set(`project.${k}.id`, p.id);
    f.set(`project.${k}.name`, p.name);
    f.set(`project.${k}.budget`, p.budget);
    f.set(`project.${k}.period`, p.period);
    f.set(`project.${k}.ends`, p.ends);
    for (const a of p.agents) f.append(`project.${k}.agents`, a);
  });
  for (const a of v.agents) {
    f.append('agent', a.id);
    f.set(`${a.id}.require_project.shown`, '1');
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

/** Add a project row to a form. */
function addProject(f: FormData, key: string, p: Record<string, string>, agents: string[] = []) {
  f.append('project.row', key);
  for (const [k, v] of Object.entries(p)) f.set(`project.${key}.${k}`, v);
  for (const a of agents) f.append(`project.${key}.agents`, a);
}

/** Add a usual-price row to a form. */
function addPrice(f: FormData, key: string, p: Record<string, string>) {
  f.append('price.row', key);
  for (const [k, v] of Object.entries(p)) f.set(`price.${key}.${k}`, v);
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

  it('round-trips projects, monthly budget, "must name a project" and the invoice tolerance', async () => {
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    const edited = formFrom(raw, (f) => {
      addProject(
        f,
        'r0',
        {
          id: 'lab-2027',
          name: 'New lab wing',
          budget: '25000',
          period: 'total',
          ends: '2027-06-30',
        },
        ['buyer'],
      );
      addProject(f, 'r1', {
        id: 'office',
        name: 'Office',
        budget: '500',
        period: 'month',
        ends: '',
      });
      addProject(f, 'r2', { id: '', name: '', budget: '', period: 'month', ends: '' }); // blank
      f.set('buyer.monthly_budget', '8000');
      f.set('buyer.require_project', 'on');
      f.set('tolerance_percent', '3.5');
      f.set('tolerance_min', '10');
    });
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(edited, raw));
    const v = await w.store.view(w.orgId, ALICE);
    // The database keeps projects in its own key order.
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...(v.config.policy.projects ?? [])].sort(byId)).toEqual([
      {
        id: 'lab-2027',
        name: 'New lab wing',
        budgetBase: 2_500_000,
        period: 'total',
        agents: ['buyer'],
        ends: '2027-06-30',
      },
      { id: 'office', name: 'Office', budgetBase: 50_000, period: 'month', agents: [] },
    ]);
    expect(v.config.agents.buyer?.mandate).toMatchObject({
      monthlyBudget: 800_000,
      requireProject: true,
    });
    expect(v.config.policy.invoiceCheck).toEqual({
      tolerancePercent: 3.5,
      toleranceMinBase: 1_000,
    });

    const shown = mandateFields(v.raw, 'CHF');
    expect([...shown.projects].sort(byId)).toEqual([
      {
        id: 'lab-2027',
        name: 'New lab wing',
        budget: '25000',
        period: 'total',
        ends: '2027-06-30',
        agents: ['buyer'],
      },
      { id: 'office', name: 'Office', budget: '500', period: 'month', ends: '', agents: [] },
    ]);
    expect(shown.agents[0]).toMatchObject({ monthly_budget: '8000', require_project: true });
    expect(shown).toMatchObject({ tolerance_percent: '3.5', tolerance_min: '10' });

    // Saving the page again unchanged adds nothing to the ledger.
    const count = v.entries.length;
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(formFrom(v.raw), v.raw));
    expect((await w.store.view(w.orgId, ALICE)).entries).toHaveLength(count);

    // Unticking "must name a project" and clearing the monthly budget turn them off.
    const off = formFrom(v.raw, (f) => {
      f.delete('buyer.require_project');
      f.set('buyer.monthly_budget', '');
    });
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(off, v.raw));
    expect((await w.store.view(w.orgId, ALICE)).config.agents.buyer?.mandate).toMatchObject({
      monthlyBudget: null,
      requireProject: false,
    });
  });

  it('keeps stored values the form does not show, and their stored form', async () => {
    const stored = {
      ...(await w.store.view(w.orgId, ALICE)).raw,
      reference_prices: [{ item: 'Gloves', price: 22, supplier: 'Example A' }],
      projects: { office: { name: 'Office', budget: 500, agents: ['buyer'] } },
      invoice_check: { tolerance_percent: 2, tolerance_min: 5 },
    };
    await w.store.updateConfig(w.orgId, ALICE, stored);
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    const count = (await w.store.view(w.orgId, ALICE)).entries.length;

    // The same values typed back keep numbers as numbers: nothing changes.
    const same = rawFromForm(formFrom(raw), raw);
    expect(same.reference_prices).toEqual(raw.reference_prices);
    expect(same.projects).toEqual(raw.projects);
    await w.store.updateConfig(w.orgId, ALICE, same);
    expect((await w.store.view(w.orgId, ALICE)).entries).toHaveLength(count);

    // A form without these sections (an older page) keeps them as stored.
    const partial = formFrom(raw, (f) => {
      for (const k of [...f.keys()]) {
        if (
          /^(price|project)|^(prices|projects)_shown$|^tolerance_|require_project|monthly_budget/.test(
            k,
          )
        ) {
          f.delete(k);
        }
      }
    });
    const kept = rawFromForm(partial, raw);
    expect(kept.reference_prices).toEqual(raw.reference_prices);
    expect(kept.projects).toEqual(raw.projects);
    expect(kept.invoice_check).toEqual(raw.invoice_check);
  });

  it('records each change with old and new values, shows it as a recent change, audit intact', async () => {
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    const edited = formFrom(raw, (f) => {
      f.set('buyer.daily_budget', '120000');
      f.set('tolerance_percent', '5');
      addPrice(f, 'r0', { item: 'Gloves', price: '22', supplier: 'Example A', unit: 'box' });
    });
    await w.store.updateConfig(w.orgId, ALICE, rawFromForm(edited, raw), 'New budget');
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.audit.ok).toBe(true);
    const data = JSON.parse(v.entries.at(-1)?.data ?? '{}') as { diff: unknown[] };
    expect(data.diff).toEqual(
      expect.arrayContaining([
        { path: 'agents.buyer.daily_budget', before: '100000', after: '120000' },
        {
          path: 'invoice_check',
          before: { tolerance_min: 5, tolerance_percent: 2 },
          after: { tolerance_min: 5, tolerance_percent: 5 },
        },
      ]),
    );

    const [latest] = recentChanges(v.entries);
    expect(latest).toMatchObject({ by: 'alice@example.com', note: 'New budget' });
    expect(latest?.lines).toEqual(
      expect.arrayContaining([
        { label: 'Agent buyer: daily budget', before: '100000', after: '120000' },
        { label: 'Usual prices', before: 'none', after: '1 usual price' },
        { label: 'Invoice tolerance', before: '2%, at least 5', after: '5%, at least 5' },
      ]),
    );
  });

  it('shows older entries, which name only the changed settings', () => {
    const entries = [
      {
        type: 'config.updated',
        created_at: '2026-10-01T10:00:00Z',
        data: JSON.stringify({ by: 'bob@example.com', changes: ['fx', 'agents.buyer'] }),
      },
      { type: 'payment.decision', created_at: '2026-10-02T10:00:00Z', data: '{}' },
    ];
    expect(recentChanges(entries)).toEqual([
      {
        at: '2026-10-01T10:00:00Z',
        by: 'bob@example.com',
        note: null,
        lines: [
          { label: 'Exchange rates', before: null, after: null },
          { label: 'Agent buyer', before: null, after: null },
        ],
      },
    ]);
  });

  it('explains what the core rejects in plain words, at the right field', async () => {
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    const edited = formFrom(raw, (f) => {
      f.set('buyer.monthly_budget', '12.345');
      f.set('buyer.require_project', 'on');
      addPrice(f, 'r0', { item: 'Gloves', price: '22', currency: 'USD' });
    });
    let message = '';
    try {
      await w.store.updateConfig(w.orgId, ALICE, rawFromForm(edited, raw));
    } catch (err) {
      message = (err as Error).message;
    }
    const problems = explainProblems(message);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Agent buyer: monthly budget',
          path: 'agents.buyer.monthly_budget',
        }),
        expect.objectContaining({
          label: 'Agent buyer: every purchase must name a project',
          message: 'No project is open to this agent',
        }),
        expect.objectContaining({
          label: 'Usual prices, row 1: currency',
          message: 'USD has no exchange rate. Add one under Exchange rates.',
        }),
      ]),
    );
    expect(fieldKey('agents.buyer.monthly_budget')).toBe('buyer.monthly_budget');
    expect(fieldKey('reference_prices[0].currency')).toBe('price#0.currency');
    expect(fieldKey('reference_prices[2].match')).toBe('price#2.keywords');
    expect(fieldKey('projects.lab.v2.budget')).toBe('project@lab.v2.budget');
    expect(fieldKey('projects.office')).toBe('project@office.id');
    expect(fieldKey('invoice_check.tolerance_min')).toBe('tolerance_min');

    // The schema's own wording ("✖ problem → at path") is made plain too.
    expect(
      explainProblems(
        'Not saved:\n✖ Too big: expected number to be <=50\n  → at invoice_check.tolerance_percent',
      ),
    ).toEqual([
      {
        label: 'Invoice tolerance (%)',
        message: 'Use 50 or less.',
        path: 'invoice_check.tolerance_percent',
      },
    ]);
    expect(explainProblems('Something went wrong.')).toEqual([
      { label: '', message: 'Something went wrong.', path: '' },
    ]);
  });

  it('names incomplete rows and numbers that are not numbers', () => {
    const f = new FormData();
    f.set('prices_shown', '1');
    addPrice(f, 'r0', { item: 'Gloves without a price', price: '' });
    addPrice(f, 'r1', { item: '', price: '', supplier: '', currency: '', unit: '', keywords: '' });
    f.set('projects_shown', '1');
    addProject(f, 'r0', { id: '', name: 'No id', budget: '5', period: 'month', ends: '' });
    f.set('tolerance_percent', 'two');
    f.set('tolerance_min', '5');
    f.append('agent', 'buyer');
    f.set('buyer.velocity_per_minute', 'ten');
    let message = '';
    try {
      rawFromForm(f, { base_currency: 'CHF' });
    } catch (err) {
      expect(err).toBeInstanceOf(FormProblem);
      message = (err as Error).message;
    }
    expect(explainProblems(message).map((p) => [fieldKey(p.path), p.message])).toEqual([
      ['buyer.velocity_per_minute', 'Use a whole number, e.g. 10.'],
      ['price#0.price', 'Enter the usual price.'],
      ['above_percent', 'Use a whole number, e.g. 10.'],
      ['tolerance_percent', 'Use a number, e.g. 20.'],
      ['project@(new).id', 'Give the project a short id, e.g. lab-2027.'],
    ]);
  });

  it('explains a malformed exchange-rate line', () => {
    const f = new FormData();
    f.set('fx_lines', 'EUR');
    expect(() => rawFromForm(f, { base_currency: 'CHF' })).toThrow(FormProblem);
  });
});
