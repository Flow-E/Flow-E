import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, issuerIdFor } from '../../src/crypto/ed25519.js';
import {
  AGENT_FREEZE,
  KILL_SWITCH,
  PAYMENT_DECISION,
  PAYMENT_RESOLVED,
  auditEntries,
  buildEntry,
  decisionData,
  foldControls,
  foldPayments,
  toEngineViews,
  type StoredEntry,
} from '../../src/ledger/fold.js';
import { GENESIS_HASH } from '../../src/ledger/receipt.js';

const pem = generateKeyPair();
const publicKey = createPublicKey(pem.publicKeyPem);
const signer = { issuer: issuerIdFor(publicKey), privateKey: createPrivateKey(pem.privateKeyPem) };
const NOW = Date.parse('2026-10-21T10:00:00Z');

function chain(inputs: Parameters<typeof buildEntry>[1][]): StoredEntry[] {
  const out: StoredEntry[] = [];
  for (const input of inputs) {
    const last = out.at(-1);
    out.push(buildEntry(last ? { seq: last.seq, hash: last.hash } : null, input, signer).stored);
  }
  return out;
}

const decision = (
  paymentId: string,
  agentId: string,
  amountBase: number | null,
  memo?: string,
) => ({
  type: PAYMENT_DECISION,
  agentId,
  now: NOW,
  data: decisionData({
    paymentId,
    request: {
      merchant: 'Example Reagents AG',
      amount: 100,
      currency: 'CHF',
      category: '5169',
      country: 'CH',
      ...(memo === undefined ? {} : { memo }),
    },
    result: { decision: 'review', rule: 'APPROVAL_THRESHOLD', reason: 'r', trace: [], amountBase },
    baseCurrency: 'CHF',
  }),
});

describe('buildEntry', () => {
  it('starts at the genesis hash and honours a given id', () => {
    const { entry, stored } = buildEntry(
      null,
      { type: 'x', agentId: 'a', now: NOW, data: { k: 1 }, id: 'rcpt_fixed' },
      signer,
    );
    expect(entry).toMatchObject({ seq: 1, id: 'rcpt_fixed', prev_hash: GENESIS_HASH });
    expect(stored.data).toBe('{"k":1}');
  });
});

describe('decisionData', () => {
  it('keeps a memo only when there is one', () => {
    expect(decision('p1', 'a', 1, 'note').data.request).toHaveProperty('memo', 'note');
    expect(decision('p2', 'a', 1).data.request).not.toHaveProperty('memo');
  });
});

describe('foldPayments and foldControls', () => {
  const rows = chain([
    decision('p1', 'lab', 100),
    decision('p2', 'office', null),
    { type: KILL_SWITCH, agentId: '*', now: NOW, data: { on: true, by: 'x', note: null } },
    // A human action for a payment that does not exist is ignored.
    {
      type: PAYMENT_RESOLVED,
      agentId: 'lab',
      now: NOW,
      data: { payment_id: 'ghost', status: 'approved', by: 'x', note: null },
    },
    // A resolution without a status changes who decided, not the status.
    {
      type: PAYMENT_RESOLVED,
      agentId: 'lab',
      now: NOW,
      data: { payment_id: 'p1', by: 'y', note: 'n' },
    },
    { type: AGENT_FREEZE, agentId: 'lab', now: NOW, data: { frozen: true, by: 'x', note: null } },
  ]);

  it('folds payments, optionally for one agent, skipping other entry types', () => {
    expect(foldPayments(rows).map((p) => p.paymentId)).toEqual(['p1', 'p2']);
    const [lab] = foldPayments(rows, 'lab');
    expect(foldPayments(rows, 'lab')).toHaveLength(1);
    expect(lab).toMatchObject({ status: 'review', decidedBy: 'y', note: 'n' });
  });

  it('folds controls, skipping payment entries', () => {
    expect(foldControls(rows)).toMatchObject({
      killSwitch: { on: true, by: 'x' },
      frozen: { lab: { frozen: true } },
    });
  });

  it('shapes payments for the engine, a missing base amount counting as 0', () => {
    expect(toEngineViews(foldPayments(rows)).map((v) => v.amountBase)).toEqual([100, 0]);
  });

  it('audits a chain built here', () => {
    expect(auditEntries(rows, signer.issuer, publicKey)).toMatchObject({ ok: true, entries: 6 });
  });
});
