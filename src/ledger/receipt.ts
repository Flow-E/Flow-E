import { createHash, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../crypto/canonical.js';
import { issuerIdFor, issuerIdForVersion, signPayload, verifyPayload } from '../crypto/ed25519.js';

/**
 * Ledger entries, their hash chain and receipts.
 *
 * hash      = SHA-256("mandate-ledger-v2\n" + canonical({seq, id, type, agent_id, created_at, data, prev_hash}))
 * signature = Ed25519 over canonical({issuer, hash}), domain "mandate-receipt-v2"
 *
 * The hash commits to the entry and, through prev_hash, to every entry before it. The signature
 * proves the issuer wrote it, so rewriting history needs the issuer's private key.
 *
 * Version 1 is the same scheme under the product's earlier name: "flow-e-ledger-v1",
 * "flow-e-receipt-v1", format "flow-e-receipt/v1" and issuer ids "flow-e-issuer:…". New entries
 * are always version 2. Version 1 entries, receipts and chains still verify, so nothing signed
 * before the rename is orphaned. A chain may start with version 1 entries and continue with
 * version 2 ones, never the other way round.
 */

export const GENESIS_HASH = '0'.repeat(64);
export const RECEIPT_FORMAT = 'mandate-receipt/v2';
export const LEGACY_RECEIPT_FORMAT = 'flow-e-receipt/v1';
export type ReceiptFormat = typeof RECEIPT_FORMAT | typeof LEGACY_RECEIPT_FORMAT;

export type LedgerVersion = 1 | 2;
/** The version every new entry is written under. */
export const LEDGER_VERSION: LedgerVersion = 2;

const DOMAINS: Record<LedgerVersion, { hash: string; receipt: string; format: ReceiptFormat }> = {
  1: { hash: 'flow-e-ledger-v1', receipt: 'flow-e-receipt-v1', format: LEGACY_RECEIPT_FORMAT },
  2: { hash: 'mandate-ledger-v2', receipt: 'mandate-receipt-v2', format: RECEIPT_FORMAT },
};

/** The ledger version a receipt format belongs to. */
export function receiptVersion(format: ReceiptFormat): LedgerVersion {
  return format === LEGACY_RECEIPT_FORMAT ? 1 : 2;
}

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
  format: ReceiptFormat;
  issuer: string;
  entry: Omit<Entry, 'signature'>;
  signature: string;
}

/** The entry hash. Version 2 unless asked otherwise; version 1 only to check older entries. */
export function entryHash(body: EntryBody, version: LedgerVersion = LEDGER_VERSION): string {
  const canonical = canonicalJson({
    seq: body.seq,
    id: body.id,
    type: body.type,
    agent_id: body.agent_id,
    created_at: body.created_at,
    data: body.data,
    prev_hash: body.prev_hash,
  });
  return createHash('sha256')
    .update(`${DOMAINS[version].hash}\n${canonical}`, 'utf8')
    .digest('hex');
}

/**
 * Which version's hash this entry carries: 2, 1 (written before the rename), or null when the
 * contents match neither (the entry was altered).
 */
export function entryVersion(entry: EntryBody & { hash: string }): LedgerVersion | null {
  if (entryHash(entry, 2) === entry.hash) return 2;
  if (entryHash(entry, 1) === entry.hash) return 1;
  return null;
}

/** Sign a new (version 2) entry hash. The issuer id is signed in its version 2 form. */
export function signHash(privateKey: KeyObject, issuer: string, hash: string): string {
  return signPayload(
    privateKey,
    DOMAINS[LEDGER_VERSION].receipt,
    canonicalJson({ issuer: issuerIdForVersion(issuer, LEDGER_VERSION), hash }),
  );
}

/**
 * Check an entry signature made under the given version (default: the current one). The issuer
 * id is put in that version's form first, so a ledger bound to either form checks the same.
 */
export function verifyHashSignature(
  publicKey: KeyObject,
  issuer: string,
  hash: string,
  signature: string,
  version: LedgerVersion = LEDGER_VERSION,
): boolean {
  return verifyPayload(
    publicKey,
    DOMAINS[version].receipt,
    canonicalJson({ issuer: issuerIdForVersion(issuer, version), hash }),
    signature,
  );
}

/** A receipt for a stored entry, in the format of the version the entry was written under. */
export function toReceipt(issuer: string, entry: Entry): Receipt {
  const { signature, ...rest } = entry;
  const version = entryVersion(entry) ?? LEDGER_VERSION;
  return {
    format: DOMAINS[version].format,
    issuer: issuerIdForVersion(issuer, version),
    entry: rest,
    signature,
  };
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
  format: z.enum([RECEIPT_FORMAT, LEGACY_RECEIPT_FORMAT]),
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
  const version = receiptVersion(receipt.format);
  const keyId = issuerIdForVersion(issuerIdFor(publicKey), version);
  check(
    receipt.issuer === keyId,
    `issued by ${keyId}`,
    `receipt names issuer ${receipt.issuer}, but the public key is ${keyId}`,
  );
  const recomputed = entryHash(receipt.entry, version);
  check(
    recomputed === receipt.entry.hash,
    'contents match the entry hash',
    'contents do not match the entry hash (the receipt was altered)',
  );
  check(
    verifyHashSignature(publicKey, receipt.issuer, receipt.entry.hash, receipt.signature, version),
    'issuer signature is valid',
    'issuer signature is not valid',
  );
  return { valid, checks };
}
