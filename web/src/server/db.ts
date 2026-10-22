import 'server-only';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A tiny database interface with two implementations: PGlite (embedded Postgres, for local
 * development and tests) and postgres.js (Supabase or any Postgres, for deployment).
 */

export interface Sql {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Sql {
  /** Run `fn` in one transaction; it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

/** Apply every migration file in order (all are idempotent). Used for PGlite only. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<void> {
  const files = (await readdir(/*turbopackIgnore: true*/ dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    // Local development and tests only (PGlite); deployments apply migrations themselves.
    const text = await readFile(path.join(/*turbopackIgnore: true*/ dir, file), 'utf8');
    await db.query(text);
  }
}

/** Embedded Postgres in this process. `dataDir` undefined = in memory (tests). */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  // PGlite creates its own folder but not missing parents (e.g. web/.data).
  if (dataDir) await mkdir(/*turbopackIgnore: true*/ path.dirname(dataDir), { recursive: true });
  const pg = await PGlite.create(dataDir);
  const wrap = (q: { query: typeof pg.query; exec: typeof pg.exec }): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      if (params === undefined || params.length === 0) {
        // exec allows multiple statements (migrations); return the last result's rows.
        const results = await q.exec(text);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await q.query<T>(text, params)).rows;
    },
  });
  const base = wrap(pg);
  return {
    query: base.query.bind(base),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}

/** A Postgres server (e.g. Supabase). `prepare: false` keeps it compatible with poolers. */
export async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 5, prepare: false, idle_timeout: 20 });
  type Unsafe = (text: string, params?: never[]) => Promise<unknown[]>;
  const wrap = (s: { unsafe: Unsafe }): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      return (await s.unsafe(text, (params ?? []) as never[])) as T[];
    },
  });
  const base = wrap(sql);
  return {
    query: base.query.bind(base),
    transaction: async <T>(fn: (tx: Sql) => Promise<T>) =>
      (await sql.begin((tx) => fn(wrap(tx as unknown as { unsafe: Unsafe })))) as T,
    close: () => sql.end({ timeout: 5 }),
  };
}
