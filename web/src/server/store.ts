import 'server-only';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  ActionError,
  AmountError,
  CATALOG,
  ConfigError,
  DEMO_CONFIG_YAML,
  DEMO_STORY_STEPS,
  PAYMENT_DECISION,
  PAYMENT_SCOPE,
  auditEntries,
  buildEntry,
  canonicalJson,
  csvFromEntries,
  dailySpend,
  decisionData,
  effectiveStatus,
  entryHash,
  evaluate,
  foldControls,
  foldPayments,
  fromStored,
  generateKeyPair,
  issueCredential,
  issuerIdFor,
  newId,
  parseAmount,
  parseConfigObject,
  parseCredential,
  parseReceipt,
  planCancel,
  planFreeze,
  planInvoice,
  planKillSwitch,
  planOrder,
  planResolve,
  signatureCheck,
  toEngineViews,
  toReceipt,
  verifyReceipt,
  type Actor,
  type AgentStatus,
  type AuditResult,
  type Controls,
  type CredentialFile,
  type EntryInput,
  type EvaluationResult,
  type MandateConfig,
  type PaymentRecord,
  type PaymentRequest,
  type Receipt,
  type StoredEntry,
  mandateDiff,
  type JsonValue,
} from '@flow-e/mcp/core';
import type { Db, Sql } from './db';
import { decryptSecret, encryptSecret } from './keys';
import { SAMPLE_APPROVER, SAMPLE_DAYS, SAMPLE_HISTORY, samplePlan } from './sample-history';

/**
 * The website's sandbox store. Every method takes the signed-in owner's id and works on that
 * owner's active sandbox only: no sandbox id ever comes from the browser, so one user cannot
 * reach another's data. Payments are decided and recorded in one transaction with the sandbox
 * row locked, exactly like the CLI ledger's decide().
 */

export const CONFIG_UPDATED = 'config.updated';
const CREDENTIAL_DAYS = 90;
const DAY = 86_400_000;
const MINUTE = 60_000;

interface SandboxRow {
  id: string;
  owner_id: string;
  config: unknown;
  credentials: unknown;
  issuer: string;
  issuer_public_key: string;
  issuer_private_key_enc: string;
}

interface Loaded {
  row: SandboxRow;
  config: MandateConfig;
  raw: Record<string, unknown>;
  publicKey: KeyObject;
}

export interface AgentView {
  id: string;
  owner: string;
  configuredStatus: AgentStatus;
  effectiveStatus: AgentStatus;
  frozenBy: { by: string; at: string } | null;
  today: { budget: number; approved: number; pending: number; remaining: number };
}

export interface SandboxView {
  /** The store's clock when the view was read; budgets and the dashboard use it. */
  now: number;
  issuer: string;
  publicKeyPem: string;
  organisation: string | null;
  baseCurrency: string;
  currencyDecimals: Readonly<Record<string, number>> | undefined;
  timezone: string;
  config: MandateConfig;
  raw: Record<string, unknown>;
  agents: AgentView[];
  controls: Controls;
  /** Newest first. */
  payments: PaymentRecord[];
  pending: PaymentRecord[];
  coolingOff: PaymentRecord[];
  entries: StoredEntry[];
  audit: AuditResult;
}

export interface PaymentOutcome {
  paymentId: string;
  receiptId: string;
  label: string;
  result: EvaluationResult;
  currency: string;
  amount: number;
}

/** A payment request as typed into the sandbox's fake-agent form. Same limits as the MCP tool. */
export const requestSchema = z.object({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  merchant: z.string().trim().min(1, 'Enter a supplier name.').max(200),
  amount: z.string().trim().min(1, 'Enter an amount.').max(40),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3,5}$/, 'Use a currency code such as CHF.'),
  category: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Use a four-digit merchant category code.'),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code such as CH.'),
  memo: z.string().trim().max(500).optional(),
});
export type RequestInput = z.infer<typeof requestSchema>;

export class SandboxStore {
  private readonly clock: () => number;

  constructor(
    private readonly db: Db,
    private readonly encryptionKey: Buffer,
    opts: { clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  // Sandbox lifecycle --------------------------------------------------------------------------

  /** The owner's active sandbox, created from the fictional demo on first use. */
  async ensureSandbox(ownerId: string): Promise<void> {
    const existing = await this.activeRow(this.db, ownerId);
    if (existing) return;
    await this.createSandbox(this.db, ownerId);
  }

  /** Archive the current sandbox and start a fresh one: new keys, empty ledger. */
  async resetSandbox(ownerId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        'update sandboxes set archived_at = now() where owner_id = $1 and archived_at is null',
        [ownerId],
      );
      await this.createSandbox(tx, ownerId);
    });
  }

  // Reads --------------------------------------------------------------------------------------

  async view(ownerId: string): Promise<SandboxView> {
    const loaded = await this.load(this.db, ownerId);
    const entries = await this.entries(this.db, loaded.row.id);
    const { config, row } = loaded;
    const now = this.clock();
    const controls = foldControls(entries);
    const all = foldPayments(entries);
    const agents: AgentView[] = Object.values(config.agents).map((a) => {
      const spend = dailySpend(
        toEngineViews(all.filter((p) => p.agentId === a.id)),
        now,
        config.policy.timezone,
        a.mandate.dailyBudget,
      );
      const human = controls.frozen[a.id];
      return {
        id: a.id,
        owner: a.owner,
        configuredStatus: a.status,
        effectiveStatus: effectiveStatus(a.status, controls, a.id),
        frozenBy: human?.frozen ? { by: human.by, at: human.at } : null,
        today: {
          budget: a.mandate.dailyBudget,
          approved: spend.approved,
          pending: spend.pending,
          remaining: spend.remaining,
        },
      };
    });
    const newestFirst = [...all].reverse();
    return {
      now,
      issuer: row.issuer,
      publicKeyPem: row.issuer_public_key,
      organisation: config.organisation ?? null,
      baseCurrency: config.policy.baseCurrency,
      currencyDecimals: config.policy.currencyDecimals,
      timezone: config.policy.timezone,
      config,
      raw: loaded.raw,
      agents,
      controls,
      payments: newestFirst,
      pending: newestFirst.filter((p) => p.status === 'review'),
      coolingOff: newestFirst.filter(
        (p) =>
          p.status === 'approved' &&
          p.cancellableUntil !== null &&
          Date.parse(p.cancellableUntil) > now,
      ),
      entries,
      audit: auditEntries(entries, row.issuer, loaded.publicKey),
    };
  }

  /** One payment with its decision entry (for the trace) and signed receipt. */
  async payment(
    ownerId: string,
    id: string,
  ): Promise<{
    payment: PaymentRecord;
    receipt: Receipt;
    trace: TraceStep[];
    /** Inside its cooling-off window right now. */
    cancellable: boolean;
  } | null> {
    const loaded = await this.load(this.db, ownerId);
    const entries = await this.entries(this.db, loaded.row.id);
    const payment = foldPayments(entries).find((p) => p.paymentId === id || p.receiptId === id);
    if (!payment) return null;
    const row = entries.find((e) => e.id === payment.receiptId && e.type === PAYMENT_DECISION);
    if (!row) return null;
    const entry = fromStored(row);
    const trace = (entry.data.trace ?? []) as unknown as TraceStep[];
    const cancellable =
      payment.status === 'approved' &&
      payment.cancellableUntil !== null &&
      Date.parse(payment.cancellableUntil) > this.clock();
    return { payment, receipt: toReceipt(loaded.row.issuer, entry), trace, cancellable };
  }

  async csv(ownerId: string): Promise<string> {
    const loaded = await this.load(this.db, ownerId);
    return csvFromEntries((await this.entries(this.db, loaded.row.id)).map(fromStored));
  }

  /**
   * Verify a receipt (pasted or downloaded) against this sandbox's public key, offline-style,
   * and check its position in this sandbox's ledger.
   */
  async verify(
    ownerId: string,
    receiptText: string,
  ): Promise<{ valid: boolean; checks: string[] }> {
    const loaded = await this.load(this.db, ownerId);
    const receipt = parseReceipt(receiptText);
    const { valid, checks } = verifyReceipt(receipt, loaded.publicKey);
    let ok = valid;
    const entries = await this.entries(this.db, loaded.row.id);
    const { seq, hash, prev_hash: prevHash } = receipt.entry;
    const stored = entries.find((e) => e.seq === seq);
    const prev = entries.find((e) => e.seq === seq - 1);
    if (!stored) {
      ok = false;
      checks.push(`✖ this sandbox's ledger has no entry #${seq}`);
    } else if (stored.hash !== hash || entryHash(fromStored(stored)) !== hash) {
      ok = false;
      checks.push(`✖ ledger entry #${seq} differs from this receipt`);
    } else if (seq > 1 && prev?.hash !== prevHash) {
      ok = false;
      checks.push(`✖ ledger entry #${seq - 1} no longer matches the receipt's link`);
    } else {
      checks.push(`✔ matches ledger entry #${seq} and its link to the previous entry`);
    }
    return { valid: ok, checks };
  }

  // The fake agent -----------------------------------------------------------------------------

  /** Ask for a payment as the given demo agent: evaluate and record in one transaction. */
  async requestPayment(
    ownerId: string,
    input: RequestInput,
    label?: string,
  ): Promise<PaymentOutcome> {
    const req = requestSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const loaded = await this.load(tx, ownerId, true);
      const { config, row } = loaded;
      const agent = config.agents[req.agentId];
      if (!agent) throw new ActionError(`Agent "${req.agentId}" is not in this sandbox.`);
      const currency = req.currency.toUpperCase();
      let amount: number;
      try {
        amount = parseAmount(req.amount, currency, config.policy.currencyDecimals);
      } catch (err) {
        throw new ActionError(`Invalid amount: ${(err as AmountError).message}`);
      }
      const credentials = await this.freshCredentials(tx, loaded);
      const entries = await this.entries(tx, row.id);
      const request = {
        merchant: req.merchant,
        amount,
        currency,
        category: req.category,
        country: req.country.toUpperCase(),
        ...(req.memo ? { memo: req.memo } : {}),
      };
      const decided = await this.decide(tx, loaded, entries, {
        agentId: agent.id,
        request,
        credential: credentials[agent.id] ?? null,
        now: this.clock(),
      });
      return { ...decided, label: label ?? req.merchant, currency, amount };
    });
  }

  /**
   * Fill an EMPTY sandbox with 30 days of fictional purchasing, for demos of the dashboard. Every
   * request goes through the real engine and every entry into the same signed chain; only the
   * clock is set back, step by step in time order, which is why the ledger must be empty. The
   * first entry says so. Organisations have no such method: their timestamps are always real.
   */
  async fillSampleHistory(ownerId: string, actor: ActorInput): Promise<number> {
    return this.db.transaction(async (tx) => {
      const loaded = await this.load(tx, ownerId, true);
      const entries = await this.entries(tx, loaded.row.id);
      if (entries.length > 0) {
        throw new ActionError(
          'Sample history only fills an empty sandbox. Start over first, then fill it.',
        );
      }
      const now = this.clock();
      const steps = samplePlan(now, loaded.config.policy.timezone);
      const first = steps[0]?.at ?? now - MINUTE;
      const start = first - MINUTE;
      await this.append(tx, loaded, entries, {
        type: SAMPLE_HISTORY,
        agentId: '*',
        now: start,
        data: {
          by: actor.by,
          note: 'Fictional sample history for the dashboard. The entries after this one carry backdated times; they were generated at generated_at.',
          generated_at: new Date(now).toISOString(),
          days: SAMPLE_DAYS,
        },
      });
      // Credentials valid over the whole history, and one that had lapsed, as an agent's would.
      const valid: Record<string, CredentialFile> = {};
      const lapsed: Record<string, CredentialFile> = {};
      for (const agent of Object.values(loaded.config.agents)) {
        valid[agent.id] = this.issue(loaded.row, loaded.config, agent.id, agent.owner, start, 90);
        lapsed[agent.id] = this.issue(
          loaded.row,
          loaded.config,
          agent.id,
          agent.owner,
          start - 60 * DAY,
          30,
        );
      }
      const paymentIds = new Map<string, string>();
      const by = { by: SAMPLE_APPROVER };
      for (const step of steps) {
        if (step.kind === 'request') {
          const decided = await this.decide(tx, loaded, entries, {
            agentId: step.agentId,
            request: step.request,
            credential: (step.expiredCredential ? lapsed : valid)[step.agentId] ?? null,
            now: step.at,
          });
          paymentIds.set(step.key, decided.paymentId);
          continue;
        }
        const actorAt = { ...by, note: step.note, now: step.at };
        let entry: EntryInput | null = null;
        if (step.kind === 'kill_switch') {
          entry = planKillSwitch(foldControls(entries), step.on, actorAt);
        } else {
          const id = paymentIds.get(step.key);
          const payment = foldPayments(entries).find((p) => p.paymentId === id);
          // The engine decides; a step that no longer fits its decision is skipped.
          if (!id || !payment) continue;
          if (step.kind === 'resolve' && payment.status === 'review') {
            entry = planResolve(foldPayments(entries), id, step.status, actorAt).entry;
          } else if (
            step.kind === 'cancel' &&
            payment.status === 'approved' &&
            payment.cancellableUntil !== null &&
            Date.parse(payment.cancellableUntil) > step.at
          ) {
            entry = planCancel(foldPayments(entries), id, actorAt).entry;
          }
        }
        if (entry) await this.append(tx, loaded, entries, entry);
      }
      return entries.length;
    });
  }

  /** The same seven requests as `flow-e simulate`, as the lab-procurement agent. */
  async playStory(ownerId: string): Promise<PaymentOutcome[]> {
    const outcomes: PaymentOutcome[] = [];
    for (const step of DEMO_STORY_STEPS) {
      const item = CATALOG[step.item - 1];
      if (!item) continue;
      outcomes.push(
        await this.requestPayment(
          ownerId,
          {
            agentId: 'lab-procurement',
            merchant: item.supplier,
            amount: step.amount ?? item.price,
            currency: item.currency,
            category: item.category,
            country: item.country,
            memo: item.item,
          },
          step.amount ? `${item.item}, split part: ${item.currency} ${step.amount}` : item.item,
        ),
      );
    }
    return outcomes;
  }

  // Owner actions ------------------------------------------------------------------------------

  async resolve(ownerId: string, id: string, status: 'approved' | 'declined', actor: ActorInput) {
    await this.act(
      ownerId,
      (entries) => planResolve(foldPayments(entries), id, status, this.actor(actor)).entry,
    );
  }

  async cancel(ownerId: string, id: string, actor: ActorInput) {
    await this.act(
      ownerId,
      (entries) => planCancel(foldPayments(entries), id, this.actor(actor)).entry,
    );
  }

  /** Record that an approved payment was ordered from the supplier. */
  async recordOrder(ownerId: string, id: string, reference: string, actor: ActorInput) {
    await this.act(
      ownerId,
      (entries) =>
        planOrder(foldPayments(entries), id, {
          ...this.actor(actor),
          ...(reference.trim() ? { reference } : {}),
        }).entry,
    );
  }

  /** Match the supplier's invoice to an approved payment. `amount` in normal units. */
  async recordInvoice(
    ownerId: string,
    id: string,
    invoice: { number: string; amount: string; currency: string },
    actor: ActorInput,
  ) {
    await this.act(ownerId, (entries, config) => {
      const currency = invoice.currency.trim().toUpperCase();
      let amount: number;
      try {
        amount = parseAmount(invoice.amount.trim(), currency, config.policy.currencyDecimals);
      } catch (err) {
        throw new ActionError(`Invoice total: ${(err as Error).message}`);
      }
      return planInvoice(foldPayments(entries), id, {
        ...this.actor(actor),
        number: invoice.number,
        amount,
        currency,
      }).entry;
    });
  }

  async setFrozen(ownerId: string, agentId: string, frozen: boolean, actor: ActorInput) {
    await this.act(ownerId, (entries, config) => {
      if (!config.agents[agentId])
        throw new ActionError(`Agent "${agentId}" is not in this sandbox.`);
      return planFreeze(foldControls(entries), agentId, frozen, this.actor(actor));
    });
  }

  async setKillSwitch(ownerId: string, on: boolean, actor: ActorInput) {
    await this.act(ownerId, (entries) =>
      planKillSwitch(foldControls(entries), on, this.actor(actor)),
    );
  }

  /**
   * Replace the sandbox's mandate. Validated with the same schema as mandate.yaml; the base
   * currency and the set of agents stay fixed. The change itself is recorded in the ledger.
   */
  async updateConfig(
    ownerId: string,
    raw: Record<string, unknown>,
    actor: ActorInput,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const loaded = await this.load(tx, ownerId, true);
      // Checked before validation, so the message names the real problem.
      if (raw.base_currency !== loaded.config.policy.baseCurrency) {
        throw new ConfigError('The base currency of a sandbox cannot be changed.');
      }
      const next = parseConfigObject(raw);
      const before = Object.keys(loaded.config.agents).sort().join(',');
      if (Object.keys(next.agents).sort().join(',') !== before) {
        throw new ConfigError('Agents cannot be added or removed in the sandbox.');
      }
      await tx.query('update sandboxes set config = $1::jsonb where id = $2', [
        JSON.stringify(raw),
        loaded.row.id,
      ]);
      const a = this.actor(actor);
      const entries = await this.entries(tx, loaded.row.id);
      await this.append(tx, loaded, entries, {
        type: CONFIG_UPDATED,
        agentId: '*',
        now: a.now,
        data: {
          by: a.by,
          note: a.note ?? null,
          diff: mandateDiff(loaded.raw, raw) as unknown as JsonValue,
          config_sha256: createHash('sha256').update(canonicalJson(raw)).digest('hex'),
        },
      });
    });
  }

  // Internals ----------------------------------------------------------------------------------

  private actor(a: ActorInput): Actor {
    return { by: a.by, note: a.note, now: this.clock() };
  }

  private async act(
    ownerId: string,
    plan: (entries: StoredEntry[], config: MandateConfig) => EntryInput | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const loaded = await this.load(tx, ownerId, true);
      const entries = await this.entries(tx, loaded.row.id);
      const entry = plan(entries, loaded.config);
      if (entry) await this.append(tx, loaded, entries, entry);
    });
  }

  /** Evaluate one request with the real engine and record the decision. */
  private async decide(
    tx: Sql,
    loaded: Loaded,
    entries: StoredEntry[],
    input: {
      agentId: string;
      request: PaymentRequest;
      credential: CredentialFile | null;
      now: number;
    },
  ): Promise<{ paymentId: string; receiptId: string; result: EvaluationResult }> {
    const { config, row } = loaded;
    const agent = config.agents[input.agentId];
    if (!agent) throw new ActionError(`Agent "${input.agentId}" is not in this sandbox.`);
    const controls = foldControls(entries);
    const result = evaluate(
      {
        id: agent.id,
        status: effectiveStatus(agent.status, controls, agent.id),
        credential: input.credential,
      },
      agent.mandate,
      input.request,
      {
        now: input.now,
        killSwitch: controls.killSwitch?.on === true,
        ledger: toEngineViews(foldPayments(entries, agent.id)),
        organisationLedger: toEngineViews(foldPayments(entries)),
        policy: config.policy,
        kya: {
          issuer: row.issuer,
          requiredScope: PAYMENT_SCOPE,
          verifySignature: signatureCheck(loaded.publicKey),
        },
      },
    );
    const paymentId = newId('pay');
    const receipt = await this.append(tx, loaded, entries, {
      type: PAYMENT_DECISION,
      agentId: agent.id,
      now: input.now,
      data: decisionData({
        paymentId,
        request: input.request,
        result,
        baseCurrency: config.policy.baseCurrency,
      }),
    });
    return { paymentId, receiptId: receipt.entry.id, result };
  }

  private async append(
    tx: Sql,
    loaded: Loaded,
    entries: StoredEntry[],
    input: EntryInput,
  ): Promise<Receipt> {
    const last = entries.at(-1);
    const privateKey = createPrivateKey(
      decryptSecret(loaded.row.issuer_private_key_enc, this.encryptionKey),
    );
    const { entry, stored } = buildEntry(last ? { seq: last.seq, hash: last.hash } : null, input, {
      issuer: loaded.row.issuer,
      privateKey,
    });
    await tx.query(
      `insert into ledger_entries
         (sandbox_id, seq, id, type, agent_id, created_at, data, prev_hash, hash, signature)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        loaded.row.id,
        stored.seq,
        stored.id,
        stored.type,
        stored.agent_id,
        stored.created_at,
        stored.data,
        stored.prev_hash,
        stored.hash,
        stored.signature,
      ],
    );
    entries.push(stored);
    return toReceipt(loaded.row.issuer, entry);
  }

  private async entries(sql: Sql, sandboxId: string): Promise<StoredEntry[]> {
    return sql.query<StoredEntry>(
      `select seq, id, type, agent_id, created_at, data, prev_hash, hash, signature
         from ledger_entries where sandbox_id = $1 order by seq`,
      [sandboxId],
    );
  }

  private async activeRow(
    sql: Sql,
    ownerId: string,
    forUpdate = false,
  ): Promise<SandboxRow | undefined> {
    const rows = await sql.query<SandboxRow>(
      `select id, owner_id, config, credentials, issuer, issuer_public_key, issuer_private_key_enc
         from sandboxes where owner_id = $1 and archived_at is null${forUpdate ? ' for update' : ''}`,
      [ownerId],
    );
    return rows[0];
  }

  private async load(sql: Sql, ownerId: string, forUpdate = false): Promise<Loaded> {
    const row = await this.activeRow(sql, ownerId, forUpdate);
    if (!row) throw new ActionError('No sandbox yet. Open the sandbox page to create one.');
    const raw = asObject(row.config);
    return {
      row,
      raw,
      config: parseConfigObject(raw),
      publicKey: createPublicKey(row.issuer_public_key),
    };
  }

  /** The stored credentials, reissued when missing or within a day of expiry. */
  private async freshCredentials(tx: Sql, loaded: Loaded): Promise<Record<string, CredentialFile>> {
    const stored = asObject(loaded.row.credentials);
    const now = this.clock();
    const result: Record<string, CredentialFile> = {};
    let changed = false;
    for (const agent of Object.values(loaded.config.agents)) {
      let credential: CredentialFile | null = null;
      try {
        credential = parseCredential(JSON.stringify(stored[agent.id]));
      } catch {
        credential = null;
      }
      if (!credential || Date.parse(credential.claims.expires_at) <= now + DAY) {
        credential = this.issue(loaded.row, loaded.config, agent.id, agent.owner, now);
        changed = true;
      }
      result[agent.id] = credential;
    }
    if (changed) {
      await tx.query('update sandboxes set credentials = $1::jsonb where id = $2', [
        JSON.stringify(result),
        loaded.row.id,
      ]);
    }
    return result;
  }

  private issue(
    row: Pick<SandboxRow, 'issuer_public_key' | 'issuer_private_key_enc'>,
    config: MandateConfig,
    agentId: string,
    owner: string,
    now: number,
    validDays = CREDENTIAL_DAYS,
  ): CredentialFile {
    return issueCredential({
      privateKey: createPrivateKey(decryptSecret(row.issuer_private_key_enc, this.encryptionKey)),
      publicKey: createPublicKey(row.issuer_public_key),
      agentId,
      agentName: `${agentId} (sandbox agent)`,
      owner,
      organisation: config.organisation ?? 'Example Labs AG (fictional)',
      scope: [PAYMENT_SCOPE],
      now,
      validDays,
    });
  }

  private async createSandbox(sql: Sql, ownerId: string): Promise<void> {
    const raw = asObject(parseYaml(DEMO_CONFIG_YAML));
    const config = parseConfigObject(raw);
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const row = {
      issuer_public_key: publicKeyPem,
      issuer_private_key_enc: encryptSecret(privateKeyPem, this.encryptionKey),
    };
    const now = this.clock();
    const credentials: Record<string, CredentialFile> = {};
    for (const agent of Object.values(config.agents)) {
      credentials[agent.id] = this.issue(row, config, agent.id, agent.owner, now);
    }
    await sql.query(
      `insert into sandboxes
         (id, owner_id, config, credentials, issuer, issuer_public_key, issuer_private_key_enc)
       values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
       on conflict (owner_id) where archived_at is null do nothing`,
      [
        randomUUID(),
        ownerId,
        JSON.stringify(raw),
        JSON.stringify(credentials),
        issuerIdFor(createPublicKey(publicKeyPem)),
        row.issuer_public_key,
        row.issuer_private_key_enc,
      ],
    );
  }
}

export interface ActorInput {
  by: string;
  note?: string | undefined;
}

export interface TraceStep {
  rule: string;
  outcome: 'pass' | 'decline' | 'review' | 'note' | 'skip';
  detail: string;
  data?: Record<string, string | number | boolean | null>;
}

function asObject(value: unknown): Record<string, unknown> {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError('Stored sandbox data is not an object.');
  }
  return v as Record<string, unknown>;
}
