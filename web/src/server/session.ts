import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Sign-in sessions: a cookie holding the user id, email and expiry, signed with
 * FLOWE_SESSION_SECRET (HMAC-SHA256). How a person proves who they are is an adapter:
 *
 * - `dev`: type any email, no verification. Only when FLOWE_DEV_LOGIN=1 and NODE_ENV is not
 *   production; refused everywhere else.
 * - `supabase`: email sign-in link through Supabase Auth with PKCE (NEXT_PUBLIC_SUPABASE_URL and
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY); see src/server/supabase-auth.ts and /auth/callback.
 */

export const SESSION_COOKIE = 'flowe_session';
/** Where an emailed sign-in link continues to (a path checked with safeNext). */
export const NEXT_COOKIE = 'flowe_next';
const MAX_AGE_S = 12 * 60 * 60;

export interface Session {
  /** Stable owner id for the sandbox, e.g. "dev:alice@example.com". */
  userId: string;
  email: string;
  /** When this session last passed the second factor (ms); absent until it has. */
  mfaAt?: number;
}

export type AuthMode = 'dev' | 'supabase' | 'none';

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  if (env.FLOWE_DEV_LOGIN === '1' && env.NODE_ENV !== 'production') return 'dev';
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return 'supabase';
  return 'none';
}

function secret(): string {
  const s = process.env.FLOWE_SESSION_SECRET;
  if (!s || s.length < 32)
    throw new Error('FLOWE_SESSION_SECRET must be set (at least 32 characters).');
  return s;
}

export function signSession(session: Session, expiresAtMs: number, key = secret()): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: session.userId,
      email: session.email,
      exp: Math.floor(expiresAtMs / 1000),
      ...(session.mfaAt === undefined ? {} : { mfa: Math.floor(session.mfaAt / 1000) }),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(
  token: string | undefined,
  nowMs: number,
  key = secret(),
): Session | null {
  return readSessionWithExpiry(token, nowMs, key)?.session ?? null;
}

/** The session and when it ends (ms). */
export function readSessionWithExpiry(
  token: string | undefined,
  nowMs: number,
  key = secret(),
): { session: Session; expiresAtMs: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      email?: unknown;
      exp?: unknown;
      mfa?: unknown;
    };
    if (
      typeof data.sub !== 'string' ||
      typeof data.email !== 'string' ||
      typeof data.exp !== 'number'
    ) {
      return null;
    }
    if (data.exp * 1000 <= nowMs) return null;
    return {
      session: {
        userId: data.sub,
        email: data.email,
        ...(typeof data.mfa === 'number' ? { mfaAt: data.mfa * 1000 } : {}),
      },
      expiresAtMs: data.exp * 1000,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  return readSession((await cookies()).get(SESSION_COOKIE)?.value, Date.now());
}

export async function startSession(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, signSession(session, Date.now() + MAX_AGE_S * 1000), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_S,
  });
}

/**
 * Record that this session just passed the second factor. Keeps the session's own expiry, so a
 * verified session lasts exactly as long as the session (at most 12 hours).
 */
export async function markMfaVerified(nowMs = Date.now()): Promise<void> {
  const jar = await cookies();
  const current = readSessionWithExpiry(jar.get(SESSION_COOKIE)?.value, nowMs);
  if (!current) return;
  const { session, expiresAtMs } = current;
  const maxAge = Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000));
  jar.set(
    SESSION_COOKIE,
    signSession({ userId: session.userId, email: session.email, mfaAt: nowMs }, expiresAtMs),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge,
    },
  );
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Owner id for a dev-login email. Lower-cased so one person keeps one sandbox. */
export function devUserId(email: string): string {
  return `dev:${email.trim().toLowerCase()}`;
}
