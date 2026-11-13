import 'server-only';
import path from 'node:path';
import { migrate, openPglite, openPostgres, type Db } from './db';
import { mailerFromEnv } from './email';
import { encryptionKeyFromEnv } from './keys';
import { OrgStore } from './org-store';
import { ApiKeyStore } from './api-keys';
import { ReorderStore } from './reorder';
import { WebhookStore } from './webhooks';
import { SandboxStore } from './store';
import { mandateEnv } from './env';

/**
 * One database and one set of stores per server process. Storage is chosen by environment:
 * - DATABASE_URL set: Postgres (Supabase). Apply db/migrations/*.sql there yourself.
 * - otherwise: PGlite in MANDATE_PGLITE_DIR (default web/.data/pglite), migrated on start.
 */

interface Stores {
  db: Db;
  sandbox: SandboxStore;
  orgs: OrgStore;
}

const globalForStore = globalThis as unknown as { mandateStores?: Promise<Stores> };

async function open(): Promise<Stores> {
  const key = encryptionKeyFromEnv();
  let db: Db;
  if (process.env.DATABASE_URL) {
    db = await openPostgres(process.env.DATABASE_URL);
  } else {
    if (process.env.NODE_ENV === 'production' && !mandateEnv('ALLOW_PGLITE')) {
      throw new Error('DATABASE_URL is not set. Production needs Postgres (see web/README.md).');
    }
    db = await openPglite(mandateEnv('PGLITE_DIR') ?? path.join(process.cwd(), '.data', 'pglite'));
    await migrate(db);
  }
  return {
    db,
    sandbox: new SandboxStore(db, key),
    orgs: new OrgStore(db, key, mailerFromEnv(db)),
  };
}

/** Survives hot reloads in development, so PGlite opens its data directory once. */
function stores(): Promise<Stores> {
  globalForStore.mandateStores ??= open().catch((err: unknown) => {
    globalForStore.mandateStores = undefined;
    throw err;
  });
  return globalForStore.mandateStores;
}

export async function getStore(): Promise<SandboxStore> {
  return (await stores()).sandbox;
}

export async function getOrgStore(): Promise<OrgStore> {
  return (await stores()).orgs;
}

export async function getDb(): Promise<Db> {
  return (await stores()).db;
}

export async function getReorderStore(): Promise<ReorderStore> {
  const { db, orgs } = await stores();
  return new ReorderStore(db, orgs);
}

export async function getApiKeyStore(): Promise<ApiKeyStore> {
  const { db, orgs } = await stores();
  return new ApiKeyStore(db, orgs);
}

export async function getWebhookStore(): Promise<WebhookStore> {
  const { db, orgs } = await stores();
  return new WebhookStore(db, orgs, encryptionKeyFromEnv());
}

/** Everything the /api/v1 routes need; the rate limiter lives in each route module. */
export async function getV1Stores() {
  const { db, orgs } = await stores();
  return { keys: new ApiKeyStore(db, orgs), orgs, reorder: new ReorderStore(db, orgs) };
}
