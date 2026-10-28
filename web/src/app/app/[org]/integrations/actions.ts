'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import { text } from '@/lib/form';
import type { OrgStore, User } from '@/server/org-store';
import { ForbiddenError } from '@/server/permissions';
import { getApiKeyStore, getOrgStore, getWebhookStore } from '@/server/runtime';
import { getSession } from '@/server/session';
import { requireStrongSession, returnPath } from '@/server/strong-session';
import type { ActionResult, SecretResult } from '../../actions';

/**
 * Integration actions: organisation API keys and webhooks. Owners only, with the second factor
 * (integrations.manage); the stores check the role in the organisation named by the form.
 */

async function context(form: FormData) {
  const session = await getSession();
  if (!session) redirect('/login?next=/app');
  const user: User = { userId: session.userId, email: session.email };
  const orgId = text(form, 'org');
  const orgs: OrgStore = await getOrgStore();
  if (z.uuid().safeParse(orgId).success) {
    await requireStrongSession(
      user,
      await orgs.role(orgId, user),
      'integrations.manage',
      await returnPath(`/app/${orgId}/integrations`),
    );
  }
  return { user, orgId };
}

function problem(err: unknown): string {
  if (err instanceof ActionError || err instanceof ForbiddenError) return err.message;
  if (err instanceof Error && (err.name === 'ActionError' || err.name === 'ForbiddenError')) {
    return err.message;
  }
  console.error('integration action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Nothing was changed; please try again.';
}

function refresh(orgId: string) {
  if (z.uuid().safeParse(orgId).success) revalidatePath(`/app/${orgId}/integrations`);
}

const strings = (form: FormData, name: string) =>
  form.getAll(name).filter((v): v is string => typeof v === 'string');

export async function createApiKeyAction(
  _prev: SecretResult,
  form: FormData,
): Promise<SecretResult> {
  const { user, orgId } = await context(form);
  try {
    const { key } = await (
      await getApiKeyStore()
    ).create(orgId, user, {
      name: text(form, 'name'),
      scopes: strings(form, 'scope') as never,
    });
    refresh(orgId);
    return { secret: key, ok: 'Use it as "Authorization: Bearer <key>".' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function revokeApiKeyAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { user, orgId } = await context(form);
  try {
    await (await getApiKeyStore()).revoke(orgId, user, text(form, 'key'));
    refresh(orgId);
    return { ok: 'Revoked. Calls with this key are refused from now on.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function createWebhookAction(
  _prev: SecretResult,
  form: FormData,
): Promise<SecretResult> {
  const { user, orgId } = await context(form);
  try {
    const { secret } = await (
      await getWebhookStore()
    ).create(orgId, user, {
      url: text(form, 'url'),
      events: strings(form, 'event') as never,
    });
    refresh(orgId);
    return { secret, ok: 'Check each delivery with it (see "Connect your systems").' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function removeWebhookAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { user, orgId } = await context(form);
  try {
    await (await getWebhookStore()).disable(orgId, user, text(form, 'webhook'));
    refresh(orgId);
    return { ok: 'Removed. Nothing more is sent to it.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function testWebhookAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { user, orgId } = await context(form);
  try {
    const status = await (await getWebhookStore()).sendTest(orgId, user, text(form, 'webhook'));
    refresh(orgId);
    return status === 'delivered'
      ? { ok: 'Test event delivered.' }
      : { error: 'The test event was not accepted. See the delivery log below.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function resendDeliveryAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { user, orgId } = await context(form);
  try {
    const status = await (await getWebhookStore()).resend(orgId, user, text(form, 'delivery'));
    refresh(orgId);
    return status === 'delivered'
      ? { ok: 'Delivered.' }
      : { error: 'Not accepted this time either.' };
  } catch (err) {
    return { error: problem(err) };
  }
}
