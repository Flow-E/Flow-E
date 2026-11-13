import { createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, defaultHome } from '../../src/cli/home.js';
import { canonicalJson } from '../../src/crypto/canonical.js';
import {
  generateKeyPair,
  issuerIdFor,
  issuerMatches,
  signPayload,
} from '../../src/crypto/ed25519.js';
import { issuerIdForVersion, sameIssuer } from '../../src/engine/issuer.js';
import {
  CREDENTIAL_FORMAT,
  LEGACY_CREDENTIAL_DOMAIN,
  LEGACY_CREDENTIAL_FORMAT,
  issueCredential,
  parseCredential,
  signatureCheck,
  type CredentialFile,
} from '../../src/kya/credential.js';
import { auditEntries, buildEntry, fromStored, type StoredEntry } from '../../src/ledger/fold.js';
import { Ledger } from '../../src/ledger/ledger.js';
import {
  GENESIS_HASH,
  LEGACY_RECEIPT_FORMAT,
  RECEIPT_FORMAT,
  entryHash,
  entryVersion,
  parseReceipt,
  toReceipt,
  verifyReceipt,
  type EntryBody,
  type Receipt,
} from '../../src/ledger/receipt.js';

/**
 * Data signed before the rename to Mandate (version 1, "flow-e-*") must keep verifying, and must
 * not become a way around the checks: altered v1 data, v1 entries after v2 ones, and labels
 * swapped between the versions all fail.
 */

const NOW = Date.parse('2026-11-13T09:00:00Z');

function keys(): { privateKey: KeyObject; publicKey: KeyObject; issuer: string; legacy: string } {
  const pair = generateKeyPair();
  const publicKey = createPublicKey(pair.publicKeyPem);
  const issuer = issuerIdFor(publicKey);
  return {
    privateKey: createPrivateKey(pair.privateKeyPem),
    publicKey,
    issuer,
    legacy: issuerIdForVersion(issuer, 1),
  };
}

/** An entry exactly as Flow-E wrote it before the rename. */
function legacyEntry(
  k: ReturnType<typeof keys>,
  prev: { seq: number; hash: string } | null,
  data: Record<string, string | number> = { note: 'written as Flow-E' },
): StoredEntry {
  const body: EntryBody = {
    seq: (prev?.seq ?? 0) + 1,
    id: `rcpt_legacy_${(prev?.seq ?? 0) + 1}`,
    type: 'payment.decision',
    agent_id: 'lab-procurement',
    created_at: new Date(NOW).toISOString(),
    data,
    prev_hash: prev?.hash ?? GENESIS_HASH,
  };
  const hash = entryHash(body, 1);
  const signature = signPayload(
    k.privateKey,
    'flow-e-receipt-v1',
    canonicalJson({ issuer: k.legacy, hash }),
  );
  return { ...body, data: canonicalJson(body.data), hash, signature };
}

function currentEntry(k: ReturnType<typeof keys>, prev: { seq: number; hash: string } | null) {
  return buildEntry(
    prev,
    { type: 'payment.decision', agentId: 'lab-procurement', now: NOW, data: { note: 'Mandate' } },
    { issuer: k.issuer, privateKey: k.privateKey },
  ).stored;
}

function chain(k: ReturnType<typeof keys>, versions: (1 | 2)[]): StoredEntry[] {
  const rows: StoredEntry[] = [];
  for (const v of versions) {
    const prev = rows.at(-1) ?? null;
    rows.push(v === 1 ? legacyEntry(k, prev) : currentEntry(k, prev));
  }
  return rows;
}

function at<T>(items: T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`no item ${i}`);
  return item;
}

describe('issuer ids across the rename', () => {
  it('writes new ids as mandate-issuer and treats the flow-e form as the same issuer', () => {
    const k = keys();
    expect(k.issuer).toMatch(/^mandate-issuer:[0-9a-f]{16}$/);
    expect(k.legacy).toBe(k.issuer.replace('mandate-issuer:', 'flow-e-issuer:'));
    expect(issuerIdForVersion(k.legacy, 2)).toBe(k.issuer);
    expect(sameIssuer(k.issuer, k.legacy)).toBe(true);
    expect(issuerMatches(k.legacy, k.publicKey)).toBe(true);
  });

  it('never matches a different key, an unknown prefix or an empty fingerprint', () => {
    const a = keys();
    const b = keys();
    expect(sameIssuer(a.issuer, b.legacy)).toBe(false);
    expect(issuerMatches(b.issuer, a.publicKey)).toBe(false);
    expect(sameIssuer('other-issuer:abc', 'mandate-issuer:abc')).toBe(false);
    expect(sameIssuer('mandate-issuer:', 'flow-e-issuer:')).toBe(false);
    expect(issuerIdForVersion('other-issuer:abc', 1)).toBe('other-issuer:abc');
  });
});

describe('version 1 receipts', () => {
  it('a receipt from before the rename still verifies, in its own format', () => {
    const k = keys();
    const row = at(chain(k, [1]), 0);
    const receipt = toReceipt(k.issuer, fromStored(row));
    expect(receipt.format).toBe(LEGACY_RECEIPT_FORMAT);
    expect(receipt.issuer).toBe(k.legacy);
    const parsed = parseReceipt(JSON.stringify(receipt));
    expect(verifyReceipt(parsed, k.publicKey).valid).toBe(true);
  });

  it('a new receipt is version 2', () => {
    const k = keys();
    const row = at(chain(k, [2]), 0);
    const receipt = toReceipt(k.issuer, fromStored(row));
    expect(receipt.format).toBe(RECEIPT_FORMAT);
    expect(receipt.issuer).toBe(k.issuer);
    expect(entryVersion(fromStored(row))).toBe(2);
    expect(verifyReceipt(receipt, k.publicKey).valid).toBe(true);
  });

  it('an altered version 1 receipt fails', () => {
    const k = keys();
    const receipt = toReceipt(k.issuer, fromStored(legacyEntry(k, null, { amount: 100 })));
    const altered: Receipt = { ...receipt, entry: { ...receipt.entry, data: { amount: 1 } } };
    const check = verifyReceipt(altered, k.publicKey);
    expect(check.valid).toBe(false);
    expect(check.checks.join('\n')).toContain('the receipt was altered');
  });

  it('relabelling a receipt as the other version fails', () => {
    const k = keys();
    const v1 = toReceipt(k.issuer, fromStored(at(chain(k, [1]), 0)));
    const v2 = toReceipt(k.issuer, fromStored(at(chain(k, [2]), 0)));
    for (const swapped of [
      { ...v1, format: RECEIPT_FORMAT, issuer: k.issuer },
      { ...v2, format: LEGACY_RECEIPT_FORMAT, issuer: k.legacy },
      { ...v1, issuer: k.issuer },
      { ...v2, issuer: k.legacy },
    ] as Receipt[]) {
      expect(verifyReceipt(swapped, k.publicKey).valid).toBe(false);
    }
  });

  it('refuses a version 1 receipt checked against another key', () => {
    const k = keys();
    const receipt = toReceipt(k.issuer, fromStored(at(chain(k, [1]), 0)));
    expect(verifyReceipt(receipt, keys().publicKey).valid).toBe(false);
  });
});

describe('chains across the rename', () => {
  it('a chain written before the rename audits clean, bound to either form', () => {
    const k = keys();
    const rows = chain(k, [1, 1, 1]);
    expect(auditEntries(rows, k.legacy, k.publicKey)).toMatchObject({ ok: true, entries: 3 });
    expect(auditEntries(rows, k.issuer, k.publicKey)).toMatchObject({ ok: true, entries: 3 });
  });

  it('a chain that continues from version 1 into version 2 audits clean', () => {
    const k = keys();
    const rows = chain(k, [1, 1, 2, 2]);
    expect(auditEntries(rows, k.legacy, k.publicKey)).toMatchObject({ ok: true, entries: 4 });
  });

  it('a version 1 entry after a version 2 one breaks the chain', () => {
    const k = keys();
    const rows = chain(k, [1, 2, 1]);
    const result = auditEntries(rows, k.legacy, k.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstBroken.seq).toBe(3);
      expect(result.firstBroken.reason).toContain('version 1 entry after a version 2 entry');
    }
  });

  it('an edited version 1 entry is caught', () => {
    const k = keys();
    const rows = chain(k, [1, 1, 2]);
    rows[1] = { ...at(rows, 1), data: canonicalJson({ note: 'edited' }) };
    const result = auditEntries(rows, k.issuer, k.publicKey);
    expect(result).toMatchObject({ ok: false, firstBroken: { seq: 2 } });
  });

  it('a version 1 entry re-signed without the issuer key is caught', () => {
    const k = keys();
    const forger = keys();
    const rows = chain(k, [1, 1]);
    const hash = at(rows, 1).hash;
    rows[1] = {
      ...at(rows, 1),
      signature: signPayload(
        forger.privateKey,
        'flow-e-receipt-v1',
        canonicalJson({ issuer: k.legacy, hash }),
      ),
    };
    const result = auditEntries(rows, k.issuer, k.publicKey);
    expect(result).toMatchObject({ ok: false, firstBroken: { seq: 2 } });
    if (!result.ok) expect(result.firstBroken.reason).toContain('signature is not valid');
  });

  it('a ledger bound to the flow-e form opens under the new id and keeps its chain', () => {
    const k = keys();
    const path = join(mkdtempSync(join(tmpdir(), 'mandate-legacy-')), 'ledger.db');
    const old = Ledger.open(path, { issuer: k.legacy, privateKey: k.privateKey });
    old.close();
    const ledger = Ledger.open(path, { issuer: k.issuer, privateKey: k.privateKey });
    try {
      expect(ledger.audit(k.publicKey)).toMatchObject({ ok: true });
    } finally {
      ledger.close();
    }
    expect(() => Ledger.open(path, { issuer: keys().issuer, privateKey: k.privateKey })).toThrow(
      /Refusing to mix keys/,
    );
  });
});

describe('version 1 credentials', () => {
  function legacyCredential(k: ReturnType<typeof keys>): CredentialFile {
    const current = issueCredential({
      privateKey: k.privateKey,
      publicKey: k.publicKey,
      agentId: 'lab-procurement',
      agentName: 'Lab procurement',
      owner: 'owner@mandate.test',
      organisation: 'Fictional Lab',
      scope: ['payments:request'],
      now: NOW,
      validDays: 30,
    });
    const claims = { ...current.claims, issuer: k.legacy };
    return {
      format: LEGACY_CREDENTIAL_FORMAT,
      claims,
      signature: signPayload(k.privateKey, LEGACY_CREDENTIAL_DOMAIN, canonicalJson(claims)),
    };
  }

  it('a credential issued before the rename parses and its signature is valid', () => {
    const k = keys();
    const file = parseCredential(JSON.stringify(legacyCredential(k)));
    expect(file.format).toBe(LEGACY_CREDENTIAL_FORMAT);
    expect(signatureCheck(k.publicKey)(file)).toEqual({ valid: true });
  });

  it('a tampered version 1 credential fails', () => {
    const k = keys();
    const file = legacyCredential(k);
    const tampered = { ...file, claims: { ...file.claims, scope: ['payments:request', 'admin'] } };
    expect(signatureCheck(k.publicKey)(tampered).valid).toBe(false);
  });

  it('a signature cannot move between the versions', () => {
    const k = keys();
    const legacy = legacyCredential(k);
    // v1 signature, claims relabelled to the current issuer form: checked as v2, fails.
    const relabelled = { ...legacy, claims: { ...legacy.claims, issuer: k.issuer } };
    expect(signatureCheck(k.publicKey)(relabelled).valid).toBe(false);
    // A current credential is version 2 and verifies only as such.
    const current = issueCredential({
      privateKey: k.privateKey,
      publicKey: k.publicKey,
      agentId: 'lab-procurement',
      agentName: 'Lab procurement',
      owner: 'owner@mandate.test',
      organisation: 'Fictional Lab',
      scope: ['payments:request'],
      now: NOW,
      validDays: 30,
    });
    expect(current.format).toBe(CREDENTIAL_FORMAT);
    expect(signatureCheck(k.publicKey)(current)).toEqual({ valid: true });
    const downgraded = { ...current, claims: { ...current.claims, issuer: k.legacy } };
    expect(signatureCheck(k.publicKey)(downgraded).valid).toBe(false);
  });
});

describe('state folder and env across the rename', () => {
  const none = () => false;
  it('defaults to .mandate', () => {
    expect(defaultHome({}, '/p', none)).toBe('.mandate');
    expect(defaultConfig({})).toBe('mandate.yaml');
  });

  it('keeps using a .flow-e folder when it is the only one', () => {
    expect(defaultHome({}, '/p', (p) => p.replace(/\\/g, '/') === '/p/.flow-e')).toBe('.flow-e');
    expect(defaultHome({}, '/p', () => true)).toBe('.mandate');
  });

  it('reads MANDATE_* first, then the older FLOWE_*', () => {
    expect(defaultHome({ FLOWE_HOME: 'old' }, '/p', none)).toBe('old');
    expect(defaultHome({ MANDATE_HOME: 'new', FLOWE_HOME: 'old' }, '/p', none)).toBe('new');
    expect(defaultConfig({ FLOWE_CONFIG: 'old.yaml' })).toBe('old.yaml');
    expect(defaultConfig({ MANDATE_CONFIG: 'new.yaml', FLOWE_CONFIG: 'old.yaml' })).toBe(
      'new.yaml',
    );
  });
});
