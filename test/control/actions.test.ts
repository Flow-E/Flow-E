import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionError,
  cancelCoolingOff,
  effectiveStatus,
  resolvePayment,
  setAgentFrozen,
  setKillSwitch,
} from '../../src/control/actions.js';
import { csvCell, exportCsv } from '../../src/control/csv.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { MINUTE, NOW } from '../engine/fixtures.js';
import { pay, setup, type Setup } from '../ledger/helpers.js';

let s: Setup;
beforeEach(() => {
  s = setup();
});
afterEach(() => {
  s.ledger.close();
});

const by = (now = NOW, note?: string) => ({ by: 'M. Keller', note, now });
const paymentId = (r: ReturnType<typeof pay>) => r.entry.data.payment_id as string;

describe('approving and declining a payment in review', () => {
  it('approves, recording who and why, and starts cooling-off for a new supplier', () => {
    const r = pay(s.ledger, { amount: 600_000 }, NOW - MINUTE);
    const p = resolvePayment(s.ledger, paymentId(r), 'approved', by(NOW, 'Quote checked'));
    expect(p).toMatchObject({
      status: 'approved',
      engineDecision: 'review',
      decidedBy: 'M. Keller',
      note: 'Quote checked',
      updatedAt: '2026-10-21T10:00:00.000Z',
      cancellableUntil: '2026-10-21T10:10:00.000Z',
    });
    expect(s.ledger.paymentViews('lab-procurement')[0]?.status).toBe('approved');
  });

  it('does not start cooling-off when the supplier was paid before', () => {
    pay(s.ledger, {}, NOW - 60 * MINUTE);
    const r = pay(s.ledger, { amount: 600_000 }, NOW - MINUTE);
    expect(resolvePayment(s.ledger, paymentId(r), 'approved', by()).cancellableUntil).toBeNull();
  });

  it('declines, which frees the budget it was holding', () => {
    const r = pay(s.ledger, { amount: 600_000 }, NOW - MINUTE);
    resolvePayment(s.ledger, paymentId(r), 'declined', by());
    expect(s.ledger.payment('lab-procurement', paymentId(r))?.status).toBe('declined');
    expect(s.ledger.paymentViews('lab-procurement')[0]?.status).toBe('declined');
  });

  it('accepts the receipt id as well as the payment id', () => {
    const r = pay(s.ledger, { amount: 600_000 });
    expect(resolvePayment(s.ledger, r.entry.id, 'approved', by()).status).toBe('approved');
  });

  it.each([
    ['an approved payment', {}, /is approved, not waiting for review/],
    ['a declined payment', { country: 'RU' }, /is declined, not waiting for review/],
  ])('refuses to resolve %s', (_n, overrides, message) => {
    const r = pay(s.ledger, overrides);
    expect(() => resolvePayment(s.ledger, paymentId(r), 'approved', by())).toThrow(message);
  });

  it('refuses to resolve the same payment twice', () => {
    const r = pay(s.ledger, { amount: 600_000 });
    resolvePayment(s.ledger, paymentId(r), 'declined', by());
    expect(() => resolvePayment(s.ledger, paymentId(r), 'approved', by())).toThrow(ActionError);
  });

  it('refuses an unknown payment, a missing actor and an overlong note', () => {
    const r = pay(s.ledger, { amount: 600_000 });
    expect(() => resolvePayment(s.ledger, 'pay_nope', 'approved', by())).toThrow(/No payment/);
    expect(() =>
      resolvePayment(s.ledger, paymentId(r), 'approved', { by: '  ', now: NOW }),
    ).toThrow(/Say who is acting/);
    expect(() =>
      resolvePayment(s.ledger, paymentId(r), 'approved', by(NOW, 'x'.repeat(501))),
    ).toThrow(/500 characters/);
  });
});

describe('cooling-off cancellation', () => {
  it('cancels inside the window, which frees the budget', () => {
    const r = pay(s.ledger, {}, NOW - 5 * MINUTE);
    const p = cancelCoolingOff(s.ledger, paymentId(r), by());
    expect(p).toMatchObject({
      status: 'cancelled',
      cancellableUntil: null,
      decidedBy: 'M. Keller',
    });
    expect(s.ledger.paymentViews('lab-procurement')[0]?.status).toBe('cancelled');
  });

  it('refuses once the window has closed', () => {
    const r = pay(s.ledger, {}, NOW - 10 * MINUTE);
    expect(() => cancelCoolingOff(s.ledger, paymentId(r), by())).toThrow(
      /closed at 2026-10-21T10:00:00.000Z/,
    );
  });

  it('refuses a payment without a window (known supplier)', () => {
    pay(s.ledger, {}, NOW - 60 * MINUTE);
    const r = pay(s.ledger, {}, NOW - MINUTE);
    expect(() => cancelCoolingOff(s.ledger, paymentId(r), by())).toThrow(/no cooling-off window/);
  });

  it('refuses a payment that is not approved, or already cancelled', () => {
    const review = pay(s.ledger, { amount: 600_000 });
    expect(() => cancelCoolingOff(s.ledger, paymentId(review), by())).toThrow(/only approved/);
    const r = pay(s.ledger, { merchant: 'Basel Labware AG' }, NOW - MINUTE);
    cancelCoolingOff(s.ledger, paymentId(r), by());
    expect(() => cancelCoolingOff(s.ledger, paymentId(r), by())).toThrow(/is cancelled/);
  });

  it('applies to a payment approved by a human, counted from the approval', () => {
    const r = pay(s.ledger, { amount: 600_000 }, NOW - 60 * MINUTE);
    resolvePayment(s.ledger, paymentId(r), 'approved', by(NOW - 5 * MINUTE));
    expect(cancelCoolingOff(s.ledger, paymentId(r), by()).status).toBe('cancelled');
  });
});

describe('freeze and kill switch', () => {
  it('freezes and unfreezes one agent, and reports no-ops', () => {
    expect(setAgentFrozen(s.ledger, 'lab-procurement', true, by())).toBe(true);
    expect(setAgentFrozen(s.ledger, 'lab-procurement', true, by())).toBe(false);
    expect(s.ledger.controls().frozen['lab-procurement']).toEqual({
      frozen: true,
      by: 'M. Keller',
      at: '2026-10-21T10:00:00.000Z',
    });
    expect(setAgentFrozen(s.ledger, 'lab-procurement', false, by())).toBe(true);
    expect(s.ledger.controls().frozen['lab-procurement']?.frozen).toBe(false);
  });

  it('rejects an invalid agent id', () => {
    expect(() => setAgentFrozen(s.ledger, '../x', true, by())).toThrow(/not a valid agent id/);
  });

  it('switches the kill switch on and off', () => {
    expect(s.ledger.controls().killSwitch).toBeNull();
    expect(setKillSwitch(s.ledger, true, by())).toBe(true);
    expect(setKillSwitch(s.ledger, true, by())).toBe(false);
    expect(s.ledger.controls().killSwitch).toMatchObject({ on: true, by: 'M. Keller' });
    setKillSwitch(s.ledger, false, by());
    expect(s.ledger.controls().killSwitch?.on).toBe(false);
  });

  it('works out the status the engine sees', () => {
    const controls = { killSwitch: null, frozen: { a: { frozen: true, by: 'x', at: '' } } };
    expect(effectiveStatus('active', controls, 'a')).toBe('frozen');
    expect(effectiveStatus('active', controls, 'b')).toBe('active');
    expect(effectiveStatus('paused', controls, 'b')).toBe('paused');
  });
});

describe('every human action is a signed, chained ledger entry', () => {
  it('keeps the ledger auditable', () => {
    const a = pay(s.ledger, { amount: 600_000 }, NOW - 3 * MINUTE);
    const b = pay(s.ledger, { merchant: 'Basel Labware AG' }, NOW - 2 * MINUTE);
    resolvePayment(s.ledger, paymentId(a), 'approved', by());
    cancelCoolingOff(s.ledger, paymentId(b), by());
    setAgentFrozen(s.ledger, 'lab-procurement', true, by());
    setKillSwitch(s.ledger, true, by());
    expect(s.ledger.entries().map((e) => e.type)).toEqual([
      'payment.decision',
      'payment.decision',
      'payment.resolved',
      'payment.cancelled',
      'control.agent_freeze',
      'control.kill_switch',
    ]);
    s.ledger.close();
    const ro = Ledger.openReadOnly(s.path);
    expect(ro.audit(s.issuer.publicKey)).toMatchObject({ ok: true, entries: 6 });
    ro.close();
    s.ledger = Ledger.open(s.path, { issuer: s.issuer.id, privateKey: s.issuer.privateKey });
  });
});

describe('CSV export', () => {
  it('quotes every cell and neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-2')).toBe(`"'-2"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\t=1')).toBe(`"'\t=1"`);
    expect(csvCell('plain, "quoted"')).toBe(`"plain, ""quoted"""`);
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(null)).toBe('""');
  });

  it('exports one row per entry with decimal amounts and the human actor', () => {
    const r = pay(s.ledger, { amount: 600_000, memo: '=cmd|calc' }, NOW - MINUTE);
    resolvePayment(s.ledger, paymentId(r), 'approved', by(NOW, 'ok'));
    setKillSwitch(s.ledger, true, by());
    const lines = exportCsv(s.ledger).trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      '"seq","created_at","type","agent_id","payment_id","decision_or_status","merchant","amount","currency","amount_base","base_currency","category","country","rule","reason","memo","by","note","receipt_id","hash"',
    );
    expect(lines[1]).toContain(`"review","Alpine Reagents AG","6000.00","CHF","6000.00","CHF"`);
    expect(lines[1]).toContain(`"'=cmd|calc","engine"`);
    expect(lines[2]).toContain(`"payment.resolved","lab-procurement"`);
    expect(lines[2]).toContain(`"approved"`);
    expect(lines[2]).toContain(`"M. Keller","ok"`);
    expect(lines[3]).toContain(`"control.kill_switch","*","","kill switch on"`);
  });
});
