import { randomBytes, type KeyObject } from 'node:crypto';
import Database from 'better-sqlite3';
import { canonicalJson } from '../crypto/canonical.js';
import { issuerIdFor } from '../crypto/ed25519.js';
import type { EvaluationResult, LedgerEntryView, PaymentRequest } from '../engine/types.js';
import {
  GENESIS_HASH,
  entryHash,
  signHash,
  toReceipt,
  verifyHashSignature,
  type Entry,
  type EntryBody,
  type JsonValue,
  type Receipt,
} from './receipt.js';

/**
 * Append-only ledger in SQLite. Triggers refuse UPDATE and DELETE; anything done around them
 * (editing the file directly, dropping the triggers) breaks the hash chain or a signature, and
 * `audit()` names the first broken entry.
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

/** Entry types. Status changes are new entries; nothing is ever updated in place. */
export const PAYMENT_DECISION = 'payment.decision';
/** A human approved or declined a payment that was in review. */
export const PAYMENT_RESOLVED = 'payment.resolved';
/** A human cancelled an approved payment inside its cooling-off window. */
export const PAYMENT_CANCELLED = 'payment.cancelled';
export const AGENT_FREEZE = 'control.agent_freeze';
export const KILL_SWITCH = 'control.kill_switch';
/** agent_id used for entries that concern every agent. */
export const ALL_AGENTS = '*';

export interface Controls {
  killSwitch: { on: boolean; by: string; at: string } | null;
  frozen: Record<string, { frozen: boolean; by: string; at: string }>;
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

export interface Signer {
  issuer: string;
  privateKey: KeyObject;
}

interface Row {
  seq: number;
  id: string;
  type: string;
  agent_id: string;
  created_at: string;
  data: string;
  prev_hash: string;
  hash: string;
  signature: string;
}

export type AuditResult =
  | { ok: true; entries: number; head: { seq: number; hash: string } | null }
  | { ok: false; entries: number; firstBroken: { seq: number; id: string | null; reason: string } };

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
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
  append(input: {
    type: string;
    agentId: string;
    now: number;
    data: { [key: string]: JsonValue };
    id?: string;
  }): Receipt {
    const signer = this.signer;
    if (!signer) throw new LedgerError('The ledger was opened read-only.');
    // Canonicalise up front: throws on undefined, NaN and other values JSON cannot hold exactly.
    const dataText = canonicalJson(input.data);
    const last = this.db.prepare<[], { seq: number; hash: string }>(
      'SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1',
    );
    const insert = this.db.prepare(
      `INSERT INTO entries (seq, id, type, agent_id, created_at, data, prev_hash, hash, signature)
       VALUES (@seq, @id, @type, @agent_id, @created_at, @data, @prev_hash, @hash, @signature)`,
    );
    const write = this.db.transaction((): Entry => {
      const prev = last.get();
      const body: EntryBody = {
        seq: (prev?.seq ?? 0) + 1,
        id: input.id ?? newId('rcpt'),
        type: input.type,
        agent_id: input.agentId,
        created_at: new Date(input.now).toISOString(),
        data: input.data,
        prev_hash: prev?.hash ?? GENESIS_HASH,
      };
      const hash = entryHash(body);
      const entry: Entry = {
        ...body,
        hash,
        signature: signHash(signer.privateKey, signer.issuer, hash),
      };
      insert.run({ ...entry, data: dataText });
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
    const { request: r, result } = input;
    const request: { [key: string]: JsonValue } = {
      merchant: r.merchant,
      amount: r.amount,
      currency: r.currency,
      category: r.category,
      country: r.country,
    };
    if (r.memo !== undefined) request.memo = r.memo;
    return this.append({
      type: PAYMENT_DECISION,
      agentId: input.agentId,
      now: input.now,
      data: {
        payment_id: input.paymentId,
        request,
        decision: result.decision,
        rule: result.rule,
        reason: result.reason,
        amount_base: result.amountBase,
        base_currency: input.baseCurrency,
        cancellable_until:
          result.cancellableUntil === undefined
            ? null
            : new Date(result.cancellableUntil).toISOString(),
        trace: result.trace.map((t) => {
          const step: { [key: string]: JsonValue } = {
            rule: t.rule,
            outcome: t.outcome,
            detail: t.detail,
          };
          if (t.data) step.data = t.data;
          return step;
        }),
      },
    });
  }

  entries(): Entry[] {
    return this.db.prepare<[], Row>('SELECT * FROM entries ORDER BY seq').all().map(fromRow);
  }

  /** Find an entry by receipt id or by the payment id it records. */
  find(id: string): Entry | undefined {
    const row =
      this.db.prepare<[string], Row>('SELECT * FROM entries WHERE id = ?').get(id) ??
      this.db
        .prepare<[string, string], Row>(
          "SELECT * FROM entries WHERE type = ? AND json_extract(data, '$.payment_id') = ? ORDER BY seq LIMIT 1",
        )
        .get(PAYMENT_DECISION, id);
    return row ? fromRow(row) : undefined;
  }

  bySeq(seq: number): Entry | undefined {
    const row = this.db.prepare<[number], Row>('SELECT * FROM entries WHERE seq = ?').get(seq);
    return row ? fromRow(row) : undefined;
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
            .prepare<string[], Row>('SELECT * FROM entries WHERE type IN (?, ?, ?) ORDER BY seq')
            .all(...types)
        : this.db
            .prepare<string[], Row>(
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
    const controls: Controls = { killSwitch: null, frozen: {} };
    const rows = this.db
      .prepare<[string, string], Row>('SELECT * FROM entries WHERE type IN (?, ?) ORDER BY seq')
      .all(KILL_SWITCH, AGENT_FREEZE);
    for (const row of rows) {
      const d = JSON.parse(row.data) as { on?: boolean; frozen?: boolean; by: string };
      if (row.type === KILL_SWITCH) {
        controls.killSwitch = { on: d.on === true, by: d.by, at: row.created_at };
      } else {
        controls.frozen[row.agent_id] = { frozen: d.frozen === true, by: d.by, at: row.created_at };
      }
    }
    return controls;
  }

  /** Run reads and appends as one write transaction, serialised against other processes. */
  write<T>(run: () => T): T {
    if (!this.signer) throw new LedgerError('The ledger was opened read-only.');
    return this.db.transaction(run).immediate();
  }

  /** This agent's payments, shaped for the policy engine. */
  paymentViews(agentId: string): LedgerEntryView[] {
    return this.payments(agentId).map((p) => ({
      id: p.paymentId,
      merchant: p.request.merchant,
      amountBase: p.amountBase ?? 0,
      status: p.status,
      createdAt: Date.parse(p.createdAt),
    }));
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
    const keyId = issuerIdFor(publicKey);
    if (keyId !== this.issuer) {
      return {
        ok: false,
        entries: 0,
        firstBroken: {
          seq: 0,
          id: null,
          reason: `the ledger is bound to issuer ${this.issuer}, but the public key is ${keyId}`,
        },
      };
    }
    let expectedSeq = 1;
    let prevHash = GENESIS_HASH;
    const rows = this.db.prepare<[], Row>('SELECT * FROM entries ORDER BY seq').iterate();
    for (const row of rows) {
      const broken = (reason: string): AuditResult => ({
        ok: false,
        entries: expectedSeq - 1,
        firstBroken: { seq: row.seq, id: typeof row.id === 'string' ? row.id : null, reason },
      });
      if (row.seq > expectedSeq) {
        // The first broken position is the gap itself, not the row after it.
        return {
          ok: false,
          entries: expectedSeq - 1,
          firstBroken: {
            seq: expectedSeq,
            id: null,
            reason: `entry #${expectedSeq} is missing (next entry found is #${row.seq})`,
          },
        };
      }
      if (row.seq !== expectedSeq) return broken(`unexpected sequence number ${row.seq}`);
      if (row.prev_hash !== prevHash) {
        return broken(`does not link to entry #${expectedSeq - 1} (prev_hash mismatch)`);
      }
      let entry: Entry;
      try {
        entry = fromRow(row);
        if (canonicalJson(entry.data) !== row.data) throw new Error('not canonical');
      } catch {
        return broken('data is not valid canonical JSON (edited by hand?)');
      }
      if (entryHash(entry) !== row.hash) {
        return broken('contents do not match the stored hash (edited after writing)');
      }
      if (!verifyHashSignature(publicKey, this.issuer, row.hash, row.signature)) {
        return broken('issuer signature is not valid (hash rewritten without the issuer key)');
      }
      prevHash = row.hash;
      expectedSeq += 1;
    }
    const count = expectedSeq - 1;
    return { ok: true, entries: count, head: count === 0 ? null : { seq: count, hash: prevHash } };
  }
}

/** A payment as the agent and the owner see it. */
export interface PaymentRecord {
  paymentId: string;
  receiptId: string;
  agentId: string;
  status: 'approved' | 'declined' | 'review' | 'cancelled';
  /** The engine's original decision. */
  engineDecision: 'approved' | 'declined' | 'review';
  rule: string | null;
  reason: string;
  request: {
    merchant: string;
    amount: number;
    currency: string;
    category: string;
    country: string;
    memo?: string;
  };
  amountBase: number | null;
  baseCurrency: string;
  createdAt: string;
  cancellableUntil: string | null;
  /** "engine", or the person who last changed the status. */
  decidedBy: string;
  /** When a human last changed the status; null if never. */
  updatedAt: string | null;
  note: string | null;
}

interface DecisionData {
  payment_id: string;
  request: PaymentRecord['request'];
  decision: PaymentRecord['engineDecision'];
  rule: string | null;
  reason: string;
  amount_base: number | null;
  base_currency: string;
  cancellable_until: string | null;
}

interface HumanActionData {
  payment_id: string;
  status?: 'approved' | 'declined';
  by: string;
  note: string | null;
  cancellable_until?: string | null;
}

function foldPayments(rows: Row[]): PaymentRecord[] {
  const byId = new Map<string, PaymentRecord>();
  for (const row of rows) {
    if (row.type === PAYMENT_DECISION) {
      const d = JSON.parse(row.data) as DecisionData;
      byId.set(d.payment_id, {
        paymentId: d.payment_id,
        receiptId: row.id,
        agentId: row.agent_id,
        status: d.decision,
        engineDecision: d.decision,
        rule: d.rule,
        reason: d.reason,
        request: d.request,
        amountBase: d.amount_base,
        baseCurrency: d.base_currency,
        createdAt: row.created_at,
        cancellableUntil: d.cancellable_until,
        decidedBy: 'engine',
        updatedAt: null,
        note: null,
      });
      continue;
    }
    const d = JSON.parse(row.data) as HumanActionData;
    const p = byId.get(d.payment_id);
    if (!p) continue;
    p.decidedBy = d.by;
    p.updatedAt = row.created_at;
    p.note = d.note;
    if (row.type === PAYMENT_CANCELLED) {
      p.status = 'cancelled';
      p.cancellableUntil = null;
    } else if (d.status) {
      p.status = d.status;
      p.cancellableUntil = d.cancellable_until ?? null;
    }
  }
  return [...byId.values()];
}

function fromRow(row: Row): Entry {
  return { ...row, data: JSON.parse(row.data) as Entry['data'] };
}
