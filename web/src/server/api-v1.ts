import 'server-only';
import { z } from 'zod';
import {
  PAYMENT_DECISION,
  foldPayments,
  formatMoney,
  fromStored,
  toReceipt,
  type MandateConfig,
  type PaymentRecord,
  type StoredEntry,
} from '@flow-e/mcp/core';
import { apiError, readJson, type ApiAnswer, type ApiDeps } from './api-auth';
import type { ApiCaller } from './api-keys';
import type { OrgStore } from './org-store';
import type { ReorderStore } from './reorder';

/**
 * The /api/v1 routes for other systems, behind an organisation API key (src/server/api-auth.ts).
 * Every answer is computed from the caller's own organisation only: the organisation comes from
 * the key, never from the request.
 */

interface OrgData {
  issuer: string;
  config: MandateConfig;
  entries: StoredEntry[];
}

export interface V1Deps extends ApiDeps {
  orgs: OrgStore;
  reorder: ReorderStore;
}

const money = (minor: number | null, currency: string, config: MandateConfig) =>
  minor === null
    ? null
    : formatMoney(minor, currency, config.policy.currencyDecimals).split(' ')[1];

/** A payment as other systems see it: amounts as decimal strings, times in UTC. */
export function paymentJson(p: PaymentRecord, config: MandateConfig) {
  const ordered = p.fulfilment?.ordered ?? null;
  const invoice = p.fulfilment?.invoice ?? null;
  return {
    payment_id: p.paymentId,
    receipt_id: p.receiptId,
    agent_id: p.agentId,
    status: p.status,
    decision: p.engineDecision,
    rule: p.rule,
    reason: p.reason,
    supplier: p.request.merchant,
    item: p.request.item ?? null,
    quantity: p.request.quantity ?? null,
    project: p.request.project ?? null,
    amount: money(p.request.amount, p.request.currency, config),
    currency: p.request.currency,
    amount_in_base_currency: money(p.amountBase, p.baseCurrency, config),
    base_currency: p.baseCurrency,
    created_at: p.createdAt,
    decided_by: p.decidedBy,
    ordered: ordered ? { at: ordered.at, reference: ordered.reference } : null,
    invoice: invoice
      ? {
          number: invoice.number,
          match: invoice.match,
          amount: money(invoice.amount, invoice.currency, config),
          currency: invoice.currency,
        }
      : null,
  };
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
});

function cursorOf(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

/** GET /api/v1/orders: approved payments with an order, newest first, a page at a time. */
export function listOrders(data: OrgData, url: URL): ApiAnswer {
  const q = listQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!q.success) return apiError(400, '"limit" is 1 to 100; "cursor" comes from next_cursor.');
  const after = q.data.cursor ? Buffer.from(q.data.cursor, 'base64url').toString('utf8') : null;
  const orders = foldPayments(data.entries)
    .filter((p) => p.fulfilment?.ordered)
    .map((p) => ({ p, key: `${p.fulfilment?.ordered?.at ?? ''}|${p.paymentId}` }))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .filter((o) => after === null || o.key < after);
  const page = orders.slice(0, q.data.limit);
  const last = page.at(-1);
  return {
    status: 200,
    body: {
      data: page.map((o) => paymentJson(o.p, data.config)),
      next_cursor:
        orders.length > page.length && last
          ? cursorOf(last.p.fulfilment?.ordered?.at ?? '', last.p.paymentId)
          : null,
    },
  };
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

function findPayment(data: OrgData, id: string): PaymentRecord | null {
  if (!idSchema.safeParse(id).success) return null;
  return foldPayments(data.entries).find((p) => p.paymentId === id || p.receiptId === id) ?? null;
}

/** GET /api/v1/payments/{id}: one payment of the caller's organisation. */
export function getPayment(data: OrgData, id: string): ApiAnswer {
  const p = findPayment(data, id);
  return p ? { status: 200, body: paymentJson(p, data.config) } : apiError(404, 'No such payment.');
}

/** GET /api/v1/receipts/{id}: the signed receipt of a payment decision (payment or receipt id). */
export function getReceipt(data: OrgData, id: string): ApiAnswer {
  const p = findPayment(data, id);
  const row = p
    ? data.entries.find((e) => e.id === p.receiptId && e.type === PAYMENT_DECISION)
    : undefined;
  return row
    ? { status: 200, body: toReceipt(data.issuer, fromStored(row)) }
    : apiError(404, 'No such receipt.');
}

/** POST /api/v1/reorder-signals. The Idempotency-Key header may stand in for the field. */
export async function postSignal(
  req: Request,
  caller: ApiCaller,
  deps: V1Deps,
): Promise<ApiAnswer> {
  const body = await readJson(req);
  if (!body.ok) return apiError(body.status, body.message);
  let value = body.value;
  const header = req.headers.get('idempotency-key')?.trim();
  if (header && value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.idempotency_key === undefined) value = { ...v, idempotency_key: header };
  }
  const { config } = await deps.orgs.systemView(caller.orgId);
  return deps.reorder.receiveSignal(caller, value, config.policy.referencePrices ?? []);
}
