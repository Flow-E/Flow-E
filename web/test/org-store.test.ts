import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionError, ConfigError } from '@flow-e/mcp/core';
import { MailerConfigError, OutboxMailer, mailerFromEnv } from '@/server/email';
import type { OrgStore, User } from '@/server/org-store';
import { ForbiddenError, type Permission } from '@/server/permissions';
import { ReorderStore } from '@/server/reorder';
import { sha256 } from '@/server/tokens';
import {
  ALICE,
  BOB,
  CAROL,
  DAVE,
  ORIGIN,
  approvalLinks,
  outbox,
  request,
  tokenOf,
  world,
  type World,
} from './org-helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('every action × role, enforced by the store', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.close();
  });

  let n = 0;
  const unique = () => `x${++n}`;

  /** Each action prepares what it needs, acts as `user`, and tidies up after itself. */
  const ACTIONS: Record<Permission, (s: OrgStore, orgId: string, user: User) => Promise<unknown>> =
    {
      'org.read': (s, orgId, user) => s.view(orgId, user),
      'payment.resolve': async (s, orgId, user) => {
        const p = await s.requestPayment(w.auth, request('800'), ORIGIN);
        expect(p.decision).toBe('review');
        await s.resolve(orgId, user, p.payment_id, 'approved');
      },
      'payment.cancel': async (s, orgId, user) => {
        const p = await s.requestPayment(w.auth, request('100'), ORIGIN);
        expect(p.cancellable_until).not.toBeNull();
        await s.cancel(orgId, user, p.payment_id);
      },
      'payment.fulfil': async (s, orgId, user) => {
        const p = await s.requestPayment(w.auth, request('100'), ORIGIN);
        await s.recordInvoice(orgId, user, p.payment_id, {
          number: 'INV-1',
          amount: '100.00',
          currency: 'CHF',
        });
      },
      'invoice.record': (s, orgId, user) =>
        s.addInvoice(orgId, user, {
          supplier: `Fictional Supplier ${unique()}`,
          number: `INV-${unique()}`,
          invoiceDate: '2026-10-20',
          amount: '10.00',
          currency: 'CHF',
        }),
      'agent.freeze': async (s, orgId, user) => {
        await s.setFrozen(orgId, user, 'buyer', true);
        await s.setFrozen(orgId, user, 'buyer', false);
      },
      'killswitch.set': async (s, orgId, user) => {
        await s.setKillSwitch(orgId, user, true);
        await s.setKillSwitch(orgId, user, false);
      },
      'mandate.update': async (s, orgId, user) => {
        const raw = (await s.view(orgId, ALICE)).raw;
        await s.updateConfig(orgId, user, { ...raw, blocked_suppliers: [`Blocked ${unique()}`] });
      },
      'agent.create': (s, orgId, user) =>
        s.createAgent(orgId, user, {
          agentId: `agent-${unique()}`,
          displayName: 'Another agent',
          owner: 'alice@example.com',
          dailyBudget: '100',
          perPaymentLimit: '50',
          categories: ['5111'],
        }),
      'agent.keys': async (s, orgId, user) => {
        const k = await s.createKey(orgId, user, 'buyer', { expiresInDays: 30 });
        await s.revokeKey(orgId, user, k.id);
      },
      'member.invite': (s, orgId, user) =>
        s.invite(orgId, user, { email: `${unique()}@example.com`, role: 'viewer' }, ORIGIN),
      'member.manage': (s, orgId, user) => s.changeRole(orgId, user, CAROL.userId, 'viewer'),
      'org.settings': (s, orgId, user) => s.rename(orgId, user, 'Example Labs AG (fictional)'),
      'reorder.manage': (s, orgId, user) =>
        new ReorderStore(w.db, s).saveItems(orgId, user, [{ item: 'Glassware', quantity: 1 }]),
      'reorder.run': async (s, orgId, user) => {
        const r = new ReorderStore(w.db, s);
        await r.saveItems(orgId, ALICE, [{ item: 'Glassware', quantity: 1 }]);
        await r.run(orgId, user, { agentId: 'buyer', origin: ORIGIN, callModel: null });
      },
    };

  const EXPECTED: Record<Permission, User[]> = {
    'org.read': [ALICE, BOB, CAROL],
    'payment.resolve': [ALICE, BOB],
    'payment.cancel': [ALICE, BOB],
    'payment.fulfil': [ALICE, BOB],
    'invoice.record': [ALICE, BOB],
    'agent.freeze': [ALICE, BOB],
    'killswitch.set': [ALICE, BOB],
    'reorder.manage': [ALICE, BOB],
    'reorder.run': [ALICE, BOB],
    'mandate.update': [ALICE],
    'agent.create': [ALICE],
    'agent.keys': [ALICE],
    'member.invite': [ALICE],
    'member.manage': [ALICE],
    'org.settings': [ALICE],
  };

  const label: Record<string, string> = {
    [ALICE.userId]: 'owner',
    [BOB.userId]: 'approver',
    [CAROL.userId]: 'viewer',
    [DAVE.userId]: 'non-member',
  };

  for (const permission of Object.keys(ACTIONS) as Permission[]) {
    for (const user of [ALICE, BOB, CAROL, DAVE]) {
      const allowed = EXPECTED[permission].includes(user);
      it(`${label[user.userId]} ${allowed ? 'can' : 'cannot'} ${permission}`, async () => {
        const run = ACTIONS[permission](w.store, w.orgId, user);
        if (allowed) await expect(run).resolves.not.toThrow();
        else await expect(run).rejects.toThrow(ForbiddenError);
      });
    }
  }

  it('leaves an intact, signed ledger behind', async () => {
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.audit.ok).toBe(true);
    expect(v.controls.killSwitch?.on ?? false).toBe(false);
  });
});

describe('organisations', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it('starts with its own issuer, an encrypted key, a valid mandate and a signed ledger', async () => {
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.issuer).toMatch(/^flow-e-issuer:[0-9a-f]{16}$/);
    expect(v.baseCurrency).toBe('CHF');
    expect(v.timezone).toBe('Europe/Zurich');
    expect(v.audit.ok).toBe(true);
    expect(v.entries.map((e) => e.type)).toEqual([
      'org.created',
      'member.added',
      'agent.created',
      'member.invited',
      'member.added',
      'member.invited',
      'member.added',
      'agent.key_created',
    ]);
    const rows = await w.db.query<{ issuer_private_key_enc: string }>(
      'select issuer_private_key_enc from orgs',
    );
    expect(rows[0]?.issuer_private_key_enc).not.toMatch(/PRIVATE KEY/);
  });

  it('lists only the organisations a user belongs to, with their role', async () => {
    await w.store.createOrg(DAVE, {
      name: 'Dave Fictional GmbH',
      baseCurrency: 'EUR',
      timezone: 'Europe/Berlin',
    });
    expect((await w.store.listOrgs(BOB)).map((o) => [o.name, o.role])).toEqual([
      ['Example Labs AG (fictional)', 'approver'],
    ]);
    expect((await w.store.listOrgs(DAVE)).map((o) => [o.name, o.role, o.baseCurrency])).toEqual([
      ['Dave Fictional GmbH', 'owner', 'EUR'],
    ]);
  });

  it('rejects a bad timezone or currency', async () => {
    await expect(
      w.store.createOrg(DAVE, { name: 'X', baseCurrency: 'CHF', timezone: 'Mars/Olympus' }),
    ).rejects.toThrow();
    await expect(
      w.store.createOrg(DAVE, { name: 'X', baseCurrency: 'USD' as 'CHF', timezone: 'UTC' }),
    ).rejects.toThrow();
  });

  it('records mandate changes with who, what and both hashes; the base currency is fixed', async () => {
    const raw = (await w.store.view(w.orgId, ALICE)).raw;
    await w.store.updateConfig(w.orgId, ALICE, { ...raw, blocked_countries: ['KP'] }, 'sanctions');
    const v = await w.store.view(w.orgId, ALICE);
    const entry = v.entries.at(-1);
    expect(entry?.type).toBe('config.updated');
    const data = JSON.parse(entry?.data ?? '{}') as Record<string, unknown>;
    expect(data).toMatchObject({
      by: 'alice@example.com',
      note: 'sanctions',
      changes: ['blocked_countries'],
    });
    expect(data.old_config_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.new_config_sha256).not.toBe(data.old_config_sha256);
    await expect(
      w.store.updateConfig(w.orgId, ALICE, { ...raw, base_currency: 'EUR' }),
    ).rejects.toThrow(ConfigError);
    await expect(w.store.updateConfig(w.orgId, ALICE, { ...raw, agents: {} })).rejects.toThrow(
      ConfigError,
    );
  });

  it('pauses and resumes an agent, which the engine then respects', async () => {
    await w.store.setPaused(w.orgId, ALICE, 'buyer', true);
    expect((await w.store.requestPayment(w.auth, request('10'), ORIGIN)).decision).toBe('declined');
    await w.store.setPaused(w.orgId, ALICE, 'buyer', false);
    expect((await w.store.requestPayment(w.auth, request('10'), ORIGIN)).decision).toBe('approved');
    const types = (await w.store.view(w.orgId, ALICE)).entries.map((e) => e.type);
    expect(types).toContain('agent.paused');
    expect(types).toContain('agent.resumed');
  });

  it('issues the agent a credential signed by the organisation issuer', async () => {
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.agents[0]).toMatchObject({ id: 'buyer', displayName: 'Lab buyer' });
    expect(v.agents[0]?.credentialExpires).toBe('2027-01-19T10:00:00.000Z');
    const check = await w.store.checkMandate(w.auth);
    expect(check.agent).toMatchObject({
      name: 'Lab buyer',
      organisation: 'Example Labs AG (fictional)',
    });
  });
});

describe('isolation between organisations', () => {
  let w: World;
  let daveOrg: string;
  beforeEach(async () => {
    w = await world();
    daveOrg = await w.store.createOrg(DAVE, {
      name: 'Dave Fictional GmbH',
      baseCurrency: 'EUR',
      timezone: 'UTC',
    });
  });
  afterEach(async () => {
    await w.close();
  });

  it('a member of one organisation cannot read or act on another', async () => {
    await expect(w.store.view(daveOrg, ALICE)).rejects.toThrow(ForbiddenError);
    await expect(w.store.setKillSwitch(daveOrg, ALICE, true)).rejects.toThrow(ForbiddenError);
    await expect(w.store.view(w.orgId, DAVE)).rejects.toThrow(ForbiddenError);
    await expect(w.store.csv(w.orgId, DAVE)).rejects.toThrow(ForbiddenError);
  });

  it("cannot reach another organisation's payment through its own", async () => {
    const p = await w.store.requestPayment(w.auth, request('800'), ORIGIN);
    await expect(w.store.resolve(daveOrg, DAVE, p.payment_id, 'approved')).rejects.toThrow(
      ActionError,
    );
    expect(await w.store.payment(daveOrg, DAVE, p.payment_id)).toBeNull();
    expect((await w.store.payment(w.orgId, ALICE, p.payment_id))?.payment.status).toBe('review');
  });

  it("cannot manage another organisation's keys or members", async () => {
    const k = await w.store.createKey(w.orgId, ALICE, 'buyer', { expiresInDays: null });
    await expect(w.store.revokeKey(daveOrg, DAVE, k.id)).rejects.toThrow('No such key');
    await expect(w.store.removeMember(daveOrg, DAVE, ALICE.userId)).rejects.toThrow('not a member');
    expect(await w.store.authenticateAgent(k.key)).not.toBeNull();
  });

  it('an unknown or malformed organisation id looks the same as a forbidden one', async () => {
    await expect(w.store.view('not-a-uuid', ALICE)).rejects.toThrow(ForbiddenError);
    await expect(w.store.view('00000000-0000-4000-8000-000000000000', ALICE)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('invitations and members', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it('stores only the hash of the token and emails the link', async () => {
    const { link, emailed } = await w.store.invite(
      w.orgId,
      ALICE,
      { email: 'Erin@Example.com', role: 'approver' },
      ORIGIN,
    );
    expect(emailed).toBe(true);
    const token = tokenOf(link);
    const rows = await w.db.query<{ token_hash: string; email: string }>(
      "select token_hash, email from org_invitations where email = 'erin@example.com'",
    );
    expect(rows[0]?.token_hash).toBe(sha256(token));
    const dump = JSON.stringify(await w.db.query('select * from org_invitations'));
    expect(dump).not.toContain(token);
    const mail = (await outbox(w.db, 'invitation')).filter(
      (m) => m.to_email === 'erin@example.com',
    );
    expect(mail[0]?.body_text).toContain(link);
    expect(mail[0]?.body_text).not.toMatch(/<img/i);
  });

  it('must be accepted by the invited address, once, within 7 days', async () => {
    const erin: User = { userId: 'dev:erin@example.com', email: 'erin@example.com' };
    const a = await w.store.invite(w.orgId, ALICE, { email: erin.email, role: 'approver' }, ORIGIN);
    await expect(w.store.acceptInvitation(tokenOf(a.link), DAVE)).rejects.toThrow(ForbiddenError);
    await w.store.acceptInvitation(tokenOf(a.link), erin);
    expect(await w.store.role(w.orgId, erin)).toBe('approver');
    await expect(w.store.acceptInvitation(tokenOf(a.link), erin)).rejects.toThrow('accepted');

    const b = await w.store.invite(w.orgId, ALICE, { email: DAVE.email, role: 'viewer' }, ORIGIN);
    w.clock.now += 7 * DAY + 1;
    await expect(w.store.acceptInvitation(tokenOf(b.link), DAVE)).rejects.toThrow('expired');
    expect(await w.store.role(w.orgId, DAVE)).toBeNull();
  });

  it('can be revoked before use', async () => {
    const a = await w.store.invite(w.orgId, ALICE, { email: DAVE.email, role: 'viewer' }, ORIGIN);
    await w.store.revokeInvitation(w.orgId, ALICE, a.id);
    await expect(w.store.acceptInvitation(tokenOf(a.link), DAVE)).rejects.toThrow('revoked');
    expect(await w.store.invitationPreview(tokenOf(a.link))).toMatchObject({ status: 'revoked' });
    expect(await w.store.invitationPreview('x'.repeat(43))).toBeNull();
  });

  it('rejects inviting an existing member', async () => {
    await expect(
      w.store.invite(w.orgId, ALICE, { email: 'BOB@example.com', role: 'owner' }, ORIGIN),
    ).rejects.toThrow('already a member');
  });

  it('always keeps at least one owner', async () => {
    await expect(w.store.changeRole(w.orgId, ALICE, ALICE.userId, 'viewer')).rejects.toThrow(
      'at least one owner',
    );
    await expect(w.store.removeMember(w.orgId, ALICE, ALICE.userId)).rejects.toThrow(
      'at least one owner',
    );
    await w.store.changeRole(w.orgId, ALICE, BOB.userId, 'owner');
    await w.store.changeRole(w.orgId, BOB, ALICE.userId, 'viewer');
    expect(await w.store.role(w.orgId, ALICE)).toBe('viewer');
    await w.store.removeMember(w.orgId, BOB, CAROL.userId);
    expect(await w.store.role(w.orgId, CAROL)).toBeNull();
    const types = (await w.store.view(w.orgId, BOB)).entries.map((e) => e.type);
    expect(types.filter((t) => t === 'member.role_changed')).toHaveLength(2);
    expect(types).toContain('member.removed');
  });
});

describe('agent keys', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it('are shown once with a visible prefix; only the hash is stored, never in the ledger', async () => {
    expect(w.agentKey).toMatch(/^flowe_ak_[A-Za-z0-9_-]{43}$/);
    const rows = await w.db.query<{ prefix: string; key_hash: string }>(
      'select prefix, key_hash from agent_keys',
    );
    expect(rows[0]?.prefix).toBe(w.agentKey.slice(0, 15));
    expect(rows[0]?.key_hash).toBe(sha256(w.agentKey));
    const everything = JSON.stringify([
      await w.db.query('select * from agent_keys'),
      await w.db.query('select * from org_ledger_entries'),
    ]);
    expect(everything).not.toContain(w.agentKey);
    const entry = (await w.store.view(w.orgId, ALICE)).entries.find(
      (e) => e.type === 'agent.key_created',
    );
    expect(JSON.parse(entry?.data ?? '{}')).toMatchObject({ prefix: rows[0]?.prefix });
  });

  it('record when they were last used', async () => {
    w.clock.now += HOUR;
    await w.store.authenticateAgent(w.agentKey);
    const v = await w.store.view(w.orgId, ALICE);
    expect(v.agents[0]?.keys[0]?.lastUsedAt).toBe(new Date(w.clock.now).toISOString());
  });

  it('stop working when revoked, expired or rotated', async () => {
    const short = await w.store.createKey(w.orgId, ALICE, 'buyer', { expiresInDays: 1 });
    expect(await w.store.authenticateAgent(short.key)).not.toBeNull();
    const rotated = await w.store.rotateKey(w.orgId, ALICE, w.auth.keyId);
    expect(await w.store.authenticateAgent(w.agentKey)).toBeNull();
    expect(await w.store.authenticateAgent(rotated.key)).not.toBeNull();
    w.clock.now += DAY + 1;
    expect(await w.store.authenticateAgent(short.key)).toBeNull();
    await w.store.revokeKey(w.orgId, ALICE, rotated.id);
    expect(await w.store.authenticateAgent(rotated.key)).toBeNull();
    await expect(w.store.revokeKey(w.orgId, ALICE, rotated.id)).rejects.toThrow('already revoked');
    expect(await w.store.authenticateAgent('flowe_ak_nonsense')).toBeNull();
    const statuses = (await w.store.view(w.orgId, ALICE)).agents[0]?.keys
      .map((k) => k.status)
      .sort();
    expect(statuses).toEqual(['expired', 'revoked', 'revoked']);
  });

  it('are limited to five active per agent', async () => {
    for (let i = 0; i < 4; i++)
      await w.store.createKey(w.orgId, ALICE, 'buyer', { expiresInDays: null });
    await expect(
      w.store.createKey(w.orgId, ALICE, 'buyer', { expiresInDays: null }),
    ).rejects.toThrow('at most 5');
  });
});

describe('approval emails', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  async function reviewPayment() {
    const p = await w.store.requestPayment(
      w.auth,
      request('800', 'Alpine Reagents (fictional)'),
      ORIGIN,
    );
    expect(p.decision).toBe('review');
    const mails = await outbox(w.db, 'approval');
    const to = (u: User) => mails.find((m) => m.to_email === u.email);
    return { p, mails, to };
  }

  it('go to every owner and approver, not to viewers, with amount, supplier, agent and reason', async () => {
    const { p, mails, to } = await reviewPayment();
    expect(mails.map((m) => m.to_email).sort()).toEqual(['alice@example.com', 'bob@example.com']);
    const body = to(BOB)?.body_text ?? '';
    expect(to(BOB)?.subject).toBe('Approval needed: CHF 800.00 to Alpine Reagents (fictional)');
    expect(body).toContain('Lab buyer (buyer)');
    expect(body).toContain(p.reason);
    expect(body).toContain(p.payment_id);
    expect(approvalLinks(body).approve).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify(await w.db.query('select * from approval_tokens'));
    expect(dump).not.toContain(approvalLinks(body).approve);
  });

  it('approve only after the recipient confirms, once; all links for the payment are then spent', async () => {
    const { p, to } = await reviewPayment();
    const bob = approvalLinks(to(BOB)?.body_text ?? '');
    const alice = approvalLinks(to(ALICE)?.body_text ?? '');
    // Opening (previewing) changes nothing.
    expect(await w.store.approvalPreview(bob.approve, BOB)).toMatchObject({ action: 'approve' });
    expect((await w.store.payment(w.orgId, ALICE, p.payment_id))?.payment.status).toBe('review');
    // Somebody else's link.
    const other = await w.store.approvalPreview(bob.approve, ALICE);
    expect('error' in other ? other.error : '').toContain('bob@example.com');
    await expect(w.store.confirmApproval(bob.approve, ALICE)).rejects.toThrow(ForbiddenError);
    await expect(w.store.confirmApproval(bob.approve, CAROL)).rejects.toThrow(ForbiddenError);

    const r = await w.store.confirmApproval(bob.approve, BOB, 'ok by phone');
    expect(r).toEqual({ orgId: w.orgId, paymentId: p.payment_id, status: 'approved' });
    const after = await w.store.payment(w.orgId, ALICE, p.payment_id);
    expect(after?.payment).toMatchObject({
      status: 'approved',
      decidedBy: 'bob@example.com (email link)',
    });
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow('already used');
    await expect(w.store.confirmApproval(alice.decline, ALICE)).rejects.toThrow('already used');
  });

  it('expire after 24 hours', async () => {
    const { to } = await reviewPayment();
    w.clock.now += 24 * HOUR + 1;
    const bob = approvalLinks(to(BOB)?.body_text ?? '');
    await expect(w.store.confirmApproval(bob.decline, BOB)).rejects.toThrow('expired');
  });

  it("re-check the recipient's role and the payment's status at confirm time", async () => {
    const { p, to } = await reviewPayment();
    const bob = approvalLinks(to(BOB)?.body_text ?? '');
    await w.store.changeRole(w.orgId, ALICE, BOB.userId, 'viewer');
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow(ForbiddenError);
    await w.store.changeRole(w.orgId, ALICE, BOB.userId, 'approver');
    await w.store.resolve(w.orgId, ALICE, p.payment_id, 'declined');
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow(
      'not waiting for review',
    );
  });

  it('are not sent for approved or declined payments', async () => {
    await w.store.requestPayment(w.auth, request('100'), ORIGIN);
    await w.store.requestPayment(w.auth, request('60000'), ORIGIN);
    expect(await outbox(w.db, 'approval')).toHaveLength(0);
  });
});

describe('the development outbox', () => {
  it('is never chosen in production, and the choice never throws', () => {
    const sql = { query: () => Promise.resolve([]) };
    expect(mailerFromEnv(sql, { NODE_ENV: 'production' }).name).toBe('disabled');
    expect(mailerFromEnv(sql, { NODE_ENV: 'production', RESEND_API_KEY: 're_x' }).name).toBe(
      'disabled',
    );
    expect(mailerFromEnv(sql, { NODE_ENV: 'development' }).name).toBe('outbox');
  });

  it('refuses to run in production', () => {
    expect(
      () => new OutboxMailer({ query: () => Promise.resolve([]) }, { NODE_ENV: 'production' }),
    ).toThrow(MailerConfigError);
  });
});

describe('orders and invoices', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.close();
  });

  it('lets the agent record its order after cooling-off, and a person match the invoice', async () => {
    const p = await w.store.requestPayment(w.auth, request('480'), ORIGIN);
    expect(p.decision).toBe('approved');
    await expect(w.store.agentRecordOrder(w.auth, p.payment_id, 'SO-1')).rejects.toThrow(
      /still be cancelled/,
    );
    w.clock.now += 11 * 60_000;
    const ordered = await w.store.agentRecordOrder(w.auth, p.payment_id, 'SO-2026-7');
    expect(ordered).toMatchObject({ ordered: { reference: 'SO-2026-7' } });
    await w.store.recordInvoice(w.orgId, BOB, p.payment_id, {
      number: 'INV-88',
      amount: '495.50',
      currency: 'chf',
    });
    const v = await w.store.view(w.orgId, ALICE);
    const record = v.payments.find((x) => x.paymentId === p.payment_id);
    expect(record?.fulfilment?.invoice).toMatchObject({ number: 'INV-88', difference: 1_550 });
    expect(record?.status).toBe('approved');
    expect(v.audit.ok).toBe(true);
  });

  it("never records an order on another agent's payment, and refuses a viewer", async () => {
    expect(await w.store.agentRecordOrder(w.auth, 'pay_unknown')).toBeNull();
    const p = await w.store.requestPayment(w.auth, request('120'), ORIGIN);
    await expect(
      w.store.recordInvoice(w.orgId, CAROL, p.payment_id, {
        number: 'INV-1',
        amount: '120',
        currency: 'CHF',
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
