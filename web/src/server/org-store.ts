import 'server-only';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import {
  ActionError,
  ConfigError,
  PAYMENT_DECISION,
  PAYMENT_SCOPE,
  auditEntries,
  buildEntry,
  canonicalJson,
  configSchema,
  csvFromEntries,
  dailySpend,
  decisionData,
  effectiveStatus,
  entryHash,
  evaluate,
  foldControls,
  foldPayments,
  formatMoney,
  fromStored,
  generateKeyPair,
  issueCredential,
  issuerIdFor,
  mandateSummary,
  newId,
  parseConfigObject,
  parseCredential,
  parseReceipt,
  paymentAnswer,
  planCancel,
  planFreeze,
  planKillSwitch,
  planResolve,
  publicPayment,
  signatureCheck,
  toEngineViews,
  toPaymentRequest,
  toReceipt,
  verifyReceipt,
  type Actor,
  type AgentStatus,
  type AuditResult,
  type Controls,
  type CredentialFile,
  type EntryInput,
  type MandateConfig,
  type PaymentRecord,
  type Receipt,
  type RequestPaymentArgs,
  type StoredEntry,
} from '@flow-e/mcp/core';
import type { Db, Sql } from './db';
import { approvalEmail, invitationEmail, type EmailMessage, type Mailer } from './email';
import { decryptSecret, encryptSecret } from './keys';
import { ForbiddenError, assertCan, can, isRole, type Permission, type Role } from './permissions';
import { looksLikeAgentKey, looksLikeToken, newAgentKey, newToken, sha256 } from './tokens';
import type { TraceStep } from './store';

/**
 * Organisations: members with roles, real agents with API keys, approval by email. Each
 * organisation has its own issuer key, mandate and signed hash-chained ledger
 * (org_ledger_entries).
 *
 * Every person-facing method takes the signed-in user and an organisation id from the URL, reads
 * that user's role from org_members and checks it against src/server/permissions.ts before
 * touching anything. A user who is not a member gets the same answer whether or not the
 * organisation exists. Agent-facing methods take the identity resolved from an API key, never
 * an organisation or agent id supplied by the agent.
 */

export interface User {
  userId: string;
  email: string;
}

/** Who an agent key belongs to, from authenticateAgent(). */
export interface AgentAuth {
  orgId: string;
  agentId: string;
  keyId: string;
}

const CREDENTIAL_DAYS = 90;
const DAY = 86_400_000;
const INVITATION_DAYS = 7;
const APPROVAL_HOURS = 24;
const MAX_ACTIVE_KEYS = 5;

export const ORG_CREATED = 'org.created';
export const ORG_RENAMED = 'org.renamed';
export const CONFIG_UPDATED = 'config.updated';
export const MEMBER_INVITED = 'member.invited';
export const MEMBER_INVITATION_REVOKED = 'member.invitation_revoked';
export const MEMBER_ADDED = 'member.added';
export const MEMBER_ROLE_CHANGED = 'member.role_changed';
export const MEMBER_REMOVED = 'member.removed';
export const AGENT_CREATED = 'agent.created';
export const AGENT_PAUSED = 'agent.paused';
export const AGENT_RESUMED = 'agent.resumed';
export const AGENT_KEY_CREATED = 'agent.key_created';
export const AGENT_KEY_REVOKED = 'agent.key_revoked';

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const uuid = z.uuid();

/** ISO-8601 UTC text for a timestamptz column, identical on PGlite and Postgres. */
const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Inputs ----------------------------------------------------------------------------------------

const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone such as Europe/Zurich.');

export const createOrgSchema = z.object({
  name: z.string().trim().min(1, 'Name the organisation.').max(100),
  baseCurrency: z.enum(['CHF', 'EUR']),
  timezone,
});
export type CreateOrgInput = z.input<typeof createOrgSchema>;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.').max(254));

export const inviteSchema = z.object({
  email,
  role: z.enum(['owner', 'approver', 'viewer']),
});

const moneyText = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use an amount such as 500 or 1250.50.');

export const createAgentSchema = z.object({
  agentId: z
    .string()
    .trim()
    .regex(AGENT_ID, 'Agent ids use lower-case a-z, 0-9, "-" and "_" (up to 63 characters).'),
  displayName: z.string().trim().min(1, 'Give the agent a name.').max(100),
  owner: z.string().trim().min(1, 'Name the person responsible for this agent.').max(100),
  dailyBudget: moneyText,
  perPaymentLimit: moneyText,
  approvalAbove: moneyText.optional(),
  categories: z
    .array(z.string().regex(/^\d{4}$/, 'Categories are four-digit merchant category codes.'))
    .min(1, 'Allow at least one merchant category code.')
    .max(50),
});
export type CreateAgentInput = z.input<typeof createAgentSchema>;

export const keyOptionsSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).nullable(),
});

// Views -----------------------------------------------------------------------------------------

export interface OrgSummary {
  id: string;
  name: string;
  role: Role;
  baseCurrency: string;
}

export interface MemberView {
  userId: string;
  email: string;
  role: Role;
  addedBy: string;
  addedAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export interface KeyView {
  id: string;
  agentId: string;
  prefix: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  status: 'active' | 'revoked' | 'expired';
}

export interface OrgAgentView {
  id: string;
  displayName: string;
  owner: string;
  configuredStatus: AgentStatus;
  effectiveStatus: AgentStatus;
  frozenBy: { by: string; at: string } | null;
  today: { budget: number; approved: number; pending: number; remaining: number };
  createdBy: string;
  createdAt: string;
  credentialExpires: string | null;
  keys: KeyView[];
}

export interface OrgView {
  id: string;
  name: string;
  role: Role;
  issuer: string;
  publicKeyPem: string;
  baseCurrency: string;
  currencyDecimals: Readonly<Record<string, number>> | undefined;
  timezone: string;
  config: MandateConfig;
  raw: Record<string, unknown>;
  agents: OrgAgentView[];
  controls: Controls;
  /** Newest first. */
  payments: PaymentRecord[];
  pending: PaymentRecord[];
  coolingOff: PaymentRecord[];
  entries: StoredEntry[];
  audit: AuditResult;
  members: MemberView[];
  invitations: InvitationView[];
}

export interface ApprovalPreview {
  orgId: string;
  orgName: string;
  action: 'approve' | 'decline';
  payment: PaymentRecord;
  baseCurrency: string;
  currencyDecimals: Readonly<Record<string, number>> | undefined;
}

// Rows ------------------------------------------------------------------------------------------

interface OrgRow {
  id: string;
  name: string;
  config: unknown;
  issuer: string;
  issuer_public_key: string;
  issuer_private_key_enc: string;
}

interface Loaded {
  row: OrgRow;
  raw: Record<string, unknown>;
  config: MandateConfig;
  publicKey: KeyObject;
}

interface AgentRow {
  agent_id: string;
  display_name: string;
  credential: unknown;
  created_by: string;
  created_at: string;
}

interface KeyRow {
  id: string;
  agent_id: string;
  prefix: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

interface MemberRow {
  user_id: string;
  email: string;
  role: string;
  added_by: string;
  added_at: string;
}

const KEY_COLUMNS = `id, agent_id, prefix, created_by, ${iso('created_at')} as created_at,
  ${iso('expires_at')} as expires_at, ${iso('last_used_at')} as last_used_at,
  ${iso('revoked_at')} as revoked_at, revoked_by`;

export class OrgStore {
  private readonly clock: () => number;

  constructor(
    private readonly db: Db,
    private readonly encryptionKey: Buffer,
    private readonly mailer: Mailer,
    opts: { clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  // Organisations ------------------------------------------------------------------------------

  async createOrg(user: User, input: CreateOrgInput): Promise<string> {
    const o = createOrgSchema.parse(input);
    const raw: Record<string, unknown> = {
      organisation: o.name,
      base_currency: o.baseCurrency,
      timezone: o.timezone,
      agents: {},
    };
    parseConfigObject(raw);
    const { publicKeyPem, privateKeyPem } = generateKeyPair();
    const id = randomUUID();
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into orgs
           (id, name, config, issuer, issuer_public_key, issuer_private_key_enc, created_by, created_at)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::timestamptz)`,
        [
          id,
          o.name,
          JSON.stringify(raw),
          issuerIdFor(createPublicKey(publicKeyPem)),
          publicKeyPem,
          encryptSecret(privateKeyPem, this.encryptionKey),
          user.userId,
          new Date(now).toISOString(),
        ],
      );
      await tx.query(
        `insert into org_members (org_id, user_id, email, role, added_by, added_at)
         values ($1, $2, $3, 'owner', $2, $4::timestamptz)`,
        [id, user.userId, normalEmail(user.email), new Date(now).toISOString()],
      );
      const loaded = await this.load(tx, id, true);
      const entries: StoredEntry[] = [];
      await this.append(tx, loaded, entries, {
        type: ORG_CREATED,
        agentId: '*',
        now,
        data: {
          by: by(user),
          name: o.name,
          base_currency: o.baseCurrency,
          timezone: o.timezone,
          config_sha256: configHash(raw),
        },
      });
      await this.append(tx, loaded, entries, {
        type: MEMBER_ADDED,
        agentId: '*',
        now,
        data: { by: by(user), user_id: user.userId, email: normalEmail(user.email), role: 'owner' },
      });
    });
    return id;
  }

  async listOrgs(user: User): Promise<OrgSummary[]> {
    const rows = await this.db.query<{ id: string; name: string; role: string; config: unknown }>(
      `select o.id, o.name, m.role, o.config from org_members m join orgs o on o.id = m.org_id
        where m.user_id = $1 order by o.created_at`,
      [user.userId],
    );
    return rows.flatMap((r) =>
      isRole(r.role)
        ? [
            {
              id: r.id,
              name: r.name,
              role: r.role,
              baseCurrency: String(asObject(r.config).base_currency),
            },
          ]
        : [],
    );
  }

  /** The user's role in the organisation, or null (also for an unknown or malformed id). */
  async role(orgId: string, user: User, sql: Sql = this.db): Promise<Role | null> {
    if (!uuid.safeParse(orgId).success) return null;
    const rows = await sql.query<{ role: string }>(
      'select role from org_members where org_id = $1 and user_id = $2',
      [orgId, user.userId],
    );
    const role = rows[0]?.role;
    return isRole(role) ? role : null;
  }

  async view(orgId: string, user: User): Promise<OrgView> {
    const role = await this.require(this.db, orgId, user, 'org.read');
    const loaded = await this.load(this.db, orgId);
    const entries = await this.entries(this.db, orgId);
    const { config, row } = loaded;
    const now = this.clock();
    const controls = foldControls(entries);
    const all = foldPayments(entries);
    const agentRows = await this.db.query<AgentRow>(
      `select agent_id, display_name, credential, created_by, ${iso('created_at')} as created_at
         from org_agents where org_id = $1 order by created_at`,
      [orgId],
    );
    const keys = (
      await this.db.query<KeyRow>(
        `select ${KEY_COLUMNS} from agent_keys where org_id = $1 order by created_at desc`,
        [orgId],
      )
    ).map((k) => keyView(k, now));
    const agents: OrgAgentView[] = agentRows.flatMap((r) => {
      const a = config.agents[r.agent_id];
      if (!a) return [];
      const spend = dailySpend(
        toEngineViews(all.filter((p) => p.agentId === a.id)),
        now,
        config.policy.timezone,
        a.mandate.dailyBudget,
      );
      const human = controls.frozen[a.id];
      return [
        {
          id: a.id,
          displayName: r.display_name,
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
          createdBy: r.created_by,
          createdAt: r.created_at,
          credentialExpires: credentialOf(r.credential)?.claims.expires_at ?? null,
          keys: keys.filter((k) => k.agentId === a.id),
        },
      ];
    });
    const members = (
      await this.db.query<MemberRow>(
        `select user_id, email, role, added_by, ${iso('added_at')} as added_at
           from org_members where org_id = $1 order by added_at`,
        [orgId],
      )
    ).flatMap((m) =>
      isRole(m.role)
        ? [
            {
              userId: m.user_id,
              email: m.email,
              role: m.role,
              addedBy: m.added_by,
              addedAt: m.added_at,
            },
          ]
        : [],
    );
    const invitations = (
      await this.db.query<InvitationRow>(
        `select id, org_id, email, role, invited_by, ${iso('created_at')} as created_at,
                ${iso('expires_at')} as expires_at, ${iso('accepted_at')} as accepted_at,
                ${iso('revoked_at')} as revoked_at
           from org_invitations where org_id = $1 order by created_at desc limit 50`,
        [orgId],
      )
    ).flatMap((i) => {
      if (!isRole(i.role)) return [];
      return [
        {
          id: i.id,
          email: i.email,
          role: i.role,
          invitedBy: i.invited_by,
          createdAt: i.created_at,
          expiresAt: i.expires_at,
          status: invitationStatus(i, now),
        },
      ];
    });
    const newestFirst = [...all].reverse();
    return {
      id: row.id,
      name: row.name,
      role,
      issuer: row.issuer,
      publicKeyPem: row.issuer_public_key,
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
      members,
      invitations,
    };
  }

  async rename(orgId: string, user: User, name: string): Promise<void> {
    const next = createOrgSchema.shape.name.parse(name);
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'org.settings');
      const loaded = await this.load(tx, orgId, true);
      if (loaded.row.name === next) return;
      const raw = { ...loaded.raw, organisation: next };
      parseConfigObject(raw);
      await tx.query('update orgs set name = $1, config = $2::jsonb where id = $3', [
        next,
        JSON.stringify(raw),
        orgId,
      ]);
      const entries = await this.entries(tx, orgId);
      await this.append(tx, loaded, entries, {
        type: ORG_RENAMED,
        agentId: '*',
        now: this.clock(),
        data: { by: by(user), from: loaded.row.name, to: next },
      });
    });
  }

  // Payments: people ----------------------------------------------------------------------------

  async payment(
    orgId: string,
    user: User,
    id: string,
  ): Promise<{
    payment: PaymentRecord;
    receipt: Receipt;
    trace: TraceStep[];
    cancellable: boolean;
  } | null> {
    await this.require(this.db, orgId, user, 'org.read');
    const loaded = await this.load(this.db, orgId);
    const entries = await this.entries(this.db, orgId);
    const payment = foldPayments(entries).find((p) => p.paymentId === id || p.receiptId === id);
    if (!payment) return null;
    const row = entries.find((e) => e.id === payment.receiptId && e.type === PAYMENT_DECISION);
    if (!row) return null;
    const entry = fromStored(row);
    const cancellable =
      payment.status === 'approved' &&
      payment.cancellableUntil !== null &&
      Date.parse(payment.cancellableUntil) > this.clock();
    return {
      payment,
      receipt: toReceipt(loaded.row.issuer, entry),
      trace: (entry.data.trace ?? []) as unknown as TraceStep[],
      cancellable,
    };
  }

  async resolve(
    orgId: string,
    user: User,
    id: string,
    status: 'approved' | 'declined',
    note?: string,
  ): Promise<void> {
    await this.act(
      orgId,
      user,
      'payment.resolve',
      (entries) => planResolve(foldPayments(entries), id, status, this.actor(user, note)).entry,
    );
  }

  async cancel(orgId: string, user: User, id: string, note?: string): Promise<void> {
    await this.act(
      orgId,
      user,
      'payment.cancel',
      (entries) => planCancel(foldPayments(entries), id, this.actor(user, note)).entry,
    );
  }

  async setFrozen(orgId: string, user: User, agentId: string, frozen: boolean): Promise<void> {
    await this.act(orgId, user, 'agent.freeze', (entries, config) => {
      if (!config.agents[agentId]) throw new ActionError(`No agent "${agentId}".`);
      return planFreeze(foldControls(entries), agentId, frozen, this.actor(user));
    });
  }

  async setKillSwitch(orgId: string, user: User, on: boolean, note?: string): Promise<void> {
    await this.act(orgId, user, 'killswitch.set', (entries) =>
      planKillSwitch(foldControls(entries), on, this.actor(user, note)),
    );
  }

  async csv(orgId: string, user: User): Promise<string> {
    await this.require(this.db, orgId, user, 'org.read');
    return csvFromEntries((await this.entries(this.db, orgId)).map(fromStored));
  }

  async publicKey(orgId: string, user: User): Promise<string> {
    await this.require(this.db, orgId, user, 'org.read');
    return (await this.load(this.db, orgId)).row.issuer_public_key;
  }

  async verify(
    orgId: string,
    user: User,
    receiptText: string,
  ): Promise<{ valid: boolean; checks: string[] }> {
    await this.require(this.db, orgId, user, 'org.read');
    const loaded = await this.load(this.db, orgId);
    const receipt = parseReceipt(receiptText);
    const { valid, checks } = verifyReceipt(receipt, loaded.publicKey);
    let ok = valid;
    const entries = await this.entries(this.db, orgId);
    const { seq, hash, prev_hash: prevHash } = receipt.entry;
    const stored = entries.find((e) => e.seq === seq);
    const prev = entries.find((e) => e.seq === seq - 1);
    if (!stored) {
      ok = false;
      checks.push(`✖ this organisation's ledger has no entry #${seq}`);
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

  // Mandate ------------------------------------------------------------------------------------

  /**
   * Replace the mandate. Same validation as mandate.yaml; the base currency, the organisation
   * name and the set of agents stay fixed here (agents are added with createAgent). The ledger
   * records who changed it, what changed, and the old and new hashes.
   */
  async updateConfig(
    orgId: string,
    user: User,
    raw: Record<string, unknown>,
    note?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'mandate.update');
      const loaded = await this.load(tx, orgId, true);
      if (raw.base_currency !== loaded.config.policy.baseCurrency) {
        throw new ConfigError('The base currency of an organisation cannot be changed.');
      }
      const next = { ...raw, organisation: loaded.row.name };
      const parsed = parseConfigObject(next);
      const before = Object.keys(loaded.config.agents).sort().join(',');
      if (Object.keys(parsed.agents).sort().join(',') !== before) {
        throw new ConfigError(
          'Add agents on the Agents page; they cannot be added or removed here.',
        );
      }
      const changes = changedKeys(loaded.raw, next);
      if (changes.length === 0) return;
      await this.writeConfig(tx, loaded, next, {
        type: CONFIG_UPDATED,
        agentId: '*',
        data: { by: by(user), note: cleanNote(note), changes },
      });
    });
  }

  // Agents -------------------------------------------------------------------------------------

  /**
   * Add an agent with a starting mandate and a Know Your Agent credential signed by the
   * organisation's issuer, in the same format as `flow-e credential issue`.
   */
  async createAgent(orgId: string, user: User, input: CreateAgentInput): Promise<string> {
    const a = createAgentSchema.parse(input);
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'agent.create');
      const loaded = await this.load(tx, orgId, true);
      const agents = asObject(loaded.raw.agents ?? {});
      if (Object.hasOwn(agents, a.agentId)) {
        throw new ActionError(`There is already an agent "${a.agentId}".`);
      }
      const next = {
        ...loaded.raw,
        agents: {
          ...agents,
          [a.agentId]: {
            owner: a.owner,
            status: 'active',
            daily_budget: a.dailyBudget,
            per_payment_limit: a.perPaymentLimit,
            ...(a.approvalAbove === undefined ? {} : { approval_above: a.approvalAbove }),
            currencies: [loaded.config.policy.baseCurrency],
            categories: [...new Set(a.categories)],
          },
        },
      };
      parseConfigObject(next);
      const now = this.clock();
      const credential = this.issue(loaded, a.agentId, a.displayName, a.owner, now);
      await tx.query(
        `insert into org_agents (org_id, agent_id, display_name, credential, created_by, created_at)
         values ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)`,
        [
          orgId,
          a.agentId,
          a.displayName,
          JSON.stringify(credential),
          by(user),
          new Date(now).toISOString(),
        ],
      );
      await this.writeConfig(tx, loaded, next, {
        type: AGENT_CREATED,
        agentId: a.agentId,
        data: {
          by: by(user),
          display_name: a.displayName,
          owner: a.owner,
          credential_expires: credential.claims.expires_at,
        },
      });
    });
    return a.agentId;
  }

  /** Pause or resume an agent (its configured status; a freeze is a separate control). */
  async setPaused(orgId: string, user: User, agentId: string, paused: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'mandate.update');
      const loaded = await this.load(tx, orgId, true);
      const agent = loaded.config.agents[agentId];
      if (!agent) throw new ActionError(`No agent "${agentId}".`);
      if ((agent.status === 'paused') === paused) return;
      const agents = asObject(loaded.raw.agents);
      const next = {
        ...loaded.raw,
        agents: {
          ...agents,
          [agentId]: { ...asObject(agents[agentId]), status: paused ? 'paused' : 'active' },
        },
      };
      parseConfigObject(next);
      await this.writeConfig(tx, loaded, next, {
        type: paused ? AGENT_PAUSED : AGENT_RESUMED,
        agentId,
        data: { by: by(user) },
      });
    });
  }

  // Agent keys ---------------------------------------------------------------------------------

  /** A new key for an agent. The key is returned once and only its SHA-256 is stored. */
  async createKey(
    orgId: string,
    user: User,
    agentId: string,
    opts: { expiresInDays: number | null },
  ): Promise<{ id: string; key: string; prefix: string }> {
    const o = keyOptionsSchema.parse(opts);
    return this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'agent.keys');
      const loaded = await this.load(tx, orgId, true);
      return this.insertKey(tx, loaded, user, agentId, o.expiresInDays);
    });
  }

  async revokeKey(orgId: string, user: User, keyId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'agent.keys');
      const loaded = await this.load(tx, orgId, true);
      await this.revokeKeyIn(tx, loaded, user, keyId);
    });
  }

  /** Revoke a key and create its replacement (same agent, same lifetime) in one step. */
  async rotateKey(
    orgId: string,
    user: User,
    keyId: string,
  ): Promise<{ id: string; key: string; prefix: string }> {
    return this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'agent.keys');
      const loaded = await this.load(tx, orgId, true);
      const old = await this.revokeKeyIn(tx, loaded, user, keyId);
      const days =
        old.expires_at === null
          ? null
          : Math.max(
              1,
              Math.min(
                365,
                Math.round((Date.parse(old.expires_at) - Date.parse(old.created_at)) / DAY),
              ),
            );
      return this.insertKey(tx, loaded, user, old.agent_id, days);
    });
  }

  // Members ------------------------------------------------------------------------------------

  /**
   * Invite someone by email. The link (with a one-time token, stored only as its SHA-256)
   * is emailed and also returned once, so the owner can pass it on another way.
   */
  async invite(
    orgId: string,
    user: User,
    input: { email: string; role: string },
    origin: string,
  ): Promise<{ id: string; link: string; emailed: boolean }> {
    const i = inviteSchema.parse(input);
    const { token, hash } = newToken();
    const id = randomUUID();
    const now = this.clock();
    const expiresAt = new Date(now + INVITATION_DAYS * DAY).toISOString();
    const orgName = await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'member.invite');
      const loaded = await this.load(tx, orgId, true);
      const already = await tx.query<{ user_id: string }>(
        'select user_id from org_members where org_id = $1 and lower(email) = $2',
        [orgId, i.email],
      );
      if (already.length > 0) throw new ActionError(`${i.email} is already a member.`);
      await tx.query(
        `insert into org_invitations (id, org_id, email, role, token_hash, invited_by, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [id, orgId, i.email, i.role, hash, by(user), new Date(now).toISOString(), expiresAt],
      );
      const entries = await this.entries(tx, orgId);
      await this.append(tx, loaded, entries, {
        type: MEMBER_INVITED,
        agentId: '*',
        now,
        data: {
          by: by(user),
          invitation_id: id,
          email: i.email,
          role: i.role,
          expires_at: expiresAt,
        },
      });
      return loaded.row.name;
    });
    const link = `${origin}/invite/${token}`;
    const emailed = await this.deliver([
      invitationEmail({
        to: i.email,
        orgName,
        role: i.role,
        invitedBy: user.email,
        link,
        expiresAt,
      }),
    ]);
    return { id, link, emailed: emailed === 1 };
  }

  async revokeInvitation(orgId: string, user: User, invitationId: string): Promise<void> {
    if (!uuid.safeParse(invitationId).success) throw new ActionError('No such invitation.');
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'member.invite');
      const loaded = await this.load(tx, orgId, true);
      const now = this.clock();
      const rows = await tx.query<{ email: string }>(
        `update org_invitations set revoked_at = $3::timestamptz
          where id = $1 and org_id = $2 and accepted_at is null and revoked_at is null
          returning email`,
        [invitationId, orgId, new Date(now).toISOString()],
      );
      const row = rows[0];
      if (!row) throw new ActionError('That invitation was already used or revoked.');
      const entries = await this.entries(tx, orgId);
      await this.append(tx, loaded, entries, {
        type: MEMBER_INVITATION_REVOKED,
        agentId: '*',
        now,
        data: { by: by(user), invitation_id: invitationId, email: row.email },
      });
    });
  }

  /** What an invitation link is for, without accepting it. */
  async invitationPreview(token: string): Promise<{
    orgName: string;
    email: string;
    role: Role;
    status: InvitationView['status'];
  } | null> {
    if (!looksLikeToken(token)) return null;
    const rows = await this.db.query<InvitationRow & { org_name: string }>(
      `select i.id, i.org_id, i.email, i.role, i.invited_by, ${iso('i.created_at')} as created_at,
              ${iso('i.expires_at')} as expires_at, ${iso('i.accepted_at')} as accepted_at,
              ${iso('i.revoked_at')} as revoked_at, o.name as org_name
         from org_invitations i join orgs o on o.id = i.org_id where i.token_hash = $1`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row || !isRole(row.role)) return null;
    return {
      orgName: row.org_name,
      email: row.email,
      role: row.role,
      status: invitationStatus(row, this.clock()),
    };
  }

  /** Accept an invitation as the signed-in user, whose email must be the invited one. */
  async acceptInvitation(token: string, user: User): Promise<string> {
    if (!looksLikeToken(token)) throw new ActionError('This invitation link is not valid.');
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<InvitationRow>(
        `select id, org_id, email, role, invited_by, ${iso('created_at')} as created_at,
                ${iso('expires_at')} as expires_at, ${iso('accepted_at')} as accepted_at,
                ${iso('revoked_at')} as revoked_at
           from org_invitations where token_hash = $1 for update`,
        [sha256(token)],
      );
      const inv = rows[0];
      if (!inv || !isRole(inv.role)) throw new ActionError('This invitation link is not valid.');
      const now = this.clock();
      const status = invitationStatus(inv, now);
      if (status !== 'pending') throw new ActionError(`This invitation was ${status}.`);
      if (normalEmail(user.email) !== normalEmail(inv.email)) {
        throw new ForbiddenError(
          `This invitation is for ${inv.email}. Sign in with that address to accept it.`,
        );
      }
      const loaded = await this.load(tx, inv.org_id, true);
      if (await this.role(inv.org_id, user, tx)) {
        throw new ActionError('You are already a member of this organisation.');
      }
      const at = new Date(now).toISOString();
      await tx.query(
        'update org_invitations set accepted_at = $2::timestamptz, accepted_by = $3 where id = $1',
        [inv.id, at, user.userId],
      );
      await tx.query(
        `insert into org_members (org_id, user_id, email, role, added_by, added_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [inv.org_id, user.userId, normalEmail(user.email), inv.role, inv.invited_by, at],
      );
      const entries = await this.entries(tx, inv.org_id);
      await this.append(tx, loaded, entries, {
        type: MEMBER_ADDED,
        agentId: '*',
        now,
        data: {
          by: by(user),
          user_id: user.userId,
          email: normalEmail(user.email),
          role: inv.role,
          invitation_id: inv.id,
          invited_by: inv.invited_by,
        },
      });
      return inv.org_id;
    });
  }

  async changeRole(orgId: string, user: User, memberId: string, role: string): Promise<void> {
    if (!isRole(role)) throw new ActionError('Choose owner, approver or viewer.');
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'member.manage');
      const loaded = await this.load(tx, orgId, true);
      const member = await this.member(tx, orgId, memberId);
      if (member.role === role) return;
      if (member.role === 'owner') await this.keepAnOwner(tx, orgId);
      await tx.query('update org_members set role = $3 where org_id = $1 and user_id = $2', [
        orgId,
        memberId,
        role,
      ]);
      const entries = await this.entries(tx, orgId);
      await this.append(tx, loaded, entries, {
        type: MEMBER_ROLE_CHANGED,
        agentId: '*',
        now: this.clock(),
        data: { by: by(user), user_id: memberId, email: member.email, from: member.role, to: role },
      });
    });
  }

  async removeMember(orgId: string, user: User, memberId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, 'member.manage');
      const loaded = await this.load(tx, orgId, true);
      const member = await this.member(tx, orgId, memberId);
      if (member.role === 'owner') await this.keepAnOwner(tx, orgId);
      await tx.query('delete from org_members where org_id = $1 and user_id = $2', [
        orgId,
        memberId,
      ]);
      const entries = await this.entries(tx, orgId);
      await this.append(tx, loaded, entries, {
        type: MEMBER_REMOVED,
        agentId: '*',
        now: this.clock(),
        data: { by: by(user), user_id: memberId, email: member.email, role: member.role },
      });
    });
  }

  // Approval links -----------------------------------------------------------------------------

  /**
   * What an approval link would do, for the confirm page. Only the person it was sent to sees
   * the payment; everyone else gets null.
   */
  async approvalPreview(token: string, user: User): Promise<ApprovalPreview | { error: string }> {
    const t = await this.approvalToken(this.db, token);
    if (!t) return { error: 'This link is not valid.' };
    if (t.user_id !== user.userId) {
      return { error: `This link was sent to ${t.email}. Sign in with that address to use it.` };
    }
    if (t.used_at) return { error: 'This link was already used.' };
    if (Date.parse(t.expires_at) <= this.clock()) return { error: 'This link has expired.' };
    const loaded = await this.load(this.db, t.org_id);
    const payment = foldPayments(await this.entries(this.db, t.org_id)).find(
      (p) => p.paymentId === t.payment_id,
    );
    if (!payment) return { error: 'This link is not valid.' };
    return {
      orgId: t.org_id,
      orgName: loaded.row.name,
      action: t.action,
      payment,
      baseCurrency: loaded.config.policy.baseCurrency,
      currencyDecimals: loaded.config.policy.currencyDecimals,
    };
  }

  /**
   * Use an approval link (POST only). Re-checks everything at this moment: the link, that the
   * signed-in user is its recipient, their current role, and that the payment still waits.
   */
  async confirmApproval(
    token: string,
    user: User,
    note?: string,
  ): Promise<{ orgId: string; paymentId: string; status: 'approved' | 'declined' }> {
    return this.db.transaction(async (tx) => {
      const t = await this.approvalToken(tx, token, true);
      if (!t) throw new ActionError('This link is not valid.');
      if (t.user_id !== user.userId) {
        throw new ForbiddenError(`This link was sent to ${t.email}. Sign in with that address.`);
      }
      if (t.used_at) throw new ActionError('This link was already used.');
      const now = this.clock();
      if (Date.parse(t.expires_at) <= now) throw new ActionError('This link has expired.');
      await this.require(tx, t.org_id, user, 'payment.resolve');
      const loaded = await this.load(tx, t.org_id, true);
      const entries = await this.entries(tx, t.org_id);
      const status = t.action === 'approve' ? 'approved' : 'declined';
      const plan = planResolve(foldPayments(entries), t.payment_id, status, {
        by: `${by(user)} (email link)`.slice(0, 100),
        note,
        now,
      });
      await this.append(tx, loaded, entries, plan.entry);
      // Every link for this payment is spent now: the decision has been made.
      await tx.query(
        `update approval_tokens set used_at = $3::timestamptz
          where org_id = $1 and payment_id = $2 and used_at is null`,
        [t.org_id, t.payment_id, new Date(now).toISOString()],
      );
      return { orgId: t.org_id, paymentId: t.payment_id, status };
    });
  }

  // Agents over MCP ----------------------------------------------------------------------------

  /** The organisation and agent an API key belongs to, or null. Records when it was used. */
  async authenticateAgent(key: string): Promise<AgentAuth | null> {
    if (!looksLikeAgentKey(key)) return null;
    const rows = await this.db.query<{
      id: string;
      org_id: string;
      agent_id: string;
      expires_at: string | null;
      revoked_at: string | null;
    }>(
      `select id, org_id, agent_id, ${iso('expires_at')} as expires_at, ${iso('revoked_at')} as revoked_at
         from agent_keys where key_hash = $1`,
      [sha256(key)],
    );
    const row = rows[0];
    const now = this.clock();
    if (!row || row.revoked_at !== null) return null;
    if (row.expires_at !== null && Date.parse(row.expires_at) <= now) return null;
    await this.db.query('update agent_keys set last_used_at = $2::timestamptz where id = $1', [
      row.id,
      new Date(now).toISOString(),
    ]);
    return { orgId: row.org_id, agentId: row.agent_id, keyId: row.id };
  }

  /** check_mandate. */
  async checkMandate(auth: AgentAuth) {
    const loaded = await this.load(this.db, auth.orgId);
    const agent = loaded.config.agents[auth.agentId];
    if (!agent) throw new ConfigError(`Agent "${auth.agentId}" no longer has a mandate.`);
    const entries = await this.entries(this.db, auth.orgId);
    const agentRow = await this.agentRow(this.db, auth.orgId, auth.agentId);
    return mandateSummary({
      config: loaded.config,
      agent,
      controls: foldControls(entries),
      credential: credentialOf(agentRow?.credential),
      spend: dailySpend(
        toEngineViews(foldPayments(entries, agent.id)),
        this.clock(),
        loaded.config.policy.timezone,
        agent.mandate.dailyBudget,
      ),
    });
  }

  /**
   * request_payment: evaluate and record in one transaction with the organisation row locked,
   * so a freeze or kill switch that lands first always wins. A payment that needs review emails
   * every owner and approver one-time Approve and Decline links, after the commit.
   * Throws AmountError for an amount the currency cannot hold (nothing recorded).
   */
  async requestPayment(auth: AgentAuth, args: RequestPaymentArgs, origin: string) {
    const { answer, emails } = await this.db.transaction(async (tx) => {
      const loaded = await this.load(tx, auth.orgId, true);
      const { config, row } = loaded;
      const agent = config.agents[auth.agentId];
      if (!agent) throw new ConfigError(`Agent "${auth.agentId}" no longer has a mandate.`);
      const request = toPaymentRequest(args, config.policy.currencyDecimals);
      const credential = await this.freshCredential(tx, loaded, auth.agentId);
      const entries = await this.entries(tx, auth.orgId);
      const controls = foldControls(entries);
      const now = this.clock();
      const result = evaluate(
        {
          id: agent.id,
          status: effectiveStatus(agent.status, controls, agent.id),
          credential,
        },
        agent.mandate,
        request,
        {
          now,
          killSwitch: controls.killSwitch?.on === true,
          ledger: toEngineViews(foldPayments(entries, agent.id)),
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
        now,
        data: decisionData({
          paymentId,
          request,
          result,
          baseCurrency: config.policy.baseCurrency,
        }),
      });
      const answer = paymentAnswer({
        paymentId,
        receiptId: receipt.entry.id,
        request,
        result,
        baseCurrency: config.policy.baseCurrency,
        currencyDecimals: config.policy.currencyDecimals,
      });
      const emails: EmailMessage[] = [];
      if (result.decision === 'review') {
        const deciders = await tx.query<{ user_id: string; email: string; role: string }>(
          `select user_id, email, role from org_members where org_id = $1 order by added_at`,
          [auth.orgId],
        );
        const agentRow = await this.agentRow(tx, auth.orgId, agent.id);
        for (const d of deciders) {
          if (!isRole(d.role) || !can(d.role, 'payment.resolve')) continue;
          const links = await this.approvalLinks(tx, auth.orgId, paymentId, d, now, origin);
          emails.push(
            approvalEmail({
              to: d.email,
              orgName: row.name,
              agent: agentRow ? `${agentRow.display_name} (${agent.id})` : agent.id,
              supplier: request.merchant,
              amount: formatMoney(request.amount, request.currency, config.policy.currencyDecimals),
              reason: result.reason,
              paymentId,
              approveLink: links.approve,
              declineLink: links.decline,
            }),
          );
        }
      }
      return { answer, emails };
    });
    await this.deliver(emails);
    return answer;
  }

  /** get_payment: only this agent's payments. */
  async agentPayment(auth: AgentAuth, id: string) {
    const loaded = await this.load(this.db, auth.orgId);
    const payment = foldPayments(await this.entries(this.db, auth.orgId), auth.agentId).find(
      (p) => p.paymentId === id || p.receiptId === id,
    );
    return payment ? publicPayment(payment, loaded.config.policy.currencyDecimals) : null;
  }

  /** list_payments: this agent's most recent payments, newest first. */
  async agentPayments(auth: AgentAuth, limit: number) {
    const loaded = await this.load(this.db, auth.orgId);
    const payments = foldPayments(await this.entries(this.db, auth.orgId), auth.agentId)
      .reverse()
      .slice(0, limit);
    return payments.map((p) => publicPayment(p, loaded.config.policy.currencyDecimals));
  }

  // Internals ----------------------------------------------------------------------------------

  private actor(user: User, note?: string): Actor {
    return { by: by(user), note, now: this.clock() };
  }

  /** The user's role, checked against a permission. Throws ForbiddenError. */
  private async require(
    sql: Sql,
    orgId: string,
    user: User,
    permission: Permission,
  ): Promise<Role> {
    const role = await this.role(orgId, user, sql);
    assertCan(role, permission);
    return role as Role;
  }

  private async act(
    orgId: string,
    user: User,
    permission: Permission,
    plan: (entries: StoredEntry[], config: MandateConfig) => EntryInput | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.require(tx, orgId, user, permission);
      const loaded = await this.load(tx, orgId, true);
      const entries = await this.entries(tx, orgId);
      const entry = plan(entries, loaded.config);
      if (entry) await this.append(tx, loaded, entries, entry);
    });
  }

  private async writeConfig(
    tx: Sql,
    loaded: Loaded,
    next: Record<string, unknown>,
    entry: { type: string; agentId: string; data: EntryInput['data'] },
  ): Promise<void> {
    await tx.query('update orgs set config = $1::jsonb where id = $2', [
      JSON.stringify(next),
      loaded.row.id,
    ]);
    const entries = await this.entries(tx, loaded.row.id);
    await this.append(tx, loaded, entries, {
      type: entry.type,
      agentId: entry.agentId,
      now: this.clock(),
      data: {
        ...entry.data,
        old_config_sha256: configHash(loaded.raw),
        new_config_sha256: configHash(next),
      },
    });
  }

  private async insertKey(
    tx: Sql,
    loaded: Loaded,
    user: User,
    agentId: string,
    expiresInDays: number | null,
  ): Promise<{ id: string; key: string; prefix: string }> {
    if (!(await this.agentRow(tx, loaded.row.id, agentId))) {
      throw new ActionError(`No agent "${agentId}".`);
    }
    const now = this.clock();
    const active = await tx.query<{ n: number }>(
      `select count(*)::int as n from agent_keys
        where org_id = $1 and agent_id = $2 and revoked_at is null
          and (expires_at is null or expires_at > $3::timestamptz)`,
      [loaded.row.id, agentId, new Date(now).toISOString()],
    );
    if ((active[0]?.n ?? 0) >= MAX_ACTIVE_KEYS) {
      throw new ActionError(
        `An agent can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
      );
    }
    const { key, hash, prefix } = newAgentKey();
    const id = randomUUID();
    const expiresAt =
      expiresInDays === null ? null : new Date(now + expiresInDays * DAY).toISOString();
    await tx.query(
      `insert into agent_keys (id, org_id, agent_id, prefix, key_hash, created_by, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
      [id, loaded.row.id, agentId, prefix, hash, by(user), new Date(now).toISOString(), expiresAt],
    );
    const entries = await this.entries(tx, loaded.row.id);
    await this.append(tx, loaded, entries, {
      type: AGENT_KEY_CREATED,
      agentId,
      now,
      data: { by: by(user), key_id: id, prefix, expires_at: expiresAt },
    });
    return { id, key, prefix };
  }

  private async revokeKeyIn(tx: Sql, loaded: Loaded, user: User, keyId: string): Promise<KeyRow> {
    if (!uuid.safeParse(keyId).success) throw new ActionError('No such key.');
    const rows = await tx.query<KeyRow>(
      `select ${KEY_COLUMNS} from agent_keys where id = $1 and org_id = $2 for update`,
      [keyId, loaded.row.id],
    );
    const row = rows[0];
    if (!row) throw new ActionError('No such key.');
    if (row.revoked_at !== null) throw new ActionError('That key is already revoked.');
    const now = this.clock();
    await tx.query(
      'update agent_keys set revoked_at = $2::timestamptz, revoked_by = $3 where id = $1',
      [keyId, new Date(now).toISOString(), by(user)],
    );
    const entries = await this.entries(tx, loaded.row.id);
    await this.append(tx, loaded, entries, {
      type: AGENT_KEY_REVOKED,
      agentId: row.agent_id,
      now,
      data: { by: by(user), key_id: keyId, prefix: row.prefix },
    });
    return row;
  }

  private async member(
    tx: Sql,
    orgId: string,
    memberId: string,
  ): Promise<MemberRow & { role: Role }> {
    const rows = await tx.query<MemberRow>(
      `select user_id, email, role, added_by, ${iso('added_at')} as added_at
         from org_members where org_id = $1 and user_id = $2 for update`,
      [orgId, memberId],
    );
    const m = rows[0];
    if (!m || !isRole(m.role)) throw new ActionError('That person is not a member.');
    return { ...m, role: m.role };
  }

  /** Throws when removing or demoting one owner would leave none. */
  private async keepAnOwner(tx: Sql, orgId: string): Promise<void> {
    const rows = await tx.query<{ n: number }>(
      `select count(*)::int as n from org_members where org_id = $1 and role = 'owner'`,
      [orgId],
    );
    if ((rows[0]?.n ?? 0) <= 1) {
      throw new ActionError(
        'An organisation needs at least one owner. Make someone else owner first.',
      );
    }
  }

  private async approvalLinks(
    tx: Sql,
    orgId: string,
    paymentId: string,
    to: { user_id: string; email: string },
    now: number,
    origin: string,
  ): Promise<{ approve: string; decline: string }> {
    const expires = new Date(now + APPROVAL_HOURS * 3_600_000).toISOString();
    const links = { approve: '', decline: '' };
    for (const action of ['approve', 'decline'] as const) {
      const { token, hash } = newToken();
      await tx.query(
        `insert into approval_tokens
           (id, org_id, payment_id, user_id, email, action, token_hash, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
        [
          randomUUID(),
          orgId,
          paymentId,
          to.user_id,
          to.email,
          action,
          hash,
          new Date(now).toISOString(),
          expires,
        ],
      );
      links[action] = `${origin}/approve/${token}`;
    }
    return links;
  }

  private async approvalToken(
    sql: Sql,
    token: string,
    forUpdate = false,
  ): Promise<{
    org_id: string;
    payment_id: string;
    user_id: string;
    email: string;
    action: 'approve' | 'decline';
    expires_at: string;
    used_at: string | null;
  } | null> {
    if (!looksLikeToken(token)) return null;
    const rows = await sql.query<{
      org_id: string;
      payment_id: string;
      user_id: string;
      email: string;
      action: 'approve' | 'decline';
      expires_at: string;
      used_at: string | null;
    }>(
      `select org_id, payment_id, user_id, email, action, ${iso('expires_at')} as expires_at,
              ${iso('used_at')} as used_at
         from approval_tokens where token_hash = $1${forUpdate ? ' for update' : ''}`,
      [sha256(token)],
    );
    return rows[0] ?? null;
  }

  /** Send after commit. Returns how many were sent; a failure is logged without content. */
  private async deliver(messages: EmailMessage[]): Promise<number> {
    let sent = 0;
    for (const m of messages) {
      try {
        await this.mailer.send(m);
        sent += 1;
      } catch (err) {
        console.error('email not sent', m.kind, err instanceof Error ? err.name : 'unknown');
      }
    }
    return sent;
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
      `insert into org_ledger_entries
         (org_id, seq, id, type, agent_id, created_at, data, prev_hash, hash, signature)
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

  private async entries(sql: Sql, orgId: string): Promise<StoredEntry[]> {
    return sql.query<StoredEntry>(
      `select seq, id, type, agent_id, created_at, data, prev_hash, hash, signature
         from org_ledger_entries where org_id = $1 order by seq`,
      [orgId],
    );
  }

  private async load(sql: Sql, orgId: string, forUpdate = false): Promise<Loaded> {
    if (!uuid.safeParse(orgId).success) throw new ForbiddenError('No such organisation.');
    const rows = await sql.query<OrgRow>(
      `select id, name, config, issuer, issuer_public_key, issuer_private_key_enc
         from orgs where id = $1${forUpdate ? ' for update' : ''}`,
      [orgId],
    );
    const row = rows[0];
    if (!row) throw new ForbiddenError('No such organisation.');
    const raw = asObject(row.config);
    return {
      row,
      raw,
      config: parseConfigObject(raw),
      publicKey: createPublicKey(row.issuer_public_key),
    };
  }

  private async agentRow(sql: Sql, orgId: string, agentId: string): Promise<AgentRow | undefined> {
    const rows = await sql.query<AgentRow>(
      `select agent_id, display_name, credential, created_by, ${iso('created_at')} as created_at
         from org_agents where org_id = $1 and agent_id = $2`,
      [orgId, agentId],
    );
    return rows[0];
  }

  /** The agent's credential, reissued when missing or within a day of expiry. */
  private async freshCredential(
    tx: Sql,
    loaded: Loaded,
    agentId: string,
  ): Promise<CredentialFile | null> {
    const row = await this.agentRow(tx, loaded.row.id, agentId);
    const agent = loaded.config.agents[agentId];
    if (!row || !agent) return null;
    const now = this.clock();
    const current = credentialOf(row.credential);
    if (current && Date.parse(current.claims.expires_at) > now + DAY) return current;
    const next = this.issue(loaded, agentId, row.display_name, agent.owner, now);
    await tx.query(
      'update org_agents set credential = $3::jsonb where org_id = $1 and agent_id = $2',
      [loaded.row.id, agentId, JSON.stringify(next)],
    );
    return next;
  }

  private issue(
    loaded: Loaded,
    agentId: string,
    agentName: string,
    owner: string,
    now: number,
  ): CredentialFile {
    return issueCredential({
      privateKey: createPrivateKey(
        decryptSecret(loaded.row.issuer_private_key_enc, this.encryptionKey),
      ),
      publicKey: loaded.publicKey,
      agentId,
      agentName,
      owner,
      organisation: loaded.row.name,
      scope: [PAYMENT_SCOPE],
      now,
      validDays: CREDENTIAL_DAYS,
    });
  }
}

// Helpers ---------------------------------------------------------------------------------------

function by(user: User): string {
  return normalEmail(user.email).slice(0, 100);
}

function normalEmail(e: string): string {
  return e.trim().toLowerCase();
}

function cleanNote(note: string | undefined): string | null {
  const n = note?.trim() ?? '';
  if (n.length > 500) throw new ActionError('Notes are limited to 500 characters.');
  return n === '' ? null : n;
}

function configHash(raw: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex');
}

/** The mandate with schema defaults filled in, so an unchanged default is not a change. */
function normalised(raw: Record<string, unknown>): Record<string, unknown> {
  const r = configSchema.safeParse(raw);
  return r.success ? r.data : raw;
}

/** Top-level keys, and agents by id, whose value differs. */

function changedKeys(
  rawBefore: Record<string, unknown>,
  rawAfter: Record<string, unknown>,
): string[] {
  const before = normalised(rawBefore);
  const after = normalised(rawAfter);
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: string[] = [];
  for (const k of keys) {
    if (k === 'agents') {
      const a = asObject(before.agents ?? {});
      const b = asObject(after.agents ?? {});
      for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!same(a[id], b[id])) changes.push(`agents.${id}`);
      }
    } else if (!same(before[k], after[k])) {
      changes.push(k);
    }
  }
  return changes;
}

function credentialOf(value: unknown): CredentialFile | null {
  if (value === null || value === undefined) return null;
  try {
    return parseCredential(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return null;
  }
}

function keyView(k: KeyRow, now: number): KeyView {
  const status =
    k.revoked_at !== null
      ? 'revoked'
      : k.expires_at !== null && Date.parse(k.expires_at) <= now
        ? 'expired'
        : 'active';
  return {
    id: k.id,
    agentId: k.agent_id,
    prefix: k.prefix,
    createdBy: k.created_by,
    createdAt: k.created_at,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
    revokedBy: k.revoked_by,
    status,
  };
}

function invitationStatus(
  i: Pick<InvitationRow, 'accepted_at' | 'revoked_at' | 'expires_at'>,
  now: number,
): InvitationView['status'] {
  if (i.accepted_at !== null) return 'accepted';
  if (i.revoked_at !== null) return 'revoked';
  if (Date.parse(i.expires_at) <= now) return 'expired';
  return 'pending';
}

function asObject(value: unknown): Record<string, unknown> {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError('Stored organisation data is not an object.');
  }
  return v as Record<string, unknown>;
}
