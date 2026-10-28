import 'server-only';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import {
  ActionError,
  INVOICE_RECORDED,
  PAYMENT_DECISION,
  PAYMENT_ORDERED,
  PAYMENT_RESOLVED,
  fromStored,
  toReceipt,
  type StoredEntry,
} from '@flow-e/mcp/core';
import type { Db } from './db';
import { decryptSecret, encryptSecret } from './keys';
import type { OrgStore, User } from './org-store';
import { assertCan } from './permissions';
import { BlockedAddressError, safeLookup, webhookUrlProblem } from './safe-url';

/**
 * Webhooks: tell other systems (a supplier, accounting) when a payment is decided, an order is
 * recorded or an invoice is matched. Deliveries are made from the ledger after the fact: each
 * endpoint has a cursor (the last entry it has seen), so sending can never change, block or
 * slow a decision. Every delivery is signed with the endpoint's secret:
 *
 *   Flow-E-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *
 * Failed deliveries are retried after 1 min, 5 min, 30 min, 2 h, 6 h and 24 h, then marked
 * failed. Only public https addresses are called (src/server/safe-url.ts).
 */

export const WEBHOOK_EVENTS = [
  'payment.approved',
  'payment.declined',
  'payment.review',
  'order.recorded',
  'invoice.matched',
  'invoice.mismatch',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const EVENT_LABEL: Record<WebhookEvent, string> = {
  'payment.approved': 'A payment is approved (by the rules or a person)',
  'payment.declined': 'A payment is declined',
  'payment.review': 'A payment waits for a person',
  'order.recorded': 'An order is recorded',
  'invoice.matched': 'An invoice matches its authorization',
  'invoice.mismatch': 'An invoice does not match (amount differs)',
};

export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];
export const MAX_WEBHOOKS = 5;
const TIMEOUT_MS = 10_000;
const BATCH = 50;
export const SIGNATURE_HEADER = 'Flow-E-Signature';

const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const createWebhookSchema = z.object({
  url: z
    .string()
    .trim()
    .superRefine((u, ctx) => {
      const problem = webhookUrlProblem(u);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1, 'Choose at least one event.')
    .transform((e) => [...new Set(e)].sort()),
});

/** The events a ledger entry stands for. */
export function eventsFor(e: Pick<StoredEntry, 'type' | 'data'>): WebhookEvent[] {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(e.data) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (e.type === PAYMENT_DECISION || e.type === PAYMENT_RESOLVED) {
    const v = e.type === PAYMENT_DECISION ? d.decision : d.status;
    if (v === 'approved' || v === 'declined' || v === 'review') return [`payment.${v}`];
    return [];
  }
  if (e.type === PAYMENT_ORDERED) return ['order.recorded'];
  if (e.type === INVOICE_RECORDED) {
    if (d.match === 'matched') return ['invoice.matched'];
    if (d.match === 'mismatch') return ['invoice.mismatch'];
  }
  return [];
}

/** The body sent for one event: the entry as recorded, plus the signed receipt where useful. */
export function payloadFor(input: {
  deliveryId: string;
  event: WebhookEvent | 'test';
  issuer: string;
  entry: StoredEntry | null;
  now: number;
}): Record<string, unknown> {
  const { entry } = input;
  const withReceipt =
    entry !== null && (input.event === 'payment.approved' || input.event === 'order.recorded');
  return {
    id: input.deliveryId,
    event: input.event,
    created_at: new Date(input.now).toISOString(),
    issuer: input.issuer,
    ...(entry
      ? {
          entry: {
            seq: entry.seq,
            id: entry.id,
            type: entry.type,
            agent_id: entry.agent_id,
            created_at: entry.created_at,
            data: JSON.parse(entry.data) as unknown,
          },
        }
      : { message: 'A test event from Flow-E. Nothing happened.' }),
    ...(withReceipt ? { receipt: toReceipt(input.issuer, fromStored(entry)) } : {}),
  };
}

/** The signature header value for `body` sent at `t` (unix seconds). */
export function sign(secret: string, t: number, body: string): string {
  const v1 = createHmac('sha256', secret)
    .update(`${String(t)}.${body}`, 'utf8')
    .digest('hex');
  return `t=${String(t)},v1=${v1}`;
}

/** What a receiver does: true when the signature is right and at most `toleranceS` old. */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  nowS: number,
  toleranceS = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowS - t) > toleranceS) return false;
  const expected = sign(secret, t, body).split('v1=')[1] ?? '';
  const given = parts.v1 ?? '';
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export type Sender = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

/** POST over https to a public address only; no redirects, 10 s, the response body is dropped. */
export const httpsSender: Sender = (url, body, headers) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0 });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timed out after 10 seconds'));
    });
    req.on('error', reject);
    req.end(body);
  });

export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdBy: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface DeliveryView {
  id: string;
  webhookId: string;
  url: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
  deliveredAt: string | null;
}

function arr(v: string[] | string): string[] {
  return Array.isArray(v)
    ? v
    : v
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter(Boolean);
}

function errorText(err: unknown): string {
  if (err instanceof BlockedAddressError) return err.message;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return `Could not connect (${code}).`;
  if (err instanceof Error && /timed out/.test(err.message)) return 'No answer within 10 seconds.';
  return 'Could not connect.';
}

export class WebhookStore {
  private readonly clock: () => number;
  private readonly sender: Sender;

  constructor(
    private readonly db: Db,
    private readonly orgs: OrgStore,
    private readonly encryptionKey: Buffer,
    opts: { clock?: () => number; sender?: Sender } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.sender = opts.sender ?? httpsSender;
  }

  async list(orgId: string, user: User): Promise<WebhookView[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    const rows = await this.db.query<{
      id: string;
      url: string;
      events: string[] | string;
      created_by: string;
      created_at: string;
      disabled_at: string | null;
    }>(
      `select id, url, events, created_by, ${iso('created_at')} as created_at,
              ${iso('disabled_at')} as disabled_at
         from org_webhooks where org_id = $1 order by created_at desc`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: arr(r.events) as WebhookEvent[],
      createdBy: r.created_by,
      createdAt: r.created_at,
      disabledAt: r.disabled_at,
    }));
  }

  /** Returns the signing secret once; it is stored encrypted, because every delivery needs it. */
  async create(
    orgId: string,
    user: User,
    input: z.input<typeof createWebhookSchema>,
  ): Promise<{ id: string; secret: string }> {
    assertCan(await this.orgs.role(orgId, user), 'integrations.manage');
    const parsed = createWebhookSchema.safeParse(input);
    if (!parsed.success) throw new ActionError(parsed.error.issues[0]?.message ?? 'Not valid.');
    const active = await this.db.query<{ n: string | number }>(
      'select count(*) as n from org_webhooks where org_id = $1 and disabled_at is null',
      [orgId],
    );
    if (Number(active[0]?.n ?? 0) >= MAX_WEBHOOKS) {
      throw new ActionError(`At most ${String(MAX_WEBHOOKS)} webhooks. Remove one first.`);
    }
    const { entries } = await this.orgs.systemView(orgId);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    await this.db.query(
      `insert into org_webhooks (id, org_id, url, events, secret_enc, cursor_seq, created_by, created_at)
       values ($1, $2, $3, $4::text[], $5, $6, $7, $8::timestamptz)`,
      [
        id,
        orgId,
        new URL(parsed.data.url).toString(),
        `{${parsed.data.events.join(',')}}`,
        encryptSecret(secret, this.encryptionKey),
        // Only what happens from now on.
        entries.at(-1)?.seq ?? 0,
        user.email.trim().toLowerCase().slice(0, 100),
        new Date(this.clock()).toISOString(),
      ],
    );
    return { id, secret };
  }

  async disable(orgId: string, user: User, id: string): Promise<void> {
    assertCan(await this.orgs.role(orgId, user), 'integrations.manage');
    if (!z.uuid().safeParse(id).success) throw new ActionError('No such webhook.');
    const rows = await this.db.query<{ id: string }>(
      `update org_webhooks set disabled_at = $3::timestamptz
        where id = $1 and org_id = $2 and disabled_at is null returning id`,
      [id, orgId, new Date(this.clock()).toISOString()],
    );
    if (rows.length === 0) throw new ActionError('No such webhook, or it is already removed.');
    await this.db.query(
      `update org_webhook_deliveries set status = 'failed', last_error = 'Webhook removed.'
        where webhook_id = $1 and status = 'pending'`,
      [id],
    );
  }

  async deliveries(orgId: string, user: User, limit = 50): Promise<DeliveryView[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    const rows = await this.db.query<{
      id: string;
      webhook_id: string;
      url: string;
      event: string;
      status: DeliveryView['status'];
      attempts: number;
      last_status: number | null;
      last_error: string | null;
      created_at: string;
      next_attempt_at: string;
      delivered_at: string | null;
    }>(
      `select d.id, d.webhook_id, w.url, d.event, d.status, d.attempts, d.last_status, d.last_error,
              ${iso('d.created_at')} as created_at, ${iso('d.next_attempt_at')} as next_attempt_at,
              ${iso('d.delivered_at')} as delivered_at
         from org_webhook_deliveries d join org_webhooks w on w.id = d.webhook_id
        where d.org_id = $1 order by d.created_at desc limit $2`,
      [orgId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhook_id,
      url: r.url,
      event: r.event,
      status: r.status,
      attempts: r.attempts,
      lastStatus: r.last_status,
      lastError: r.last_error,
      createdAt: r.created_at,
      nextAttemptAt: r.next_attempt_at,
      deliveredAt: r.delivered_at,
    }));
  }

  /** "Send test event": queued and sent at once; shows in the delivery log like any other. */
  async sendTest(orgId: string, user: User, webhookId: string): Promise<DeliveryView['status']> {
    assertCan(await this.orgs.role(orgId, user), 'integrations.manage');
    if (!z.uuid().safeParse(webhookId).success) throw new ActionError('No such webhook.');
    const hooks = await this.db.query<{ id: string }>(
      'select id from org_webhooks where id = $1 and org_id = $2 and disabled_at is null',
      [webhookId, orgId],
    );
    if (hooks.length === 0) throw new ActionError('No such webhook.');
    const { issuer } = await this.orgs.systemView(orgId);
    const id = randomUUID();
    const now = this.clock();
    await this.db.query(
      `insert into org_webhook_deliveries
         (id, org_id, webhook_id, event, entry_seq, payload, status, next_attempt_at, created_at)
       values ($1, $2, $3, 'test', $4, $5::jsonb, 'pending', $6::timestamptz, $6::timestamptz)`,
      [
        id,
        orgId,
        webhookId,
        // Test events are not ledger entries: a negative, unique sequence number.
        -Math.floor(now / 1000) - Math.floor(Math.random() * 1000),
        JSON.stringify(payloadFor({ deliveryId: id, event: 'test', issuer, entry: null, now })),
        new Date(now).toISOString(),
      ],
    );
    return this.deliver(id);
  }

  /** Try a failed delivery again, now. */
  async resend(orgId: string, user: User, deliveryId: string): Promise<DeliveryView['status']> {
    assertCan(await this.orgs.role(orgId, user), 'integrations.manage');
    if (!z.uuid().safeParse(deliveryId).success) throw new ActionError('No such delivery.');
    const rows = await this.db.query<{ id: string }>(
      `update org_webhook_deliveries d set status = 'pending', next_attempt_at = $3::timestamptz
         from org_webhooks w
        where d.id = $1 and d.org_id = $2 and d.status = 'failed'
          and w.id = d.webhook_id and w.disabled_at is null
        returning d.id`,
      [deliveryId, orgId, new Date(this.clock()).toISOString()],
    );
    if (rows.length === 0)
      throw new ActionError('Only failed deliveries of active webhooks can be resent.');
    return this.deliver(deliveryId);
  }

  /**
   * Turn new ledger entries into deliveries, for one organisation or all. Reads the ledger only;
   * a failure here leaves the cursor where it was, so nothing is lost and nothing is sent twice.
   */
  async enqueue(orgId?: string): Promise<number> {
    const hooks = await this.db.query<{
      id: string;
      org_id: string;
      events: string[] | string;
      cursor_seq: number;
    }>(
      `select id, org_id, events, cursor_seq from org_webhooks
        where disabled_at is null${orgId ? ' and org_id = $1' : ''}`,
      orgId ? [orgId] : [],
    );
    let added = 0;
    for (const h of hooks) {
      const { issuer, entries } = await this.orgs.systemView(h.org_id);
      const wanted = new Set(arr(h.events));
      const fresh = entries.filter((e) => e.seq > h.cursor_seq);
      if (fresh.length === 0) continue;
      const now = this.clock();
      await this.db.transaction(async (tx) => {
        for (const e of fresh) {
          for (const event of eventsFor(e)) {
            if (!wanted.has(event)) continue;
            const id = randomUUID();
            const rows = await tx.query<{ id: string }>(
              `insert into org_webhook_deliveries
                 (id, org_id, webhook_id, event, entry_seq, payload, status, next_attempt_at, created_at)
               values ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7::timestamptz, $7::timestamptz)
               on conflict (webhook_id, entry_seq, event) do nothing returning id`,
              [
                id,
                h.org_id,
                h.id,
                event,
                e.seq,
                JSON.stringify(payloadFor({ deliveryId: id, event, issuer, entry: e, now })),
                new Date(now).toISOString(),
              ],
            );
            added += rows.length;
          }
        }
        await tx.query(
          'update org_webhooks set cursor_seq = $2 where id = $1 and cursor_seq < $2',
          [h.id, fresh.at(-1)?.seq ?? h.cursor_seq],
        );
      });
    }
    return added;
  }

  /** Send every delivery that is due (at most BATCH per call). */
  async deliverDue(): Promise<number> {
    const due = await this.db.query<{ id: string }>(
      `select id from org_webhook_deliveries
        where status = 'pending' and next_attempt_at <= $1::timestamptz
        order by next_attempt_at limit ${String(BATCH)}`,
      [new Date(this.clock()).toISOString()],
    );
    for (const d of due) await this.deliver(d.id);
    return due.length;
  }

  /** One attempt. Never throws for the receiver's problems; they are recorded on the delivery. */
  private async deliver(id: string): Promise<DeliveryView['status']> {
    const rows = await this.db.query<{
      payload: unknown;
      attempts: number;
      url: string;
      secret_enc: string;
      event: string;
      disabled_at: string | null;
    }>(
      `select d.payload, d.attempts, d.event, w.url, w.secret_enc, w.disabled_at
         from org_webhook_deliveries d join org_webhooks w on w.id = d.webhook_id
        where d.id = $1 and d.status = 'pending'`,
      [id],
    );
    const row = rows[0];
    if (!row || row.disabled_at !== null) return 'failed';
    const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
    const now = this.clock();
    let status = 0;
    let error: string | null = null;
    try {
      const problem = webhookUrlProblem(row.url);
      if (problem) throw new BlockedAddressError(problem);
      const secret = decryptSecret(row.secret_enc, this.encryptionKey);
      const res = await this.sender(row.url, body, {
        'content-type': 'application/json',
        'user-agent': 'Flow-E-Webhooks/1',
        'flow-e-event': row.event,
        'flow-e-delivery': id,
        [SIGNATURE_HEADER.toLowerCase()]: sign(secret, Math.floor(now / 1000), body),
      });
      status = res.status;
      if (status < 200 || status > 299) error = `The receiver answered ${String(status)}.`;
    } catch (err) {
      error = errorText(err);
    }
    const attempts = row.attempts + 1;
    const blocked = error !== null && /private or internal|not allowed|public address/i.test(error);
    const next = RETRY_DELAYS_MS[attempts - 1];
    const outcome: DeliveryView['status'] =
      error === null ? 'delivered' : blocked || next === undefined ? 'failed' : 'pending';
    await this.db.query(
      `update org_webhook_deliveries
          set status = $2, attempts = $3, last_status = $4, last_error = $5,
              next_attempt_at = $6::timestamptz, delivered_at = $7::timestamptz
        where id = $1`,
      [
        id,
        outcome,
        attempts,
        status === 0 ? null : status,
        error,
        new Date(now + (outcome === 'pending' ? (next ?? 0) : 0)).toISOString(),
        outcome === 'delivered' ? new Date(now).toISOString() : null,
      ],
    );
    return outcome;
  }
}
