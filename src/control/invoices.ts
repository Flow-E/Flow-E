import { hasRate, toBaseMinor } from '../engine/fx.js';
import { normalizeCode, normalizeName } from '../engine/normalize.js';
import type { GlobalPolicy } from '../engine/types.js';
import {
  ALL_AGENTS,
  INVOICE_RECORDED,
  INVOICE_RESOLVED,
  newId,
  type EntryInput,
  type PaymentRecord,
  type StoredEntry,
} from '../ledger/fold.js';
import { ActionError, type Actor } from './plan.js';

/**
 * Supplier invoices, matched against what Flow-E authorized. Pure: the matcher and the plans
 * read payments and earlier invoices and return the ledger entry to append. Every invoice that
 * is recorded, and every decision a person takes on one, is a signed ledger entry.
 */

export { INVOICE_RECORDED, INVOICE_RESOLVED };
export type { InvoiceMatch } from '../ledger/fold.js';
import type { InvoiceMatch } from '../ledger/fold.js';

export interface InvoiceInput {
  supplier: string;
  number: string;
  /** YYYY-MM-DD as printed on the invoice. */
  invoiceDate: string;
  /** Minor units of `currency`. */
  amount: number;
  currency: string;
  /** Usually the payment id the agent quoted; may be empty. */
  reference?: string;
  /** "manual", or "extracted" when the fields came from a document and a person confirmed them. */
  source: 'manual' | 'extracted';
}

export interface InvoiceRecord {
  invoiceId: string;
  supplier: string;
  number: string;
  invoiceDate: string;
  amount: number;
  currency: string;
  reference: string | null;
  paymentId: string | null;
  match: InvoiceMatch;
  /** Invoice amount minus the authorized amount, in the invoice currency; null if unknown. */
  difference: number | null;
  /** Why it matched or not, in plain words. */
  explanation: string;
  source: 'manual' | 'extracted';
  recordedBy: string;
  recordedAt: string;
  /** A person's decision on an invoice that did not match; null while it waits. */
  resolution: {
    outcome: 'accepted' | 'rejected';
    by: string;
    at: string;
    note: string | null;
  } | null;
}

/** Waiting for a person: did not match, and nobody has decided yet. */
export function needsReview(i: InvoiceRecord): boolean {
  return i.match !== 'matched' && i.resolution === null;
}

const PAYMENT_ID = /\bpay_[0-9a-f]{20}\b/;

/** The tolerated difference in base minor units: a percentage, but never below the minimum. */
function tolerance(policy: GlobalPolicy, authorizedBase: number): number {
  const check = policy.invoiceCheck ?? { tolerancePercent: 2, toleranceMinBase: 0 };
  return Math.max(
    Math.ceil((authorizedBase * check.tolerancePercent) / 100),
    check.toleranceMinBase,
  );
}

export interface MatchResult {
  match: InvoiceMatch;
  paymentId: string | null;
  difference: number | null;
  explanation: string;
}

/**
 * Match an invoice: duplicates first (same supplier and number), then by reference (a payment
 * id), then by supplier and amount among approved payments without an invoice. Within the
 * tolerance it matches; outside it is a mismatch; with no authorization it is unmatched.
 */
export function matchInvoice(input: {
  invoice: InvoiceInput;
  payments: readonly PaymentRecord[];
  invoices: readonly InvoiceRecord[];
  policy: GlobalPolicy;
}): MatchResult {
  const { invoice, payments, invoices, policy } = input;
  const supplier = normalizeName(invoice.supplier);
  const currency = normalizeCode(invoice.currency);

  const twin = invoices.find(
    (i) =>
      normalizeName(i.supplier) === supplier &&
      normalizeName(i.number) === normalizeName(invoice.number) &&
      i.resolution?.outcome !== 'rejected',
  );
  if (twin) {
    return {
      match: 'duplicate',
      paymentId: twin.paymentId,
      difference: null,
      explanation: `Invoice ${twin.number} from ${twin.supplier} was already recorded on ${twin.recordedAt.slice(0, 10)}.`,
    };
  }

  const invoiced = new Set(
    invoices
      .filter((i) => i.paymentId !== null && i.resolution?.outcome !== 'rejected')
      .map((i) => i.paymentId),
  );
  const toBase = (minor: number) =>
    currency === policy.baseCurrency
      ? minor
      : hasRate(currency, policy)
        ? toBaseMinor(minor, currency, policy)
        : null;

  const compare = (p: PaymentRecord, how: string): MatchResult => {
    if (normalizeCode(p.request.currency) !== currency) {
      return {
        match: 'mismatch',
        paymentId: p.paymentId,
        difference: null,
        explanation: `${how}, but the invoice is in ${currency} and the authorization in ${p.request.currency}.`,
      };
    }
    const difference = invoice.amount - p.request.amount;
    const diffBase = toBase(Math.abs(difference));
    const authorizedBase = p.amountBase ?? toBase(p.request.amount) ?? 0;
    const allowed = tolerance(policy, authorizedBase);
    if (diffBase !== null && diffBase <= allowed) {
      return {
        match: 'matched',
        paymentId: p.paymentId,
        difference,
        explanation: `${how}; the amount is within the tolerance.`,
      };
    }
    return {
      match: 'mismatch',
      paymentId: p.paymentId,
      difference,
      explanation: `${how}, but the amount differs by more than the tolerance.`,
    };
  };

  const referenced = (invoice.reference ?? '').match(PAYMENT_ID)?.[0];
  if (referenced) {
    const p = payments.find((x) => x.paymentId === referenced);
    if (!p) {
      return {
        match: 'unmatched',
        paymentId: null,
        difference: null,
        explanation: `The reference ${referenced} is not a payment of this organisation.`,
      };
    }
    if (p.status !== 'approved') {
      return {
        match: 'unmatched',
        paymentId: p.paymentId,
        difference: null,
        explanation: `Payment ${p.paymentId} is ${p.status}, not approved.`,
      };
    }
    if (invoiced.has(p.paymentId)) {
      return {
        match: 'duplicate',
        paymentId: p.paymentId,
        difference: null,
        explanation: `Payment ${p.paymentId} already has an invoice.`,
      };
    }
    return compare(p, `Matched by reference ${p.paymentId}`);
  }

  const open = payments.filter(
    (p) =>
      p.status === 'approved' &&
      !invoiced.has(p.paymentId) &&
      normalizeName(p.request.merchant) === supplier &&
      normalizeCode(p.request.currency) === currency,
  );
  const closest = [...open].sort(
    (a, b) =>
      Math.abs(a.request.amount - invoice.amount) - Math.abs(b.request.amount - invoice.amount) ||
      a.createdAt.localeCompare(b.createdAt),
  )[0];
  if (!closest) {
    return {
      match: 'unmatched',
      paymentId: null,
      difference: null,
      explanation: `No approved payment to ${invoice.supplier} in ${currency} is waiting for an invoice.`,
    };
  }
  const result = compare(closest, `Matched by supplier and amount to ${closest.paymentId}`);
  // Without a reference, only a match inside the tolerance is trusted; otherwise a person picks.
  return result.match === 'matched' || open.length === 1
    ? result
    : {
        match: 'unmatched',
        paymentId: null,
        difference: null,
        explanation: `No approved payment to ${invoice.supplier} matches this amount; ${String(open.length)} are waiting for an invoice.`,
      };
}

const REFERENCE = /^[\p{L}\p{N} ._/#:-]{1,80}$/u;

function clean(value: string, what: string, required: boolean): string | null {
  const v = value.trim();
  if (v === '') {
    if (required) throw new ActionError(`Enter the ${what}.`);
    return null;
  }
  if (!REFERENCE.test(v)) {
    throw new ActionError(`${what}: up to 80 letters, digits, spaces and . _ / # : -`);
  }
  return v;
}

/** Record an invoice and its match. `actor.by` is the person who entered or confirmed it. */
export function planInvoiceRecord(input: {
  invoice: InvoiceInput;
  payments: readonly PaymentRecord[];
  invoices: readonly InvoiceRecord[];
  policy: GlobalPolicy;
  actor: Actor;
}): { invoiceId: string; match: MatchResult; entry: EntryInput } {
  const { invoice, actor } = input;
  const by = actor.by.trim();
  if (by === '' || by.length > 100) throw new ActionError('Say who is acting (1–100 characters).');
  const supplier = invoice.supplier.trim();
  if (supplier === '' || supplier.length > 200) throw new ActionError('Enter the supplier.');
  const number = clean(invoice.number, 'invoice number', true) ?? '';
  const reference = clean(invoice.reference ?? '', 'reference', false);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(invoice.invoiceDate) ||
    Number.isNaN(Date.parse(invoice.invoiceDate))
  ) {
    throw new ActionError('Enter the invoice date as YYYY-MM-DD.');
  }
  if (!Number.isSafeInteger(invoice.amount) || invoice.amount <= 0) {
    throw new ActionError('Enter the invoice total, above 0.');
  }
  const currency = normalizeCode(invoice.currency);
  if (!/^[A-Z]{3,5}$/.test(currency)) throw new ActionError('Enter a currency code such as CHF.');
  const normalized: InvoiceInput = {
    ...invoice,
    supplier,
    number,
    currency,
    ...(reference === null ? {} : { reference }),
  };
  const match = matchInvoice({ ...input, invoice: normalized });
  const agentId =
    (match.paymentId && input.payments.find((p) => p.paymentId === match.paymentId)?.agentId) ||
    ALL_AGENTS;
  const invoiceId = newId('inv');
  const note = actor.note?.trim() ?? '';
  return {
    invoiceId,
    match,
    entry: {
      type: INVOICE_RECORDED,
      agentId,
      now: actor.now,
      data: {
        invoice_id: invoiceId,
        supplier,
        number,
        invoice_date: invoice.invoiceDate,
        amount: invoice.amount,
        currency,
        reference,
        payment_id: match.paymentId,
        match: match.match,
        difference: match.difference,
        explanation: match.explanation,
        source: invoice.source,
        by,
        note: note === '' ? null : note.slice(0, 500),
      },
    },
  };
}

/** A person's decision on an invoice that did not match: accept it anyway, or reject it. */
export function planInvoiceResolve(
  invoices: readonly InvoiceRecord[],
  id: string,
  outcome: 'accepted' | 'rejected',
  actor: Actor,
): EntryInput {
  const invoice = invoices.find((i) => i.invoiceId === id);
  if (!invoice) throw new ActionError(`No invoice "${id}".`);
  if (!needsReview(invoice)) {
    throw new ActionError(
      invoice.match === 'matched'
        ? `Invoice ${invoice.number} matched; there is nothing to decide.`
        : `Invoice ${invoice.number} was already ${invoice.resolution?.outcome ?? 'decided'}.`,
    );
  }
  const by = actor.by.trim();
  if (by === '' || by.length > 100) throw new ActionError('Say who is acting (1–100 characters).');
  const note = actor.note?.trim() ?? '';
  if (outcome === 'rejected' && note === '') {
    throw new ActionError('Give a short reason for rejecting the invoice.');
  }
  return {
    type: INVOICE_RESOLVED,
    agentId: ALL_AGENTS,
    now: actor.now,
    data: { invoice_id: id, outcome, by, note: note === '' ? null : note.slice(0, 500) },
  };
}

interface RecordedData {
  invoice_id: string;
  supplier: string;
  number: string;
  invoice_date: string;
  amount: number;
  currency: string;
  reference: string | null;
  payment_id: string | null;
  match: InvoiceMatch;
  difference: number | null;
  explanation: string;
  source: 'manual' | 'extracted';
  by: string;
}

/** Invoices with their current state, oldest first. Entries must be in sequence order. */
export function foldInvoices(
  rows: readonly Pick<StoredEntry, 'type' | 'created_at' | 'data'>[],
): InvoiceRecord[] {
  const byId = new Map<string, InvoiceRecord>();
  for (const row of rows) {
    if (row.type === INVOICE_RECORDED) {
      const d = JSON.parse(row.data) as RecordedData;
      byId.set(d.invoice_id, {
        invoiceId: d.invoice_id,
        supplier: d.supplier,
        number: d.number,
        invoiceDate: d.invoice_date,
        amount: d.amount,
        currency: d.currency,
        reference: d.reference,
        paymentId: d.payment_id,
        match: d.match,
        difference: d.difference,
        explanation: d.explanation,
        source: d.source,
        recordedBy: d.by,
        recordedAt: row.created_at,
        resolution: null,
      });
    } else if (row.type === INVOICE_RESOLVED) {
      const d = JSON.parse(row.data) as {
        invoice_id: string;
        outcome: 'accepted' | 'rejected';
        by: string;
        note: string | null;
      };
      const i = byId.get(d.invoice_id);
      if (i) i.resolution = { outcome: d.outcome, by: d.by, at: row.created_at, note: d.note };
    }
  }
  return [...byId.values()];
}
