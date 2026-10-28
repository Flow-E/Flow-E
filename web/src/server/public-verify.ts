import 'server-only';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  GENESIS_HASH,
  PAYMENT_DECISION,
  ReceiptError,
  issuerIdFor,
  parseReceipt,
  verifyReceipt,
  type Receipt,
} from '@flow-e/mcp/core';
import type { Sql } from './db';
import { publishedKey, type PublishedKey } from './published-keys';
import { RateLimiter } from './rate-limit';

/**
 * The public receipt check behind /verify: anyone (a supplier, an auditor, finance) pastes a
 * Flow-E receipt and learns whether it is genuine. No sign-in.
 *
 * It uses only two things: the pasted receipt, and the issuer's published public key (the file
 * at /keys/<issuer>.pub, or a key the person pastes themselves). No lookups by payment id, no
 * search, nothing else from the account; it never says what happened after signing. The crypto
 * is the core's verifyReceipt, the same check as `flow-e verify --offline`.
 */

export const MAX_RECEIPT_BYTES = 32 * 1024;
export const MAX_KEY_BYTES = 4 * 1024;
/** Per client address, and for the whole server instance (addresses are cheap to change). */
export const VERIFY_PER_MINUTE = 20;
export const VERIFY_GLOBAL_PER_MINUTE = 600;
/** A receipt dated further ahead than this is not a plausible ledger entry. */
const CLOCK_SKEW_MS = 5 * 60_000;

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
   * valid: signature and hash check out with the key. invalid: they do not (forged or altered).
   * unknown-issuer: no key is published for this issuer and none was supplied; nothing checked.
   * error: not a receipt at all (or too long, or too many requests).
   */
  outcome: 'valid' | 'invalid' | 'unknown-issuer' | 'error';
  error?: string;
  /** From the receipt (only once it parsed). */
  issuer?: string;
  /** Where the key came from: published on this site, or pasted by the person checking. */
  keySource?: 'published' | 'supplied';
  /** The published key's address on this site. */
  keyUrl?: string;
  issuerKind?: 'organisation' | 'sandbox';
  /** The name published with the key; null for a sandbox or a supplied key. */
  issuerName?: string | null;
  checks?: string[];
  /** Whether the entry's place in its ledger is plausible: sequence, previous hash, date. */
  position?: { consistent: boolean; checks: string[] };
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

/**
 * What one receipt can show about its place in the hash chain without the rest of the ledger:
 * the first entry starts from the genesis hash and no other does, an entry never points at
 * itself, and its date is a real date that is not in the future.
 */
export function positionChecks(
  receipt: Pick<Receipt, 'entry'>,
  now: number,
): { consistent: boolean; checks: string[] } {
  const e = receipt.entry;
  const checks: string[] = [];
  let consistent = true;
  const check = (ok: boolean, yes: string, no: string) => {
    checks.push(ok ? `✔ ${yes}` : `✖ ${no}`);
    if (!ok) consistent = false;
  };
  const first = e.seq === 1;
  check(
    first === (e.prev_hash === GENESIS_HASH),
    first
      ? 'first entry of its ledger, starting from the genesis hash'
      : `entry ${String(e.seq)} of its ledger, after an earlier entry`,
    first
      ? 'claims to be the first entry but does not start from the genesis hash'
      : `entry ${String(e.seq)} claims to start a new ledger (genesis hash)`,
  );
  check(e.hash !== e.prev_hash, 'links to a different previous entry', 'links to itself');
  const at = Date.parse(e.created_at);
  check(
    !Number.isNaN(at) && at <= now + CLOCK_SKEW_MS,
    'dated in the past',
    Number.isNaN(at) ? 'has no readable date' : 'is dated in the future',
  );
  return { consistent, checks };
}

function parseSuppliedKey(text: string): KeyObject | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_KEY_BYTES) return null;
  try {
    const key = createPublicKey(text);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

export interface VerifyDeps {
  /** The issuer's published key, or null. */
  resolveKey: (issuer: string) => Promise<PublishedKey | null>;
  now: number;
}

/**
 * Check one pasted receipt. Untrusted input: size-capped, parsed by the core's strict schema.
 * `suppliedKey`: a public key (PEM) the person has from elsewhere; then the published key is not
 * used at all.
 */
export async function verifyPublicReceipt(
  text: string,
  deps: VerifyDeps,
  suppliedKey?: string,
): Promise<PublicVerifyResult> {
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

  let key: KeyObject;
  let source: Pick<PublicVerifyResult, 'keySource' | 'keyUrl' | 'issuerKind' | 'issuerName'>;
  if (suppliedKey !== undefined && suppliedKey.trim() !== '') {
    const parsed = parseSuppliedKey(suppliedKey);
    if (!parsed) {
      return {
        outcome: 'error',
        error: 'That public key is not readable. Paste the whole issuer.pub file, BEGIN to END.',
      };
    }
    key = parsed;
    source = { keySource: 'supplied', issuerName: null };
  } else {
    const published = await deps.resolveKey(receipt.issuer);
    if (!published) return { outcome: 'unknown-issuer', ...base };
    key = createPublicKey(published.publicKeyPem);
    source = {
      keySource: 'published',
      keyUrl: `/keys/${published.issuer}.pub`,
      issuerKind: published.kind,
      issuerName: published.organisation,
    };
  }

  let checks: string[];
  let valid: boolean;
  try {
    ({ valid, checks } = verifyReceipt(receipt, key));
  } catch {
    // A malformed signature can make the crypto throw; that is simply not a valid receipt.
    valid = false;
    checks = [`✖ issuer signature is not valid for key ${issuerIdFor(key)}`];
  }
  const result: PublicVerifyResult = {
    outcome: valid ? 'valid' : 'invalid',
    ...base,
    ...source,
    checks,
    position: positionChecks(receipt, deps.now),
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

const wrapperSchema = z.strictObject({
  receipt: z.string(),
  public_key: z.string().optional(),
});

/**
 * The body is either the receipt itself, or `{"receipt": "<text>", "public_key": "<PEM>"}` to
 * check against a key the person supplies.
 */
export function splitBody(body: string): { receipt: string; key?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { receipt: body };
  }
  const wrapper = wrapperSchema.safeParse(parsed);
  return wrapper.success
    ? { receipt: wrapper.data.receipt, key: wrapper.data.public_key }
    : { receipt: body };
}

/** POST /api/verify: the body is the receipt (see splitBody); the answer a PublicVerifyResult. */
export async function handleVerify(
  req: Request,
  deps: { sql: Sql; limits: VerifyLimits; now?: () => number },
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
  const body = await readBody(req, MAX_RECEIPT_BYTES + MAX_KEY_BYTES);
  if (body === null) {
    return reply(413, {
      outcome: 'error',
      error: 'That is too long to be a Flow-E receipt (32 KB at most).',
    });
  }
  try {
    const { receipt, key } = splitBody(body);
    return reply(
      200,
      await verifyPublicReceipt(
        receipt,
        {
          resolveKey: (issuer) => publishedKey(deps.sql, issuer),
          now: deps.now?.() ?? Date.now(),
        },
        key,
      ),
    );
  } catch (err) {
    console.error('public verify failed', err instanceof Error ? err.name : 'unknown');
    return reply(500, {
      outcome: 'error',
      error: 'Something went wrong while checking. Please try again.',
    });
  }
}
