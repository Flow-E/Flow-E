import { describe, expect, it } from 'vitest';
import { gateToken, passwordMatches, safeNext, verifyGateToken } from '@/server/gate';
import { authMode, readSession, signSession } from '@/server/session';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const HOUR = 3_600_000;

describe('site password gate', () => {
  it('accepts its own fresh token', async () => {
    const t = await gateToken('correct horse', NOW + HOUR);
    expect(await verifyGateToken('correct horse', t, NOW)).toBe(true);
  });

  it('rejects expired, forged, malformed and other-password tokens', async () => {
    const t = await gateToken('correct horse', NOW + HOUR);
    expect(await verifyGateToken('correct horse', t, NOW + 2 * HOUR)).toBe(false);
    expect(await verifyGateToken('another password', t, NOW)).toBe(false);
    const [exp, sig] = t.split('.');
    expect(
      await verifyGateToken('correct horse', `${String(Number(exp) + 999)}.${sig ?? ''}`, NOW),
    ).toBe(false);
    for (const bad of [undefined, '', 'x', '123', 'abc.def', '1.!!!']) {
      expect(await verifyGateToken('correct horse', bad, NOW)).toBe(false);
    }
  });

  it('compares typed passwords exactly', async () => {
    expect(await passwordMatches('s3cret', 's3cret')).toBe(true);
    expect(await passwordMatches('s3cret ', 's3cret')).toBe(false);
    expect(await passwordMatches('', 's3cret')).toBe(false);
  });

  it('only redirects to same-site paths afterwards', () => {
    expect(safeNext('/sandbox?x=1')).toBe('/sandbox?x=1');
    for (const bad of [undefined, null, '', 'https://evil.example', '//evil.example', '/\\evil']) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});

describe('sessions', () => {
  const key = 'k'.repeat(40);
  const s = { userId: 'dev:a@example.com', email: 'a@example.com' };

  it('round-trips a signed session until it expires', () => {
    const t = signSession(s, NOW + HOUR, key);
    expect(readSession(t, NOW, key)).toEqual(s);
    expect(readSession(t, NOW + 2 * HOUR, key)).toBeNull();
  });

  it('rejects tampering and another key', () => {
    const t = signSession(s, NOW + HOUR, key);
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'dev:b@example.com', email: 'b', exp: 9e9 }),
    ).toString('base64url');
    expect(readSession(`${forged}.${sig ?? ''}`, NOW, key)).toBeNull();
    expect(readSession(`${payload ?? ''}.x`, NOW, key)).toBeNull();
    expect(readSession(t, NOW, 'z'.repeat(40))).toBeNull();
    expect(readSession(undefined, NOW, key)).toBeNull();
  });

  it('allows dev login only outside production', () => {
    expect(authMode({ FLOWE_DEV_LOGIN: '1', NODE_ENV: 'development' })).toBe('dev');
    expect(authMode({ FLOWE_DEV_LOGIN: '1', NODE_ENV: 'production' })).toBe('none');
    expect(
      authMode({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      }),
    ).toBe('supabase');
  });
});
