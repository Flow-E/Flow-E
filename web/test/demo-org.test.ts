import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foldInvoices } from '@flow-e/mcp/core';
import { buildDashboard } from '@/server/analytics';
import { migrate, openPglite, type Db } from '@/server/db';
import { DEMO_ORG_NAME, leaveDemoOrgs, seedDemoOrg } from '@/server/demo-org';
import { OutboxMailer } from '@/server/email';
import { OrgStore, type OrgView } from '@/server/org-store';
import { ReorderStore } from '@/server/reorder';
import { replay } from '@/server/replay';
import { ALICE, MIGRATIONS } from './org-helpers';

/** Wednesday 28 Oct 2026, 11:00 in Zurich. */
const NOW = Date.parse('2026-10-28T10:00:00Z');

describe('Lab Alpha (fictional), the demo organisation', () => {
  let db: Db;
  let key: Buffer;
  let orgId: string;
  let view: OrgView;
  let store: OrgStore;

  beforeAll(async () => {
    db = await openPglite();
    await migrate(db, MIGRATIONS);
    key = randomBytes(32);
    orgId = await seedDemoOrg({ db, encryptionKey: key, user: ALICE, now: NOW });
    store = new OrgStore(db, key, new OutboxMailer(db, { NODE_ENV: 'test' }), { clock: () => NOW });
    view = await store.view(orgId, ALICE);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it('is marked fictional in its first ledger entry, and its ledger is intact', () => {
    expect(view.name).toBe(DEMO_ORG_NAME);
    expect(view.demo).toBe(true);
    expect(view.audit.ok).toBe(true);
    expect(view.agents.map((a) => a.id).sort()).toEqual(['lab-consumables', 'reagents']);
  });

  it('has 60 days of history with approvals, declines and requests waiting for a person', () => {
    const first = Date.parse(view.payments.at(-1)?.createdAt ?? '');
    expect(NOW - first).toBeGreaterThan(55 * 86_400_000);
    expect(view.payments.length).toBeGreaterThan(80);
    const by = (s: string) => view.payments.filter((p) => p.status === s).length;
    expect(by('approved')).toBeGreaterThan(50);
    expect(by('declined')).toBeGreaterThan(0);
    expect(view.pending.length).toBeGreaterThan(0);
    expect(view.payments.some((p) => p.fulfilment?.ordered)).toBe(true);
    // Every supplier is fictional.
    expect(new Set(view.payments.map((p) => p.request.merchant))).toEqual(
      new Set(
        [...view.payments.map((p) => p.request.merchant)].filter((m) => m.startsWith('Example ')),
      ),
    );
  });

  it('has invoice mismatches, one without authorization and a duplicate', () => {
    const inv = foldInvoices(view.entries);
    const count = (m: string) => inv.filter((i) => i.match === m).length;
    expect(count('matched')).toBeGreaterThan(5);
    expect(count('mismatch')).toBeGreaterThan(0);
    expect(count('unmatched')).toBe(1);
    expect(count('duplicate')).toBe(1);
  });

  it('gives the replay and the dashboard meaningful numbers', () => {
    const r = replay({
      entries: view.entries,
      proposed: {
        ...view.config,
        agents: Object.fromEntries(
          Object.entries(view.config.agents).map(([id, a]) => [
            id,
            { ...a, mandate: { ...a.mandate, approvalAbove: 50_000 } },
          ]),
        ),
      },
      now: NOW,
    });
    expect(r.requests).toBeGreaterThan(40);
    expect(r.after.review).toBeGreaterThan(r.before.review);
    const dash = buildDashboard({
      entries: view.entries,
      agents: view.agents.map((a) => ({
        id: a.id,
        name: a.displayName,
        dailyBudget: a.today.budget,
      })),
      timezone: view.timezone,
      now: NOW,
      period: '30d',
      agentId: null,
      policy: view.config.policy,
    });
    expect(dash.priceCheck.checked).toBeGreaterThan(20);
  });

  it('comes with a reorder list whose run shows a decline, the hint and the corrected request', async () => {
    const reorder = new ReorderStore(db, store, { clock: () => NOW });
    const items = await reorder.items(orgId, ALICE);
    expect(items.map((i) => i.item)).toContain('PCR master mix, 10 kits');
    const run = await reorder.run(orgId, ALICE, {
      agentId: 'lab-consumables',
      origin: 'http://localhost',
      callModel: null,
    });
    const text = run.log.map((l) => l.text).join('\n');
    expect(text).toMatch(/Petri dishes, 500 from Example Discount Supplies GmbH .*: declined/);
    expect(text).toMatch(/Followed Flow-E's hint: ask Example Labware AG/);
    expect(text).toMatch(/Petri dishes, 500 from Example Labware AG .*: approved/);
  });

  it('reset: the admin leaves the old one; others are untouched', async () => {
    const other = await store.createOrg(ALICE, {
      name: DEMO_ORG_NAME, // same name, but not a demo: never removed
      baseCurrency: 'CHF',
      timezone: 'Europe/Zurich',
    });
    expect(await leaveDemoOrgs(db, ALICE)).toBe(1);
    const left = (await store.listOrgs(ALICE)).map((o) => o.id);
    expect(left).toContain(other);
    expect(left).not.toContain(orgId);
  });
});
