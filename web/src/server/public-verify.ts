import 'server-only';
import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { PAYMENT_DECISION, ReceiptError, parseReceipt, verifyReceipt } from '@flow-e/mcp/core';
import type { Sql } from './db';
import { RateLimiter } from './rate-limit';

/**
 * The public receipt check behind /verify: anyone (a supplier, an auditor, finance) pastes a
 * Flow-E receipt and learns whether it is genuine. No sign-in.
 *
 * What it may reveal: only what is inside the pasted receipt, plus whether its issuer id
 * belongs to an organisation or sandbox on this site (and that organisation's name). It does
 * not look at the ledger, so it never says what happened to the payment after signing. The
 * crypto is the core's verifyReceipt, the same check as `flow-e verify --offline`.
 */

export const MAX_RECEIPT_BYTES = 32 * 1024;
/** Per client address, and for the whole server instance (addresses are cheap to change). */
export const VERIFY_PER_MINUTE = 20;
export const VERIFY_GLOBAL_PER_MINUTE = 600;

export interface VerifiedPayment {
  paymentId: string;
  agentId: string;
  merchant: string;
  amount: number;
  currency: string;
  amountBase: number | null;
  baseCurrency: string;
  decision: 'approved' | 'declined' | 'review';
  reason: string;
  memo: string | null;
  createdAt: string;
}

export interface PublicVerifyResult {
  /**
   * valid: signature and hash check out with a known issuer's key. invalid: they do not.
   * unknown-issuer: no organisation or sandbox here has this issuer id, so nothing was checked.
   * error: not a receipt at all (or too long, or too many requests).
   */
  outcome: 'valid' | 'invalid' | 'unknown-issuer' | 'error';
  error?: string;
  /** From the receipt (only once it parsed). */
  issuer?: string;
  issuerKind?: 'organisation' | 'sandbox';
  /** The organisation's current name on this site; null for a sandbox. */
  issuerName?: string | null;
  checks?: string[];
  /** The ledger entry type and time, from the receipt. */
  entryType?: string;
  createdAt?: string;
  /** Only for a valid payment decision. */
  payment?: VerifiedPayment;
}

const decisionSchema = z.object({
  payment_id: z.string().min(1).max(200),
  request: z.object({
    merchant: z.string().max(500),
    amount: z.number().int(),
    currency: z.string().min(1).max(10),
    memo: z.string().max(2000).optional(),
  }),
  decision: z.enum(['approved', 'declined', 'review']),
  reason: z.string().max(5000),
  amount_base: z.number().int().nullable(),
  base_currency: z.string().min(1).max(10),
});

interface IssuerRow {
  name: string | null;
  issuer_public_key: string;
  kind: 'organisation' | 'sandbox';
}

async function findIssuer(sql: Sql, issuer: string): Promise<IssuerRow | null> {
  const orgs = await sql.query<{ name: string; issuer_public_key: string }>(
    'select name, issuer_public_key from orgs where issuer = $1 limit 1',
    [issuer],
  );
  const org = orgs[0];
  if (org) return { ...org, kind: 'organisation' };
  // Archived sandboxes too: a receipt from before "Start over" is still genuine.
  const boxes = await sql.query<{ issuer_public_key: string }>(
    'select issuer_public_key from sandboxes where issuer = $1 limit 1',
    [issuer],
  );
  const box = boxes[0];
  return box ? { name: null, issuer_public_key: box.issuer_public_key, kind: 'sandbox' } : null;
}

/** Check one pasted receipt. Untrusted input: size-capped, parsed by the core's strict schema. */
export async function verifyPublicReceipt(sql: Sql, text: string): Promise<PublicVerifyResult> {
  if (text.trim() === '') return { outcome: 'error', error: 'Paste a receipt first.' };
  if (Buffer.byteLength(text, 'utf8') > MAX_RECEIPT_BYTES) {
    return { outcome: 'error', error: 'That is too long to be a Flow-E receipt (32 KB at most).' };
  }
  let receipt;
  try {
    receipt = parseReceipt(text);
  } catch (err) {
    if (err instanceof ReceiptError) {
      return {
        outcome: 'error',
        error: err.message.startsWith('Receipt is not valid JSON')
          ? 'This is not valid JSON. Paste the whole receipt file, from { to }.'
          : 'This is not a Flow-E receipt: it lacks fields a receipt has, or has others.',
      };
    }
    throw err;
  }

  const base = {
    issuer: receipt.issuer,
    entryType: receipt.entry.type,
    createdAt: receipt.entry.created_at,
  };
  const found = await findIssuer(sql, receipt.issuer);
  if (!found) return { outcome: 'unknown-issuer', ...base };

  let checks: string[];
  let valid: boolean;
  try {
    ({ valid, checks } = verifyReceipt(receipt, createPublicKey(found.issuer_public_key)));
  } catch {
    // A malformed signature can make the crypto throw; that is simply not a valid receipt.
    valid = false;
    checks = ['✖ issuer signature is not valid'];
  }
  const result: PublicVerifyResult = {
    outcome: valid ? 'valid' : 'invalid',
    ...base,
    issuerKind: found.kind,
    issuerName: found.name,
    checks,
  };
  if (valid && receipt.entry.type === PAYMENT_DECISION) {
    const d = decisionSchema.safeParse(receipt.entry.data);
    if (d.success) {
      result.payment = {
        paymentId: d.data.payment_id,
        agentId: receipt.entry.agent_id,
        merchant: d.data.request.merchant,
        amount: d.data.request.amount,
        currency: d.data.request.currency,
        amountBase: d.data.amount_base,
        baseCurrency: d.data.base_currency,
        decision: d.data.decision,
        reason: d.data.reason,
        memo: d.data.request.memo ?? null,
        createdAt: receipt.entry.created_at,
      };
    }
  }
  return result;
}

// HTTP --------------------------------------------------------------------------------------------

export interface VerifyLimits {
  perClient: RateLimiter;
  global: RateLimiter;
}

export function newVerifyLimits(clock?: () => number): VerifyLimits {
  return {
    perClient: new RateLimiter(VERIFY_PER_MINUTE, 60_000, clock),
    global: new RateLimiter(VERIFY_GLOBAL_PER_MINUTE, 60_000, clock),
  };
}

/** The client address as the hosting proxy reports it (Vercel sets both headers). */
function clientKey(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded ?? 'unknown';
}

/** Read at most `limit` bytes of the body; null when it is larger. */
async function readBody(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reply(
  status: number,
  body: PublicVerifyResult,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** POST /api/verify: the body is the receipt text; the answer is a PublicVerifyResult. */
export async function handleVerify(
  req: Request,
  deps: { sql: Sql; limits: VerifyLimits },
): Promise<Response> {
  const mine = deps.limits.perClient.take(clientKey(req));
  const all = mine.ok ? deps.limits.global.take('*') : mine;
  if (!mine.ok || !all.ok) {
    const wait = Math.max(mine.retryAfterS, all.retryAfterS);
    return reply(
      429,
      { outcome: 'error', error: `Too many checks. Try again in ${String(wait)} seconds.` },
      { 'retry-after': String(wait) },
    );
  }
  const body = await readBody(req, MAX_RECEIPT_BYTES);
  if (body === null) {
    return reply(413, {
      outcome: 'error',
      error: 'That is too long to be a Flow-E receipt (32 KB at most).',
    });
  }
  try {
    return reply(200, await verifyPublicReceipt(deps.sql, body));
  } catch (err) {
    console.error('public verify failed', err instanceof Error ? err.name : 'unknown');
    return reply(500, {
      outcome: 'error',
      error: 'Something went wrong while checking. Please try again.',
    });
  }
}
