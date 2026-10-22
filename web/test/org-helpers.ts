import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { migrate, openPglite, type Db } from '@/server/db';
import { OutboxMailer } from '@/server/email';
import { OrgStore, type AgentAuth, type User } from '@/server/org-store';

export const MIGRATIONS = path.resolve(__dirname, '../db/migrations');
/** Wednesday 21 Oct 2026, 12:00 in Zurich. */
export const NOW = Date.parse('2026-10-21T10:00:00Z');
export const ORIGIN = 'http://localhost:3150';

export const ALICE: User = { userId: 'dev:alice@example.com', email: 'alice@example.com' };
export const BOB: User = { userId: 'dev:bob@example.com', email: 'bob@example.com' };
export const CAROL: User = { userId: 'dev:carol@example.com', email: 'carol@example.com' };
export const DAVE: User = { userId: 'dev:dave@example.com', email: 'dave@example.com' };

export interface World {
  db: Db;
  store: OrgStore;
  clock: { now: number };
  orgId: string;
  agentKey: string;
  auth: AgentAuth;
  close(): Promise<void>;
}

export const tokenOf = (link: string) => link.split('/').at(-1) ?? '';

/**
 * A fictional organisation: Alice owner, Bob approver, Carol viewer, one agent "buyer" with a
 * key. Approval above CHF 500.
 */
export async function world(): Promise<World> {
  const db = await openPglite();
  await migrate(db, MIGRATIONS);
  const clock = { now: NOW };
  const store = new OrgStore(db, randomBytes(32), new OutboxMailer(db, { NODE_ENV: 'test' }), {
    clock: () => clock.now,
  });
  const orgId = await store.createOrg(ALICE, {
    name: 'Example Labs AG (fictional)',
    baseCurrency: 'CHF',
    timezone: 'Europe/Zurich',
  });
  await store.createAgent(orgId, ALICE, {
    agentId: 'buyer',
    displayName: 'Lab buyer',
    owner: 'alice@example.com',
    dailyBudget: '100000',
    perPaymentLimit: '50000',
    approvalAbove: '500',
    categories: ['5169'],
  });
  for (const [user, role] of [
    [BOB, 'approver'],
    [CAROL, 'viewer'],
  ] as const) {
    const { link } = await store.invite(orgId, ALICE, { email: user.email, role }, ORIGIN);
    await store.acceptInvitation(tokenOf(link), user);
  }
  const { key } = await store.createKey(orgId, ALICE, 'buyer', { expiresInDays: null });
  const auth = await store.authenticateAgent(key);
  if (!auth) throw new Error('test setup: key did not authenticate');
  return { db, store, clock, orgId, agentKey: key, auth, close: () => db.close() };
}

let supplier = 0;
/** A payment request to a new fictional supplier. */
export function request(amount: string, merchant = `Fictional Supplier ${++supplier}`) {
  return { merchant, amount, currency: 'CHF', category: '5169', country: 'CH' };
}

export async function outbox(db: Db, kind?: string) {
  const rows = await db.query<{
    to_email: string;
    subject: string;
    body_text: string;
    kind: string;
  }>('select to_email, subject, body_text, kind from email_outbox order by created_at, id');
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

/** The approve/decline links in an approval email. */
export function approvalLinks(body: string): { approve: string; decline: string } {
  const approve = /Approve: (\S+)/.exec(body)?.[1] ?? '';
  const decline = /Decline: (\S+)/.exec(body)?.[1] ?? '';
  return { approve: tokenOf(approve), decline: tokenOf(decline) };
}
