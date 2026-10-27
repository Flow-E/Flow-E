'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import { text } from '@/lib/form';
import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/** Sandbox invoice actions: the signed-in user's own sandbox only, typed-in invoices only. */

interface Result {
  ok?: string;
  error?: string;
}

async function context() {
  const session = await getSession();
  if (!session) redirect('/login');
  return {
    store: await getStore(),
    ownerId: session.userId,
    actor: { by: `${session.email} (sandbox)` },
  };
}

function problem(err: unknown): string {
  if (err instanceof ActionError) return err.message;
  if (err instanceof Error && err.name === 'ActionError') return err.message;
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join(' ');
  console.error('sandbox invoice action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Nothing was recorded; please try again.';
}

const optional = (form: FormData, name: string) => {
  const v = text(form, name).trim();
  return v === '' ? undefined : v;
};

export async function addSandboxInvoiceAction(_prev: Result, form: FormData): Promise<Result> {
  const { store, ownerId, actor } = await context();
  let invoiceId: string;
  try {
    ({ invoiceId } = await store.addInvoice(
      ownerId,
      {
        supplier: text(form, 'supplier'),
        number: text(form, 'number'),
        invoiceDate: text(form, 'invoiceDate'),
        amount: text(form, 'amount'),
        currency: text(form, 'currency'),
        reference: optional(form, 'reference'),
      },
      actor,
    ));
  } catch (err) {
    return { error: problem(err) };
  }
  revalidatePath('/sandbox', 'layout');
  redirect(`/sandbox/invoices/${invoiceId}`);
}

export async function resolveSandboxInvoiceAction(_prev: Result, form: FormData): Promise<Result> {
  const { store, ownerId, actor } = await context();
  const outcome = text(form, 'outcome') === 'accepted' ? 'accepted' : 'rejected';
  const note = optional(form, 'note');
  if (outcome === 'rejected' && !note) return { error: 'Give a short reason for rejecting.' };
  try {
    await store.resolveInvoice(ownerId, text(form, 'id'), outcome, { ...actor, note });
  } catch (err) {
    return { error: problem(err) };
  }
  revalidatePath('/sandbox', 'layout');
  return { ok: outcome === 'accepted' ? 'Accepted.' : 'Rejected.' };
}
