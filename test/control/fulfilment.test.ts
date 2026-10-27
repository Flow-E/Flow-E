import { describe, expect, it } from 'vitest';
import {
  ActionError,
  PAYMENT_DECISION,
  PAYMENT_INVOICED,
  PAYMENT_ORDERED,
  foldPayments,
  planInvoice,
  planOrder,
  type EntryInput,
} from '../../src/core.js';

const NOW = Date.parse('2026-10-27T10:00:00Z');
const MINUTE = 60_000;

/** A ledger as rows, built from entry inputs in order. */
function rows(inputs: EntryInput[]) {
  return inputs.map((e, i) => ({
    id: `e${String(i)}`,
    type: e.type,
    agent_id: e.agentId,
    created_at: new Date(e.now).toISOString(),
    data: JSON.stringify(e.data),
  }));
}

const decision = (status: 'approved' | 'review', cancellableUntil: number | null = null) => ({
  type: PAYMENT_DECISION,
  agentId: 'buyer',
  now: NOW,
  data: {
    payment_id: 'pay_1',
    request: {
      merchant: 'Example AG',
      amount: 48_000,
      currency: 'CHF',
      category: '5047',
      country: 'CH',
    },
    decision: status,
    rule: status === 'review' ? 'APPROVAL_THRESHOLD' : null,
    reason: 'x',
    amount_base: 48_000,
    base_currency: 'CHF',
    cancellable_until: cancellableUntil === null ? null : new Date(cancellableUntil).toISOString(),
    trace: [],
  },
});

describe('orders and invoices', () => {
  it('records an order and an invoice without changing the decision', () => {
    const log: EntryInput[] = [decision('approved')];
    log.push(
      planOrder(foldPayments(rows(log)), 'pay_1', {
        by: 'agent buyer',
        now: NOW + MINUTE,
        reference: 'SO-77',
      }).entry,
    );
    log.push(
      planInvoice(foldPayments(rows(log)), 'pay_1', {
        by: 'ap@example.com',
        now: NOW + 3 * MINUTE,
        number: 'INV-2026-0042',
        amount: 49_500,
        currency: 'chf',
      }).entry,
    );
    const [p] = foldPayments(rows(log));
    expect(p).toMatchObject({ status: 'approved', decidedBy: 'engine', updatedAt: null });
    expect(p?.fulfilment).toMatchObject({
      ordered: { by: 'agent buyer', reference: 'SO-77' },
      invoice: { number: 'INV-2026-0042', amount: 49_500, currency: 'CHF', difference: 1_500 },
    });
    expect(log.map((e) => e.type)).toEqual([PAYMENT_DECISION, PAYMENT_ORDERED, PAYMENT_INVOICED]);
  });

  it('refuses an order during cooling-off, twice, or for a payment that is not approved', () => {
    const cooling = foldPayments(rows([decision('approved', NOW + 10 * MINUTE)]));
    expect(() => planOrder(cooling, 'pay_1', { by: 'a', now: NOW + MINUTE })).toThrow(
      /still be cancelled/,
    );
    expect(() =>
      planOrder(foldPayments(rows([decision('review')])), 'pay_1', { by: 'a', now: NOW }),
    ).toThrow(ActionError);
    const log: EntryInput[] = [decision('approved')];
    log.push(planOrder(foldPayments(rows(log)), 'pay_1', { by: 'a', now: NOW }).entry);
    expect(() => planOrder(foldPayments(rows(log)), 'pay_1', { by: 'a', now: NOW })).toThrow(
      /already recorded/,
    );
  });

  it('refuses invoices in another currency, without a number, or a malformed reference', () => {
    const ps = foldPayments(rows([decision('approved')]));
    const base = { by: 'ap', now: NOW, number: 'INV-1', amount: 100, currency: 'CHF' };
    expect(() => planInvoice(ps, 'pay_1', { ...base, currency: 'EUR' })).toThrow(
      /in EUR, the approval in CHF/,
    );
    expect(() => planInvoice(ps, 'pay_1', { ...base, number: ' ' })).toThrow(/invoice number/);
    expect(() => planInvoice(ps, 'pay_1', { ...base, amount: 0 })).toThrow(/above 0/);
    expect(() => planOrder(ps, 'pay_1', { by: 'a', now: NOW, reference: '<script>' })).toThrow(
      /Order reference/,
    );
  });
});
