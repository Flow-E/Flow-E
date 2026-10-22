'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { safeNext } from '@/lib/next-path';
import { NEXT_COOKIE, authMode, devUserId, endSession, startSession } from '@/server/session';
import {
  PKCE_COOKIE,
  PKCE_MAX_AGE_S,
  SignInError,
  newPkce,
  sendSignInLink,
} from '@/server/supabase-auth';

export interface LoginState {
  error?: string;
  /** Set once a sign-in link is on its way to this address. */
  sentTo?: string;
}

/**
 * The site's own origin, for the link Supabase emails. FLOWE_SITE_URL wins when set (use it in
 * production); otherwise the request's host. Supabase only redirects to URLs on its allowlist.
 */
async function siteOrigin(): Promise<string> {
  const fixed = process.env.FLOWE_SITE_URL?.replace(/\/+$/, '');
  if (fixed) return fixed;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3150';
  const proto =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Email a one-time sign-in link (Supabase Auth, PKCE). */
export async function sendLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (authMode() !== 'supabase') return { error: 'Email sign-in is not configured here.' };
  const parsed = email.safeParse(form.get('email'));
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? 'Enter an email address.' };
  const { verifier, challenge } = newPkce();
  try {
    await sendSignInLink(parsed.data, `${await siteOrigin()}/auth/callback`, challenge);
  } catch (err) {
    return {
      error: err instanceof SignInError ? err.message : 'Sign-in failed. Try again shortly.',
    };
  }
  (await cookies()).set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax: the cookie must arrive when the person clicks the link in their email.
    sameSite: 'lax',
    path: '/auth/callback',
    maxAge: PKCE_MAX_AGE_S,
  });
  const next = safeNext(form.get('next'));
  (await cookies()).set(NEXT_COOKIE, next, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/auth/callback',
    maxAge: PKCE_MAX_AGE_S,
  });
  return { sentTo: parsed.data };
}

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter an email address.' }).max(200));

/** Development only: sign in as any email, without verification. */
export async function devLogin(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (authMode() !== 'dev') return { error: 'Development sign-in is switched off here.' };
  const parsed = email.safeParse(form.get('email'));
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? 'Enter an email address.' };
  await startSession({ userId: devUserId(parsed.data), email: parsed.data });
  redirect(safeNext(form.get('next')));
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect('/');
}
