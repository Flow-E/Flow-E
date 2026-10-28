import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import type { Db } from './db';
import type { OrgStore, User } from './org-store';
import { assertCan } from './permissions';
import { sha256 } from './tokens';

/**
 * Organisation API keys, for systems around Flow-E (an inventory system, accounting). Separate
 * from agent keys: an organisation key can never ask for a payment, approve or change anything
 * in the mandate. Two scopes: `reorder:write` (send reorder signals) and `read` (orders,
 * payments, receipts). Only the SHA-256 of a key is stored; the key is shown once.
 */

export const API_SCOPES = ['reorder:write', 'read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_LABEL: Record<ApiScope, string> = {
  'reorder:write': 'Send reorder signals',
  read: 'Read orders, payments and receipts',
};

export const API_KEY_PREFIX = 'flowe_ok_';
const VISIBLE = API_KEY_PREFIX.length + 6;
export const MAX_API_KEYS = 10;
export const ACCESS_LOG_DAYS = 90;
const DAY = 86_400_000;

const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export function looksLikeApiKey(text: string): boolean {
  return /^flowe_ok_[A-Za-z0-9_-]{43}$/.test(text);
}

export const createKeySchema = z.object({
  name: z.string().trim().min(1, 'Name the key, e.g. "Inventory system".').max(80),
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, 'Choose at least one permission.')
    .transform((s) => [...new Set(s)].sort()),
});

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiCaller {
  orgId: string;
  keyId: string;
  name: string;
  scopes: ApiScope[];
}

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[] | string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Postgres arrays come back as arrays from postgres.js and as "{a,b}" text from some drivers. */
function scopesOf(v: string[] | string): ApiScope[] {
  const list = Array.isArray(v)
    ? v
    : v
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter(Boolean);
  return list.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s));
}

export class ApiKeyStore {
  private readonly clock: () => number;

  constructor(
    private readonly db: Db,
    private readonly orgs: OrgStore,
    opts: { clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? Date.now;
  }

  async list(orgId: string, user: User): Promise<ApiKeyView[]> {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    const rows = await this.db.query<KeyRow>(
      `select id, name, prefix, scopes, created_by, ${iso('created_at')} as created_at,
              ${iso('last_used_at')} as last_used_at, ${iso('revoked_at')} as revoked_at
         from org_api_keys where org_id = $1 order by created_at desc`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: scopesOf(r.scopes),
      createdBy: r.created_by,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
  }

  /** Returns the key once; only its hash is kept. */
  async create(
    orgId: string,
    user: User,
    input: z.input<typeof createKeySchema>,
  ): Promise<{ id: string; key: string }> {
    assertCan(await this.orgs.role(orgId, user), 'integrations.manage');
    const parsed = createKeySchema.safeParse(input);
    if (!parsed.success) throw new ActionError(parsed.error.issues[0]?.message ?? 'Not valid.');
    const active = await this.db.query<{ n: string | number }>(
      'select count(*) as n from org_api_keys where org_id = $1 and revoked_at is null',
      [orgId],
    );
    if (Number(active[0]?.n ?? 0) >= MAX_API_KEYS) {
      throw new ActionError(`At most ${String(MAX_API_KEYS)} active keys. Revoke one first.`);
    }
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    await this.db.query(
      `insert into org_api_keys (id, org_id, name, prefix, key_hash, scopes, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6::text[], $7, $8::timestamptz)`,
      [
        id,
        orgId,
        parsed.data.name,
        key.slice(0, VISIBLE),
        sha256(key),
        `{${parsed.data.scopes.join(',')}}`,
        user.email.trim().toLowerCase().slice(0, 100),
        new Date(this.clock()).toISOString(),
      ],
    );
    return { id, key };
  }

  /** Takes effect at once: the next call with the key is refused. */
  async revoke(orgId: string, user: User, keyId: string): Promise<void> {
    assertCan(await this.orgs.role(orgId, user), 'integrations.manage');
    if (!z.uuid().safeParse(keyId).success) throw new ActionError('No such key.');
    const rows = await this.db.query<{ id: string }>(
      `update org_api_keys set revoked_at = $3::timestamptz
        where id = $1 and org_id = $2 and revoked_at is null returning id`,
      [keyId, orgId, new Date(this.clock()).toISOString()],
    );
    if (rows.length === 0) throw new ActionError('No such key, or it is already revoked.');
  }

  /** The caller behind a bearer key, or null for a malformed, unknown or revoked key. */
  async authenticate(key: string): Promise<ApiCaller | null> {
    if (!looksLikeApiKey(key)) return null;
    const rows = await this.db.query<{
      id: string;
      org_id: string;
      name: string;
      scopes: string[] | string;
    }>(
      `select id, org_id, name, scopes from org_api_keys
        where key_hash = $1 and revoked_at is null`,
      [sha256(key)],
    );
    const row = rows[0];
    if (!row) return null;
    await this.db.query('update org_api_keys set last_used_at = $2::timestamptz where id = $1', [
      row.id,
      new Date(this.clock()).toISOString(),
    ]);
    return { orgId: row.org_id, keyId: row.id, name: row.name, scopes: scopesOf(row.scopes) };
  }

  /** One row per call: method, path and status. Never the key, the body or the address. */
  async logAccess(caller: ApiCaller, method: string, path: string, status: number): Promise<void> {
    await this.db.query(
      `insert into org_api_access_log (id, org_id, key_id, method, path, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [
        randomUUID(),
        caller.orgId,
        caller.keyId,
        method.slice(0, 10),
        path.slice(0, 200),
        status,
        new Date(this.clock()).toISOString(),
      ],
    );
  }

  async accessLog(orgId: string, user: User, limit = 50) {
    assertCan(await this.orgs.role(orgId, user), 'org.read');
    return this.db.query<{
      method: string;
      path: string;
      status: number;
      created_at: string;
      key_name: string;
    }>(
      `select l.method, l.path, l.status, ${iso('l.created_at')} as created_at, k.name as key_name
         from org_api_access_log l join org_api_keys k on k.id = l.key_id
        where l.org_id = $1 order by l.created_at desc limit $2`,
      [orgId, Math.min(Math.max(limit, 1), 200)],
    );
  }

  /** Delete access-log rows older than ACCESS_LOG_DAYS (every organisation). */
  async purgeAccessLog(): Promise<void> {
    await this.db.query('delete from org_api_access_log where created_at < $1::timestamptz', [
      new Date(this.clock() - ACCESS_LOG_DAYS * DAY).toISOString(),
    ]);
  }
}
