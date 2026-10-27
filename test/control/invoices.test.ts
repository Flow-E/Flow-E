import { describe, expect, it } from 'vitest';
import {
  ActionError,
  INVOICE_RECORDED,
  PAYMENT_DECISION,
  foldInvoices,
  foldPayments,
  mandateDiff,
  matchInvoice,
  planInvoiceRecord,
  planInvoiceResolve,
  type EntryInput,
  type GlobalPolicy,
  type InvoiceInput,
} from '../../src/core.js';

const NOW = Date.parse('2026-10-27T10:00:00Z');
const policy: GlobalPolicy = {
  baseCurrency: 'CHF',
  fx: { EUR: '0.93' },
  blockedCountries: [],
  blockedSuppliers: [],
  timezone: 'Europe/Zurich',
  businessHours: { days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1080 },
  invoiceCheck: { tolerancePercent: 2, toleranceMinBase: 500 },
};

let n = 0;
function decision(amount: number, merchant = 'Example Labware AG', currency = 'CHF'): EntryInput {
  n += 1;
  return {
    type: PAYMENT_DECISION,
    agentId: 'buyer',
    now: NOW - n * 60_000,
    data: {
      payment_id: `pay_${String(n).padStart(20, '0')}`,
      request: { merchant, amount, currency, category: '5047', country: 'CH' },
      decision: 'approved',
      rule: null,
      reason: 'All rules passed.',
      amount_base: currency === 'CHF' ? amount : Math.ceil(amount * 0.93),
      base_currency: 'CHF',
      cancellable_until: null,
      trace: [],
    },
  };
}

function rows(log: EntryInput[]) {
  return log.map((e, i) => ({
    id: `e${String(i)}`,
    type: e.type,
    agent_id: e.agentId,
    created_at: new Date(e.now).toISOString(),
    data: JSON.stringify(e.data),
  }));
}

const invoice = (o: Partial<InvoiceInput> = {}): InvoiceInput => ({
  supplier: 'Example Labware AG',
  number: 'INV-1',
  invoiceDate: '2026-10-26',
  amount: 100_000,
  currency: 'CHF',
  source: 'manual',
  ...o,
});

function record(log: EntryInput[], i: InvoiceInput) {
  const r = rows(log);
  const plan = planInvoiceRecord({
    invoice: i,
    payments: foldPayments(r),
    invoices: foldInvoices(r),
    policy,
    actor: { by: 'ap@example.com', now: NOW },
  });
  log.push(plan.entry);
  return plan;
}

describe('invoice matching', () => {
  it('matches by reference within the tolerance (2%, at least CHF 5)', () => {
    const log = [decision(100_000)];
    const id = (log[0]?.data as { payment_id: string }).payment_id;
    // CHF 1,020 on CHF 1,000: exactly 2%.
    expect(record(log, invoice({ reference: `PO ${id}`, amount: 102_000 })).match).toMatchObject({
      match: 'matched',
      paymentId: id,
      difference: 2_000,
    });
  });

  it('flags one cent over the tolerance as a mismatch, and keeps the minimum for small amounts', () => {
    const log = [decision(100_000), decision(10_000)];
    const [big = '', small = ''] = log.map((e) => (e.data as { payment_id: string }).payment_id);
    expect(record(log, invoice({ reference: big, amount: 102_001 })).match.match).toBe('mismatch');
    // CHF 104.90 on CHF 100: 4.9%, but under the CHF 5 minimum.
    expect(
      record(log, invoice({ number: 'INV-2', reference: small, amount: 10_490 })).match.match,
    ).toBe('matched');
  });

  it('matches by supplier and amount when there is no reference', () => {
    const log = [decision(30_000), decision(100_000), decision(100_000, 'Other AG')];
    const expected = (log[1]?.data as { payment_id: string }).payment_id;
    const r = record(log, invoice({ amount: 100_500 }));
    expect(r.match).toMatchObject({ match: 'matched', paymentId: expected });
  });

  it('is unmatched without an authorization, or for a reference that is not approved', () => {
    expect(record([decision(100_000, 'Other AG')], invoice()).match.match).toBe('unmatched');
    expect(
      record([], invoice({ reference: 'pay_99999999999999999999' })).match.explanation,
    ).toMatch(/not a payment of this organisation/);
  });

  it('marks a second invoice with the same supplier and number as a duplicate', () => {
    const log = [decision(100_000), decision(100_000)];
    const first = record(log, invoice());
    const again = record(log, invoice({ supplier: ' example LABWARE ag', number: 'inv-1' }));
    expect(again.match.match).toBe('duplicate');
    // ...and a second invoice for a payment that already has one, by reference.
    expect(
      record(log, invoice({ number: 'INV-9', reference: first.match.paymentId ?? '' })).match.match,
    ).toBe('duplicate');
  });

  it('a mismatch in another currency than authorized says so', () => {
    const log = [decision(100_000, 'Example Labware AG', 'EUR')];
    const id = (log[0]?.data as { payment_id: string }).payment_id;
    expect(record(log, invoice({ reference: id })).match.explanation).toMatch(
      /in CHF and the authorization in EUR/,
    );
  });

  it('a person resolves a mismatch once, with a reason to reject; matched ones need nothing', () => {
    const log = [decision(100_000)];
    const plan = record(log, invoice({ amount: 150_000 }));
    let inv = foldInvoices(rows(log));
    expect(() =>
      planInvoiceResolve(inv, plan.invoiceId, 'rejected', { by: 'ap', now: NOW }),
    ).toThrow(/reason/);
    log.push(
      planInvoiceResolve(inv, plan.invoiceId, 'rejected', {
        by: 'ap',
        now: NOW,
        note: 'Wrong price',
      }),
    );
    inv = foldInvoices(rows(log));
    expect(inv[0]?.resolution).toMatchObject({ outcome: 'rejected', note: 'Wrong price' });
    expect(() =>
      planInvoiceResolve(inv, plan.invoiceId, 'accepted', { by: 'ap', now: NOW }),
    ).toThrow(ActionError);
    // A rejected invoice does not block the real one with the same number.
    expect(record(log, invoice()).match.match).toBe('matched');
  });

  it('shows the matched invoice on its payment, never a duplicate', () => {
    const log = [decision(100_000)];
    record(log, invoice());
    record(log, invoice());
    const [p] = foldPayments(rows(log));
    expect(p?.fulfilment?.invoice).toMatchObject({ number: 'INV-1', match: 'matched' });
    expect(log.filter((e) => e.type === INVOICE_RECORDED)).toHaveLength(2);
  });

  it('refuses malformed input', () => {
    const log = [decision(100_000)];
    expect(() => record(log, invoice({ number: '' }))).toThrow(/invoice number/);
    expect(() => record(log, invoice({ invoiceDate: '26.10.2026' }))).toThrow(/YYYY-MM-DD/);
    expect(() => record(log, invoice({ amount: -1 }))).toThrow(/above 0/);
    expect(() => record(log, invoice({ reference: '<x>' }))).toThrow(/reference/);
    expect(() =>
      matchInvoice({ invoice: invoice(), payments: [], invoices: [], policy }),
    ).not.toThrow();
  });
});

describe('mandate changes record old and new values', () => {
  it('lists each changed setting, and nothing for defaults that were only filled in', () => {
    const before = {
      base_currency: 'CHF',
      agents: {
        bot: {
          owner: 'A',
          daily_budget: 100,
          per_payment_limit: 50,
          currencies: ['CHF'],
          categories: ['5111'],
        },
      },
    };
    const after = {
      base_currency: 'CHF',
      timezone: 'UTC',
      agents: {
        bot: {
          owner: 'A',
          daily_budget: 200,
          per_payment_limit: 50,
          currencies: ['CHF'],
          categories: ['5111'],
          velocity_per_minute: 10,
        },
      },
    };
    expect(mandateDiff(before, after)).toEqual([
      { path: 'agents.bot.daily_budget', before: 100, after: 200 },
    ]);
  });
});
