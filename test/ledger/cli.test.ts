import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runAudit, runReceipt, runVerify } from '../../src/cli/ledger-commands.js';
import { storePaths } from '../../src/kya/store.js';
import { LedgerError } from '../../src/ledger/ledger.js';
import type { Receipt } from '../../src/ledger/receipt.js';
import { MINUTE, NOW } from '../engine/fixtures.js';
import { pay, setup, tamper, type Setup } from './helpers.js';

let s: Setup;
let receipts: Receipt[];
beforeEach(() => {
  s = setup();
  receipts = [
    pay(s.ledger, {}, NOW - 3 * MINUTE),
    pay(s.ledger, { country: 'RU' }, NOW - 2 * MINUTE),
    pay(s.ledger, { merchant: 'Basel Labware AG' }, NOW - MINUTE),
  ];
  s.ledger.close();
});

/** Save receipt n (1-based) the way `imprest receipt <id> > file` would. */
function saveReceipt(n: number): string {
  const r = receipts[n - 1];
  if (!r) throw new Error('no receipt');
  const file = join(s.dir, `receipt-${n}.json`);
  writeFileSync(file, runReceipt({ home: s.home, id: r.entry.id }).text);
  return file;
}

describe('imprest audit', () => {
  it('reports an intact ledger', () => {
    const out = runAudit({ home: s.home });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^✔ Ledger intact: 3 entries, head #3 [0-9a-f]{64}$/);
  });

  it('points to the first broken entry after a hand edit', () => {
    tamper(
      s.path,
      `UPDATE entries SET data = json_set(data, '$.decision', 'approved') WHERE seq = 2`,
    );
    const out = runAudit({ home: s.home });
    expect(out.ok).toBe(false);
    expect(out.text).toBe(
      `✖ Ledger is BROKEN at entry #2 (${receipts[1]?.entry.id ?? ''}): contents do not match the stored hash (edited after writing).\n` +
        '  Entries #1–#1 verified; nothing from #2 on can be trusted.',
    );
  });

  it('names a missing entry', () => {
    tamper(s.path, 'DELETE FROM entries WHERE seq = 1');
    expect(runAudit({ home: s.home }).text).toMatch(/BROKEN at entry #1: entry #1 is missing/);
  });

  it('needs a ledger', () => {
    expect(() => runAudit({ home: s.home, ledger: join(s.dir, 'none.db') })).toThrow(LedgerError);
  });
});

describe('imprest receipt', () => {
  it('prints the receipt for a receipt id or a payment id', () => {
    const r = receipts[0];
    expect(JSON.parse(runReceipt({ home: s.home, id: r?.entry.id ?? '' }).text)).toEqual(r);
    const paymentId = r?.entry.data.payment_id as string;
    expect(JSON.parse(runReceipt({ home: s.home, id: paymentId }).text)).toEqual(r);
  });
  it('says so when the id is unknown', () => {
    expect(() => runReceipt({ home: s.home, id: 'pay_nope' })).toThrow(
      /No ledger entry or payment/,
    );
  });
});

describe('imprest verify', () => {
  it('verifies a receipt and its position in the ledger', () => {
    const out = runVerify({ home: s.home, receipt: saveReceipt(2) });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('✔ issuer signature is valid');
    expect(out.text).toContain('✔ matches ledger entry #2 and its link to the previous entry');
    expect(out.text.endsWith('VALID')).toBe(true);
  });

  it('verifies offline for an auditor who has only the public key', () => {
    const file = saveReceipt(1);
    const auditor = join(s.dir, 'auditor');
    mkdirSync(auditor);
    copyFileSync(storePaths(s.home).publicKey, join(auditor, 'issuer.pub'));
    const out = runVerify({
      home: join(auditor, 'no-mandate-here'),
      receipt: file,
      pubkey: join(auditor, 'issuer.pub'),
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain(
      'chain position not checked (no ledger available; offline check only)',
    );
  });

  it('skips the ledger with --offline', () => {
    expect(runVerify({ home: s.home, receipt: saveReceipt(1), offline: true }).text).toContain(
      'offline check only',
    );
  });

  it('fails a receipt whose ledger entry was later changed', () => {
    const file = saveReceipt(2);
    tamper(s.path, `UPDATE entries SET hash = '${'a'.repeat(64)}' WHERE seq = 2`);
    const out = runVerify({ home: s.home, receipt: file });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('✖ ledger entry #2 differs from this receipt');
  });

  it('fails a receipt whose ledger row was edited but kept its old hash', () => {
    const file = saveReceipt(2);
    tamper(
      s.path,
      `UPDATE entries SET data = json_set(data, '$.decision', 'approved') WHERE seq = 2`,
    );
    const out = runVerify({ home: s.home, receipt: file });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('✖ ledger entry #2 differs from this receipt');
  });

  it('fails a receipt whose predecessor was changed', () => {
    const file = saveReceipt(3);
    tamper(s.path, `UPDATE entries SET hash = '${'b'.repeat(64)}' WHERE seq = 2`);
    expect(runVerify({ home: s.home, receipt: file }).text).toContain(
      "✖ ledger entry #2 no longer matches the receipt's link",
    );
  });

  it('fails a receipt whose entry was deleted from the end of the ledger', () => {
    const file = saveReceipt(3);
    tamper(s.path, 'DELETE FROM entries WHERE seq = 3');
    const out = runVerify({ home: s.home, receipt: file });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('✖ the ledger has no entry #3');
  });

  it('fails an edited receipt even without a ledger', () => {
    const file = saveReceipt(2);
    const r = JSON.parse(
      runReceipt({ home: s.home, id: receipts[1]?.entry.id ?? '' }).text,
    ) as Receipt;
    r.entry.data.decision = 'approved';
    writeFileSync(file, JSON.stringify(r));
    const out = runVerify({ home: s.home, receipt: file, offline: true });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/✖ contents do not match the entry hash[\s\S]*INVALID$/);
  });

  it('rejects a public key file that is not Ed25519', () => {
    const bad = join(s.dir, 'bad.pub');
    writeFileSync(bad, 'nope');
    expect(() => runVerify({ home: s.home, receipt: saveReceipt(1), pubkey: bad })).toThrow(
      /not an Ed25519 public key/,
    );
  });
});
