import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@/lib/next-path';
import { NEXT_COOKIE, startSession } from '@/server/session';
import { afterSignIn } from '@/server/strong-session';
import {
  PKCE_COOKIE,
  SignInError,
  callbackErrorMessage,
  exchangeCode,
  supabaseUserId,
} from '@/server/supabase-auth';

/**
 * Where the emailed sign-in link lands (after Supabase): /auth/callback?code=…. Trades the code
 * and this browser's PKCE verifier for the user, starts a Flow-E session and opens the sandbox.
 * Any failure goes back to /login with a message; nothing is half signed in.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const fail = (message: string) => {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?error=${encodeURIComponent(message)}`;
    const res = NextResponse.redirect(url, 303);
    res.cookies.delete({ name: PKCE_COOKIE, path: '/auth/callback' });
    return res;
  };

  const supabaseError = callbackErrorMessage(params);
  if (supabaseError) return fail(supabaseError);

  const code = params.get('code');
  if (!code) return fail('This sign-in link is incomplete. Request a new one.');
  const verifier = request.cookies.get(PKCE_COOKIE)?.value;
  if (!verifier) {
    return fail(
      'Open the sign-in link in the same browser where you requested it, or request a new one.',
    );
  }

  let userId: string;
  try {
    const user = await exchangeCode(code, verifier);
    userId = supabaseUserId(user);
    await startSession({ userId, email: user.email });
  } catch (err) {
    return fail(err instanceof SignInError ? err.message : 'Sign-in failed. Try again shortly.');
  }

  // With an authenticator app set up, the code comes first (then on to `next`).
  const target = await afterSignIn(userId, safeNext(request.cookies.get(NEXT_COOKIE)?.value));
  const next = new URL(target, request.nextUrl);
  const url = request.nextUrl.clone();
  url.pathname = next.pathname;
  url.search = next.search;
  const res = NextResponse.redirect(url, 303);
  res.cookies.delete({ name: PKCE_COOKIE, path: '/auth/callback' });
  res.cookies.delete({ name: NEXT_COOKIE, path: '/auth/callback' });
  return res;
}
