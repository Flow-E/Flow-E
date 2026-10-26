'use server';

import { text, texts } from '@/lib/form';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError, z } from 'zod';
import { ActionError, ConfigError, ReceiptError } from '@flow-e/mcp/core';
import { money, ruleName } from '@/lib/format';
import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';
import type { PaymentOutcome, TraceStep } from '@/server/store';

/**
 * Sandbox actions. Every one checks the session first and works only on the signed-in user's
 * own sandbox (the store resolves it from the session; no sandbox id comes from the form).
 */

export interface ActionResult {
  ok?: string;
  error?: string;
}

export interface OutcomeView {
  paymentId: string;
  label: string;
  decision: 'approved' | 'declined' | 'review';
  rule: string;
  reason: string;
  amount: string;
  amountBase: string | null;
  trace: TraceStep[];
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
  if (err instanceof ActionError || err instanceof ConfigError || err instanceof ReceiptError) {
    return err.message;
  }
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join(' ');
  console.error('sandbox action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Nothing was changed; please try again.';
}

function refresh() {
  revalidatePath('/sandbox', 'layout');
}

const note = (form: FormData) => {
  const n = text(form, 'note').trim();
  return n === '' ? undefined : n;
};

function view(o: PaymentOutcome, baseCurrency = 'CHF'): OutcomeView {
  return {
    paymentId: o.paymentId,
    label: o.label,
    decision: o.result.decision,
    rule: ruleName(o.result.rule),
    reason: o.result.reason,
    amount: money(o.amount, o.currency),
    amountBase: o.result.amountBase === null ? null : money(o.result.amountBase, baseCurrency),
    trace: o.result.trace,
  };
}

// Owner actions ---------------------------------------------------------------------------------

export async function resolveAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, ownerId, actor } = await context();
  const status = form.get('status') === 'approved' ? 'approved' : 'declined';
  try {
    await store.resolve(ownerId, text(form, 'id'), status, { ...actor, note: note(form) });
  } catch (err) {
    return { error: problem(err) };
  }
  refresh();
  return { ok: status === 'approved' ? 'Approved.' : 'Declined.' };
}

export async function cancelAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, ownerId, actor } = await context();
  try {
    await store.cancel(ownerId, text(form, 'id'), { ...actor, note: note(form) });
  } catch (err) {
    return { error: problem(err) };
  }
  refresh();
  return { ok: 'Cancelled.' };
}

export async function freezeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, ownerId, actor } = await context();
  const frozen = form.get('frozen') === 'true';
  try {
    await store.setFrozen(ownerId, text(form, 'agentId'), frozen, actor);
  } catch (err) {
    return { error: problem(err) };
  }
  refresh();
  return { ok: frozen ? 'Frozen.' : 'Unfrozen.' };
}

export async function killSwitchAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, ownerId, actor } = await context();
  const on = form.get('on') === 'true';
  try {
    await store.setKillSwitch(ownerId, on, { ...actor, note: note(form) });
  } catch (err) {
    return { error: problem(err) };
  }
  refresh();
  return { ok: on ? 'Every agent is stopped.' : 'Kill switch released.' };
}

/** Fill an empty sandbox with 30 days of fictional history, for the dashboard. */
export async function sampleHistoryAction(_prev: ActionResult): Promise<ActionResult> {
  const { store, ownerId, actor } = await context();
  try {
    await store.fillSampleHistory(ownerId, actor);
  } catch (err) {
    return { error: problem(err) };
  }
  refresh();
  return { ok: 'Filled with 30 days of fictional history.' };
}

// The fake agent --------------------------------------------------------------------------------

export interface RequestState {
  outcomes?: OutcomeView[];
  error?: string;
}

export async function requestPaymentAction(
  _prev: RequestState,
  form: FormData,
): Promise<RequestState> {
  const { store, ownerId } = await context();
  try {
    const outcome = await store.requestPayment(
      ownerId,
      {
        agentId: text(form, 'agentId', 'lab-procurement'),
        merchant: text(form, 'merchant'),
        amount: text(form, 'amount'),
        currency: text(form, 'currency'),
        category: text(form, 'category'),
        country: text(form, 'country'),
        ...(note(form) ? { memo: note(form) } : {}),
      },
      text(form, 'label') || undefined,
    );
    refresh();
    return { outcomes: [view(outcome)] };
  } catch (err) {
    return { error: problem(err) };
  }
}

export async function storyAction(_prev: RequestState): Promise<RequestState> {
  const { store, ownerId } = await context();
  try {
    const outcomes = await store.playStory(ownerId);
    refresh();
    return { outcomes: outcomes.map((o) => view(o)) };
  } catch (err) {
    return { error: problem(err) };
  }
}

// Mandate ---------------------------------------------------------------------------------------

const list = (value: string, separator: RegExp) =>
  value
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s !== '');
const codes = (value: string) => list(value, /[\s,]+/).map((s) => s.toUpperCase());
const lines = (value: string) => list(value, /\r?\n/);

const agentIds = z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/));

export async function updateMandateAction(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { store, ownerId, actor } = await context();
  try {
    const current = (await store.view(ownerId)).raw;
    const fx: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      const m = /^fx\.([A-Z]{3,5})$/.exec(k);
      if (m?.[1] && typeof v === 'string') fx[m[1]] = v.trim();
    }
    const agents: Record<string, unknown> = {};
    for (const id of agentIds.parse(texts(form, 'agent'))) {
      const f = (name: string, fallback = '') => text(form, `${id}.${name}`, fallback).trim();
      const approval = f('approval_above');
      agents[id] = {
        owner: f('owner'),
        status: f('status', 'active'),
        daily_budget: f('daily_budget'),
        per_payment_limit: f('per_payment_limit'),
        ...(approval === '' ? {} : { approval_above: approval }),
        currencies: codes(f('currencies')),
        categories: list(f('categories'), /[\s,]+/),
        suppliers: {
          mode: f('supplier_mode', 'any'),
          allow: lines(f('allow')),
          block: lines(f('block')),
        },
        blocked_countries: codes(f('blocked_countries')),
        velocity_per_minute: Number(f('velocity_per_minute')),
        business_hours_only: f('business_hours_only') === 'on',
      };
    }
    const raw: Record<string, unknown> = {
      ...(current.organisation === undefined ? {} : { organisation: current.organisation }),
      base_currency: current.base_currency,
      timezone: text(form, 'timezone').trim(),
      fx,
      ...(current.currency_decimals === undefined
        ? {}
        : { currency_decimals: current.currency_decimals }),
      blocked_countries: codes(text(form, 'blocked_countries')),
      blocked_suppliers: lines(text(form, 'blocked_suppliers')),
      business_hours: {
        days: texts(form, 'days').map(Number),
        start: text(form, 'start'),
        end: text(form, 'end'),
      },
      agents,
    };
    await store.updateConfig(ownerId, raw, { ...actor, note: note(form) });
  } catch (err) {
    return { error: problem(err).replace(/^mandate\.yaml is invalid:\n?/, 'Not saved:\n') };
  }
  refresh();
  return { ok: 'Saved. The new mandate applies to the next request.' };
}

export async function resetAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const { store, ownerId } = await context();
  if (text(form, 'confirm').trim().toLowerCase() !== 'reset') {
    return { error: 'Type reset to confirm.' };
  }
  try {
    await store.resetSandbox(ownerId);
  } catch (err) {
    return { error: problem(err) };
  }
  refresh();
  return { ok: 'Started over: new keys, empty ledger, the original mandate.' };
}

// Receipts --------------------------------------------------------------------------------------

export interface VerifyState {
  valid?: boolean;
  checks?: string[];
  error?: string;
}

export async function verifyAction(_prev: VerifyState, form: FormData): Promise<VerifyState> {
  const { store, ownerId } = await context();
  const receipt = text(form, 'receipt');
  if (receipt.trim() === '') return { error: 'Paste a receipt first.' };
  if (receipt.length > 200_000) return { error: 'That is too long to be a receipt.' };
  try {
    return await store.verify(ownerId, receipt);
  } catch (err) {
    return { error: problem(err) };
  }
}
