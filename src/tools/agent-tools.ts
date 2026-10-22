import { z } from 'zod';
import { ConfigError, type AgentConfig, type MandateConfig } from '../config/schema.js';
import { effectiveStatus } from '../control/plan.js';
import { AmountError, formatMoney, parseAmount } from '../engine/money.js';
import type { DailySpend } from '../engine/rules.js';
import { formatClock } from '../engine/time.js';
import type { Credential, EvaluationResult, PaymentRequest } from '../engine/types.js';
import type { Controls, PaymentRecord } from '../ledger/fold.js';

/**
 * The agent-facing tools, defined once for every host: names, input schemas, descriptions for
 * the model, and the exact shape of each answer. The stdio server (src/mcp/server.ts) and the
 * website's remote endpoint both build their MCP servers from these, so an agent sees the same
 * tools wherever Flow-E runs. Pure: no I/O.
 */

export const AGENT_INSTRUCTIONS = `This server holds your spending mandate: the budget and rules your organisation set for you.
Call check_mandate before planning purchases. Call request_payment before every purchase and only buy when the decision is "approved".
Flow-E authorizes payments; it does not move money. A decision is final unless a human changes it: never split a declined payment, or re-submit it with a changed supplier name, category, country or currency, to get around a rule. Buying the item from a different supplier that is genuinely allowed is fine. Never place an order that is "review" until get_payment shows "approved".`;

export const requestPaymentShape = {
  merchant: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Supplier name exactly as it appears on the quote or invoice.'),
  amount: z
    .union([z.string().max(40), z.number()])
    .describe(
      'Total to pay in normal currency units as a decimal string, e.g. "1250.50" for ' +
        '1,250.50. Not cents. No thousands separators.',
    ),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3,5}$/)
    .describe('Currency code, e.g. CHF, EUR, USD.'),
  category: z
    .union([z.string().regex(/^\d{4}$/), z.number().int().min(0).max(9999)])
    .describe('Four-digit merchant category code (MCC), e.g. "5169" for chemicals.'),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .describe('ISO 3166-1 alpha-2 country of the supplier, e.g. "CH".'),
  memo: z
    .string()
    .max(500)
    .optional()
    .describe('What is being bought and why, for the people who review the ledger.'),
};

export const getPaymentShape = {
  id: z.string().trim().min(1).max(100).describe('The payment_id from request_payment.'),
};

export const listPaymentsShape = {
  limit: z.number().int().min(1).max(50).default(10).describe('How many, 1–50.'),
};

export type RequestPaymentArgs = z.infer<z.ZodObject<typeof requestPaymentShape>>;

export const AGENT_TOOLS = {
  check_mandate: {
    title: 'Check my spending mandate',
    description:
      'Shows what you are allowed to spend: remaining budget today, per-payment limit, the ' +
      'amount above which a human must approve, and the allowed currencies, categories, ' +
      'suppliers and countries. Call it before planning purchases. Read-only.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  request_payment: {
    title: 'Request a payment',
    description:
      'Ask for authorization to pay a supplier. Returns "approved", "declined" or "review" ' +
      'with the reason, a payment_id and a signed receipt_id. Only buy when approved. ' +
      'Never split a declined payment into smaller ones, and never re-submit it with a ' +
      'disguised supplier name, category, country or currency: that is recorded and blocked. ' +
      'Choosing a different supplier that is genuinely allowed is fine. If the ' +
      'decision is "review", a human must approve first; tell them the payment_id and check ' +
      'get_payment later. This authorizes only; it does not move money.',
    inputSchema: requestPaymentShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  get_payment: {
    title: 'Get a payment',
    description:
      'Current status of one of your payments, by payment_id (or receipt_id). A payment in ' +
      '"review" becomes "approved" or "declined" once a human decides; an approved payment can ' +
      'become "cancelled" if a human cancels it during cooling-off. Read-only.',
    inputSchema: getPaymentShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  list_payments: {
    title: 'List my payments',
    description: 'Your most recent payment requests and their status, newest first. Read-only.',
    inputSchema: listPaymentsShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
} as const;

export const NEXT_STEP = {
  approved:
    'Authorized. Complete the purchase through the normal checkout and quote the payment_id. ' +
    'Flow-E has not moved any money.',
  declined:
    'Not authorized. Do not buy this, and do not retry it in a disguised form (split, renamed, ' +
    're-categorised or in another currency). You may buy the item from a different supplier ' +
    'that your mandate allows. Tell your human what was declined and why.',
  review:
    'A human must approve this first. Do not buy yet. Give your human the payment_id and check ' +
    'get_payment later.',
} as const;

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** What check_mandate answers. */
export function mandateSummary(input: {
  config: MandateConfig;
  agent: AgentConfig;
  controls: Controls;
  credential: Credential | null;
  spend: DailySpend;
}) {
  const { config, agent, controls, credential, spend } = input;
  const { policy } = config;
  const m = agent.mandate;
  const money = (n: number) => formatMoney(n, policy.baseCurrency, policy.currencyDecimals);
  const hours = policy.businessHours;
  return {
    agent: {
      id: agent.id,
      name: credential?.claims.agent_name ?? agent.id,
      owner: agent.owner,
      organisation: credential?.claims.organisation ?? config.organisation ?? null,
      status: controls.killSwitch?.on
        ? 'blocked: the organisation kill switch is on'
        : effectiveStatus(agent.status, controls, agent.id),
      credential_expires: credential?.claims.expires_at ?? 'no valid credential',
    },
    base_currency: policy.baseCurrency,
    today: {
      date: spend.date,
      timezone: policy.timezone,
      daily_budget: money(m.dailyBudget),
      approved: money(spend.approved),
      pending_review: money(spend.pending),
      remaining: money(spend.remaining),
    },
    limits: {
      per_payment: money(m.perPaymentLimit),
      human_approval_above: m.approvalAbove === null ? null : money(m.approvalAbove),
      max_requests_per_minute: m.velocityPerMinute,
      business_hours: m.businessHoursOnly
        ? `${hours.days.map((d) => DAY_NAMES[d]).join(', ')} ${formatClock(hours.startMinute)}–${formatClock(hours.endMinute)} ${policy.timezone}; outside them a human must approve`
        : null,
    },
    allowed: {
      currencies: m.currencies,
      fx_to_base: Object.fromEntries(
        m.currencies.filter((c) => c !== policy.baseCurrency).map((c) => [c, String(policy.fx[c])]),
      ),
      categories: m.categories,
      suppliers: m.suppliers.mode === 'allowlist' ? m.suppliers.allow : 'any supplier not blocked',
      blocked_suppliers: [...policy.blockedSuppliers, ...m.suppliers.block],
      blocked_countries: [...new Set([...policy.blockedCountries, ...m.blockedCountries])],
    },
    rules: [
      'Every purchase needs request_payment first.',
      'A payment to the same supplier within 10 minutes counts with the previous ones.',
      'The first payment to a new supplier can be cancelled by a human for 10 minutes.',
    ],
  };
}

/**
 * Turn request_payment arguments into the engine's request. Throws AmountError for an amount
 * the currency cannot hold (the caller answers "Invalid amount: …" and records nothing).
 */
export function toPaymentRequest(
  args: RequestPaymentArgs,
  currencyDecimals?: Readonly<Record<string, number>>,
): PaymentRequest {
  const currency = args.currency.toUpperCase();
  const amount = parseAmount(args.amount, currency, currencyDecimals);
  return {
    merchant: args.merchant,
    amount,
    currency,
    // MCCs look numeric, so accept 5169 as well as "5169" (and 742 as "0742").
    category: String(args.category).padStart(4, '0'),
    country: args.country.toUpperCase(),
    ...(args.memo === undefined ? {} : { memo: args.memo }),
  };
}

/** What request_payment answers once the decision is recorded. */
export function paymentAnswer(input: {
  paymentId: string;
  receiptId: string;
  request: PaymentRequest;
  result: EvaluationResult;
  baseCurrency: string;
  currencyDecimals?: Readonly<Record<string, number>> | undefined;
}) {
  const { result, request, currencyDecimals } = input;
  const base = (n: number | null) =>
    n === null ? null : formatMoney(n, input.baseCurrency, currencyDecimals);
  return {
    payment_id: input.paymentId,
    receipt_id: input.receiptId,
    decision: result.decision,
    reason: result.reason,
    rule: result.rule,
    amount: formatMoney(request.amount, request.currency, currencyDecimals),
    amount_in_base_currency: base(result.amountBase),
    cancellable_until:
      result.cancellableUntil === undefined
        ? null
        : new Date(result.cancellableUntil).toISOString(),
    next_step: NEXT_STEP[result.decision],
  };
}

/** A payment as get_payment and list_payments show it to the agent. */
export function publicPayment(p: PaymentRecord, decimals?: Readonly<Record<string, number>>) {
  return {
    payment_id: p.paymentId,
    receipt_id: p.receiptId,
    status: p.status,
    reason: p.reason,
    merchant: p.request.merchant,
    amount: formatMoney(p.request.amount, p.request.currency, decimals),
    amount_in_base_currency:
      p.amountBase === null ? null : formatMoney(p.amountBase, p.baseCurrency, decimals),
    category: p.request.category,
    country: p.request.country,
    memo: p.request.memo ?? null,
    requested_at: p.createdAt,
    cancellable_until: p.cancellableUntil,
    decided_by: p.decidedBy,
    decided_at: p.updatedAt,
    note_from_human: p.note,
  };
}

/** Error text for the agent: expected errors verbatim, anything else generic. Never key material. */
export function agentErrorText(err: unknown): string {
  if (err instanceof ConfigError) return `The mandate configuration cannot be used: ${err.message}`;
  return 'Internal error.';
}

export function invalidAmountText(err: unknown): string {
  return `Invalid amount: ${err instanceof AmountError ? err.message : 'not a valid amount.'}`;
}
