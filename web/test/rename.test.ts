import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX, looksLikeApiKey } from '@/server/api-keys';
import { mandateEnv } from '@/server/env';
import { encryptionKeyFromEnv } from '@/server/keys';
import { adminEmails } from '@/server/pilot';
import { ISSUER_PATTERN } from '@/server/published-keys';
import { AGENT_KEY_PREFIX, looksLikeAgentKey, newAgentKey } from '@/server/tokens';

/** The site was called Flow-E before; what an existing deployment holds must keep working. */

const body = () => randomBytes(32).toString('base64url');

describe('keys across the rename', () => {
  it('issues new agent keys as mandate_ak_ and still accepts flowe_ak_ ones', () => {
    expect(AGENT_KEY_PREFIX).toBe('mandate_ak_');
    expect(newAgentKey().key.startsWith('mandate_ak_')).toBe(true);
    expect(looksLikeAgentKey(`mandate_ak_${body()}`)).toBe(true);
    expect(looksLikeAgentKey(`flowe_ak_${body()}`)).toBe(true);
    expect(looksLikeAgentKey(`other_ak_${body()}`)).toBe(false);
    expect(looksLikeAgentKey(`flowe_ok_${body()}`)).toBe(false);
  });

  it('issues new organisation keys as mandate_ok_ and still accepts flowe_ok_ ones', () => {
    expect(API_KEY_PREFIX).toBe('mandate_ok_');
    expect(looksLikeApiKey(`mandate_ok_${body()}`)).toBe(true);
    expect(looksLikeApiKey(`flowe_ok_${body()}`)).toBe(true);
    expect(looksLikeApiKey(`flowe_ak_${body()}`)).toBe(false);
  });

  it('publishes issuer keys under either id form', () => {
    expect(ISSUER_PATTERN.test('mandate-issuer:0123456789abcdef')).toBe(true);
    expect(ISSUER_PATTERN.test('flow-e-issuer:0123456789abcdef')).toBe(true);
    expect(ISSUER_PATTERN.test('other-issuer:0123456789abcdef')).toBe(false);
  });
});

describe('environment across the rename', () => {
  it('reads MANDATE_* first, then the older FLOWE_*', () => {
    expect(mandateEnv('SITE_URL', {} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(mandateEnv('SITE_URL', { FLOWE_SITE_URL: 'old' } as unknown as NodeJS.ProcessEnv)).toBe(
      'old',
    );
    expect(
      mandateEnv('SITE_URL', {
        MANDATE_SITE_URL: 'new',
        FLOWE_SITE_URL: 'old',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe('new');
  });

  it('a deployment that only has FLOWE_* settings keeps its key and admins', () => {
    const key = randomBytes(32).toString('base64');
    const env = {
      FLOWE_SANDBOX_KEY: key,
      FLOWE_ADMIN_EMAILS: 'Admin@Example.test',
    } as unknown as NodeJS.ProcessEnv;
    expect(encryptionKeyFromEnv(env).equals(Buffer.from(key, 'base64'))).toBe(true);
    expect(adminEmails(env).has('admin@example.test')).toBe(true);
  });
});
