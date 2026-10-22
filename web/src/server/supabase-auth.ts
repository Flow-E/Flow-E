import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Email sign-in links through Supabase Auth, server side only, with PKCE:
 *
 * 1. `sendSignInLink` asks Supabase to email a one-time link and sends the SHA-256 of a random
 *    verifier with it. The verifier itself stays in an httpOnly cookie in this browser.
 * 2. The link goes through Supabase, which redirects back to /auth/callback?code=….
 * 3. `exchangeCode` trades the code plus the verifier for the user. Without the verifier (another
 *    browser, an attacker who only has the link) the exchange fails.
 *
 * Only the user's id and email are kept, in Flow-E's own session cookie; Supabase tokens are
 * never stored or sent to the browser. Requests use the public publishable key only.
 */

export const PKCE_COOKIE = 'flowe_pkce';
/** How long a sign-in link can be used from this browser. Matches Supabase's default (1 h). */
export const PKCE_MAX_AGE_S = 60 * 60;

export interface SupabaseConfig {
  url: string;
  key: string;
}

export interface SupabaseUser {
  id: string;
  email: string;
}

/** A failure with a message that is safe and useful to show the person signing in. */
export class SignInError extends Error {
  override name = 'SignInError';
}

export function supabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase sign-in is not configured.');
  return { url, key };
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

type Fetch = typeof fetch;

/** Ask Supabase to email a sign-in link that returns to `redirectTo`. */
export async function sendSignInLink(
  email: string,
  redirectTo: string,
  challenge: string,
  config: SupabaseConfig = supabaseConfig(),
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const url = `${config.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        create_user: true,
        data: {},
        code_challenge: challenge,
        code_challenge_method: 's256',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SignInError('The sign-in service is not reachable right now. Try again shortly.');
  }
  if (res.ok) return;
  if (res.status === 429) {
    throw new SignInError(
      'Too many sign-in emails were sent in a short time. Wait a few minutes and try again.',
    );
  }
  if (res.status >= 500) {
    throw new SignInError('The sign-in service has a problem right now. Try again shortly.');
  }
  throw new SignInError('That sign-in email could not be sent. Check the address and try again.');
}

/** Trade the code from the sign-in link, plus this browser's verifier, for the user. */
export async function exchangeCode(
  code: string,
  verifier: string,
  config: SupabaseConfig = supabaseConfig(),
  fetchImpl: Fetch = fetch,
): Promise<SupabaseUser> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.url}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SignInError('The sign-in service is not reachable right now. Try again shortly.');
  }
  if (!res.ok) {
    throw new SignInError(
      res.status >= 500
        ? 'The sign-in service has a problem right now. Try again shortly.'
        : 'This sign-in link has expired or was already used. Request a new one.',
    );
  }
  const body = (await res.json().catch(() => null)) as {
    user?: { id?: unknown; email?: unknown };
  } | null;
  const id = body?.user?.id;
  const email = body?.user?.email;
  if (typeof id !== 'string' || id === '' || typeof email !== 'string' || email === '') {
    throw new SignInError('The sign-in service sent an unexpected answer. Try again.');
  }
  return { id, email: email.toLowerCase() };
}

/** The sandbox owner id for a Supabase user: stable even if they change their email. */
export function supabaseUserId(user: SupabaseUser): string {
  return `supabase:${user.id}`;
}

/** Map Supabase's error parameters on the callback URL to a message for people. */
export function callbackErrorMessage(params: URLSearchParams): string | null {
  const code = params.get('error_code') ?? params.get('error');
  if (!code) return null;
  if (code === 'otp_expired') return 'This sign-in link has expired. Request a new one.';
  if (code === 'access_denied') return 'This sign-in link is no longer valid. Request a new one.';
  return 'Sign-in did not complete. Request a new link.';
}
