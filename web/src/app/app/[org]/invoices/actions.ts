'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError, z } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import { text } from '@/lib/form';
import type { User } from '@/server/org-store';
import { ForbiddenError } from '@/server/permissions';
import { getOrgStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * Invoice actions for organisations. The organisation id comes from the form; the store checks
 * the signed-in user's role in it (invoice.record) before anything is written.
 */

interface Result {
  ok?: string;
  error?: string;
}

async function context(form: FormData) {
  const session = await getSession();
  if (!session) redirect('/login?next=/app');
  const user: User = { userId: session.userId, email: session.email };
  return { store: await getOrgStore(), user, orgId: text(form, 'org') };
}

function problem(err: unknown): string {
  if (err instanceof ActionError || err instanceof ForbiddenError) return err.message;
  // By name too: in development the cached store can come from an older copy of the modules.
  if (err instanceof Error && (err.name === 'ActionError' || err.name === 'ForbiddenError')) {
    return err.message;
  }
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join(' ');
  console.error('invoice action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Nothing was recorded; please try again.';
}

const optional = (form: FormData, name: string) => {
  const v = text(form, name).trim();
  return v === '' ? undefined : v;
};

/** Record a typed-in invoice, or confirm one read from an uploaded file; then open it. */
export async function addInvoiceAction(_prev: Result, form: FormData): Promise<Result> {
  const { store, user, orgId } = await context(form);
  if (!z.uuid().safeParse(orgId).success) return { error: 'No such organisation.' };
  let invoiceId: string;
  try {
    ({ invoiceId } = await store.addInvoice(orgId, user, {
      supplier: text(form, 'supplier'),
      number: text(form, 'number'),
      invoiceDate: text(form, 'invoiceDate'),
      amount: text(form, 'amount'),
      currency: text(form, 'currency'),
      reference: optional(form, 'reference'),
      source: text(form, 'source') === 'extracted' ? 'extracted' : 'manual',
      fileId: optional(form, 'fileId'),
    }));
  } catch (err) {
    return { error: problem(err) };
  }
  revalidatePath(`/app/${orgId}`, 'layout');
  redirect(`/app/${orgId}/invoices/${invoiceId}`);
}

export async function resolveInvoiceAction(_prev: Result, form: FormData): Promise<Result> {
  const { store, user, orgId } = await context(form);
  const outcome = text(form, 'outcome') === 'accepted' ? 'accepted' : 'rejected';
  const note = optional(form, 'note');
  if (outcome === 'rejected' && !note) return { error: 'Give a short reason for rejecting.' };
  try {
    await store.resolveInvoice(orgId, user, text(form, 'id'), outcome, note);
  } catch (err) {
    return { error: problem(err) };
  }
  if (z.uuid().safeParse(orgId).success) revalidatePath(`/app/${orgId}`, 'layout');
  return { ok: outcome === 'accepted' ? 'Accepted.' : 'Rejected.' };
}
