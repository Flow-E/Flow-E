import { describe, expect, it } from 'vitest';
import {
  INVOICE_RECORDED,
  PAYMENT_DECISION,
  PAYMENT_INVOICED,
  PAYMENT_ORDERED,
  decisionData,
  foldPayments,
  toEngineViews,
} from '../../src/ledger/fold.js';
import type { EvaluationResult } from '../../src/engine/types.js';

const AT = '2026-10-27T10:00:00.000Z';

const result = (over: Partial<EvaluationResult> = {}): EvaluationResult => ({
  decision: 'approved',
  rule: null,
  reason: 'All rules passed.',
  trace: [{ rule: 'KILL_SWITCH', outcome: 'pass', detail: 'off', data: { on: false } }],
  amountBase: 12_000,
  ...over,
});

const req = {
  merchant: 'Example AG',
  amount: 12_000,
  currency: 'CHF',
  category: '5047',
  country: 'CH',
};

let seq = 0;
function row(type: string, data: object, agent = 'buyer') {
  seq += 1;
  return {
    id: `e${String(seq)}`,
    type,
    agent_id: agent,
    created_at: AT,
    data: JSON.stringify(data),
  };
}

function decision(paymentId: string, over: Partial<EvaluationResult> = {}, extra: object = {}) {
  return row(PAYMENT_DECISION, {
    ...decisionData({
      paymentId,
      request: { ...req, ...extra },
      result: result(over),
      baseCurrency: 'CHF',
    }),
  });
}

describe('decision data', () => {
  it('records item, quantity, the recognised project id, guidance and hints', () => {
    const d = decisionData({
      paymentId: 'pay_1',
      request: { ...req, memo: 'm', item: 'Tips', quantity: 2, project: 'Grant SNF-123' },
      result: result({
        decision: 'declined',
        rule: 'SUPPLIER',
        guidance: 'Approved suppliers: A.',
        howToComply: [{ action: 'choose_supplier', approved_suppliers: ['A'] }],
        projectId: 'snf-123',
        cancellableUntil: Date.parse(AT),
      }),
      baseCurrency: 'CHF',
    });
    expect(d).toMatchObject({
      request: { item: 'Tips', quantity: 2, project: 'snf-123', memo: 'm' },
      guidance: 'Approved suppliers: A.',
      how_to_comply: [{ action: 'choose_supplier' }],
      cancellable_until: AT,
    });
  });

  it('keeps the project as named when the engine did not recognise it', () => {
    const d = decisionData({
      paymentId: 'pay_2',
      request: { ...req, project: 'unknown' },
      result: result(),
      baseCurrency: 'CHF',
    });
    expect(d.request).toMatchObject({ project: 'unknown' });
    expect(d).not.toHaveProperty('how_to_comply');
    expect(d).not.toHaveProperty('guidance');
  });
});

describe('folding orders and invoices', () => {
  it('ignores entries for unknown payments, and fills in missing optional fields', () => {
    const p = foldPayments([
      decision('pay_a', { howToComply: [{ action: 'wait', seconds: 60 }], guidance: 'g' }),
      row(PAYMENT_ORDERED, { payment_id: 'pay_missing', by: 'x' }),
      row(INVOICE_RECORDED, {
        invoice_id: 'inv_0',
        payment_id: null,
        number: 'N',
        amount: 1,
        currency: 'CHF',
        difference: null,
        match: 'unmatched',
        by: 'x',
      }),
      row(INVOICE_RECORDED, {
        invoice_id: 'inv_9',
        payment_id: 'pay_missing',
        number: 'N',
        amount: 1,
        currency: 'CHF',
        difference: null,
        match: 'unmatched',
        by: 'x',
      }),
      row(PAYMENT_ORDERED, { payment_id: 'pay_a', by: 'agent buyer' }),
      row(PAYMENT_INVOICED, { payment_id: 'pay_a', by: 'ap' }),
    ]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ guidance: 'g', howToComply: [{ action: 'wait' }] });
    expect(p[0]?.fulfilment?.ordered).toEqual({
      at: AT,
      by: 'agent buyer',
      reference: null,
      note: null,
    });
    // An older manual invoice entry without amount, number or currency.
    expect(p[0]?.fulfilment?.invoice).toMatchObject({
      number: '',
      amount: 0,
      currency: 'CHF',
      difference: -12_000,
      match: 'matched',
      invoiceId: null,
    });
  });

  it('a recorded invoice without a difference falls back to amount minus approved; a duplicate never replaces it', () => {
    const p = foldPayments([
      decision('pay_b'),
      row(INVOICE_RECORDED, {
        invoice_id: 'inv_1',
        payment_id: 'pay_b',
        number: 'A',
        amount: 13_000,
        currency: 'CHF',
        difference: null,
        match: 'mismatch',
        by: 'ap',
      }),
      row(INVOICE_RECORDED, {
        invoice_id: 'inv_2',
        payment_id: 'pay_b',
        number: 'A',
        amount: 99_000,
        currency: 'CHF',
        difference: 87_000,
        match: 'duplicate',
        by: 'ap',
        note: 'twice',
      }),
    ]);
    expect(p[0]?.fulfilment?.invoice).toMatchObject({
      invoiceId: 'inv_1',
      difference: 1_000,
      note: null,
      match: 'mismatch',
    });
  });

  it('engine views carry the project and the decision rule', () => {
    const views = toEngineViews(
      foldPayments([
        decision(
          'pay_c',
          { projectId: 'p1', rule: 'SPLIT_DETECTION', decision: 'review' },
          { project: 'Project One' },
        ),
      ]),
    );
    expect(views[0]).toMatchObject({ project: 'p1', rule: 'SPLIT_DETECTION', status: 'review' });
  });
});
