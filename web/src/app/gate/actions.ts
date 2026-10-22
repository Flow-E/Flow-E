'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { text } from '@/lib/form';
import { GATE_COOKIE, GATE_MAX_AGE_S, gateToken, passwordMatches, safeNext } from '@/server/gate';

export interface GateState {
  error?: string;
}

export async function unlock(_prev: GateState, form: FormData): Promise<GateState> {
  const password = process.env.SITE_PASSWORD;
  const next = safeNext(text(form, 'next', '/'));
  if (!password) redirect(next);
  const typed = text(form, 'password');
  if (!(await passwordMatches(typed, password))) {
    // A short pause makes guessing slower without telling an attacker anything.
    await new Promise((r) => setTimeout(r, 600));
    return { error: 'That password is not right.' };
  }
  (await cookies()).set(
    GATE_COOKIE,
    await gateToken(password, Date.now() + GATE_MAX_AGE_S * 1000),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: GATE_MAX_AGE_S,
    },
  );
  redirect(next);
}
