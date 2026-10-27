'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError, z } from 'zod';
import {
  ActionError,
  ConfigError,
  CredentialError,
  ReceiptError,
  parseConfigObject,
} from '@flow-e/mcp/core';
import { text } from '@/lib/form';
import { FormProblem, codes, rawFromForm } from '@/lib/mandate-form-data';
import { createDemoLab, DEMO_LAB_AGENT } from '@/server/demo-lab';
import { siteOrigin } from '@/server/origin';
import type { OrgStore, User } from '@/server/org-store';
import { ForbiddenError, can, type Permission } from '@/server/permissions';
import { replay, type ReplayResult } from '@/server/replay';
import { getOrgStore } from '@/server/runtime';
import { getSession } from '@/server/session';
import { requireStrongSession, returnPath } from '@/server/strong-session';

/**
 * Organisation actions. Each reads the signed-in user from the session cookie and passes the
 * organisation id from the form to the store, which checks the user's role in that
 * organisation (src/server/permissions.ts) before doing anything. The form decides nothing
 * about who may act.
 */

export interface ActionResult {
  ok?: string;
  error?: string;
}

/** A secret shown exactly once: an agent key or an invitation link. */
export interface SecretResult extends ActionResult {
  secret?: string;
  label?: string;
}

export interface PreviewState {
  result?: ReplayResult;
  error?: string;
}

export interface VerifyState {
  valid?: boolean;
  checks?: string[];
  error?: string;
}

async function context(form?: FormData) {
  const session = await getSession();
  if (!session) redirect('/login?next=/app');
  const user: User = { userId: session.userId, email: session.email };
  return { store: await getOrgStore(), user, orgId: form ? text(form, 'org') : '' };
}

/**
 * Owners and approvers need a passed second factor for the actions in STRONG_PERMISSIONS
 * (src/server/strong-session.ts): this redirects to set one up or to enter a code, then back
 * to the page the form was on. Outside any try/catch, so the redirect is not swallowed.
 */
async function strong(store: OrgStore, user: User, orgId: string, permission: Permission) {
  if (!z.uuid().safeParse(orgId).success) return; // the store refuses it anyway
  const role = await store.role(orgId, user);
  await requireStrongSession(user, role, permission, await returnPath(`/app/${orgId}`));
}

function problem(err: unknown): string {
  if (
    err instanceof ActionError ||
    err instanceof ConfigError ||
    err instanceof ReceiptError ||
    err instanceof CredentialError ||
    err instanceof ForbiddenError ||
    err instanceof FormProblem
  ) {
    return err.message.replace(/^mandate\.yaml is invalid:\n?/, 'Not saved:\n');
  }
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join(' ');
  console.error('org action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Nothing was changed; please try again.';
}

function refresh(orgId: string) {
  if (z.uuid().safeParse(orgId).success) revalidatePath(`/app/${orgId}`, 'layout');
}

const note = (form: FormData) => {
  const n = text(form, 'note').trim();
  return n === '' ? undefined : n;
};

// Organisations ---------------------------------------------------------------------------------

export async function createOrgAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user } = await context();
  let id: string;
  try {
    id = await store.createOrg(user, {
      name: text(form, 'name'),
      baseCurrency: text(form, 'baseCurrency') as 'CHF',
      timezone: text(form, 'timezone'),
    });
  } catch (err) {
    return { error: problem(err) };
  }
  redirect(`/app/${id}`);
}

/** A fictional lab organisation for demos, then straight to its agent to create a key. */
export async function createDemoLabAction(_prev: ActionResult): Promise<ActionResult> {
  const { store, user } = await context();
  let id: string;
  try {
    id = await createDemoLab(store, user);
  } catch (err) {
    return { error: problem(err) };
  }
  redirect(`/app/${id}/agents/${DEMO_LAB_AGENT}`);
}

export async function renameAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  try {
    await store.rename(orgId, user, text(form, 'name'));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  revalidatePath('/app');
  return { ok: 'Renamed. New credentials will carry the new name.' };
}

// Payments and controls -------------------------------------------------------------------------

export async function resolveAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'payment.resolve');
  const status = form.get('status') === 'approved' ? 'approved' : 'declined';
  // A decline always carries a short reason for the ledger (an approval note is optional).
  if (status === 'declined' && !note(form)) return { error: 'Give a short reason for declining.' };
  try {
    await store.resolve(orgId, user, text(form, 'id'), status, note(form));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: status === 'approved' ? 'Approved.' : 'Declined.' };
}

export async function cancelAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  try {
    await store.cancel(orgId, user, text(form, 'id'), note(form));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: 'Cancelled.' };
}

export async function orderAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  try {
    await store.recordOrder(orgId, user, text(form, 'id'), {
      reference: text(form, 'reference'),
      ...(note(form) ? { note: note(form) } : {}),
    });
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: 'Recorded as ordered.' };
}

export async function freezeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  const frozen = form.get('frozen') === 'true';
  try {
    await store.setFrozen(orgId, user, text(form, 'agentId'), frozen);
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: frozen ? 'Frozen.' : 'Unfrozen.' };
}

export async function killSwitchAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'killswitch.set');
  const on = form.get('on') === 'true';
  try {
    await store.setKillSwitch(orgId, user, on, note(form));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: on ? 'Every agent is stopped.' : 'Kill switch released.' };
}

/** Bound to the organisation id on the page: verifyAction.bind(null, orgId). */
export async function verifyAction(
  orgId: string,
  _prev: VerifyState,
  form: FormData,
): Promise<VerifyState> {
  const { store, user } = await context();
  const receipt = text(form, 'receipt');
  if (receipt.trim() === '') return { error: 'Paste a receipt first.' };
  if (receipt.length > 200_000) return { error: 'That is too long to be a receipt.' };
  try {
    return await store.verify(orgId, user, receipt);
  } catch (err) {
    return { error: problem(err) };
  }
}

// Mandate ---------------------------------------------------------------------------------------

/** Bound to the organisation id on the page: updateMandateAction.bind(null, orgId). */
export async function updateMandateAction(
  orgId: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, user } = await context();
  await strong(store, user, orgId, 'mandate.update');
  try {
    const current = (await store.view(orgId, user)).raw;
    await store.updateConfig(orgId, user, rawFromForm(form, current), note(form));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: 'Saved. The new mandate applies to the next request.' };
}

/** "What if": the last 30 days replayed against the mandate in the form. Nothing is saved. */
export async function previewMandateAction(
  orgId: string,
  _prev: PreviewState,
  form: FormData,
): Promise<PreviewState> {
  const { store, user } = await context();
  try {
    const view = await store.view(orgId, user);
    if (!can(view.role, 'mandate.update')) throw new ForbiddenError('Only owners can change it.');
    const proposed = parseConfigObject({
      ...rawFromForm(form, view.raw),
      organisation: view.name,
    });
    return { result: replay({ entries: view.entries, proposed, now: view.now }) };
  } catch (err) {
    return { error: problem(err).replace(/^Not saved:/, 'Cannot preview:') };
  }
}

// Agents and keys -------------------------------------------------------------------------------

export async function createAgentAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'agent.create');
  let agentId: string;
  try {
    const approval = text(form, 'approvalAbove').trim();
    agentId = await store.createAgent(orgId, user, {
      agentId: text(form, 'agentId'),
      displayName: text(form, 'displayName'),
      owner: text(form, 'owner'),
      dailyBudget: text(form, 'dailyBudget'),
      perPaymentLimit: text(form, 'perPaymentLimit'),
      ...(approval === '' ? {} : { approvalAbove: approval }),
      categories: codes(text(form, 'categories')),
    });
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  redirect(`/app/${orgId}/agents/${agentId}`);
}

export async function pauseAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  const paused = form.get('paused') === 'true';
  try {
    await store.setPaused(orgId, user, text(form, 'agentId'), paused);
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: paused ? 'Paused.' : 'Active again.' };
}

const expiry = z.enum(['never', '30', '90', '365']);

export async function createKeyAction(_prev: SecretResult, form: FormData): Promise<SecretResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'agent.keys');
  try {
    const e = expiry.parse(text(form, 'expires', 'never'));
    const k = await store.createKey(orgId, user, text(form, 'agentId'), {
      expiresInDays: e === 'never' ? null : Number(e),
    });
    refresh(orgId);
    return { secret: k.key, label: k.prefix, ok: 'Key created.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function rotateKeyAction(_prev: SecretResult, form: FormData): Promise<SecretResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'agent.keys');
  try {
    const k = await store.rotateKey(orgId, user, text(form, 'keyId'));
    refresh(orgId);
    return { secret: k.key, label: k.prefix, ok: 'Rotated: the old key no longer works.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function revokeKeyAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'agent.keys');
  try {
    await store.revokeKey(orgId, user, text(form, 'keyId'));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: 'Revoked.' };
}

// Members ---------------------------------------------------------------------------------------

export async function inviteAction(_prev: SecretResult, form: FormData): Promise<SecretResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'member.invite');
  try {
    const r = await store.invite(
      orgId,
      user,
      { email: text(form, 'email'), role: text(form, 'role') },
      await siteOrigin(),
    );
    refresh(orgId);
    return {
      secret: r.link,
      label: text(form, 'email').trim().toLowerCase(),
      ok: r.emailed
        ? 'Invitation sent. You can also pass on this link yourself; it is shown only now.'
        : 'The email could not be sent. Pass on this link yourself; it is shown only now.',
    };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function revokeInvitationAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'member.invite');
  try {
    await store.revokeInvitation(orgId, user, text(form, 'invitationId'));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: 'Invitation revoked.' };
}

export async function changeRoleAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'member.manage');
  try {
    await store.changeRole(orgId, user, text(form, 'memberId'), text(form, 'role'));
  } catch (err) {
    return { error: problem(err) };
  }
  refresh(orgId);
  return { ok: 'Role changed.' };
}

export async function removeMemberAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, user, orgId } = await context(form);
  await strong(store, user, orgId, 'member.manage');
  const self = text(form, 'memberId') === user.userId;
  try {
    await store.removeMember(orgId, user, text(form, 'memberId'));
  } catch (err) {
    return { error: problem(err) };
  }
  if (self) redirect('/app');
  refresh(orgId);
  return { ok: 'Removed.' };
}

// Invitations and approval links (the token is the only input) ----------------------------------

export async function acceptInvitationAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, user } = await context();
  let orgId: string;
  try {
    orgId = await store.acceptInvitation(text(form, 'token'), user);
  } catch (err) {
    return { error: problem(err) };
  }
  revalidatePath('/app');
  redirect(`/app/${orgId}`);
}

export async function confirmApprovalAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, user } = await context();
  const token = text(form, 'token');
  // The second factor first: the link's organisation and this person's role there decide.
  const preview = await store.approvalPreview(token, user);
  if ('error' in preview) return { error: preview.error };
  await requireStrongSession(
    user,
    await store.role(preview.orgId, user),
    'payment.resolve',
    `/approve/${token}`,
  );
  let r: { orgId: string; paymentId: string };
  try {
    r = await store.confirmApproval(token, user, note(form));
  } catch (err) {
    return { error: problem(err) };
  }
  // The link is spent now; show the payment with its new status and who decided.
  refresh(r.orgId);
  redirect(`/app/${r.orgId}/payments/${r.paymentId}`);
}
