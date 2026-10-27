import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from '@/server/totp';

// The RFC's shared secret for SHA-1: the ASCII bytes of "12345678901234567890".
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET = base32Encode(RFC_KEY);

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trips and matches the well-known encoding of the RFC key', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).equals(RFC_KEY)).toBe(true);
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').equals(RFC_KEY)).toBe(true);
    const fresh = newTotpSecret();
    expect(fresh).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(fresh)).toHaveLength(20);
  });

  it('HOTP matches the RFC 4226 test values', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, i) => hotp(RFC_KEY, i))).toEqual(expected);
  });

  it('matches the RFC 6238 SHA-1 test vectors (8 digits)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) expect(totpCode(RFC_SECRET, t * 1000, 8)).toBe(code);
    // Six digits are the last six of the same value.
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082');
  });

  it('accepts one 30-second step either side, and nothing further', () => {
    const now = 1_800_000_015_000;
    const step = totpStep(now);
    const at = (s: number) => totpCode(RFC_SECRET, s * 30_000);
    expect(verifyTotp(RFC_SECRET, at(step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, at(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, at(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, at(step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(step + 2), now)).toBeNull();
  });

  it('refuses a replayed code (same or older step) and junk', () => {
    const now = 1_800_000_015_000;
    const step = totpStep(now);
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
    for (const junk of ['', '12345', '1234567', 'abcdef', '12345a']) {
      expect(verifyTotp(RFC_SECRET, junk, now)).toBeNull();
    }
  });

  it('builds the otpauth address authenticator apps read', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'alice@example.com');
    expect(uri).toBe(
      'otpauth://totp/Flow-E%3Aalice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Flow-E&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('makes 10 distinct recovery codes whose hash ignores case, spaces and dashes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const c = codes[0] ?? '';
    expect(hashRecoveryCode(c.toUpperCase().replace('-', ' '))).toBe(hashRecoveryCode(c));
    expect(hashRecoveryCode(c)).toMatch(/^[0-9a-f]{64}$/);
  });
});
