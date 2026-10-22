import { normalizeName } from '../engine/normalize.js';
import { COOLING_OFF_MS } from '../engine/rules.js';
import type { AgentStatus } from '../engine/types.js';
import {
  AGENT_FREEZE,
  ALL_AGENTS,
  KILL_SWITCH,
  PAYMENT_CANCELLED,
  PAYMENT_RESOLVED,
  type Controls,
  type EntryInput,
  type PaymentRecord,
} from '../ledger/fold.js';

/**
 * What a human owner may do, as pure checks: each plan validates the request against the
 * current payments or controls and returns the ledger entry to append (or null for a no-op).
 * Stores call these inside their own write transaction, so the check and the write are atomic.
 */

export class ActionError extends Error {
  override name = 'ActionError';
}

export interface Actor {
  /** Who acted, as recorded in the ledger. */
  by: string;
  note?: string | undefined;
  now: number;
}

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function checkActor(a: Actor): { by: string; note: string | null } {
  const by = a.by.trim();
  if (by === '' || by.length > 100) throw new ActionError('Say who is acting (1–100 characters).');
  const note = a.note?.trim() ?? '';
  if (note.length > 500) throw new ActionError('Notes are limited to 500 characters.');
  return { by, note: note === '' ? null : note };
}

export function findPayment(payments: readonly PaymentRecord[], id: string): PaymentRecord {
  const payment = payments.find((p) => p.paymentId === id || p.receiptId === id);
  if (!payment) throw new ActionError(`No payment "${id}".`);
  return payment;
}

/** Approve or decline a payment that is waiting for review. `payments`: all payments. */
export function planResolve(
  payments: readonly PaymentRecord[],
  id: string,
  status: 'approved' | 'declined',
  actor: Actor,
): { paymentId: string; entry: EntryInput } {
  const { by, note } = checkActor(actor);
  const payment = findPayment(payments, id);
  if (payment.status !== 'review') {
    throw new ActionError(
      `Payment ${payment.paymentId} is ${payment.status}, not waiting for review.`,
    );
  }
  // Cooling-off applies to the first approved payment to a supplier, whoever approved it.
  const key = normalizeName(payment.request.merchant);
  const known = payments.some(
    (p) =>
      p.agentId === payment.agentId &&
      p.status === 'approved' &&
      normalizeName(p.request.merchant) === key,
  );
  const cancellableUntil =
    status === 'approved' && !known ? new Date(actor.now + COOLING_OFF_MS).toISOString() : null;
  return {
    paymentId: payment.paymentId,
    entry: {
      type: PAYMENT_RESOLVED,
      agentId: payment.agentId,
      now: actor.now,
      data: {
        payment_id: payment.paymentId,
        status,
        by,
        note,
        cancellable_until: cancellableUntil,
      },
    },
  };
}

/** Cancel an approved payment while its cooling-off window is still open. */
export function planCancel(
  payments: readonly PaymentRecord[],
  id: string,
  actor: Actor,
): { paymentId: string; entry: EntryInput } {
  const { by, note } = checkActor(actor);
  const payment = findPayment(payments, id);
  if (payment.status !== 'approved') {
    throw new ActionError(
      `Payment ${payment.paymentId} is ${payment.status}; only approved payments can be cancelled.`,
    );
  }
  if (payment.cancellableUntil === null) {
    throw new ActionError(
      `Payment ${payment.paymentId} has no cooling-off window (the supplier was paid before).`,
    );
  }
  if (actor.now >= Date.parse(payment.cancellableUntil)) {
    throw new ActionError(
      `The cooling-off window for ${payment.paymentId} closed at ${payment.cancellableUntil}.`,
    );
  }
  return {
    paymentId: payment.paymentId,
    entry: {
      type: PAYMENT_CANCELLED,
      agentId: payment.agentId,
      now: actor.now,
      data: { payment_id: payment.paymentId, by, note },
    },
  };
}

/** Freeze or unfreeze one agent; null when it already is in that state. */
export function planFreeze(
  controls: Controls,
  agentId: string,
  frozen: boolean,
  actor: Actor,
): EntryInput | null {
  if (!AGENT_ID.test(agentId)) throw new ActionError(`"${agentId}" is not a valid agent id.`);
  const { by, note } = checkActor(actor);
  if ((controls.frozen[agentId]?.frozen ?? false) === frozen) return null;
  return { type: AGENT_FREEZE, agentId, now: actor.now, data: { frozen, by, note } };
}

/** Turn the global kill switch on or off; null when it already is. */
export function planKillSwitch(controls: Controls, on: boolean, actor: Actor): EntryInput | null {
  const { by, note } = checkActor(actor);
  if ((controls.killSwitch?.on ?? false) === on) return null;
  return { type: KILL_SWITCH, agentId: ALL_AGENTS, now: actor.now, data: { on, by, note } };
}

/** The status the engine sees: a human freeze overrides an active configuration. */
export function effectiveStatus(
  configured: AgentStatus,
  controls: Controls,
  agentId: string,
): AgentStatus {
  if (configured !== 'active') return configured;
  return controls.frozen[agentId]?.frozen === true ? 'frozen' : 'active';
}
