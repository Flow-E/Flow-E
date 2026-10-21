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
  type Ledger,
  type PaymentRecord,
} from '../ledger/ledger.js';

/**
 * What the human owner can do. Used by the CLI and the control panel; never exposed to agents.
 * Every action is a new signed ledger entry, checked and written in one write transaction.
 */

export class ActionError extends Error {
  override name = 'ActionError';
}

export interface Actor {
  /** Who acted, as recorded in the ledger (v1 has no accounts; this is a label). */
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

function findPayment(ledger: Ledger, id: string): PaymentRecord {
  const payment = ledger.payments().find((p) => p.paymentId === id || p.receiptId === id);
  if (!payment) throw new ActionError(`No payment "${id}".`);
  return payment;
}

/** Approve or decline a payment that is waiting for review. */
export function resolvePayment(
  ledger: Ledger,
  id: string,
  status: 'approved' | 'declined',
  actor: Actor,
): PaymentRecord {
  const { by, note } = checkActor(actor);
  return ledger.write(() => {
    const payment = findPayment(ledger, id);
    if (payment.status !== 'review') {
      throw new ActionError(
        `Payment ${payment.paymentId} is ${payment.status}, not waiting for review.`,
      );
    }
    // Cooling-off applies to the first approved payment to a supplier, whoever approved it.
    const key = normalizeName(payment.request.merchant);
    const known = ledger
      .payments(payment.agentId)
      .some((p) => p.status === 'approved' && normalizeName(p.request.merchant) === key);
    const cancellableUntil =
      status === 'approved' && !known ? new Date(actor.now + COOLING_OFF_MS).toISOString() : null;
    ledger.append({
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
    });
    return findPayment(ledger, payment.paymentId);
  });
}

/** Cancel an approved payment while its cooling-off window is still open. */
export function cancelCoolingOff(ledger: Ledger, id: string, actor: Actor): PaymentRecord {
  const { by, note } = checkActor(actor);
  return ledger.write(() => {
    const payment = findPayment(ledger, id);
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
    ledger.append({
      type: PAYMENT_CANCELLED,
      agentId: payment.agentId,
      now: actor.now,
      data: { payment_id: payment.paymentId, by, note },
    });
    return findPayment(ledger, payment.paymentId);
  });
}

/** Freeze or unfreeze one agent. Returns false when it was already in that state. */
export function setAgentFrozen(
  ledger: Ledger,
  agentId: string,
  frozen: boolean,
  actor: Actor,
): boolean {
  if (!AGENT_ID.test(agentId)) throw new ActionError(`"${agentId}" is not a valid agent id.`);
  const { by, note } = checkActor(actor);
  return ledger.write(() => {
    if ((ledger.controls().frozen[agentId]?.frozen ?? false) === frozen) return false;
    ledger.append({ type: AGENT_FREEZE, agentId, now: actor.now, data: { frozen, by, note } });
    return true;
  });
}

/** The global kill switch: when on, every agent's every payment is declined. */
export function setKillSwitch(ledger: Ledger, on: boolean, actor: Actor): boolean {
  const { by, note } = checkActor(actor);
  return ledger.write(() => {
    if ((ledger.controls().killSwitch?.on ?? false) === on) return false;
    ledger.append({
      type: KILL_SWITCH,
      agentId: ALL_AGENTS,
      now: actor.now,
      data: { on, by, note },
    });
    return true;
  });
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
