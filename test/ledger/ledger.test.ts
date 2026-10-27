import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/crypto/canonical.js';
import { generateKeyPair } from '../../src/crypto/ed25519.js';
import { evaluate } from '../../src/engine/evaluate.js';
import { storePaths } from '../../src/kya/store.js';
import { Ledger, LedgerError, PAYMENT_DECISION } from '../../src/ledger/ledger.js';
import {
  GENESIS_HASH,
  entryHash,
  parseReceipt,
  ReceiptError,
  verifyReceipt,
  type Receipt,
} from '../../src/ledger/receipt.js';
import { MINUTE, NOW, context, credential, mandate, request } from '../engine/fixtures.js';
import { pay, setup, tamper, type Setup } from './helpers.js';

let s: Setup;
beforeEach(() => {
  s = setup();
});
afterEach(() => {
  try {
    s.ledger.close();
  } catch {
    // already closed
  }
});

function audit(path = s.path) {
  const ro = Ledger.openReadOnly(path);
  try {
    return ro.audit(s.issuer.publicKey);
  } finally {
    ro.close();
  }
}

/** Three decisions: approved, declined (blocked country), review (above threshold). */
function threeEntries(): Receipt[] {
  const r = [
    pay(s.ledger, {}, NOW - 30 * MINUTE),
    pay(s.ledger, { country: 'RU' }, NOW - 20 * MINUTE),
    pay(s.ledger, { amount: 600_000, merchant: 'Basel Labware AG' }, NOW - 10 * MINUTE),
  ];
  s.ledger.close();
  return r;
}

describe('hash chain', () => {
  it('links every entry to the one before, starting from the genesis hash', () => {
    const [a, b, c] = threeEntries();
    expect(a?.entry).toMatchObject({ seq: 1, prev_hash: GENESIS_HASH });
    expect(b?.entry).toMatchObject({ seq: 2, prev_hash: a?.entry.hash });
    expect(c?.entry).toMatchObject({ seq: 3, prev_hash: b?.entry.hash });
    for (const r of [a, b, c]) {
      if (!r) throw new Error('missing receipt');
      expect(r.entry.hash).toBe(entryHash(r.entry));
      expect(r.entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.entry.id).toMatch(/^rcpt_[0-9a-f]{20}$/);
    }
  });

  it('audits an intact ledger and reports the head', () => {
    const [, , c] = threeEntries();
    expect(audit()).toEqual({ ok: true, entries: 3, head: { seq: 3, hash: c?.entry.hash } });
  });

  it('audits an empty ledger', () => {
    s.ledger.close();
    expect(audit()).toEqual({ ok: true, entries: 0, head: null });
  });

  it('keeps one valid chain when two processes append to the same file', () => {
    const other = Ledger.open(s.path, { issuer: s.issuer.id, privateKey: s.issuer.privateKey });
    for (let i = 0; i < 10; i++) pay(i % 2 ? s.ledger : other, {}, NOW + i);
    other.close();
    s.ledger.close();
    expect(audit()).toMatchObject({ ok: true, entries: 10 });
  });
});

describe('append-only', () => {
  it('refuses UPDATE and DELETE through SQL', () => {
    threeEntries();
    const db = new Database(s.path);
    expect(() => db.exec("UPDATE entries SET data = '{}' WHERE seq = 2")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM entries WHERE seq = 3')).toThrow(/append-only/);
    db.close();
    expect(audit().ok).toBe(true);
  });

  it('writes nothing when the data cannot be represented exactly', () => {
    expect(() =>
      s.ledger.append({ type: 'x', agentId: 'a', now: NOW, data: { bad: Number.NaN } }),
    ).toThrow(TypeError);
    expect(s.ledger.entries()).toHaveLength(0);
  });
});

describe('editing the file by hand breaks the audit at the first changed entry', () => {
  const cases: [string, (path: string, r: Receipt[]) => void, number, RegExp][] = [
    [
      'changed amount',
      (p) => {
        tamper(p, `UPDATE entries SET data = json_set(data, '$.request.amount', 1) WHERE seq = 2`);
      },
      2,
      /contents do not match the stored hash/,
    ],
    [
      'changed decision',
      (p) => {
        tamper(
          p,
          `UPDATE entries SET data = json_set(data, '$.decision', 'approved') WHERE seq = 2`,
        );
      },
      2,
      /contents do not match/,
    ],
    [
      'reformatted JSON (same meaning, different bytes)',
      (p) => {
        tamper(p, `UPDATE entries SET data = json_pretty(data) WHERE seq = 1`);
      },
      1,
      /not valid canonical JSON/,
    ],
    [
      'unparseable JSON',
      (p) => {
        tamper(p, `UPDATE entries SET data = 'oops' WHERE seq = 3`);
      },
      3,
      /not valid canonical JSON/,
    ],
    [
      'changed timestamp',
      (p) => {
        tamper(p, `UPDATE entries SET created_at = '2020-01-01T00:00:00.000Z' WHERE seq = 2`);
      },
      2,
      /contents do not match/,
    ],
    [
      'deleted middle entry',
      (p) => {
        tamper(p, 'DELETE FROM entries WHERE seq = 2');
      },
      2,
      /entry #2 is missing/,
    ],
    [
      'relinked entry',
      (p) => {
        tamper(p, `UPDATE entries SET prev_hash = '${'1'.repeat(64)}' WHERE seq = 3`);
      },
      3,
      /does not link to entry #2/,
    ],
    [
      'signature copied from another entry',
      (p, r) => {
        tamper(p, `UPDATE entries SET signature = '${r[0]?.signature ?? ''}' WHERE seq = 2`);
      },
      2,
      /signature is not valid/,
    ],
  ];

  it.each(cases)('%s', (_name, edit, seq, reason) => {
    const receipts = threeEntries();
    edit(s.path, receipts);
    const result = audit();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.firstBroken.seq).toBe(seq);
    expect(result.firstBroken.reason).toMatch(reason);
    expect(result.entries).toBe(seq - 1);
  });

  it('catches a rewrite that recomputes the hash, because it cannot re-sign', () => {
    threeEntries();
    const db = new Database(s.path);
    db.exec('DROP TRIGGER entries_no_update');
    const row = db.prepare('SELECT * FROM entries WHERE seq = 2').get() as Record<string, string>;
    const data = JSON.parse(row.data ?? '') as { decision: string };
    data.decision = 'approved';
    const body = { ...row, seq: 2, data } as unknown as Parameters<typeof entryHash>[0];
    db.prepare('UPDATE entries SET data = ?, hash = ? WHERE seq = 2').run(
      canonicalJson(data),
      entryHash(body),
    );
    db.close();
    const result = audit();
    expect(result).toMatchObject({ ok: false, firstBroken: { seq: 2 } });
    expect(!result.ok && result.firstBroken.reason).toMatch(/signature is not valid/);
  });

  it('catches an entry forged and signed with another key', () => {
    threeEntries();
    // Sign a well-formed, correctly linked entry with a different key and insert it.
    const other = generateKeyPair();
    const fake = Ledger.open(join(s.dir, 'other.db'), {
      issuer: s.issuer.id,
      privateKey: createPrivateKey(other.privateKeyPem),
    });
    const forged = fake.append({ type: 'x', agentId: 'a', now: NOW, data: {} });
    fake.close();
    const last = audit();
    if (!last.ok || !last.head) throw new Error('setup');
    const body = { ...forged.entry, seq: 4, prev_hash: last.head.hash };
    const hash = entryHash(body);
    tamper(
      s.path,
      `INSERT INTO entries VALUES (4, 'rcpt_forged', 'x', 'a', '${body.created_at}', '{}', '${body.prev_hash}', '${hash}', '${forged.signature}')`,
    );
    expect(audit()).toMatchObject({ ok: false, firstBroken: { seq: 4, id: 'rcpt_forged' } });
  });

  it('refuses to audit with a public key the ledger was not written with', () => {
    threeEntries();
    const ro = Ledger.openReadOnly(s.path);
    const wrong = createPublicKey(generateKeyPair().publicKeyPem);
    const result = ro.audit(wrong);
    ro.close();
    expect(result).toMatchObject({ ok: false, firstBroken: { seq: 0 } });
    expect(!result.ok && result.firstBroken.reason).toMatch(/bound to issuer/);
  });

  it('does not see a deleted tail by itself (known limit; receipts held elsewhere catch it)', () => {
    threeEntries();
    tamper(s.path, 'DELETE FROM entries WHERE seq = 3');
    expect(audit()).toMatchObject({ ok: true, entries: 2 });
  });
});

describe('payment decisions', () => {
  it('records the request, decision, numbers and full trace', () => {
    const r = pay(s.ledger, { amount: 600_000 });
    expect(r.entry.type).toBe(PAYMENT_DECISION);
    expect(r.entry.agent_id).toBe('lab-procurement');
    expect(r.entry.data).toMatchObject({
      request: {
        merchant: 'Alpine Reagents AG',
        amount: 600_000,
        currency: 'CHF',
        category: '5169',
        country: 'CH',
        memo: 'Buffer solution, 10 L',
      },
      decision: 'review',
      rule: 'APPROVAL_THRESHOLD',
      amount_base: 600_000,
      base_currency: 'CHF',
      cancellable_until: null,
    });
    expect(r.entry.data.payment_id).toMatch(/^pay_/);
    expect(r.entry.data.trace).toHaveLength(18);
  });

  it('records the cooling-off window and leaves out a missing memo', () => {
    const r = pay(s.ledger, { memo: undefined });
    expect(r.entry.data.cancellable_until).toBe('2026-10-21T10:10:00.000Z');
    expect(r.entry.data.request).not.toHaveProperty('memo');
  });

  it('finds an entry by receipt id or by payment id', () => {
    const r = pay(s.ledger);
    const paymentId = r.entry.data.payment_id as string;
    expect(s.ledger.find(r.entry.id)?.seq).toBe(1);
    expect(s.ledger.find(paymentId)?.seq).toBe(1);
    expect(s.ledger.receipt(paymentId)).toEqual(r);
    expect(s.ledger.receipt('nope')).toBeUndefined();
    expect(s.ledger.bySeq(99)).toBeUndefined();
  });

  it("gives the engine this agent's payments only", () => {
    pay(s.ledger, {}, NOW - MINUTE);
    pay(s.ledger, { country: 'RU' }, NOW - MINUTE);
    pay(s.ledger, {}, NOW - MINUTE, 'other-agent');
    const views = s.ledger.paymentViews('lab-procurement');
    expect(views.map((v) => [v.status, v.amountBase, v.merchant])).toEqual([
      ['approved', 120_000, 'Alpine Reagents AG'],
      ['declined', 120_000, 'Alpine Reagents AG'],
    ]);
    expect(views[0]?.createdAt).toBe(NOW - MINUTE);
  });

  it('feeds the daily budget: recorded spend counts against the next request', () => {
    for (let i = 0; i < 4; i++) {
      pay(
        s.ledger,
        { amount: 400_000, merchant: i % 2 ? 'Alpine Reagents AG' : 'Basel Labware AG' },
        NOW - (60 - i * 15) * MINUTE,
      );
    }
    const result = evaluate(
      { id: 'lab-procurement', status: 'active', credential: credential() },
      mandate(),
      request({ amount: 400_001 }),
      context({ context: { ledger: s.ledger.paymentViews('lab-procurement') } }),
    );
    expect(result).toMatchObject({ decision: 'declined', rule: 'DAILY_BUDGET' });
  });
});

describe('opening', () => {
  it('binds a ledger to one issuer', () => {
    s.ledger.close();
    const other = generateKeyPair();
    expect(() =>
      Ledger.open(s.path, {
        issuer: 'flow-e-issuer:other',
        privateKey: createPrivateKey(other.privateKeyPem),
      }),
    ).toThrow(/belongs to issuer .*Refusing to mix keys/);
  });
  it('read-only opening needs an existing ledger', () => {
    expect(() => Ledger.openReadOnly(join(s.dir, 'missing.db'))).toThrow(LedgerError);
  });
  it('read-only opening rejects a database that is not a ledger', () => {
    const p = join(s.dir, 'plain.db');
    new Database(p).exec('CREATE TABLE t (x)');
    expect(() => Ledger.openReadOnly(p)).toThrow(/not a mandate ledger/);
    const q = join(s.dir, 'meta-only.db');
    new Database(q).exec('CREATE TABLE meta (key TEXT, value TEXT)');
    expect(() => Ledger.openReadOnly(q)).toThrow(/no issuer recorded/);
  });
  it('read-only ledgers refuse to append', () => {
    s.ledger.close();
    const ro = Ledger.openReadOnly(s.path);
    expect(() => ro.append({ type: 'x', agentId: 'a', now: NOW, data: {} })).toThrow(/read-only/);
    ro.close();
  });
});

describe('receipts', () => {
  it('verify offline with nothing but the public key file', () => {
    const r = pay(s.ledger);
    const pem = readFileSync(storePaths(s.home).publicKey, 'utf8');
    const roundTrip = parseReceipt(JSON.stringify(r));
    expect(verifyReceipt(roundTrip, createPublicKey(pem))).toEqual({
      valid: true,
      checks: [
        `✔ issued by ${s.issuer.id}`,
        '✔ contents match the entry hash',
        '✔ issuer signature is valid',
      ],
    });
  });

  it('fail when the contents were changed', () => {
    const r = pay(s.ledger);
    const edited = { ...r, entry: { ...r.entry, data: { ...r.entry.data, decision: 'declined' } } };
    expect(verifyReceipt(edited, s.issuer.publicKey).checks).toContain(
      '✖ contents do not match the entry hash (the receipt was altered)',
    );
  });

  it('fail when the chain position was changed (the hash commits to prev_hash and seq)', () => {
    pay(s.ledger);
    const r = pay(s.ledger);
    const moved = { ...r, entry: { ...r.entry, prev_hash: '0'.repeat(64) } };
    expect(verifyReceipt(moved, s.issuer.publicKey).valid).toBe(false);
    const renumbered = { ...r, entry: { ...r.entry, seq: 1 } };
    expect(verifyReceipt(renumbered, s.issuer.publicKey).valid).toBe(false);
  });

  it.each([
    ['id', 'rcpt_other'],
    ['type', 'payment.other'],
    ['agent_id', 'other-agent'],
    ['created_at', '2020-01-01T00:00:00.000Z'],
  ] as const)('fail when the %s field was changed', (field, value) => {
    const r = pay(s.ledger);
    const edited = { ...r, entry: { ...r.entry, [field]: value } };
    expect(verifyReceipt(edited, s.issuer.publicKey).valid).toBe(false);
  });

  it('fail when contents and hash were both changed', () => {
    const r = pay(s.ledger, { country: 'RU' });
    const entry = { ...r.entry, data: { ...r.entry.data, decision: 'approved' } };
    const forged = { ...r, entry: { ...entry, hash: entryHash(entry) } };
    const check = verifyReceipt(forged, s.issuer.publicKey);
    expect(check.valid).toBe(false);
    expect(check.checks).toContain('✖ issuer signature is not valid');
  });

  it('fail against another public key', () => {
    const r = pay(s.ledger);
    const check = verifyReceipt(r, createPublicKey(generateKeyPair().publicKeyPem));
    expect(check.valid).toBe(false);
    expect(check.checks[0]).toMatch(/but the public key is/);
  });

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['wrong format', JSON.stringify({ format: 'x' }), /malformed/],
  ])('parseReceipt rejects %s', (_n, text, message) => {
    expect(() => parseReceipt(text)).toThrow(ReceiptError);
    expect(() => parseReceipt(text)).toThrow(message);
  });

  it('parseReceipt rejects a bad hash field', () => {
    const r = pay(s.ledger);
    const bad = { ...r, entry: { ...r.entry, hash: 'xyz' } };
    expect(() => parseReceipt(JSON.stringify(bad))).toThrow(/malformed/);
  });
});
