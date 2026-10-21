import { createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyStoreError, loadIssuer } from '../kya/store.js';
import { Ledger, LedgerError } from '../ledger/ledger.js';
import { entryHash, parseReceipt, verifyReceipt } from '../ledger/receipt.js';

/** Command bodies for the ledger, kept apart from commander so tests can call them directly. */

export interface CommandResult {
  ok: boolean;
  text: string;
}

export function ledgerPath(home: string): string {
  return join(home, 'ledger.db');
}

function publicKeyFrom(home: string, file: string | undefined): KeyObject {
  if (file === undefined) return loadIssuer(home).publicKey;
  try {
    const key = createPublicKey(readFileSync(file, 'utf8'));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return key;
  } catch {
    throw new KeyStoreError(`${file} is not an Ed25519 public key.`);
  }
}

export function runAudit(o: { home: string; ledger?: string | undefined }): CommandResult {
  const path = o.ledger ?? ledgerPath(o.home);
  const publicKey = loadIssuer(o.home).publicKey;
  const ledger = Ledger.openReadOnly(path);
  try {
    const result = ledger.audit(publicKey);
    if (result.ok) {
      return {
        ok: true,
        text: result.head
          ? `✔ Ledger intact: ${result.entries} entries, head #${result.head.seq} ${result.head.hash}`
          : '✔ Ledger intact: no entries yet.',
      };
    }
    const b = result.firstBroken;
    return {
      ok: false,
      text:
        `✖ Ledger is BROKEN at entry #${b.seq}${b.id ? ` (${b.id})` : ''}: ${b.reason}.\n` +
        `  Entries #1–#${result.entries} verified; nothing from #${b.seq} on can be trusted.`,
    };
  } finally {
    ledger.close();
  }
}

export function runVerify(o: {
  home: string;
  receipt: string;
  pubkey?: string | undefined;
  ledger?: string | undefined;
  offline?: boolean | undefined;
}): CommandResult {
  const receipt = parseReceipt(readFileSync(o.receipt, 'utf8'));
  const { valid, checks } = verifyReceipt(receipt, publicKeyFrom(o.home, o.pubkey));
  const lines = [`Receipt ${receipt.entry.id} (entry #${receipt.entry.seq}):`, ...checks];
  let ok = valid;

  const path = o.ledger ?? ledgerPath(o.home);
  if (o.offline || !existsSync(path)) {
    lines.push('· chain position not checked (no ledger available; offline check only)');
  } else {
    const ledger = Ledger.openReadOnly(path);
    try {
      const { seq, hash, prev_hash: prevHash } = receipt.entry;
      const stored = ledger.bySeq(seq);
      const prev = seq > 1 ? ledger.bySeq(seq - 1) : undefined;
      if (!stored) {
        ok = false;
        lines.push(`✖ the ledger has no entry #${seq} (it was removed or this is another ledger)`);
      } else if (stored.hash !== hash || entryHash(stored) !== hash) {
        ok = false;
        lines.push(`✖ ledger entry #${seq} differs from this receipt`);
      } else if (seq > 1 && prev?.hash !== prevHash) {
        ok = false;
        lines.push(`✖ ledger entry #${seq - 1} no longer matches the receipt's link`);
      } else {
        lines.push(`✔ matches ledger entry #${seq} and its link to the previous entry`);
      }
    } finally {
      ledger.close();
    }
    lines.push('  (run "imprest audit" to check the whole chain)');
  }
  lines.push(ok ? 'VALID' : 'INVALID');
  return { ok, text: lines.join('\n') };
}

export function runReceipt(o: {
  home: string;
  id: string;
  ledger?: string | undefined;
}): CommandResult {
  const ledger = Ledger.openReadOnly(o.ledger ?? ledgerPath(o.home));
  try {
    const receipt = ledger.receipt(o.id);
    if (!receipt) throw new LedgerError(`No ledger entry or payment with id "${o.id}".`);
    return { ok: true, text: JSON.stringify(receipt, null, 2) };
  } finally {
    ledger.close();
  }
}
