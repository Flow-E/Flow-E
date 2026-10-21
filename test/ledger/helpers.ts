import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { evaluate } from '../../src/engine/evaluate.js';
import type { PaymentRequest } from '../../src/engine/types.js';
import { initIssuer, loadSigningIssuer } from '../../src/kya/store.js';
import { Ledger, newId } from '../../src/ledger/ledger.js';
import type { Receipt } from '../../src/ledger/receipt.js';
import { NOW, context, credential, mandate, request } from '../engine/fixtures.js';

export interface Setup {
  dir: string;
  home: string;
  path: string;
  issuer: ReturnType<typeof loadSigningIssuer>;
  ledger: Ledger;
}

export function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'imprest-ledger-'));
  const home = join(dir, '.imprest');
  initIssuer(home);
  const issuer = loadSigningIssuer(home);
  const path = join(home, 'ledger.db');
  const ledger = Ledger.open(path, { issuer: issuer.id, privateKey: issuer.privateKey });
  return { dir, home, path, issuer, ledger };
}

/** Evaluate a request with the engine (fixture KYA) and record the decision. */
export function pay(
  ledger: Ledger,
  overrides: Omit<Partial<PaymentRequest>, 'memo'> & { memo?: string | undefined } = {},
  now = NOW,
  agentId = 'lab-procurement',
): Receipt {
  const { memo, ...rest } = overrides;
  const req = request(rest);
  if ('memo' in overrides) {
    if (memo === undefined) delete req.memo;
    else req.memo = memo;
  }
  const result = evaluate(
    { id: 'lab-procurement', status: 'active', credential: credential() },
    mandate(),
    req,
    context({ context: { now, ledger: ledger.paymentViews('lab-procurement') } }),
  );
  return ledger.appendDecision({
    agentId,
    paymentId: newId('pay'),
    request: req,
    result,
    baseCurrency: 'CHF',
    now,
  });
}

/** Open the file the way an attacker would: raw SQL, triggers dropped. */
export function tamper(path: string, ...statements: string[]): void {
  const db = new Database(path);
  db.exec('DROP TRIGGER IF EXISTS entries_no_update; DROP TRIGGER IF EXISTS entries_no_delete;');
  for (const sql of statements) db.exec(sql);
  db.close();
}
