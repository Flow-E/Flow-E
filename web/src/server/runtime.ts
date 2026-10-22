import 'server-only';
import path from 'node:path';
import { migrate, openPglite, openPostgres, type Db } from './db';
import { parseEncryptionKey } from './keys';
import { SandboxStore } from './store';

/**
 * One store per server process. Storage is chosen by environment:
 * - DATABASE_URL set: Postgres (Supabase). Apply db/migrations/*.sql there yourself.
 * - otherwise: PGlite in FLOWE_PGLITE_DIR (default web/.data/pglite), migrated on start.
 */

const globalForStore = globalThis as unknown as { floweStore?: Promise<SandboxStore> };

async function open(): Promise<SandboxStore> {
  const key = parseEncryptionKey(process.env.FLOWE_SANDBOX_KEY);
  let db: Db;
  if (process.env.DATABASE_URL) {
    db = await openPostgres(process.env.DATABASE_URL);
  } else {
    if (process.env.NODE_ENV === 'production' && !process.env.FLOWE_ALLOW_PGLITE) {
      throw new Error('DATABASE_URL is not set. Production needs Postgres (see web/README.md).');
    }
    db = await openPglite(
      process.env.FLOWE_PGLITE_DIR ?? path.join(process.cwd(), '.data', 'pglite'),
    );
    await migrate(db);
  }
  return new SandboxStore(db, key);
}

/** Survives hot reloads in development, so PGlite opens its data directory once. */
export function getStore(): Promise<SandboxStore> {
  globalForStore.floweStore ??= open().catch((err: unknown) => {
    globalForStore.floweStore = undefined;
    throw err;
  });
  return globalForStore.floweStore;
}
