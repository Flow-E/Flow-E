import 'server-only';
import { formatMoney } from '@flow-e/mcp/core';
import type { Db } from './db';
import type { Mailer } from './email';
import { OrgStore, type AgentAuth, type User } from './org-store';
import { ReorderStore } from './reorder';

/**
 * "Lab Alpha (fictional)": a demonstration organisation with 60 days of history, for the
 * what-if replay, the value report and live demos. Only admins (FLOWE_ADMIN_EMAILS) can create
 * it. It is marked fictional in its first ledger entry, so every page shows a banner that cannot
 * be removed.
 *
 * The history is real Flow-E activity, not inserted rows: a store whose clock walks through
 * the past 60 days makes every request through the agent tools, every approval, order and
 * invoice, so every entry is signed and hash-chained like any other. Deterministic: the same
 * `now` gives the same history. Nobody is emailed while it is built.
 */

export const DEMO_ORG_NAME = 'Lab Alpha (fictional)';
export const DEMO_DAYS = 60;
const DAY = 86_400_000;
const ORIGIN = 'https://flow-e.invalid';

const LABWARE = 'Example Labware AG';
const REAGENTS = 'Example Reagents AG';
const OUTSIDER = 'Example Discount Supplies GmbH';

interface Product {
  item: string;
  match: string;
  price: number;
  supplier: string;
  category: string;
}

const LAB_ITEMS: Product[] = [
  {
    item: 'Pipette tips, 20 racks',
    match: 'pipette tips',
    price: 310,
    supplier: LABWARE,
    category: '5047',
  },
  {
    item: 'Nitrile gloves, 10 boxes',
    match: 'nitrile gloves',
    price: 220,
    supplier: LABWARE,
    category: '5047',
  },
  {
    item: 'Centrifuge tubes, 2,000',
    match: 'centrifuge tubes',
    price: 260,
    supplier: LABWARE,
    category: '5047',
  },
  {
    item: 'Petri dishes, 500',
    match: 'petri dishes',
    price: 180,
    supplier: LABWARE,
    category: '5047',
  },
  {
    item: 'Serological pipettes, 200',
    match: 'serological pipettes',
    price: 150,
    supplier: LABWARE,
    category: '5047',
  },
];
const REAGENT_ITEMS: Product[] = [
  {
    item: 'Phosphate buffer solution, 10 L',
    match: 'phosphate buffer',
    price: 1150,
    supplier: REAGENTS,
    category: '5169',
  },
  {
    item: 'Ethanol absolute, 20 L',
    match: 'ethanol',
    price: 420,
    supplier: REAGENTS,
    category: '5169',
  },
  { item: 'Agarose, 500 g', match: 'agarose', price: 380, supplier: REAGENTS, category: '5169' },
  {
    item: 'PCR master mix, 10 kits',
    match: 'pcr master mix',
    price: 1900,
    supplier: REAGENTS,
    category: '5169',
  },
  {
    item: 'Cell culture medium, 24 bottles',
    match: 'cell culture medium',
    price: 860,
    supplier: REAGENTS,
    category: '5169',
  },
];

/** A small seeded random generator, so the same `now` always builds the same history. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const quietMailer: Mailer = {
  name: 'demo-seed',
  send: () => Promise.resolve(),
};

const decimal = (minor: number) => formatMoney(minor, 'CHF').split(' ')[1] ?? '0';

interface Done {
  id: string;
  auth: AgentAuth;
  supplier: string;
  amount: number;
  day: number;
  reason: 'threshold' | 'price' | null;
}

/**
 * Build Lab Alpha with history up to `now`, owned by `user`. Returns the organisation id. Takes
 * a few hundred store calls; run it from an admin action with a long time limit.
 */
export async function seedDemoOrg(input: {
  db: Db;
  encryptionKey: Buffer;
  user: User;
  now: number;
}): Promise<string> {
  const clock = { t: input.now - DEMO_DAYS * DAY };
  const store = new OrgStore(input.db, input.encryptionKey, quietMailer, { clock: () => clock.t });
  const reorder = new ReorderStore(input.db, store, { clock: () => clock.t });
  const user = input.user;
  const rand = random(Math.floor(input.now / DAY));
  /** Local working time on day `d` (Zurich is UTC+1 or +2; 07:00–14:00 UTC stays inside 08–18). */
  const at = (d: number, minutes: number) => {
    const day = Math.floor((input.now - (DEMO_DAYS - d) * DAY) / DAY) * DAY;
    return day + 7 * 3_600_000 + minutes * 60_000;
  };
  const weekday = (d: number) => {
    const w = new Date(at(d, 0)).getUTCDay();
    return w !== 0 && w !== 6;
  };

  const orgId = await store.createOrg(
    user,
    { name: DEMO_ORG_NAME, baseCurrency: 'CHF', timezone: 'Europe/Zurich' },
    { demo: true },
  );
  await store.createAgent(orgId, user, {
    agentId: 'lab-consumables',
    displayName: 'Lab consumables agent',
    owner: 'Dr. B. Beispiel, lab manager (fictional)',
    dailyBudget: '3000',
    perPaymentLimit: '2000',
    approvalAbove: '1200',
    categories: ['5047'],
  });
  await store.createAgent(orgId, user, {
    agentId: 'reagents',
    displayName: 'Reagents agent',
    owner: 'Dr. C. Exempel, research group lead (fictional)',
    dailyBudget: '6000',
    perPaymentLimit: '4000',
    approvalAbove: '2500',
    categories: ['5169'],
  });
  const raw = (await store.view(orgId, user)).raw;
  const agents = raw.agents as Record<string, Record<string, unknown>>;
  const allow = { mode: 'allowlist', allow: [LABWARE, REAGENTS] };
  await store.updateConfig(
    orgId,
    user,
    {
      ...raw,
      price_check: { above_percent: 20, below_percent: 50, above: 'review' },
      reference_prices: [...LAB_ITEMS, ...REAGENT_ITEMS].map((p) => ({
        item: p.item,
        match: [p.match],
        price: String(p.price),
        supplier: p.supplier,
      })),
      projects: {
        'snf-1': {
          name: 'Grant SNF-1 (fictional)',
          budget: '70000',
          period: 'total',
          agents: ['reagents'],
          ends: '2027-03-31',
        },
      },
      agents: {
        ...agents,
        'lab-consumables': {
          ...agents['lab-consumables'],
          suppliers: allow,
          monthly_budget: '28000',
        },
        reagents: { ...agents.reagents, suppliers: allow, monthly_budget: '55000' },
      },
    },
    'Demo organisation set up with fictional data.',
  );

  const auths: Record<string, AgentAuth> = {};
  for (const agentId of ['lab-consumables', 'reagents']) {
    const { key } = await store.createKey(orgId, user, agentId, { expiresInDays: null });
    const auth = await store.authenticateAgent(key);
    if (!auth) throw new Error('demo seed: agent key did not authenticate');
    auths[agentId] = auth;
  }
  const lab = auths['lab-consumables'];
  const rea = auths.reagents;
  if (!lab || !rea) throw new Error('demo seed: agents missing');

  const approved: Done[] = [];
  const toResolve: Done[] = [];
  let invoiceNo = 1000;

  for (let d = 0; d < DEMO_DAYS; d++) {
    if (!weekday(d)) continue;
    // Yesterday's reviews: approved when only above the threshold, declined when overpriced.
    clock.t = at(d, 5);
    for (const r of toResolve.splice(0)) {
      const ok = r.reason === 'threshold';
      await store.resolve(
        orgId,
        user,
        r.id,
        ok ? 'approved' : 'declined',
        ok ? 'Checked with the group lead.' : 'Too expensive; ask for a better offer.',
      );
      if (ok) approved.push({ ...r, day: d });
    }
    // Orders for approvals at least a day old (after any cooling-off).
    for (const a of approved.filter((x) => x.day === d - 1)) {
      clock.t = at(d, 10);
      try {
        await store.agentRecordOrder(a.auth, a.id, `PO-${String(invoiceNo++)}`);
      } catch {
        // Still in cooling-off: ordered later by a person, as in real life.
      }
    }
    // Invoices for orders a few days old: most match, a few do not.
    for (const [i, a] of approved.filter((x) => x.day === d - 4).entries()) {
      clock.t = at(d, 20 + i);
      const n = invoiceNo++;
      const variant = n % 9;
      const amount =
        variant === 3 ? Math.round(a.amount * 1.08) : variant === 6 ? a.amount + 300 : a.amount;
      await store.addInvoice(orgId, user, {
        supplier: a.supplier,
        number: `INV-${String(n)}`,
        invoiceDate: new Date(clock.t).toISOString().slice(0, 10),
        amount: decimal(amount),
        currency: 'CHF',
        reference: a.id,
      });
    }

    // Today's requests: two or three per agent.
    const plan: {
      auth: AgentAuth;
      p: Product;
      qty: number;
      factor: number;
      supplier?: string;
      project?: string;
    }[] = [];
    for (let k = 0; k < 2 + Math.floor(rand() * 2); k++) {
      const p = LAB_ITEMS[Math.floor(rand() * LAB_ITEMS.length)] ?? LAB_ITEMS[0];
      if (!p) continue;
      plan.push({ auth: lab, p, qty: 1 + Math.floor(rand() * 3), factor: 0.95 + rand() * 0.1 });
    }
    for (let k = 0; k < 1 + Math.floor(rand() * 2); k++) {
      const p = REAGENT_ITEMS[Math.floor(rand() * REAGENT_ITEMS.length)] ?? REAGENT_ITEMS[0];
      if (!p) continue;
      plan.push({
        auth: rea,
        p,
        qty: 1 + Math.floor(rand() * 2),
        factor: 0.95 + rand() * 0.1,
        ...(rand() < 0.6 ? { project: 'snf-1' } : {}),
      });
    }
    // Now and then: an overpriced offer, or a supplier outside the approved list.
    const odd = rand();
    if (odd < 0.12 && plan[0]) plan[0].factor = 1.45;
    else if (odd < 0.24 && plan[0]) plan[0].supplier = OUTSIDER;
    else if (odd < 0.34 && plan[0]) plan[0].qty = 8; // one big order, above the per-payment limit

    for (const [k, x] of plan.entries()) {
      clock.t = at(d, 60 + k * 47 + Math.floor(rand() * 30));
      const amount = Math.round(x.p.price * x.qty * x.factor * 100);
      const supplier = x.supplier ?? x.p.supplier;
      const answer = await store.requestPayment(
        x.auth,
        {
          merchant: supplier,
          amount: decimal(amount),
          currency: 'CHF',
          category: x.p.category,
          country: 'CH',
          item: x.p.item,
          quantity: x.qty,
          memo: `${String(x.qty)} × ${x.p.item}`,
          ...(x.project ? { project: x.project } : {}),
        },
        ORIGIN,
      );
      const done: Done = {
        id: answer.payment_id,
        auth: x.auth,
        supplier,
        amount,
        day: d,
        reason: null,
      };
      if (answer.decision === 'approved') approved.push(done);
      if (answer.decision === 'review') {
        // The last two working days stay waiting, so the demo has approvals to show.
        const recent = d >= DEMO_DAYS - 3;
        if (!recent) {
          toResolve.push({ ...done, reason: answer.rule === 'FAIR_PRICE' ? 'price' : 'threshold' });
        }
      }
    }
  }

  // Two requests waiting for a person this morning: above the threshold, and above the usual price.
  const pcr = REAGENT_ITEMS.find((p) => p.match === 'pcr master mix');
  const tips = LAB_ITEMS.find((p) => p.match === 'pipette tips');
  for (const [k, w] of [
    { auth: rea, p: pcr, qty: 2, factor: 1, project: 'snf-1' },
    { auth: lab, p: tips, qty: 1, factor: 1.5 },
  ].entries()) {
    if (!w.p) continue;
    clock.t = input.now - (3 - k) * 3_600_000;
    const amount = Math.round(w.p.price * w.qty * w.factor * 100);
    const answer = await store.requestPayment(
      w.auth,
      {
        merchant: w.p.supplier,
        amount: decimal(amount),
        currency: 'CHF',
        category: w.p.category,
        country: 'CH',
        item: w.p.item,
        quantity: w.qty,
        memo: `${String(w.qty)} × ${w.p.item}`,
        ...(w.project ? { project: w.project } : {}),
      },
      ORIGIN,
    );
    if (answer.decision === 'approved') {
      approved.push({
        id: answer.payment_id,
        auth: w.auth,
        supplier: w.p.supplier,
        amount,
        day: DEMO_DAYS,
        reason: null,
      });
    }
  }

  // One invoice nobody authorized, and the same invoice twice.
  clock.t = input.now - 2 * 3_600_000;
  await store.addInvoice(orgId, user, {
    supplier: LABWARE,
    number: 'INV-9001',
    invoiceDate: new Date(clock.t).toISOString().slice(0, 10),
    amount: '412.35',
    currency: 'CHF',
  });
  // An approval from the last days, which has no invoice yet.
  const last = approved.find((x) => x.day >= DEMO_DAYS - 4);
  if (last) {
    for (let i = 0; i < 2; i++) {
      await store.addInvoice(orgId, user, {
        supplier: last.supplier,
        number: 'INV-9002',
        invoiceDate: new Date(clock.t).toISOString().slice(0, 10),
        amount: decimal(last.amount),
        currency: 'CHF',
        reference: last.id,
      });
    }
  }

  await reorder.saveItems(orgId, user, [
    { item: 'Pipette tips, 20 racks', quantity: '2', stock: '3', minStock: '5' },
    { item: 'Nitrile gloves, 10 boxes', quantity: '3', stock: '8', minStock: '4' },
    // A cheaper supplier outside the approved list: Flow-E declines and names the approved ones.
    { item: 'Petri dishes, 500', quantity: '2', stock: '1', minStock: '4', supplier: OUTSIDER },
    { item: 'PCR master mix, 10 kits', quantity: '1', stock: '0', minStock: '1' },
    { item: 'Agarose, 500 g', quantity: '1' },
  ]);
  return orgId;
}

/**
 * "Reset": the admin leaves every earlier Lab Alpha (it disappears from their list; its signed
 * ledger is kept, as every ledger is) and gets a fresh one.
 */
export async function leaveDemoOrgs(db: Db, user: User): Promise<number> {
  const rows = await db.query<{ org_id: string; data: string }>(
    `select m.org_id, e.data::text as data
       from org_members m
       join orgs o on o.id = m.org_id
       join org_ledger_entries e on e.org_id = o.id and e.type = 'org.created'
      where m.user_id = $1 and o.name = $2`,
    [user.userId, DEMO_ORG_NAME],
  );
  let n = 0;
  for (const r of rows) {
    if ((JSON.parse(r.data) as { demo?: unknown }).demo !== true) continue;
    await db.query('delete from org_members where org_id = $1 and user_id = $2', [
      r.org_id,
      user.userId,
    ]);
    n += 1;
  }
  return n;
}
