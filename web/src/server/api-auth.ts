import 'server-only';
import { ZodError } from 'zod';
import { ActionError } from '@flow-e/mcp/core';
import type { ApiCaller, ApiKeyStore, ApiScope } from './api-keys';
import { RateLimiter } from './rate-limit';

/**
 * The guard around every /api/v1 route: a bearer organisation key, the scope the route needs,
 * a per-key rate limit and one access-log row per call. Answers are JSON, never cached. An
 * unknown, revoked or malformed key gets the same 401; a key without the scope gets 403.
 */

export const API_RATE_PER_MINUTE = 60;
export const MAX_API_BODY_BYTES = 16 * 1024;

export function newApiLimiter(clock?: () => number): RateLimiter {
  return new RateLimiter(API_RATE_PER_MINUTE, 60_000, clock);
}

export interface ApiDeps {
  keys: ApiKeyStore;
  limiter: RateLimiter;
}

export interface ApiAnswer {
  status: number;
  body: unknown;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export const apiError = (status: number, message: string): ApiAnswer => ({
  status,
  body: { error: message },
});

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? null;
}

/** Read a JSON body of at most MAX_API_BODY_BYTES; null when too large or not JSON. */
export async function readJson(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_API_BODY_BYTES)
    return { ok: false, status: 413, message: 'Body too large (16 KB at most).' };
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_API_BODY_BYTES) {
    return { ok: false, status: 413, message: 'Body too large (16 KB at most).' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: 'The body is not valid JSON.' };
  }
}

export async function withApiKey(
  req: Request,
  deps: ApiDeps,
  scope: ApiScope,
  run: (caller: ApiCaller) => Promise<ApiAnswer>,
): Promise<Response> {
  const key = bearer(req);
  const caller = key ? await deps.keys.authenticate(key) : null;
  if (!caller) {
    return json(
      401,
      { error: 'Send a valid organisation API key as "Authorization: Bearer flowe_ok_…".' },
      { 'www-authenticate': 'Bearer' },
    );
  }
  const path = new URL(req.url).pathname;
  const finish = async (status: number, body: unknown, headers?: Record<string, string>) => {
    try {
      await deps.keys.logAccess(caller, req.method, path, status);
    } catch (err) {
      console.error('api access log failed', err instanceof Error ? err.name : 'unknown');
    }
    return json(status, body, headers);
  };
  const rate = deps.limiter.take(caller.keyId);
  if (!rate.ok) {
    return finish(
      429,
      { error: `Too many requests. Try again in ${String(rate.retryAfterS)} seconds.` },
      {
        'retry-after': String(rate.retryAfterS),
      },
    );
  }
  if (!caller.scopes.includes(scope)) {
    return finish(403, { error: `This key does not have the "${scope}" permission.` });
  }
  try {
    const answer = await run(caller);
    return await finish(answer.status, answer.body);
  } catch (err) {
    if (err instanceof ActionError) return finish(400, { error: err.message });
    if (err instanceof ZodError) {
      return finish(400, {
        error: 'The request is not valid.',
        problems: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      });
    }
    console.error('api call failed', err instanceof Error ? err.name : 'unknown');
    return finish(500, { error: 'Something went wrong. Nothing was changed; please try again.' });
  }
}
