import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ConfigError,
  parseConfig,
  type AgentConfig,
  type MandateConfig,
} from '../config/schema.js';
import { evaluate } from '../engine/evaluate.js';
import { AmountError, formatMoney, parseAmount } from '../engine/money.js';
import { dailySpend } from '../engine/rules.js';
import { formatClock } from '../engine/time.js';
import type { Credential, PaymentRequest } from '../engine/types.js';
import { PAYMENT_SCOPE, signatureCheck, type CredentialFile } from '../kya/credential.js';
import { loadSigningIssuer, readCredential, type SigningIssuer } from '../kya/store.js';
import { Ledger, newId, type PaymentRecord } from '../ledger/ledger.js';
import { effectiveStatus } from '../control/actions.js';
import { join } from 'node:path';

/**
 * The agent-facing MCP server. One server per agent, started with that agent's credential.
 *
 * The agent can read its mandate and its own payments, and ask for a payment. Nothing here can
 * approve, change policy, unfreeze or read another agent's data: those tools do not exist.
 * Keys and credentials never appear in tool output.
 */

export interface MandateServerOptions {
  home: string;
  configPath: string;
  agentId: string;
  /** Epoch milliseconds; injectable for tests. */
  clock?: () => number;
}

export interface MandateServer {
  server: McpServer;
  ledger: Ledger;
  issuerId: string;
  close(): void;
}

const INSTRUCTIONS = `This server holds your spending mandate: the budget and rules your organisation set for you.
Call check_mandate before planning purchases. Call request_payment before every purchase and only buy when the decision is "approved".
Imprest authorizes payments; it does not move money. A decision is final unless a human changes it: never split a declined payment, or re-submit it with a changed supplier name, category, country or currency, to get around a rule. Buying the item from a different supplier that is genuinely allowed is fine. Never place an order that is "review" until get_payment shows "approved".`;

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Load-time checks: fail loudly at start rather than at the first request. */
function startupCheck(o: MandateServerOptions): { issuer: SigningIssuer } {
  const issuer = loadSigningIssuer(o.home);
  const config = parseConfig(readFileSync(o.configPath, 'utf8'));
  if (!config.agents[o.agentId]) {
    throw new ConfigError(`Agent "${o.agentId}" is not in ${o.configPath}.`);
  }
  readCredential(o.home, o.agentId);
  return { issuer };
}

export function createMandateServer(o: MandateServerOptions): MandateServer {
  const clock = o.clock ?? Date.now;
  const { issuer } = startupCheck(o);
  const ledger = Ledger.open(join(o.home, 'ledger.db'), {
    issuer: issuer.id,
    privateKey: issuer.privateKey,
  });
  const verifySignature = signatureCheck(issuer.publicKey);

  /**
   * Re-read the mandate and credential on every call, so an owner's edit (a lower budget, a
   * frozen status, a reissued credential) applies at once. Unreadable means no authority.
   */
  function current(): { config: MandateConfig; agent: AgentConfig; credential: Credential | null } {
    const config = parseConfig(readFileSync(o.configPath, 'utf8'));
    const agent = config.agents[o.agentId];
    if (!agent) throw new ConfigError(`Agent "${o.agentId}" no longer has a mandate.`);
    let credential: CredentialFile | null;
    try {
      credential = readCredential(o.home, o.agentId);
    } catch {
      credential = null;
    }
    return { config, agent, credential };
  }

  /** Currency decimal overrides for display; a broken config must not hide the agent's history. */
  function decimals(): Readonly<Record<string, number>> | undefined {
    try {
      return current().config.policy.currencyDecimals;
    } catch {
      return undefined;
    }
  }

  const server = new McpServer(
    { name: 'imprest', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'check_mandate',
    {
      title: 'Check my spending mandate',
      description:
        'Shows what you are allowed to spend: remaining budget today, per-payment limit, the ' +
        'amount above which a human must approve, and the allowed currencies, categories, ' +
        'suppliers and countries. Call it before planning purchases. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      try {
        const { config, agent, credential } = current();
        const { policy } = config;
        const m = agent.mandate;
        const money = (n: number) => formatMoney(n, policy.baseCurrency, policy.currencyDecimals);
        const spend = dailySpend(
          ledger.paymentViews(agent.id),
          clock(),
          policy.timezone,
          m.dailyBudget,
        );
        const hours = policy.businessHours;
        const controls = ledger.controls();
        return text({
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
              m.currencies
                .filter((c) => c !== policy.baseCurrency)
                .map((c) => [c, String(policy.fx[c])]),
            ),
            categories: m.categories,
            suppliers:
              m.suppliers.mode === 'allowlist' ? m.suppliers.allow : 'any supplier not blocked',
            blocked_suppliers: [...policy.blockedSuppliers, ...m.suppliers.block],
            blocked_countries: [...new Set([...policy.blockedCountries, ...m.blockedCountries])],
          },
          rules: [
            'Every purchase needs request_payment first.',
            'A payment to the same supplier within 10 minutes counts with the previous ones.',
            'The first payment to a new supplier can be cancelled by a human for 10 minutes.',
          ],
        });
      } catch (err) {
        return toolError(errorText(err));
      }
    },
  );

  server.registerTool(
    'request_payment',
    {
      title: 'Request a payment',
      description:
        'Ask for authorization to pay a supplier. Returns "approved", "declined" or "review" ' +
        'with the reason, a payment_id and a signed receipt_id. Only buy when approved. ' +
        'Never split a declined payment into smaller ones, and never re-submit it with a ' +
        'disguised supplier name, category, country or currency: that is recorded and blocked. ' +
        'Choosing a different supplier that is genuinely allowed is fine. If the ' +
        'decision is "review", a human must approve first; tell them the payment_id and check ' +
        'get_payment later. This authorizes only; it does not move money.',
      inputSchema: {
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const { config, agent, credential } = current();
        const { policy } = config;
        const currency = args.currency.toUpperCase();
        let amount: number;
        try {
          amount = parseAmount(args.amount, currency, policy.currencyDecimals);
        } catch (err) {
          return toolError(`Invalid amount: ${(err as AmountError).message}`);
        }
        const request: PaymentRequest = {
          merchant: args.merchant,
          amount,
          currency,
          // MCCs look numeric, so accept 5169 as well as "5169" (and 742 as "0742").
          category: String(args.category).padStart(4, '0'),
          country: args.country.toUpperCase(),
          ...(args.memo === undefined ? {} : { memo: args.memo }),
        };
        const now = clock();
        const paymentId = newId('pay');
        const { receipt, result } = ledger.decide(agent.id, (views) => {
          // Read inside the write transaction: a freeze that lands first always wins.
          const controls = ledger.controls();
          return {
            paymentId,
            request,
            baseCurrency: policy.baseCurrency,
            now,
            result: evaluate(
              {
                id: agent.id,
                status: effectiveStatus(agent.status, controls, agent.id),
                credential,
              },
              agent.mandate,
              request,
              {
                now,
                killSwitch: controls.killSwitch?.on === true,
                ledger: views,
                policy,
                kya: { issuer: issuer.id, requiredScope: PAYMENT_SCOPE, verifySignature },
              },
            ),
          };
        });
        const base = (n: number | null) =>
          n === null ? null : formatMoney(n, policy.baseCurrency, policy.currencyDecimals);
        return text({
          payment_id: paymentId,
          receipt_id: receipt.entry.id,
          decision: result.decision,
          reason: result.reason,
          rule: result.rule,
          amount: formatMoney(amount, currency, policy.currencyDecimals),
          amount_in_base_currency: base(result.amountBase),
          cancellable_until:
            result.cancellableUntil === undefined
              ? null
              : new Date(result.cancellableUntil).toISOString(),
          next_step: NEXT_STEP[result.decision],
        });
      } catch (err) {
        return toolError(`${errorText(err)} The payment is NOT authorized; treat it as declined.`);
      }
    },
  );

  server.registerTool(
    'get_payment',
    {
      title: 'Get a payment',
      description:
        'Current status of one of your payments, by payment_id (or receipt_id). A payment in ' +
        '"review" becomes "approved" or "declined" once a human decides; an approved payment can ' +
        'become "cancelled" if a human cancels it during cooling-off. Read-only.',
      inputSchema: {
        id: z.string().trim().min(1).max(100).describe('The payment_id from request_payment.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => {
      try {
        const payment = ledger.payment(o.agentId, id);
        return payment
          ? text(publicPayment(payment, decimals()))
          : toolError(`You have no payment "${id}".`);
      } catch (err) {
        return toolError(errorText(err));
      }
    },
  );

  server.registerTool(
    'list_payments',
    {
      title: 'List my payments',
      description: 'Your most recent payment requests and their status, newest first. Read-only.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe('How many, 1–50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ limit }) => {
      try {
        const payments = ledger.payments(o.agentId).reverse().slice(0, limit);
        const d = decimals();
        return text({ payments: payments.map((p) => publicPayment(p, d)) });
      } catch (err) {
        return toolError(errorText(err));
      }
    },
  );

  return {
    server,
    ledger,
    issuerId: issuer.id,
    close: () => {
      ledger.close();
    },
  };
}

const NEXT_STEP = {
  approved:
    'Authorized. Complete the purchase through the normal checkout and quote the payment_id. ' +
    'Imprest has not moved any money.',
  declined:
    'Not authorized. Do not buy this, and do not retry it in a disguised form (split, renamed, ' +
    're-categorised or in another currency). You may buy the item from a different supplier ' +
    'that your mandate allows. Tell your human what was declined and why.',
  review:
    'A human must approve this first. Do not buy yet. Give your human the payment_id and check ' +
    'get_payment later.',
} as const;

function publicPayment(p: PaymentRecord, decimals?: Readonly<Record<string, number>>) {
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
function errorText(err: unknown): string {
  if (err instanceof ConfigError) return `The mandate configuration cannot be used: ${err.message}`;
  return 'Internal error.';
}
