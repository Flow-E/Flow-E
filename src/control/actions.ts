import type { Ledger, PaymentRecord } from '../ledger/ledger.js';
import {
  findPayment,
  planCancel,
  planFreeze,
  planInvoice,
  planOrder,
  planKillSwitch,
  planResolve,
  type Actor,
} from './plan.js';

export { ActionError, effectiveStatus, type Actor } from './plan.js';

/**
 * What the human owner can do. Used by the CLI and the control panel; never exposed to agents.
 * Every action is a new signed ledger entry, checked and written in one write transaction.
 * The checks themselves live in plan.ts, shared with other stores.
 */

/** Approve or decline a payment that is waiting for review. */
export function resolvePayment(
  ledger: Ledger,
  id: string,
  status: 'approved' | 'declined',
  actor: Actor,
): PaymentRecord {
  return ledger.write(() => {
    const plan = planResolve(ledger.payments(), id, status, actor);
    ledger.append(plan.entry);
    return findPayment(ledger.payments(), plan.paymentId);
  });
}

/** Cancel an approved payment while its cooling-off window is still open. */
export function cancelCoolingOff(ledger: Ledger, id: string, actor: Actor): PaymentRecord {
  return ledger.write(() => {
    const plan = planCancel(ledger.payments(), id, actor);
    ledger.append(plan.entry);
    return findPayment(ledger.payments(), plan.paymentId);
  });
}

/** Record that an approved payment was ordered from the supplier. */
export function recordOrder(
  ledger: Ledger,
  id: string,
  actor: Actor & { reference?: string },
): PaymentRecord {
  return ledger.write(() => {
    const plan = planOrder(ledger.payments(), id, actor);
    ledger.append(plan.entry);
    return findPayment(ledger.payments(), plan.paymentId);
  });
}

/** Match the supplier's invoice to an approved payment. */
export function recordInvoice(
  ledger: Ledger,
  id: string,
  actor: Actor & { number: string; amount: number; currency: string },
): PaymentRecord {
  return ledger.write(() => {
    const plan = planInvoice(ledger.payments(), id, actor);
    ledger.append(plan.entry);
    return findPayment(ledger.payments(), plan.paymentId);
  });
}

/** Freeze or unfreeze one agent. Returns false when it was already in that state. */
export function setAgentFrozen(
  ledger: Ledger,
  agentId: string,
  frozen: boolean,
  actor: Actor,
): boolean {
  return ledger.write(() => {
    const entry = planFreeze(ledger.controls(), agentId, frozen, actor);
    if (!entry) return false;
    ledger.append(entry);
    return true;
  });
}

/** The global kill switch: when on, every agent's every payment is declined. */
export function setKillSwitch(ledger: Ledger, on: boolean, actor: Actor): boolean {
  return ledger.write(() => {
    const entry = planKillSwitch(ledger.controls(), on, actor);
    if (!entry) return false;
    ledger.append(entry);
    return true;
  });
}
