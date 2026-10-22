import type { KeyObject } from 'node:crypto';
import Database from 'better-sqlite3';
import type { EvaluationResult, LedgerEntryView, PaymentRequest } from '../engine/types.js';
import {
  KILL_SWITCH,
  AGENT_FREEZE,
  PAYMENT_CANCELLED,
  PAYMENT_DECISION,
  PAYMENT_RESOLVED,
  auditEntries,
  buildEntry,
  decisionData,
  foldControls,
  foldPayments,
  fromStored,
  toEngineViews,
  type AuditResult,
  type Controls,
  type EntryInput,
  type PaymentRecord,
  type Signer,
  type StoredEntry,
} from './fold.js';
import { toReceipt, type Entry, type Receipt } from './receipt.js';

export {
  AGENT_FREEZE,
  ALL_AGENTS,
  KILL_SWITCH,
  PAYMENT_CANCELLED,
  PAYMENT_DECISION,
  PAYMENT_RESOLVED,
  newId,
  type AuditResult,
  type Controls,
  type PaymentRecord,
  type Signer,
} from './fold.js';

/**
 * Append-only ledger in SQLite. Triggers refuse UPDATE and DELETE; anything done around them
 * (editing the file directly, dropping the triggers) breaks the hash chain or a signature, and
 * `audit()` names the first broken entry. The rules themselves live in fold.ts.
 */

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS entries (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  signature  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS entries_by_agent ON entries (agent_id, seq);

CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries
BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;

CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries
BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
`;

export class LedgerError extends Error {
  override name = 'LedgerError';
}

export class Ledger {
  private constructor(
    private readonly db: Database.Database,
    readonly issuer: string,
    private readonly signer: Signer | null,
  ) {}

  /** Open for writing, creating the file if needed. The ledger is bound to one issuer. */
  static open(path: string, signer: Signer): Ledger {
    const db = new Database(path);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec(SCHEMA);
      const meta = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
      const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      db.transaction(() => {
        const issuer = meta.get('issuer')?.value;
        if (issuer === undefined) {
          insert.run('issuer', signer.issuer);
          insert.run('schema_version', SCHEMA_VERSION);
        } else if (issuer !== signer.issuer) {
          throw new LedgerError(
            `This ledger belongs to issuer ${issuer}, not ${signer.issuer}. Refusing to mix keys.`,
          );
        }
      }).immediate();
      return new Ledger(db, signer.issuer, signer);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Open an existing ledger read-only, for audit and verification. */
  static openReadOnly(path: string): Ledger {
    let db: Database.Database;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      throw new LedgerError(`No ledger at ${path}.`);
    }
    try {
      const row = db
        .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'issuer'")
        .get();
      if (!row)
        throw new LedgerError(`${path} has no issuer recorded; it is not a mandate ledger.`);
      return new Ledger(db, row.value, null);
    } catch (err) {
      db.close();
      if (err instanceof LedgerError) throw err;
      throw new LedgerError(`${path} is not a mandate ledger.`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Append one entry, atomically against concurrent writers. Returns its receipt. */
  append(input: EntryInput): Receipt {
    const signer = this.signer;
    if (!signer) throw new LedgerError('The ledger was opened read-only.');
    const last = this.db.prepare<[], { seq: number; hash: string }>(
      'SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1',
    );
    const insert = this.db.prepare(
      `INSERT INTO entries (seq, id, type, agent_id, created_at, data, prev_hash, hash, signature)
       VALUES (@seq, @id, @type, @agent_id, @created_at, @data, @prev_hash, @hash, @signature)`,
    );
    const write = this.db.transaction((): Entry => {
      const { entry, stored } = buildEntry(last.get() ?? null, input, signer);
      insert.run(stored);
      return entry;
    });
    return toReceipt(this.issuer, write.immediate());
  }

  /** Record an engine decision for a payment request. */
  appendDecision(input: {
    agentId: string;
    paymentId: string;
    request: PaymentRequest;
    result: EvaluationResult;
    baseCurrency: string;
    now: number;
  }): Receipt {
    return this.append({
      type: PAYMENT_DECISION,
      agentId: input.agentId,
      now: input.now,
      data: decisionData(input),
    });
  }

  entries(): Entry[] {
    return this.rows().map(fromStored);
  }

  /** Find an entry by receipt id or by the payment id it records. */
  find(id: string): Entry | undefined {
    const row =
      this.db.prepare<[string], StoredEntry>('SELECT * FROM entries WHERE id = ?').get(id) ??
      this.db
        .prepare<[string, string], StoredEntry>(
          "SELECT * FROM entries WHERE type = ? AND json_extract(data, '$.payment_id') = ? ORDER BY seq LIMIT 1",
        )
        .get(PAYMENT_DECISION, id);
    return row ? fromStored(row) : undefined;
  }

  bySeq(seq: number): Entry | undefined {
    const row = this.db
      .prepare<[number], StoredEntry>('SELECT * FROM entries WHERE seq = ?')
      .get(seq);
    return row ? fromStored(row) : undefined;
  }

  receipt(id: string): Receipt | undefined {
    const entry = this.find(id);
    return entry ? toReceipt(this.issuer, entry) : undefined;
  }

  /**
   * Payments with their current status, oldest first: the engine's decision with any later
   * human approval, decline or cancellation folded in. One agent's, or everyone's.
   */
  payments(agentId?: string): PaymentRecord[] {
    const types = [PAYMENT_DECISION, PAYMENT_RESOLVED, PAYMENT_CANCELLED];
    const rows =
      agentId === undefined
        ? this.db
            .prepare<string[], StoredEntry>(
              'SELECT * FROM entries WHERE type IN (?, ?, ?) ORDER BY seq',
            )
            .all(...types)
        : this.db
            .prepare<string[], StoredEntry>(
              'SELECT * FROM entries WHERE agent_id = ? AND type IN (?, ?, ?) ORDER BY seq',
            )
            .all(agentId, ...types);
    return foldPayments(rows);
  }

  /** One of this agent's payments, by payment id or receipt id. Other agents' payments are invisible. */
  payment(agentId: string, id: string): PaymentRecord | undefined {
    return this.payments(agentId).find((p) => p.paymentId === id || p.receiptId === id);
  }

  /** Kill switch and per-agent freezes, as last set by a human. */
  controls(): Controls {
    return foldControls(
      this.db
        .prepare<[string, string], StoredEntry>(
          'SELECT * FROM entries WHERE type IN (?, ?) ORDER BY seq',
        )
        .all(KILL_SWITCH, AGENT_FREEZE),
    );
  }

  /** Run reads and appends as one write transaction, serialised against other processes. */
  write<T>(run: () => T): T {
    if (!this.signer) throw new LedgerError('The ledger was opened read-only.');
    return this.db.transaction(run).immediate();
  }

  /** This agent's payments, shaped for the policy engine. */
  paymentViews(agentId: string): LedgerEntryView[] {
    return toEngineViews(this.payments(agentId));
  }

  /**
   * Read this agent's payments, decide, and record the decision in one write transaction, so
   * concurrent requests (even from other processes) cannot both spend the same budget.
   */
  decide(
    agentId: string,
    run: (views: LedgerEntryView[]) => {
      paymentId: string;
      request: PaymentRequest;
      result: EvaluationResult;
      baseCurrency: string;
      now: number;
    },
  ): { receipt: Receipt; result: EvaluationResult } {
    return this.write(() => {
      const decision = run(this.paymentViews(agentId));
      return { receipt: this.appendDecision({ agentId, ...decision }), result: decision.result };
    });
  }

  /**
   * Check the whole chain: sequence, links, canonical data, hashes and signatures. Stops at the
   * first broken entry, because everything after it can no longer be trusted.
   */
  audit(publicKey: KeyObject): AuditResult {
    // Loaded up front: an early return must not leave a SQLite cursor open.
    return auditEntries(this.rows(), this.issuer, publicKey);
  }

  private rows(): StoredEntry[] {
    return this.db.prepare<[], StoredEntry>('SELECT * FROM entries ORDER BY seq').all();
  }
}
