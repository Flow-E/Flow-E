import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/crypto/canonical.js';
import {
  generateKeyPair,
  issuerIdFor,
  signPayload,
  verifyPayload,
} from '../../src/crypto/ed25519.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('is independent of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('escapes strings like JSON and keeps null and booleans', () => {
    expect(canonicalJson({ s: 'a"b\n', n: null, t: true })).toBe(
      '{"n":null,"s":"a\\"b\\n","t":true}',
    );
  });
  it('accepts objects without a prototype', () => {
    const o = Object.create(null) as Record<string, number>;
    o.k = 1;
    expect(canonicalJson(o)).toBe('{"k":1}');
  });
  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a Date', { d: new Date(0) }],
    ['a bigint', { b: 1n }],
    ['a function', { f: () => 1 }],
  ])('rejects %s instead of silently changing it', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe('ed25519', () => {
  const { publicKeyPem, privateKeyPem } = generateKeyPair();
  const pub = createPublicKey(publicKeyPem);
  const priv = createPrivateKey(privateKeyPem);

  it('signs and verifies', () => {
    const sig = signPayload(priv, 'test-domain', 'hello');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifyPayload(pub, 'test-domain', 'hello', sig)).toBe(true);
  });
  it('rejects a changed payload', () => {
    const sig = signPayload(priv, 'test-domain', 'hello');
    expect(verifyPayload(pub, 'test-domain', 'hellO', sig)).toBe(false);
  });
  it('separates domains: a signature for one purpose fails for another', () => {
    const sig = signPayload(priv, 'flow-e-receipt-v1', 'payload');
    expect(verifyPayload(pub, 'flow-e-credential-v1', 'payload', sig)).toBe(false);
  });
  it('rejects another key', () => {
    const other = createPublicKey(generateKeyPair().publicKeyPem);
    expect(verifyPayload(other, 'd', 'p', signPayload(priv, 'd', 'p'))).toBe(false);
  });
  it.each(['', 'not-base64!', 'A'.repeat(86), 'A'.repeat(200)])(
    'returns false (never throws) for malformed signature %#',
    (sig) => {
      expect(verifyPayload(pub, 'd', 'p', sig)).toBe(false);
    },
  );
  it('derives a stable issuer id from the public key', () => {
    expect(issuerIdFor(pub)).toMatch(/^flow-e-issuer:[0-9a-f]{16}$/);
    expect(issuerIdFor(createPublicKey(publicKeyPem))).toBe(issuerIdFor(pub));
    expect(issuerIdFor(createPublicKey(generateKeyPair().publicKeyPem))).not.toBe(issuerIdFor(pub));
  });
});
