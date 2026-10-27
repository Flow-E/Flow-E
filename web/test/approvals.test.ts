import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/server/permissions';
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

/** Approval-email links end to end: who may use them, when, and what the agent then sees. */
describe('approval links', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  async function waiting() {
    const p = await w.store.requestPayment(w.auth, request('800'), ORIGIN);
    expect(p.decision).toBe('review');
    const mails = await outbox(w.db, 'approval');
    const bob = approvalLinks(mails.find((m) => m.to_email === BOB.email)?.body_text ?? '');
    const alice = approvalLinks(mails.find((m) => m.to_email === ALICE.email)?.body_text ?? '');
    return { p, bob, alice };
  }

  async function statusOf(id: string) {
    return (await w.store.payment(w.orgId, ALICE, id))?.payment.status;
  }

  it('an expired link fails, at preview and at confirm, and changes nothing', async () => {
    const { p, bob } = await waiting();
    w.clock.now += 24 * HOUR + 1;
    expect(await w.store.approvalPreview(bob.approve, BOB)).toEqual({
      error: 'This link has expired.',
    });
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow('expired');
    expect(await statusOf(p.payment_id)).toBe('review');
  });

  it('a reused link fails, and so does the other link of the same email', async () => {
    const { bob } = await waiting();
    await w.store.confirmApproval(bob.decline, BOB, 'not needed');
    await expect(w.store.confirmApproval(bob.decline, BOB)).rejects.toThrow('already used');
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow('already used');
    expect(await w.store.approvalPreview(bob.approve, BOB)).toEqual({
      error: 'This link was already used.',
    });
  });

  it('a viewer cannot use one: not someone else’s, nor their own after becoming a viewer', async () => {
    const { p, bob } = await waiting();
    await expect(w.store.confirmApproval(bob.approve, CAROL)).rejects.toThrow(ForbiddenError);
    await w.store.changeRole(w.orgId, ALICE, BOB.userId, 'viewer');
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow(ForbiddenError);
    expect(await statusOf(p.payment_id)).toBe('review');
  });

  it('an approver of another organisation fails', async () => {
    const { p, bob } = await waiting();
    // Dave owns another organisation: he cannot use a link of this one.
    const other = await w.store.createOrg(DAVE, {
      name: 'Other Labs AG (fictional)',
      baseCurrency: 'CHF',
      timezone: 'Europe/Zurich',
    });
    await expect(w.store.confirmApproval(bob.approve, DAVE)).rejects.toThrow(ForbiddenError);
    expect('error' in (await w.store.approvalPreview(bob.approve, DAVE))).toBe(true);
    // Bob leaves this organisation but is an approver in Dave's: his old link no longer works.
    const { link } = await w.store.invite(
      other,
      DAVE,
      { email: BOB.email, role: 'approver' },
      ORIGIN,
    );
    await w.store.acceptInvitation(tokenOf(link), BOB);
    await w.store.removeMember(w.orgId, ALICE, BOB.userId);
    await expect(w.store.confirmApproval(bob.approve, BOB)).rejects.toThrow(ForbiddenError);
    expect(await statusOf(p.payment_id)).toBe('review');
  });

  it('a decision is written to the signed ledger and the agent sees it through get_payment', async () => {
    const { p, alice } = await waiting();
    const before = (await w.store.view(w.orgId, ALICE)).entries.length;
    expect((await w.store.agentPayment(w.auth, p.payment_id))?.status).toBe('review');

    const r = await w.store.confirmApproval(alice.approve, ALICE, 'fine');
    expect(r).toEqual({ orgId: w.orgId, paymentId: p.payment_id, status: 'approved' });

    const view = await w.store.view(w.orgId, ALICE);
    expect(view.entries).toHaveLength(before + 1);
    expect(view.audit.ok).toBe(true);
    expect(view.entries.at(-1)?.data).toContain(p.payment_id);

    const seen = await w.store.agentPayment(w.auth, p.payment_id);
    expect(seen).toMatchObject({
      payment_id: p.payment_id,
      status: 'approved',
      decided_by: 'alice@example.com (email link)',
      note_from_human: 'fine',
    });
  });
});
