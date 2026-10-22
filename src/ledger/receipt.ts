import { createHash, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../crypto/canonical.js';
import { issuerIdFor, signPayload, verifyPayload } from '../crypto/ed25519.js';

/**
 * Ledger entries, their hash chain and receipts.
 *
 * hash      = SHA-256("flow-e-ledger-v1\n" + canonical({seq, id, type, agent_id, created_at, data, prev_hash}))
 * signature = Ed25519 over canonical({issuer, hash}), domain "flow-e-receipt-v1"
 *
 * The hash commits to the entry and, through prev_hash, to every entry before it. The signature
 * proves the issuer wrote it, so rewriting history needs the issuer's private key.
 */

export const GENESIS_HASH = '0'.repeat(64);
export const RECEIPT_FORMAT = 'flow-e-receipt/v1';
const HASH_DOMAIN = 'flow-e-ledger-v1';
const RECEIPT_DOMAIN = 'flow-e-receipt-v1';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The hashed content of an entry. */
export interface EntryBody {
  seq: number;
  id: string;
  type: string;
  agent_id: string;
  /** ISO 8601. */
  created_at: string;
  data: { [key: string]: JsonValue };
  prev_hash: string;
}

export interface Entry extends EntryBody {
  hash: string;
  signature: string;
}

export interface Receipt {
  format: typeof RECEIPT_FORMAT;
  issuer: string;
  entry: Omit<Entry, 'signature'>;
  signature: string;
}

export function entryHash(body: EntryBody): string {
  const canonical = canonicalJson({
    seq: body.seq,
    id: body.id,
    type: body.type,
    agent_id: body.agent_id,
    created_at: body.created_at,
    data: body.data,
    prev_hash: body.prev_hash,
  });
  return createHash('sha256').update(`${HASH_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

export function signHash(privateKey: KeyObject, issuer: string, hash: string): string {
  return signPayload(privateKey, RECEIPT_DOMAIN, canonicalJson({ issuer, hash }));
}

export function verifyHashSignature(
  publicKey: KeyObject,
  issuer: string,
  hash: string,
  signature: string,
): boolean {
  return verifyPayload(publicKey, RECEIPT_DOMAIN, canonicalJson({ issuer, hash }), signature);
}

export function toReceipt(issuer: string, entry: Entry): Receipt {
  const { signature, ...rest } = entry;
  return { format: RECEIPT_FORMAT, issuer, entry: rest, signature };
}

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const receiptSchema = z.strictObject({
  format: z.literal(RECEIPT_FORMAT),
  issuer: z.string().min(1),
  entry: z.strictObject({
    seq: z.number().int().positive(),
    id: z.string().min(1),
    type: z.string().min(1),
    agent_id: z.string().min(1),
    created_at: z.string(),
    data: z.record(z.string(), jsonValue),
    prev_hash: hex64,
    hash: hex64,
  }),
  signature: z.string(),
});

export class ReceiptError extends Error {
  override name = 'ReceiptError';
}

export function parseReceipt(text: string): Receipt {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReceiptError('Receipt is not valid JSON.');
  }
  const result = receiptSchema.safeParse(raw);
  if (!result.success) {
    throw new ReceiptError(`Receipt is malformed:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface ReceiptCheck {
  valid: boolean;
  /** One line per check, each starting with ✔ or ✖. */
  checks: string[];
}

/** Verify a receipt offline, with only the issuer public key. */
export function verifyReceipt(receipt: Receipt, publicKey: KeyObject): ReceiptCheck {
  const checks: string[] = [];
  let valid = true;
  const check = (ok: boolean, yes: string, no: string) => {
    checks.push(ok ? `✔ ${yes}` : `✖ ${no}`);
    if (!ok) valid = false;
  };
  const keyId = issuerIdFor(publicKey);
  check(
    receipt.issuer === keyId,
    `issued by ${keyId}`,
    `receipt names issuer ${receipt.issuer}, but the public key is ${keyId}`,
  );
  const recomputed = entryHash(receipt.entry);
  check(
    recomputed === receipt.entry.hash,
    'contents match the entry hash',
    'contents do not match the entry hash (the receipt was altered)',
  );
  check(
    verifyHashSignature(publicKey, receipt.issuer, receipt.entry.hash, receipt.signature),
    'issuer signature is valid',
    'issuer signature is not valid',
  );
  return { valid, checks };
}
