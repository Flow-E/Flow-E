import { z } from 'zod';
import { ConfigError, type AgentConfig, type MandateConfig } from '../config/schema.js';
import { ActionError, effectiveStatus } from '../control/plan.js';
import { AmountError, formatMoney, parseAmount } from '../engine/money.js';
import {
  monthlySpend,
  projectSpend,
  type DailySpend,
  type MonthlySpend,
  type ProjectSpend,
} from '../engine/rules.js';
import { formatClock } from '../engine/time.js';
import type {
  Credential,
  EvaluationResult,
  LedgerEntryView,
  PaymentRequest,
  Project,
} from '../engine/types.js';
import type { Controls, PaymentRecord } from '../ledger/fold.js';

/**
 * The agent-facing tools, defined once for every host: names, input schemas, descriptions for
 * the model, and the exact shape of each answer. The stdio server (src/mcp/server.ts) and the
 * website's remote endpoint both build their MCP servers from these, so an agent sees the same
 * tools wherever Flow-E runs. Pure: no I/O.
 */

export const AGENT_INSTRUCTIONS = `This server holds your spending mandate: the budget and rules your organisation set for you.
Call check_mandate before planning purchases. Call request_payment before every purchase and only buy when the decision is "approved".
Flow-E authorizes payments; it does not move money. A decision is final unless a human changes it: never split a declined payment, or re-submit it with a changed supplier name, category, country or currency, to get around a rule. Buying the item from a different supplier that is genuinely allowed is fine. Never place an order that is "review" until get_payment shows "approved".
After you order an approved purchase from the supplier, quote the payment_id as your reference and call record_order with the supplier's order number.`;

export const recordOrderShape = {
  id: z.string().trim().min(1).max(100).describe('The payment_id of the approved payment.'),
  order_reference: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe("The supplier's order or confirmation number, if you have one."),
};

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
  item: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The product as named on the quote, e.g. "Phosphate buffer solution, 10 L". Used to ' +
        'compare the price with the usual one.',
    ),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .optional()
    .describe('How many units of item the amount covers. Default 1.'),
  project: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'The project or cost centre this purchase is for, by id or name (check_mandate lists ' +
        'yours). Required if your mandate says so.',
    ),
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
      'disguised supplier name, category, country or currency: that is recorded and sent to ' +
      'a person. Follow how_to_comply (and the guidance text): it says what would be ' +
      'approved, e.g. the approved suppliers or what is left of a budget and when it resets. ' +
      'Choosing a different supplier that is genuinely allowed is fine. If the ' +
      'decision is "review", a human must approve first; tell them the payment_id and check ' +
      'get_payment later. Name the item and quantity so the price can be compared with the ' +
      'usual one. This authorizes only; it does not move money.',
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
  record_order: {
    title: 'Record that I ordered',
    description:
      'After you placed the order for an approved payment with the supplier, record it here ' +
      "with the supplier's order number. Only for your own approved payments, and only after " +
      'any cooling-off window has closed. Recording an order changes nothing about the approval.',
    inputSchema: recordOrderShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
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

export interface BudgetState {
  monthly: MonthlySpend | null;
  projects: { project: Project; spend: ProjectSpend }[];
}

/** This agent's monthly budget and the projects it may book to, with what is left of each. */
export function budgetState(input: {
  config: MandateConfig;
  agent: AgentConfig;
  /** This agent's payments. */
  views: readonly LedgerEntryView[];
  /** Every agent's payments: project budgets are shared. */
  organisationViews: readonly LedgerEntryView[];
  now: number;
}): BudgetState {
  const { config, agent, now } = input;
  const tz = config.policy.timezone;
  const monthly = agent.mandate.monthlyBudget ?? null;
  return {
    monthly: monthly === null ? null : monthlySpend(input.views, now, tz, monthly),
    projects: (config.policy.projects ?? [])
      .filter((p) => p.agents.length === 0 || p.agents.includes(agent.id))
      .map((project) => ({
        project,
        spend: projectSpend(project, input.organisationViews, now, tz),
      })),
  };
}

/** What check_mandate answers. */
export function mandateSummary(input: {
  config: MandateConfig;
  agent: AgentConfig;
  controls: Controls;
  credential: Credential | null;
  spend: DailySpend;
  budgets?: BudgetState;
}) {
  const { config, agent, controls, credential, spend, budgets } = input;
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
    this_month: budgets?.monthly
      ? {
          month: budgets.monthly.month,
          monthly_budget: money(m.monthlyBudget ?? 0),
          approved: money(budgets.monthly.approved),
          pending_review: money(budgets.monthly.pending),
          remaining: money(budgets.monthly.remaining),
        }
      : null,
    projects:
      budgets && budgets.projects.length > 0
        ? {
            required: m.requireProject === true,
            open_to_you: budgets.projects.map(({ project, spend: s }) => ({
              id: project.id,
              name: project.name,
              budget: `${money(project.budgetBase)} ${project.period === 'month' ? 'per month' : 'in total'}`,
              remaining: money(s.remaining),
            })),
          }
        : null,
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
    price_check: policy.referencePrices?.length
      ? {
          reference_prices: policy.referencePrices.length,
          flagged_above: `${String(policy.priceCheck?.abovePercent ?? 0)}% over the usual price`,
          flagged_below:
            policy.priceCheck?.belowPercent == null
              ? null
              : `${String(policy.priceCheck.belowPercent)}% under the usual price`,
        }
      : null,
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
    ...(args.item === undefined ? {} : { item: args.item }),
    ...(args.quantity === undefined ? {} : { quantity: args.quantity }),
    ...(args.project === undefined ? {} : { project: args.project }),
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
    guidance: result.guidance ?? null,
    how_to_comply: result.howToComply ?? [],
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
    ordered: p.fulfilment?.ordered
      ? { at: p.fulfilment.ordered.at, reference: p.fulfilment.ordered.reference }
      : null,
    invoiced: p.fulfilment?.invoice ? { at: p.fulfilment.invoice.at } : null,
    note_from_human: p.note,
    how_to_comply: p.status === 'approved' ? [] : (p.howToComply ?? []),
  };
}

/** Error text for the agent: expected errors verbatim, anything else generic. Never key material. */
export function agentErrorText(err: unknown): string {
  if (err instanceof ConfigError) return `The mandate configuration cannot be used: ${err.message}`;
  // Our own wording about the agent's payment (status, cooling-off, a malformed reference).
  if (err instanceof ActionError) return err.message;
  return 'Internal error.';
}

export function invalidAmountText(err: unknown): string {
  return `Invalid amount: ${err instanceof AmountError ? err.message : 'not a valid amount.'}`;
}
