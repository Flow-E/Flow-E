import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_RECEIPT_BYTES,
  VERIFY_PER_MINUTE,
  handleVerify,
  newVerifyLimits,
  verifyPublicReceipt,
  type PublicVerifyResult,
} from '@/server/public-verify';
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

const edit = (text: string, change: (r: Record<string, unknown>) => void) => {
  const r = JSON.parse(text) as Record<string, unknown>;
  change(r);
  return JSON.stringify(r);
};

describe('public receipt check', () => {
  it('confirms a genuine receipt and shows only what it says, plus the organisation', async () => {
    const r = await verifyPublicReceipt(w.db, receiptText);
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
    // Nothing from outside the receipt: no members, keys, other payments or later status.
    const keys = Object.keys(r).sort();
    expect(keys).toEqual(
      [
        'checks',
        'createdAt',
        'entryType',
        'issuer',
        'issuerKind',
        'issuerName',
        'outcome',
        'payment',
      ].sort(),
    );
  });

  it('shows the decision as signed, not as it is now', async () => {
    const r = await verifyPublicReceipt(w.db, reviewText);
    expect(r.outcome).toBe('valid');
    expect(r.payment?.decision).toBe('review');
  });

  it('rejects a receipt changed after signing', async () => {
    const forged = edit(receiptText, (r) => {
      const entry = r.entry as { data: { request: { amount: number } } };
      entry.data.request.amount = 1200;
    });
    const r = await verifyPublicReceipt(w.db, forged);
    expect(r.outcome).toBe('invalid');
    expect(r.payment).toBeUndefined();
    expect(r.checks?.some((c) => c.includes('altered'))).toBe(true);
  });

  it('rejects a broken signature without throwing', async () => {
    for (const signature of ['', 'xyz', 'A'.repeat(86)]) {
      const r = await verifyPublicReceipt(
        w.db,
        edit(receiptText, (x) => {
          x.signature = signature;
        }),
      );
      expect(r.outcome).toBe('invalid');
    }
  });

  it('says when the issuer is not known here, without checking anything', async () => {
    const r = await verifyPublicReceipt(
      w.db,
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
    ];
    for (const text of cases) {
      const r = await verifyPublicReceipt(w.db, text);
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
    const r = await verifyPublicReceipt(w.db, text);
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
    const big = await handleVerify(post('x'.repeat(MAX_RECEIPT_BYTES + 10)), { sql: w.db, limits });
    expect(big.status).toBe(413);
    const declared = await handleVerify(
      post('{}', '203.0.113.8', { 'content-length': String(MAX_RECEIPT_BYTES * 4) }),
      { sql: w.db, limits },
    );
    expect(declared.status).toBe(413);
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
