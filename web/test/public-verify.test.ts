import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENESIS_HASH } from '@flow-e/mcp/core';
import { gateExempt } from '@/server/gate';
import {
  MAX_KEY_BYTES,
  MAX_RECEIPT_BYTES,
  VERIFY_PER_MINUTE,
  handleVerify,
  newVerifyLimits,
  positionChecks,
  verifyPublicReceipt,
  type PublicVerifyResult,
} from '@/server/public-verify';
import { handleKey, publishedKey } from '@/server/published-keys';
import { SandboxStore } from '@/server/store';
import { ALICE, ORIGIN, request, world, type World } from './org-helpers';

let w: World;
let receiptText: string;
let reviewText: string;

beforeAll(async () => {
  w = await world();
  const ok = await w.store.requestPayment(
    w.auth,
    { ...request('120', 'Fictional Pipettes GmbH'), memo: 'Pipette tips' },
    ORIGIN,
  );
  const detail = await w.store.payment(w.orgId, ALICE, ok.payment_id);
  receiptText = JSON.stringify(detail?.receipt, null, 2);
  const review = await w.store.requestPayment(w.auth, request('800'), ORIGIN);
  reviewText = JSON.stringify((await w.store.payment(w.orgId, ALICE, review.payment_id))?.receipt);
});

afterAll(async () => {
  await w.close();
});

/** The check as /api/verify runs it: the receipt plus the issuer's published key. */
const check = (text: string, key?: string) =>
  verifyPublicReceipt(
    text,
    { resolveKey: (issuer) => publishedKey(w.db, issuer), now: w.clock.now + 3_600_000 },
    key,
  );

const edit = (text: string, change: (r: Record<string, unknown>) => void) => {
  const r = JSON.parse(text) as Record<string, unknown>;
  change(r);
  return JSON.stringify(r);
};

describe('public receipt check', () => {
  it('confirms a genuine receipt with the published key, and shows only what it says', async () => {
    const r = await check(receiptText);
    expect(r.outcome).toBe('valid');
    expect(r.issuerKind).toBe('organisation');
    expect(r.issuerName).toBe('Example Labs AG (fictional)');
    expect(r.issuer).toMatch(/^flow-e-issuer:/);
    expect(r.payment).toMatchObject({
      agentId: 'buyer',
      merchant: 'Fictional Pipettes GmbH',
      amount: 12000,
      currency: 'CHF',
      decision: 'approved',
      memo: 'Pipette tips',
    });
    expect(r.checks?.every((c) => c.startsWith('✔'))).toBe(true);
    expect(r.keySource).toBe('published');
    expect(r.keyUrl).toBe(`/keys/${r.issuer ?? ''}.pub`);
    expect(r.position?.consistent).toBe(true);
    // Nothing from outside the receipt and the published key: no members, other payments or
    // later status.
    const keys = Object.keys(r).sort();
    expect(keys).toEqual(
      [
        'checks',
        'createdAt',
        'entryType',
        'issuer',
        'issuerKind',
        'issuerName',
        'keySource',
        'keyUrl',
        'outcome',
        'payment',
        'position',
      ].sort(),
    );
  });

  it('shows the decision as signed, not as it is now', async () => {
    const r = await check(reviewText);
    expect(r.outcome).toBe('valid');
    expect(r.payment?.decision).toBe('review');
  });

  it('rejects a receipt changed after signing', async () => {
    const forged = edit(receiptText, (r) => {
      const entry = r.entry as { data: { request: { amount: number } } };
      entry.data.request.amount = 1200;
    });
    const r = await check(forged);
    expect(r.outcome).toBe('invalid');
    expect(r.payment).toBeUndefined();
    expect(r.checks?.some((c) => c.includes('altered'))).toBe(true);
  });

  it('rejects a broken signature without throwing', async () => {
    for (const signature of ['', 'xyz', 'A'.repeat(86)]) {
      const r = await check(
        edit(receiptText, (x) => {
          x.signature = signature;
        }),
      );
      expect(r.outcome).toBe('invalid');
    }
  });

  it('says when the issuer is not known here, without checking anything', async () => {
    const r = await check(
      edit(receiptText, (x) => {
        x.issuer = 'flow-e-issuer:0000000000000000';
      }),
    );
    expect(r).toEqual({
      outcome: 'unknown-issuer',
      issuer: 'flow-e-issuer:0000000000000000',
      entryType: 'payment.decision',
      createdAt: expect.any(String) as string,
    });
  });

  it('turns away things that are not receipts, with a plain message', async () => {
    const cases = [
      '',
      '   ',
      'not json',
      '{}',
      '[]',
      '{"format":"flow-e-receipt/v1"}',
      edit(receiptText, (x) => {
        x.extra = '<script>alert(1)</script>';
      }),
      'x'.repeat(MAX_RECEIPT_BYTES + 1),
      '{"receipt": 5}',
    ];
    for (const text of cases) {
      const r = await check(text);
      expect(r.outcome).toBe('error');
      expect(r.error).toBeTruthy();
      expect(r.error).not.toContain('<script>');
    }
  });

  it('knows sandbox issuers, including archived sandboxes', async () => {
    const sandbox = new SandboxStore(w.db, randomBytes(32), { clock: () => w.clock.now });
    await sandbox.ensureSandbox('dev:someone@example.com');
    const out = await sandbox.requestPayment('dev:someone@example.com', {
      agentId: 'office-supplies',
      merchant: 'Fictional Paper AG',
      amount: '20',
      currency: 'CHF',
      category: '5111',
      country: 'CH',
    });
    const detail = await sandbox.payment('dev:someone@example.com', out.paymentId);
    const text = JSON.stringify(detail?.receipt);
    await sandbox.resetSandbox('dev:someone@example.com');
    const r = await check(text);
    expect(r.outcome).toBe('valid');
    expect(r.issuerKind).toBe('sandbox');
    expect(r.issuerName).toBeNull();
  });
});

describe('POST /api/verify', () => {
  const post = (body: string, ip = '203.0.113.7', headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/verify', {
      method: 'POST',
      headers: { 'x-forwarded-for': `${ip}, 10.0.0.1`, ...headers },
      body,
    });

  it('answers with the check as JSON, never cached', async () => {
    const res = await handleVerify(post(receiptText), { sql: w.db, limits: newVerifyLimits() });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as PublicVerifyResult).outcome).toBe('valid');
  });

  it('refuses bodies over 32 KB before reading them all', async () => {
    const limits = newVerifyLimits();
    const big = await handleVerify(post('x'.repeat(MAX_RECEIPT_BYTES + MAX_KEY_BYTES + 10)), {
      sql: w.db,
      limits,
    });
    expect(big.status).toBe(413);
    const declared = await handleVerify(
      post('{}', '203.0.113.8', { 'content-length': String(MAX_RECEIPT_BYTES * 4) }),
      { sql: w.db, limits },
    );
    expect(declared.status).toBe(413);
    const text = await handleVerify(post('x'.repeat(MAX_RECEIPT_BYTES + 10), '203.0.113.9'), {
      sql: w.db,
      limits,
    });
    expect(((await text.json()) as PublicVerifyResult).error).toMatch(/32 KB/);
  });

  it('limits checks per client address', async () => {
    let t = 0;
    const limits = newVerifyLimits(() => t);
    for (let i = 0; i < VERIFY_PER_MINUTE; i++) {
      expect((await handleVerify(post('{}'), { sql: w.db, limits })).status).toBe(200);
    }
    const blocked = await handleVerify(post('{}'), { sql: w.db, limits });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another address is not affected; a minute later the first one may check again.
    expect((await handleVerify(post('{}', '198.51.100.2'), { sql: w.db, limits })).status).toBe(
      200,
    );
    t += 61_000;
    expect((await handleVerify(post('{}'), { sql: w.db, limits })).status).toBe(200);
  });
});

describe('checking with a key the person supplies', () => {
  const pem = async () =>
    (await publishedKey(w.db, (JSON.parse(receiptText) as { issuer: string }).issuer))
      ?.publicKeyPem ?? '';

  it('accepts the right key, without using the published one or its name', async () => {
    const r = await verifyPublicReceipt(
      receiptText,
      {
        resolveKey: () => {
          throw new Error('must not look up a key');
        },
        now: w.clock.now,
      },
      await pem(),
    );
    expect(r).toMatchObject({ outcome: 'valid', keySource: 'supplied', issuerName: null });
    expect(r.keyUrl).toBeUndefined();
  });

  it('rejects a receipt checked against a different key', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const r = await check(receiptText, other.toString());
    expect(r.outcome).toBe('invalid');
    expect(r.payment).toBeUndefined();
    expect(r.checks?.some((c) => c.startsWith('✖'))).toBe(true);
  });

  it('turns away a key that is not an Ed25519 public key', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    for (const key of ['not a key', rsa.toString(), 'x'.repeat(MAX_KEY_BYTES + 1)]) {
      const r = await check(receiptText, key);
      expect(r.outcome).toBe('error');
      expect(r.error).toMatch(/public key/);
    }
  });

  it('takes the key through /api/verify as {receipt, public_key}', async () => {
    const res = await handleVerify(
      new Request('http://localhost/api/verify', {
        method: 'POST',
        headers: { 'x-forwarded-for': '192.0.2.50' },
        body: JSON.stringify({ receipt: receiptText, public_key: await pem() }),
      }),
      { sql: w.db, limits: newVerifyLimits() },
    );
    expect((await res.json()) as PublicVerifyResult).toMatchObject({
      outcome: 'valid',
      keySource: 'supplied',
    });
  });
});

describe('ledger position', () => {
  const entry = (
    seq: number,
    prev: string,
    hash = 'a'.repeat(64),
    at = '2026-10-21T10:00:00Z',
  ) => ({
    entry: {
      seq,
      prev_hash: prev,
      hash,
      created_at: at,
      id: 'e',
      type: 't',
      agent_id: 'a',
      data: {},
    },
  });
  const NOW = Date.parse('2026-10-21T12:00:00Z');

  it('accepts a first entry from the genesis hash and a later one from an earlier hash', () => {
    expect(positionChecks(entry(1, GENESIS_HASH), NOW).consistent).toBe(true);
    expect(positionChecks(entry(7, 'b'.repeat(64)), NOW).consistent).toBe(true);
  });

  it('flags impossible positions', () => {
    expect(positionChecks(entry(1, 'b'.repeat(64)), NOW).checks).toContain(
      '✖ claims to be the first entry but does not start from the genesis hash',
    );
    expect(positionChecks(entry(4, GENESIS_HASH), NOW).consistent).toBe(false);
    expect(positionChecks(entry(4, 'a'.repeat(64)), NOW).checks).toContain('✖ links to itself');
    expect(
      positionChecks(entry(4, 'b'.repeat(64), 'a'.repeat(64), '2026-10-22T10:00:00Z'), NOW).checks,
    ).toContain('✖ is dated in the future');
  });

  it('a genuine receipt from the ledger has a consistent position', async () => {
    expect((await check(reviewText)).position).toEqual({
      consistent: true,
      checks: expect.arrayContaining([
        expect.stringMatching(/^✔ entry \d+ of its ledger/),
      ]) as string[],
    });
  });
});

describe('published keys', () => {
  it('publishes the issuer key as PEM and JSON, and nothing for unknown or odd names', async () => {
    const issuer = (JSON.parse(receiptText) as { issuer: string }).issuer;
    const pub = await handleKey(`${issuer}.pub`, w.db);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('content-type')).toMatch(/pem/);
    const pem = await pub.text();
    expect(pem).toContain('BEGIN PUBLIC KEY');
    expect(pem).not.toContain('PRIVATE');
    const json = (await (await handleKey(`${issuer}.json`, w.db)).json()) as Record<
      string,
      unknown
    >;
    expect(json).toEqual({
      issuer,
      organisation: 'Example Labs AG (fictional)',
      kind: 'organisation',
      public_key_pem: pem,
    });
    for (const file of [
      'flow-e-issuer:0000000000000000.pub',
      `${issuer}.txt`,
      issuer,
      "x' or 1=1 --.pub",
      '../secrets.pub',
    ]) {
      expect((await handleKey(file, w.db)).status).toBe(404);
    }
  });

  it('needs no site password, for reading only and one level deep', () => {
    expect(gateExempt('/keys/flow-e-issuer:0123456789abcdef.pub', 'GET', false)).toBe(true);
    expect(gateExempt('/keys/flow-e-issuer:0123456789abcdef.pub', 'POST', false)).toBe(false);
    expect(gateExempt('/keys/a.pub', 'GET', true)).toBe(false);
    expect(gateExempt('/keys/a/b.pub', 'GET', false)).toBe(false);
    expect(gateExempt('/keysx', 'GET', false)).toBe(false);
  });
});
