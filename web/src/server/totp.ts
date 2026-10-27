import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authenticator-app codes (TOTP, RFC 6238): HMAC-SHA-1, 6 digits, 30-second steps, and one
 * step either side for clock drift. Our own small implementation on node:crypto, checked
 * against the RFC's test vectors (test/totp.test.ts). Pure: the time is always passed in.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_S = 30;
/** Steps accepted either side of the current one. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error('Not a base32 secret.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 30-second step a moment falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/** HOTP (RFC 4226) for one counter value, with the key as raw bytes. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The code an authenticator app shows at `nowMs` for a base32 secret. */
export function totpCode(secret: string, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secret), totpStep(nowMs), digits);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Digits only: people type "123 456" or paste with spaces. */
export function cleanCode(input: string): string {
  return input.replace(/[\s-]/g, '');
}

/**
 * The step a typed code matches, within ±1 step of now, or null. A step at or before
 * `lastStep` is refused: each code works once, even inside its 30 seconds.
 */
export function verifyTotp(
  secret: string,
  input: string,
  nowMs: number,
  lastStep: number | null = null,
): number | null {
  const code = cleanCode(input);
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const now = totpStep(nowMs);
  let matched: number | null = null;
  // Check every step in the window (no early exit) so timing says nothing about which matched.
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    if (sameText(hotp(key, step), code) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastStep !== null && matched <= lastStep) return null;
  return matched;
}

/** The otpauth:// address an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'Flow-E'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Recovery codes ----------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten one-time codes like "k7m2p-x9qrt": shown once, stored only as SHA-256 hashes. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    let s = '';
    for (const b of bytes) s += RECOVERY_ALPHABET.charAt(b % RECOVERY_ALPHABET.length);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Lower case, no spaces or dashes, so "K7M2P X9QRT" matches "k7m2p-x9qrt". */
export function normaliseRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}
