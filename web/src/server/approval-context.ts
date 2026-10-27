import {
  PAYMENT_DECISION,
  dailySpend,
  localTime,
  normalizeName,
  toEngineViews,
  type MandateConfig,
  type PaymentRecord,
  type StoredEntry,
} from '@flow-e/mcp/core';
import { ruleName } from '@/lib/format';
import type { TraceStep } from './store';

/**
 * Everything an approver needs to decide a payment in review, from data the page has already
 * loaded (the folded payments and the signed ledger entries). Pure: no I/O, no clock.
 * Sums are integer minor units of the base currency.
 */

export interface ApprovalReason {
  rule: string;
  /** Plain words: why this rule asked a human. */
  title: string;
  /** The engine's own sentence from the signed trace. */
  detail: string;
}

export interface BudgetEffect {
  /** The calendar day (mandate time zone) the payment counts against, YYYY-MM-DD. */
  day: string;
  isToday: boolean;
  budget: number;
  approved: number;
  /** Other payments still waiting that day (not this one). */
  pending: number;
  /** This payment in the base currency; null when it has no converted amount. */
  thisPayment: number | null;
  /** approved + pending + this payment. */
  total: number;
  overBy: number;
}

export interface SupplierHistory {
  approvedCount: number;
  approvedTotal: number;
  lastApprovedAt: string | null;
}

export interface SimilarPurchase {
  paymentId: string;
  merchant: string;
  amount: number;
  currency: string;
  amountBase: number | null;
  status: PaymentRecord['status'];
  createdAt: string;
  match: 'supplier' | 'item';
  what: string | null;
}

export interface FairPrice {
  item: string;
  quantity: number;
  expectedBase: number;
  differenceBase: number;
  differencePercent: number;
}

export interface ApprovalContext {
  reasons: ApprovalReason[];
  budget: BudgetEffect | null;
  supplier: SupplierHistory;
  similar: SimilarPurchase[];
  fairPrice: FairPrice | null;
  baseCurrency: string;
}

export interface ApprovalInput {
  payment: PaymentRecord;
  /** Every payment of the organisation or sandbox, any order. */
  payments: readonly PaymentRecord[];
  trace: readonly TraceStep[];
  /** The agent's daily budget in base minor units; null when the agent is no longer in the mandate. */
  dailyBudget: number | null;
  timezone: string;
  now: number;
}

const SIMILAR_LIMIT = 3;

function sentence(detail: string): string {
  const s = detail
    .replace(/[;:,]?\s*a human must approve\.?$/i, '')
    .trim()
    .replace(/[.;:,]$/, '');
  return s === '' ? detail : `${s}.`;
}

function reasonTitle(step: TraceStep): string {
  switch (step.rule) {
    case 'APPROVAL_THRESHOLD':
      return 'Above the amount the agent may spend without a person';
    case 'FAIR_PRICE': {
      const pct = step.data?.differencePercent;
      return typeof pct === 'number' && pct < 0
        ? 'Much cheaper than the usual price'
        : 'More expensive than the usual price';
    }
    case 'BUSINESS_HOURS':
      return 'Asked outside business hours';
    default:
      return ruleName(step.rule);
  }
}

export function reviewReasons(trace: readonly TraceStep[], fallback: string): ApprovalReason[] {
  const steps = trace.filter((t) => t.outcome === 'review');
  if (steps.length === 0) return [{ rule: '', title: 'Flow-E asked a person', detail: fallback }];
  return steps.map((t) => ({ rule: t.rule, title: reasonTitle(t), detail: sentence(t.detail) }));
}

export function fairPriceOf(trace: readonly TraceStep[]): FairPrice | null {
  const d = trace.find((t) => t.rule === 'FAIR_PRICE')?.data;
  if (!d || d.matched !== true) return null;
  const { item, quantity, expectedBase, differenceBase, differencePercent } = d;
  if (
    typeof item !== 'string' ||
    typeof quantity !== 'number' ||
    typeof expectedBase !== 'number' ||
    typeof differenceBase !== 'number' ||
    typeof differencePercent !== 'number'
  ) {
    return null;
  }
  return { item, quantity, expectedBase, differenceBase, differencePercent };
}

/** What was bought, as words to compare: the item when given, else the memo. */
function whatOf(p: PaymentRecord): string | null {
  const w = normalizeName(p.request.item ?? p.request.memo ?? '');
  return w === '' ? null : w;
}

export function approvalContext(input: ApprovalInput): ApprovalContext {
  const { payment, payments, trace, dailyBudget, timezone, now } = input;
  const others = payments.filter((p) => p.paymentId !== payment.paymentId);
  const supplierKey = normalizeName(payment.request.merchant);
  const fairPrice = fairPriceOf(trace);

  let budget: BudgetEffect | null = null;
  if (dailyBudget !== null) {
    // The payment counts against the day it was asked for, like the daily-budget rule.
    const at = Date.parse(payment.createdAt);
    const spend = dailySpend(
      toEngineViews(others.filter((p) => p.agentId === payment.agentId)),
      at,
      timezone,
      dailyBudget,
    );
    const total = spend.approved + spend.pending + (payment.amountBase ?? 0);
    budget = {
      day: spend.date,
      isToday: localTime(now, timezone).date === spend.date,
      budget: dailyBudget,
      approved: spend.approved,
      pending: spend.pending,
      thisPayment: payment.amountBase,
      total,
      overBy: Math.max(0, total - dailyBudget),
    };
  }

  const sameSupplier = (p: PaymentRecord) => normalizeName(p.request.merchant) === supplierKey;
  const paid = others.filter((p) => p.status === 'approved' && sameSupplier(p));
  const supplier: SupplierHistory = {
    approvedCount: paid.length,
    approvedTotal: paid.reduce((sum, p) => sum + (p.amountBase ?? 0), 0),
    lastApprovedAt: paid.reduce<string | null>(
      (last, p) => (last === null || p.createdAt > last ? p.createdAt : last),
      null,
    ),
  };

  const what = whatOf(payment);
  const itemKey = fairPrice ? normalizeName(fairPrice.item) : null;
  const sameItem = (p: PaymentRecord) => {
    const w = whatOf(p);
    if (w === null) return false;
    if (what !== null && w === what) return true;
    return itemKey !== null && itemKey !== '' && w.includes(itemKey);
  };
  const similar = others
    .flatMap((p): SimilarPurchase[] => {
      const match = sameSupplier(p) ? 'supplier' : sameItem(p) ? 'item' : null;
      if (!match) return [];
      return [
        {
          paymentId: p.paymentId,
          merchant: p.request.merchant,
          amount: p.request.amount,
          currency: p.request.currency,
          amountBase: p.amountBase,
          status: p.status,
          createdAt: p.createdAt,
          match,
          what: p.request.item ?? p.request.memo ?? null,
        },
      ];
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, SIMILAR_LIMIT);

  return {
    reasons: reviewReasons(trace, payment.reason),
    budget,
    supplier,
    similar,
    fairPrice,
    baseCurrency: payment.baseCurrency,
  };
}

/** The signed rule trace of a payment's decision entry. */
export function traceOf(entries: readonly StoredEntry[], receiptId: string): TraceStep[] {
  const row = entries.find((e) => e.id === receiptId && e.type === PAYMENT_DECISION);
  if (!row) return [];
  try {
    const data = JSON.parse(row.data) as { trace?: unknown };
    return Array.isArray(data.trace) ? (data.trace as TraceStep[]) : [];
  } catch {
    return [];
  }
}

/** What both the sandbox view and an organisation view provide. */
export interface ApprovalSource {
  now: number;
  timezone: string;
  config: MandateConfig;
  payments: readonly PaymentRecord[];
  entries: readonly StoredEntry[];
}

/** The approval context for one payment, straight from a loaded view. */
export function approvalContextFor(
  view: ApprovalSource,
  payment: PaymentRecord,
  trace?: readonly TraceStep[],
): ApprovalContext {
  return approvalContext({
    payment,
    payments: view.payments,
    trace: trace ?? traceOf(view.entries, payment.receiptId),
    dailyBudget: view.config.agents[payment.agentId]?.mandate.dailyBudget ?? null,
    timezone: view.timezone,
    now: view.now,
  });
}
