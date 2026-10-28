import 'server-only';
import { createPublicKey } from 'node:crypto';
import { issuerIdFor } from '@flow-e/mcp/core';
import type { Sql } from './db';

/**
 * Each issuer's public key, published at /keys/<issuer>.pub (PEM) and /keys/<issuer>.json (the
 * key plus the name the organisation signs under). Public on purpose: anyone holding a receipt
 * can check it with this key, here or offline with `flow-e verify`. A public key reveals nothing
 * secret. Only keys whose issuer id matches the key itself are published.
 */

export const ISSUER_PATTERN = /^flow-e-issuer:[0-9a-f]{16}$/;

export interface PublishedKey {
  issuer: string;
  /** The organisation's name; null for a sandbox, which is fictional by definition. */
  organisation: string | null;
  kind: 'organisation' | 'sandbox';
  publicKeyPem: string;
}

export async function publishedKey(sql: Sql, issuer: string): Promise<PublishedKey | null> {
  if (!ISSUER_PATTERN.test(issuer)) return null;
  const orgs = await sql.query<{ name: string; issuer_public_key: string }>(
    'select name, issuer_public_key from orgs where issuer = $1 limit 1',
    [issuer],
  );
  // Archived sandboxes too: a receipt from before "Start over" is still genuine.
  const boxes = orgs[0]
    ? []
    : await sql.query<{ issuer_public_key: string }>(
        'select issuer_public_key from sandboxes where issuer = $1 limit 1',
        [issuer],
      );
  const found = orgs[0]
    ? { organisation: orgs[0].name, kind: 'organisation' as const, pem: orgs[0].issuer_public_key }
    : boxes[0]
      ? { organisation: null, kind: 'sandbox' as const, pem: boxes[0].issuer_public_key }
      : null;
  if (!found) return null;
  try {
    if (issuerIdFor(createPublicKey(found.pem)) !== issuer) return null;
  } catch {
    return null;
  }
  return {
    issuer,
    organisation: found.organisation,
    kind: found.kind,
    publicKeyPem: found.pem,
  };
}

/** GET /keys/<issuer>.pub or /keys/<issuer>.json. */
export async function handleKey(file: string, sql: Sql): Promise<Response> {
  const m = /^(.+)\.(pub|json)$/.exec(file);
  const key = m?.[1] ? await publishedKey(sql, m[1]) : null;
  if (!m || !key) {
    return new Response('No published key with this name.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const cache = 'public, max-age=300';
  if (m[2] === 'pub') {
    return new Response(key.publicKeyPem, {
      headers: { 'content-type': 'application/x-pem-file; charset=utf-8', 'cache-control': cache },
    });
  }
  return new Response(
    JSON.stringify(
      {
        issuer: key.issuer,
        organisation: key.organisation,
        kind: key.kind,
        public_key_pem: key.publicKeyPem,
      },
      null,
      2,
    ),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } },
  );
}
