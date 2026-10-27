'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { text } from '@/lib/form';
import { loginUrl, safeNext } from '@/lib/next-path';
import { MfaError } from '@/server/mfa';
import { RateLimiter } from '@/server/rate-limit';
import { getSession, markMfaVerified } from '@/server/session';
import { SECURITY_PATH, getMfaStore } from '@/server/strong-session';

/**
 * The second factor: set up an authenticator app, confirm it, turn it off, and enter a code
 * when an action asks for one. Codes and recovery codes are never logged.
 */

export interface MfaState {
  ok?: string;
  error?: string;
  /** Recovery codes, returned once right after set-up. */
  codes?: string[];
}

// Six-digit codes can be guessed; a few tries per person per quarter of an hour is plenty.
const attempts = new RateLimiter(8, 15 * 60_000);

async function signedIn(next: string) {
  const session = await getSession();
  if (!session) redirect(loginUrl(next));
  return session;
}

function tooMany(userId: string): string | null {
  const r = attempts.take(userId);
  return r.ok
    ? null
    : `Too many tries. Wait ${String(Math.ceil(r.retryAfterS / 60))} minutes and try again.`;
}

function problem(err: unknown): string {
  if (err instanceof MfaError) return err.message;
  console.error('mfa action failed', err instanceof Error ? err.name : 'unknown');
  return 'Something went wrong. Nothing was changed; please try again.';
}

export async function startMfaAction(_prev: MfaState): Promise<MfaState> {
  const session = await signedIn(SECURITY_PATH);
  try {
    await (await getMfaStore()).begin(session.userId);
  } catch (err) {
    return { error: problem(err) };
  }
  revalidatePath(SECURITY_PATH);
  return {};
}

export async function cancelMfaSetupAction(_prev: MfaState): Promise<MfaState> {
  const session = await signedIn(SECURITY_PATH);
  await (await getMfaStore()).cancelPending(session.userId);
  revalidatePath(SECURITY_PATH);
  return {};
}

export async function confirmMfaAction(_prev: MfaState, form: FormData): Promise<MfaState> {
  const session = await signedIn(SECURITY_PATH);
  const limited = tooMany(session.userId);
  if (limited) return { error: limited };
  let codes: string[];
  try {
    codes = await (await getMfaStore()).confirm(session.userId, text(form, 'code'));
  } catch (err) {
    return { error: problem(err) };
  }
  // The first code proves it: this session counts as verified.
  await markMfaVerified();
  return { codes, ok: 'Authenticator app set up.' };
}

export async function disableMfaAction(_prev: MfaState, form: FormData): Promise<MfaState> {
  const session = await signedIn(SECURITY_PATH);
  const limited = tooMany(session.userId);
  if (limited) return { error: limited };
  try {
    await (await getMfaStore()).disable(session.userId, text(form, 'code'));
  } catch (err) {
    return { error: problem(err) };
  }
  revalidatePath(SECURITY_PATH);
  return { ok: 'Authenticator app turned off.' };
}

/** The challenge: a code from the app or a recovery code, then back to `next`. */
export async function verifyMfaAction(_prev: MfaState, form: FormData): Promise<MfaState> {
  const next = safeNext(text(form, 'next'), '/app');
  const session = await signedIn(`/account/verify?next=${encodeURIComponent(next)}`);
  const limited = tooMany(session.userId);
  if (limited) return { error: limited };
  let kind: 'app' | 'recovery' | null;
  try {
    kind = await (await getMfaStore()).verify(session.userId, text(form, 'code'));
  } catch (err) {
    return { error: problem(err) };
  }
  if (kind === null) {
    return { error: 'That code did not work. Try the newest code from your app.' };
  }
  await markMfaVerified();
  redirect(next);
}
