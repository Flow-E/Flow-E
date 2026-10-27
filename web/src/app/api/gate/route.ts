import { NextResponse } from 'next/server';
import { GATE_COOKIE, GATE_MAX_AGE_S, gateToken, passwordMatches, safeNext } from '@/server/gate';

/**
 * The preview password form posts here. A route handler on purpose: the gate page must be
 * reachable without the password, and a Server Action there could be used to call any other
 * action of the site. Route handlers never run Server Actions.
 */

export const dynamic = 'force-dynamic';

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const next = safeNext(field(form, 'next'));
  const go = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);
  const password = process.env.SITE_PASSWORD;
  if (!password) return go(next);
  if (!(await passwordMatches(field(form, 'password').slice(0, 200), password))) {
    // A short pause makes guessing slower without telling an attacker anything.
    await new Promise((r) => setTimeout(r, 600));
    return go(`/gate?error=1&next=${encodeURIComponent(next)}`);
  }
  const res = go(next);
  res.cookies.set(GATE_COOKIE, await gateToken(password, Date.now() + GATE_MAX_AGE_S * 1000), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: GATE_MAX_AGE_S,
  });
  return res;
}
