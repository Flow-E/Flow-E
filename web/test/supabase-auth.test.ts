import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authMode } from '@/server/session';
import {
  SignInError,
  callbackErrorMessage,
  exchangeCode,
  newPkce,
  pkceChallenge,
  sendSignInLink,
  supabaseConfig,
  supabaseUserId,
} from '@/server/supabase-auth';

const config = { url: 'https://proj.supabase.co', key: 'sb_publishable_test' };

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch that records calls and answers with the given status and JSON body. */
function fakeFetch(status: number, body: unknown = {}) {
  const calls: Call[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

/** The JSON body a recorded call sent. */
function sentBody(call: Call | undefined): unknown {
  return JSON.parse(call?.init.body as string);
}

const failingFetch = (() => Promise.reject(new TypeError('network down'))) as typeof fetch;

describe('PKCE', () => {
  it('makes a fresh verifier and its S256 challenge (base64url, no padding)', () => {
    const a = newPkce();
    const b = newPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
    expect(a.challenge).not.toMatch(/[=+/]/);
  });

  it('matches the RFC 7636 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('sendSignInLink', () => {
  it('posts the email and challenge to /otp with the redirect URL and the publishable key', async () => {
    const f = fakeFetch(200);
    await sendSignInLink('a@b.ch', 'https://flow-e.example/auth/callback', 'CHAL', config, f.impl);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe(
      'https://proj.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fflow-e.example%2Fauth%2Fcallback',
    );
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toMatchObject({ apikey: 'sb_publishable_test' });
    expect(call?.init.headers).not.toHaveProperty('Authorization');
    expect(sentBody(call)).toEqual({
      email: 'a@b.ch',
      create_user: true,
      data: {},
      code_challenge: 'CHAL',
      code_challenge_method: 's256',
    });
  });

  it.each([
    [429, /Too many sign-in emails/],
    [500, /has a problem right now/],
    [400, /could not be sent/],
  ])('turns HTTP %i into a clear message', async (status, message) => {
    await expect(
      sendSignInLink('a@b.ch', 'x', 'c', config, fakeFetch(status).impl),
    ).rejects.toThrow(message);
  });

  it('reports an unreachable service', async () => {
    await expect(sendSignInLink('a@b.ch', 'x', 'c', config, failingFetch)).rejects.toThrow(
      /not reachable/,
    );
  });
});

describe('exchangeCode', () => {
  it('trades code and verifier for the user, lower-casing the email', async () => {
    const f = fakeFetch(200, {
      access_token: 'never-kept',
      user: { id: 'uuid-1', email: 'Alice@Example.CH' },
    });
    const user = await exchangeCode('CODE', 'VERIFIER', config, f.impl);
    expect(user).toEqual({ id: 'uuid-1', email: 'alice@example.ch' });
    expect(f.calls[0]?.url).toBe('https://proj.supabase.co/auth/v1/token?grant_type=pkce');
    expect(sentBody(f.calls[0])).toEqual({
      auth_code: 'CODE',
      code_verifier: 'VERIFIER',
    });
    expect(supabaseUserId(user)).toBe('supabase:uuid-1');
  });

  it('refuses an expired or reused code', async () => {
    await expect(exchangeCode('C', 'V', config, fakeFetch(400).impl)).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it('refuses an answer without a user', async () => {
    await expect(
      exchangeCode('C', 'V', config, fakeFetch(200, { user: { id: '' } }).impl),
    ).rejects.toBeInstanceOf(SignInError);
  });

  it('reports an unreachable service', async () => {
    await expect(exchangeCode('C', 'V', config, failingFetch)).rejects.toThrow(/not reachable/);
  });
});

describe('configuration', () => {
  it('reads the public URL and key, trimming a trailing slash', () => {
    expect(
      supabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co/',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'k',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ url: 'https://p.supabase.co', key: 'k' });
    expect(() => supabaseConfig({} as NodeJS.ProcessEnv)).toThrow(/not configured/);
  });

  it('uses Supabase sign-in in production even if the dev flag is set', () => {
    const env = {
      NODE_ENV: 'production',
      FLOWE_DEV_LOGIN: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'k',
    } as unknown as NodeJS.ProcessEnv;
    expect(authMode(env)).toBe('supabase');
  });
});

describe('callback errors', () => {
  it('maps Supabase error parameters to messages', () => {
    expect(callbackErrorMessage(new URLSearchParams('error_code=otp_expired'))).toMatch(/expired/);
    expect(callbackErrorMessage(new URLSearchParams('error=access_denied'))).toMatch(
      /no longer valid/,
    );
    expect(callbackErrorMessage(new URLSearchParams('error=weird'))).toMatch(/did not complete/);
    expect(callbackErrorMessage(new URLSearchParams('code=abc'))).toBeNull();
  });
});
