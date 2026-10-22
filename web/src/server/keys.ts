import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Issuer private keys (sandboxes and organisations) are stored encrypted (AES-256-GCM). The
 * 32-byte key-encryption key comes from FLOWE_KEY_ENCRYPTION_KEY, or the older name
 * FLOWE_SANDBOX_KEY (base64), and never leaves the server.
 */

export class KeyConfigError extends Error {
  override name = 'KeyConfigError';
}

export function parseEncryptionKey(base64: string | undefined): Buffer {
  if (!base64) throw new KeyConfigError('FLOWE_SANDBOX_KEY is not set.');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) {
    throw new KeyConfigError('FLOWE_SANDBOX_KEY must be 32 random bytes, base64-encoded.');
  }
  return key;
}

/**
 * The key-encryption key from the environment. FLOWE_KEY_ENCRYPTION_KEY wins; FLOWE_SANDBOX_KEY
 * still works, so existing deployments keep reading their sandboxes. Set only one of them.
 */
export function encryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseEncryptionKey(env.FLOWE_KEY_ENCRYPTION_KEY ?? env.FLOWE_SANDBOX_KEY);
}

/** base64url(iv) . base64url(tag) . base64url(ciphertext) */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !body) throw new KeyConfigError('Malformed encrypted value.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
