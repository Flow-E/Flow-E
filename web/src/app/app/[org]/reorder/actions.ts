'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import { text } from '@/lib/form';
import type { User } from '@/server/org-store';
import { siteOrigin } from '@/server/origin';
import { ForbiddenError } from '@/server/permissions';
import { MAX_ITEMS, type ItemInput } from '@/server/reorder';
import { modelFromEnv } from '@/server/reorder-agent';
import { getReorderStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * Reorder actions. The organisation id comes from the form; the store checks the signed-in
 * user's role in it (reorder.manage, reorder.run) before anything is written or run.
 */

export interface ReorderResult {
  ok?: string;
  error?: string;
}

async function context(form: FormData) {
  const session = await getSession();
  if (!session) redirect('/login?next=/app');
  const user: User = { userId: session.userId, email: session.email };
  return { store: await getReorderStore(), user, orgId: text(form, 'org') };
}

function problem(err: unknown): string {
  if (err instanceof ActionError || err instanceof ForbiddenError) return err.message;
  if (err instanceof Error && (err.name === 'ActionError' || err.name === 'ForbiddenError')) {
    return err.message;
  }
  console.error('reorder action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Please try again.';
}

function refresh(orgId: string) {
  if (z.uuid().safeParse(orgId).success) revalidatePath(`/app/${orgId}`, 'layout');
}

const FIELDS = [
  'item',
  'supplier',
  'quantity',
  'stock',
  'minStock',
  'category',
  'country',
] as const;

/** The list's rows from the form: one value per field per row, in order; empty rows dropped. */
function rows(form: FormData): ItemInput[] {
  const cols = Object.fromEntries(
    FIELDS.map((f) => [f, form.getAll(f).map((v) => (typeof v === 'string' ? v : ''))]),
  ) as Record<(typeof FIELDS)[number], string[]>;
  const n = Math.min(cols.item.length, MAX_ITEMS + 1);
  const out: ItemInput[] = [];
  for (let i = 0; i < n; i++) {
    const row = Object.fromEntries(FIELDS.map((f) => [f, cols[f][i] ?? ''])) as Record<
      (typeof FIELDS)[number],
      string
    >;
    if (FIELDS.every((f) => row[f].trim() === '')) continue;
    out.push(row);
  }
  return out;
}

export async function saveReorderAction(
  _prev: ReorderResult,
  form: FormData,
): Promise<ReorderResult> {
  const { store, user, orgId } = await context(form);
  try {
    const list = rows(form);
    await store.saveItems(orgId, user, list);
    refresh(orgId);
    return { ok: `Saved ${String(list.length)} ${list.length === 1 ? 'item' : 'items'}.` };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function runReorderAction(
  _prev: ReorderResult,
  form: FormData,
): Promise<ReorderResult> {
  const { store, user, orgId } = await context(form);
  try {
    const run = await store.run(orgId, user, {
      agentId: text(form, 'agent'),
      origin: await siteOrigin(),
      callModel: modelFromEnv(),
    });
    refresh(orgId);
    return {
      ok:
        run.status === 'finished'
          ? 'The run finished. Its log is below.'
          : `The run ${run.status === 'failed' ? 'failed' : 'stopped early'}. Its log is below.`,
    };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function decideSuggestionAction(
  _prev: ReorderResult,
  form: FormData,
): Promise<ReorderResult> {
  const { store, user, orgId } = await context(form);
  const decision = text(form, 'decision') === 'accept' ? 'accept' : 'dismiss';
  try {
    await store.decideSuggestion(orgId, user, text(form, 'id'), decision);
    refresh(orgId);
    return { ok: decision === 'accept' ? 'Added to the reorder list.' : 'Dismissed.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function linkSuggestionAction(
  _prev: ReorderResult,
  form: FormData,
): Promise<ReorderResult> {
  const { store, user, orgId } = await context(form);
  try {
    await store.linkSuggestion(orgId, user, text(form, 'id'), text(form, 'price_item'));
    refresh(orgId);
    return { ok: 'Linked to the price list.' };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function autoIncludeAction(
  _prev: ReorderResult,
  form: FormData,
): Promise<ReorderResult> {
  const { store, user, orgId } = await context(form);
  const on = text(form, 'on') === 'true';
  try {
    await store.setAutoInclude(orgId, user, on);
    refresh(orgId);
    return {
      ok: on
        ? 'Suggestions join the next run automatically.'
        : 'Suggestions wait for a person again.',
    };
  } catch (err) {
    return { error: problem(err) };
  }
}
