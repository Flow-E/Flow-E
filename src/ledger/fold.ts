import { randomBytes, type KeyObject } from 'node:crypto';
import { canonicalJson } from '../crypto/canonical.js';
import { issuerIdFor } from '../crypto/ed25519.js';
import type { EvaluationResult, LedgerEntryView, PaymentRequest } from '../engine/types.js';
import {
  GENESIS_HASH,
  entryHash,
  signHash,
  verifyHashSignature,
  type Entry,
  type EntryBody,
  type JsonValue,
} from './receipt.js';

/**
 * The storage-independent half of the ledger: entry types, building and signing entries,
 * folding entries into payments and controls, and auditing a chain. No I/O, so the SQLite
 * ledger and any other store (e.g. Postgres for the website) share exactly the same rules.
 */

/** Entry types. Status changes are new entries; nothing is ever updated in place. */
export const PAYMENT_DECISION = 'payment.decision';
/** A human approved or declined a payment that was in review. */
export const PAYMENT_RESOLVED = 'payment.resolved';
/** A human cancelled an approved payment inside its cooling-off window. */
export const PAYMENT_CANCELLED = 'payment.cancelled';
/** The approved purchase was ordered from the supplier (by the agent or a person). */
export const PAYMENT_ORDERED = 'payment.ordered';
/** The supplier's invoice was matched to the approved payment (by a person). */
export const PAYMENT_INVOICED = 'payment.invoiced';
export const AGENT_FREEZE = 'control.agent_freeze';
export const KILL_SWITCH = 'control.kill_switch';
/** agent_id used for entries that concern every agent. */
export const ALL_AGENTS = '*';

export interface Controls {
  killSwitch: { on: boolean; by: string; at: string } | null;
  frozen: Record<string, { frozen: boolean; by: string; at: string }>;
}

export interface Signer {
  issuer: string;
  privateKey: KeyObject;
}

/** An entry as stored: `data` is the exact canonical JSON text that was hashed. */
export interface StoredEntry {
  seq: number;
  id: string;
  type: string;
  agent_id: string;
  created_at: string;
  data: string;
  prev_hash: string;
  hash: string;
  signature: string;
}

export type AuditResult =
  | { ok: true; entries: number; head: { seq: number; hash: string } | null }
  | { ok: false; entries: number; firstBroken: { seq: number; id: string | null; reason: string } };

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export interface EntryInput {
  type: string;
  agentId: string;
  now: number;
  data: { [key: string]: JsonValue };
  id?: string;
}

/**
 * Build and sign the next entry after `prev` (null for the first). Throws on data that JSON
 * cannot hold exactly (undefined, NaN …), before anything is written.
 */
export function buildEntry(
  prev: { seq: number; hash: string } | null,
  input: EntryInput,
  signer: Signer,
): { entry: Entry; stored: StoredEntry } {
  const dataText = canonicalJson(input.data);
  const body: EntryBody = {
    seq: (prev?.seq ?? 0) + 1,
    id: input.id ?? newId('rcpt'),
    type: input.type,
    agent_id: input.agentId,
    created_at: new Date(input.now).toISOString(),
    data: input.data,
    prev_hash: prev?.hash ?? GENESIS_HASH,
  };
  const hash = entryHash(body);
  const entry: Entry = {
    ...body,
    hash,
    signature: signHash(signer.privateKey, signer.issuer, hash),
  };
  return { entry, stored: { ...entry, data: dataText } };
}

/** The data of a `payment.decision` entry. */
export function decisionData(input: {
  paymentId: string;
  request: PaymentRequest;
  result: EvaluationResult;
  baseCurrency: string;
}): { [key: string]: JsonValue } {
  const { request: r, result } = input;
  const request: { [key: string]: JsonValue } = {
    merchant: r.merchant,
    amount: r.amount,
    currency: r.currency,
    category: r.category,
    country: r.country,
  };
  if (r.memo !== undefined) request.memo = r.memo;
  if (r.item !== undefined) request.item = r.item;
  if (r.quantity !== undefined) request.quantity = r.quantity;
  if (r.project !== undefined) request.project = r.project;
  return {
    payment_id: input.paymentId,
    request,
    decision: result.decision,
    rule: result.rule,
    reason: result.reason,
    ...(result.guidance === undefined ? {} : { guidance: result.guidance }),
    amount_base: result.amountBase,
    base_currency: input.baseCurrency,
    cancellable_until:
      result.cancellableUntil === undefined
        ? null
        : new Date(result.cancellableUntil).toISOString(),
    trace: result.trace.map((t) => {
      const step: { [key: string]: JsonValue } = {
        rule: t.rule,
        outcome: t.outcome,
        detail: t.detail,
      };
      if (t.data) step.data = t.data;
      return step;
    }),
  };
}

export function fromStored(row: StoredEntry): Entry {
  return { ...row, data: JSON.parse(row.data) as Entry['data'] };
}

/** A payment as the agent and the owner see it. */
export interface PaymentRecord {
  paymentId: string;
  receiptId: string;
  agentId: string;
  status: 'approved' | 'declined' | 'review' | 'cancelled';
  /** The engine's original decision. */
  engineDecision: 'approved' | 'declined' | 'review';
  rule: string | null;
  reason: string;
  request: {
    merchant: string;
    amount: number;
    currency: string;
    category: string;
    country: string;
    memo?: string;
    item?: string;
    quantity?: number;
    project?: string;
  };
  amountBase: number | null;
  /** What the agent was told would get a yes, if the answer was no or not yet. */
  guidance?: string;
  /** What happened after approval: the order and the supplier's invoice. */
  fulfilment?: Fulfilment;
  baseCurrency: string;
  createdAt: string;
  cancellableUntil: string | null;
  /** "engine", or the person who last changed the status. */
  decidedBy: string;
  /** When a human last changed the status; null if never. */
  updatedAt: string | null;
  note: string | null;
}

export interface Fulfilment {
  ordered: { at: string; by: string; reference: string | null; note: string | null } | null;
  invoice: {
    at: string;
    by: string;
    number: string;
    /** Minor units of `currency`, the request's currency. */
    amount: number;
    currency: string;
    /** Invoice amount minus the approved amount; above 0 means it costs more than approved. */
    difference: number;
    note: string | null;
  } | null;
}

interface DecisionData {
  payment_id: string;
  request: PaymentRecord['request'];
  decision: PaymentRecord['engineDecision'];
  rule: string | null;
  reason: string;
  guidance?: string;
  amount_base: number | null;
  base_currency: string;
  cancellable_until: string | null;
}

interface HumanActionData {
  payment_id: string;
  status?: 'approved' | 'declined';
  by: string;
  note: string | null;
  cancellable_until?: string | null;
}

/** Every entry type that concerns a payment, in the order they can happen. */
export const PAYMENT_TYPES: ReadonlySet<string> = new Set([
  PAYMENT_DECISION,
  PAYMENT_RESOLVED,
  PAYMENT_CANCELLED,
  PAYMENT_ORDERED,
  PAYMENT_INVOICED,
]);

interface OrderData {
  payment_id: string;
  by: string;
  reference?: string | null;
  note?: string | null;
}

interface InvoiceData {
  payment_id: string;
  by: string;
  number: string;
  amount: number;
  currency: string;
  note?: string | null;
}

/**
 * Payments with their current status, oldest first: the engine's decision with any later human
 * approval, decline or cancellation folded in. Entries must be in sequence order; entries of
 * other types are ignored. Pass `agentId` to keep one agent's payments.
 */
export function foldPayments(
  rows: readonly Pick<StoredEntry, 'id' | 'type' | 'agent_id' | 'created_at' | 'data'>[],
  agentId?: string,
): PaymentRecord[] {
  const byId = new Map<string, PaymentRecord>();
  for (const row of rows) {
    if (!PAYMENT_TYPES.has(row.type)) continue;
    if (agentId !== undefined && row.agent_id !== agentId) continue;
    if (row.type === PAYMENT_DECISION) {
      const d = JSON.parse(row.data) as DecisionData;
      byId.set(d.payment_id, {
        paymentId: d.payment_id,
        receiptId: row.id,
        agentId: row.agent_id,
        status: d.decision,
        engineDecision: d.decision,
        rule: d.rule,
        reason: d.reason,
        request: d.request,
        amountBase: d.amount_base,
        baseCurrency: d.base_currency,
        createdAt: row.created_at,
        cancellableUntil: d.cancellable_until,
        decidedBy: 'engine',
        updatedAt: null,
        note: null,
        ...(d.guidance === undefined ? {} : { guidance: d.guidance }),
      });
      continue;
    }
    if (row.type === PAYMENT_ORDERED || row.type === PAYMENT_INVOICED) {
      // After-approval facts: they never change the decision, who made it or when.
      const d = JSON.parse(row.data) as OrderData & Partial<InvoiceData>;
      const p = byId.get(d.payment_id);
      if (!p) continue;
      const f = (p.fulfilment ??= { ordered: null, invoice: null });
      if (row.type === PAYMENT_ORDERED) {
        f.ordered = {
          at: row.created_at,
          by: d.by,
          reference: d.reference ?? null,
          note: d.note ?? null,
        };
      } else {
        const amount = d.amount ?? 0;
        f.invoice = {
          at: row.created_at,
          by: d.by,
          number: d.number ?? '',
          amount,
          currency: d.currency ?? p.request.currency,
          difference: amount - p.request.amount,
          note: d.note ?? null,
        };
      }
      continue;
    }
    const d = JSON.parse(row.data) as HumanActionData;
    const p = byId.get(d.payment_id);
    if (!p) continue;
    p.decidedBy = d.by;
    p.updatedAt = row.created_at;
    p.note = d.note;
    if (row.type === PAYMENT_CANCELLED) {
      p.status = 'cancelled';
      p.cancellableUntil = null;
    } else if (d.status) {
      p.status = d.status;
      p.cancellableUntil = d.cancellable_until ?? null;
    }
  }
  return [...byId.values()];
}

/** Kill switch and per-agent freezes, as last set by a human. Entries in sequence order. */
export function foldControls(
  rows: readonly Pick<StoredEntry, 'type' | 'agent_id' | 'created_at' | 'data'>[],
): Controls {
  const controls: Controls = { killSwitch: null, frozen: {} };
  for (const row of rows) {
    if (row.type !== KILL_SWITCH && row.type !== AGENT_FREEZE) continue;
    const d = JSON.parse(row.data) as { on?: boolean; frozen?: boolean; by: string };
    if (row.type === KILL_SWITCH) {
      controls.killSwitch = { on: d.on === true, by: d.by, at: row.created_at };
    } else {
      controls.frozen[row.agent_id] = { frozen: d.frozen === true, by: d.by, at: row.created_at };
    }
  }
  return controls;
}

/** Payments shaped for the policy engine. */
export function toEngineViews(payments: readonly PaymentRecord[]): LedgerEntryView[] {
  return payments.map((p) => ({
    id: p.paymentId,
    merchant: p.request.merchant,
    amountBase: p.amountBase ?? 0,
    status: p.status,
    createdAt: Date.parse(p.createdAt),
    rule: p.rule,
    ...(p.request.project === undefined ? {} : { project: p.request.project }),
  }));
}

/**
 * Check a whole chain: sequence, links, canonical data, hashes and signatures. Stops at the
 * first broken entry, because everything after it can no longer be trusted. Rows in seq order.
 */
export function auditEntries(
  rows: Iterable<StoredEntry>,
  issuer: string,
  publicKey: KeyObject,
): AuditResult {
  const keyId = issuerIdFor(publicKey);
  if (keyId !== issuer) {
    return {
      ok: false,
      entries: 0,
      firstBroken: {
        seq: 0,
        id: null,
        reason: `the ledger is bound to issuer ${issuer}, but the public key is ${keyId}`,
      },
    };
  }
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const broken = (reason: string): AuditResult => ({
      ok: false,
      entries: expectedSeq - 1,
      firstBroken: { seq: row.seq, id: typeof row.id === 'string' ? row.id : null, reason },
    });
    if (row.seq > expectedSeq) {
      // The first broken position is the gap itself, not the row after it.
      return {
        ok: false,
        entries: expectedSeq - 1,
        firstBroken: {
          seq: expectedSeq,
          id: null,
          reason: `entry #${expectedSeq} is missing (next entry found is #${row.seq})`,
        },
      };
    }
    if (row.seq !== expectedSeq) return broken(`unexpected sequence number ${row.seq}`);
    if (row.prev_hash !== prevHash) {
      return broken(`does not link to entry #${expectedSeq - 1} (prev_hash mismatch)`);
    }
    let entry: Entry;
    try {
      entry = fromStored(row);
      if (canonicalJson(entry.data) !== row.data) throw new Error('not canonical');
    } catch {
      return broken('data is not valid canonical JSON (edited by hand?)');
    }
    if (entryHash(entry) !== row.hash) {
      return broken('contents do not match the stored hash (edited after writing)');
    }
    if (!verifyHashSignature(publicKey, issuer, row.hash, row.signature)) {
      return broken('issuer signature is not valid (hash rewritten without the issuer key)');
    }
    prevHash = row.hash;
    expectedSeq += 1;
  }
  const count = expectedSeq - 1;
  return { ok: true, entries: count, head: count === 0 ? null : { seq: count, hash: prevHash } };
}
