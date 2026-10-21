import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, issuerIdFor } from '../../src/crypto/ed25519.js';
import { evaluate } from '../../src/engine/evaluate.js';
import type { Credential } from '../../src/engine/types.js';
import {
  CredentialError,
  PAYMENT_SCOPE,
  issueCredential,
  parseCredential,
  signatureCheck,
  type CredentialFile,
} from '../../src/kya/credential.js';
import { NOW, context, mandate, request } from '../engine/fixtures.js';

function keys() {
  const pem = generateKeyPair();
  return {
    privateKey: createPrivateKey(pem.privateKeyPem),
    publicKey: createPublicKey(pem.publicKeyPem),
  };
}

const issuer = keys();
const ISSUER_ID = issuerIdFor(issuer.publicKey);
const DAY = 86_400_000;

function issue(overrides: Partial<Parameters<typeof issueCredential>[0]> = {}): CredentialFile {
  return issueCredential({
    ...issuer,
    agentId: 'lab-procurement',
    agentName: 'Lab procurement agent',
    owner: 'M. Keller, Head of Lab',
    organisation: 'Example Labs AG (fictional)',
    scope: [PAYMENT_SCOPE],
    now: NOW - DAY,
    validDays: 90,
    ...overrides,
  });
}

/** Run a real request through the engine with the real signature check. */
function decide(credential: Credential | null, now = NOW) {
  return evaluate(
    { id: 'lab-procurement', status: 'active', credential },
    mandate(),
    request(),
    context({
      context: {
        now,
        kya: {
          issuer: ISSUER_ID,
          requiredScope: PAYMENT_SCOPE,
          verifySignature: signatureCheck(issuer.publicKey),
        },
      },
    }),
  );
}

describe('issueCredential', () => {
  it('fills every claim and signs it', () => {
    const c = issue();
    expect(c.format).toBe('mandate-credential/v1');
    expect(c.claims).toEqual({
      issuer: ISSUER_ID,
      agent_id: 'lab-procurement',
      agent_name: 'Lab procurement agent',
      owner: 'M. Keller, Head of Lab',
      organisation: 'Example Labs AG (fictional)',
      scope: ['payments:request'],
      issued_at: '2026-10-20T10:00:00.000Z',
      expires_at: '2027-01-18T10:00:00.000Z',
    });
    expect(signatureCheck(issuer.publicKey)(c)).toEqual({ valid: true });
  });
  it.each([0, -1, 1.5, 3651])('rejects %s days of validity', (validDays) => {
    expect(() => issue({ validDays })).toThrow(/1–3650 whole days/);
  });
  it('rejects an empty scope', () => {
    expect(() => issue({ scope: [] })).toThrow(CredentialError);
  });
  it('never puts key material in the credential', () => {
    const text = JSON.stringify(issue());
    expect(text).not.toMatch(/PRIVATE|BEGIN/);
    const raw = issuer.privateKey.export({ format: 'jwk' }).d;
    expect(raw && text.includes(raw)).toBe(false);
  });
});

describe('credentials through the engine', () => {
  it('approves with a genuine, current, correctly scoped credential', () => {
    expect(decide(issue()).decision).toBe('approved');
  });

  it('declines a tampered credential (claim edited after signing)', () => {
    const c = issue();
    const tampered = { ...c, claims: { ...c.claims, scope: [PAYMENT_SCOPE, 'admin'] } };
    const r = decide(tampered);
    expect(r).toMatchObject({ decision: 'declined', rule: 'KYA_CREDENTIAL' });
    expect(r.reason).toMatch(/signature is not valid: it does not match the issuer key/);
  });

  it('declines a credential whose expiry was pushed out by hand', () => {
    const c = issue({ now: NOW - 100 * DAY });
    const r = decide({ ...c, claims: { ...c.claims, expires_at: '2030-01-01T00:00:00.000Z' } });
    expect(r.reason).toMatch(/signature is not valid/);
  });

  it('declines a credential with a corrupted signature', () => {
    const c = issue();
    const flipped = (c.signature.startsWith('A') ? 'B' : 'A') + c.signature.slice(1);
    expect(decide({ ...c, signature: flipped }).reason).toMatch(/signature is not valid/);
  });

  it('declines a credential from a different issuer, naming both', () => {
    const other = keys();
    const c = issueCredential({ ...argsFrom(issue()), ...other });
    const r = decide(c);
    expect(r.rule).toBe('KYA_CREDENTIAL');
    expect(r.reason).toBe(
      `Credential was issued by "${issuerIdFor(other.publicKey)}", not by "${ISSUER_ID}".`,
    );
  });

  it('declines a forgery that claims our issuer id but is signed with another key', () => {
    const other = keys();
    const forged = issueCredential({ ...argsFrom(issue()), ...other });
    const r = decide({ ...forged, claims: { ...forged.claims, issuer: ISSUER_ID } });
    expect(r.reason).toMatch(/signature is not valid/);
  });

  it('declines an expired credential, with the expiry time', () => {
    const c = issue({ now: NOW - 91 * DAY });
    const r = decide(c);
    expect(r.rule).toBe('KYA_CREDENTIAL');
    expect(r.reason).toBe(`Credential expired at ${c.claims.expires_at}.`);
  });

  it('declines a credential with the wrong scope', () => {
    const r = decide(issue({ scope: ['catalog:read'] }));
    expect(r.rule).toBe('KYA_CREDENTIAL');
    expect(r.reason).toBe('Credential scope [catalog:read] does not include "payments:request".');
  });

  it("declines another agent's genuine credential", () => {
    const r = decide(issue({ agentId: 'marketing-bot' }));
    expect(r.reason).toBe('Credential belongs to agent "marketing-bot", not "lab-procurement".');
  });

  it('survives a round trip through the credential file format', () => {
    const c = parseCredential(JSON.stringify(issue(), null, 2));
    expect(decide(c).decision).toBe('approved');
  });
});

describe('parseCredential', () => {
  it('rejects non-JSON', () => {
    expect(() => parseCredential('{')).toThrow(/not valid JSON/);
  });
  it('rejects a wrong format tag', () => {
    expect(() => parseCredential(JSON.stringify({ ...issue(), format: 'v0' }))).toThrow(
      /malformed/,
    );
  });
  it('rejects extra fields, such as an embedded public key', () => {
    const withKey = { ...issue(), public_key: 'attacker key' };
    expect(() => parseCredential(JSON.stringify(withKey))).toThrow(/malformed/);
  });
  it('rejects missing claims', () => {
    const c = issue();
    const claims: Partial<typeof c.claims> = { ...c.claims };
    delete claims.owner;
    expect(() => parseCredential(JSON.stringify({ ...c, claims }))).toThrow(/owner/);
  });
});

/** The issue options that reproduce a credential's claims (minus keys). */
function argsFrom(c: CredentialFile) {
  return {
    agentId: c.claims.agent_id,
    agentName: c.claims.agent_name,
    owner: c.claims.owner,
    organisation: c.claims.organisation,
    scope: c.claims.scope,
    now: Date.parse(c.claims.issued_at),
    validDays: 90,
  };
}
