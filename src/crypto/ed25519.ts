import {
  type KeyObject,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

/**
 * Ed25519 signing with domain separation: every signature covers `<domain>\n<payload>`, so a
 * signature made for one purpose (say, a receipt) can never be replayed as another (a credential).
 */

export interface PemKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateKeyPair(): PemKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** A stable short id for a public key: "imprest-issuer:" + first 16 hex of SHA-256(SPKI). */
export function issuerIdFor(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `imprest-issuer:${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

export function publicKeyOf(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}

function message(domain: string, payload: string): Buffer {
  return Buffer.from(`${domain}\n${payload}`, 'utf8');
}

/** Base64url Ed25519 signature. */
export function signPayload(privateKey: KeyObject, domain: string, payload: string): string {
  return sign(null, message(domain, payload), privateKey).toString('base64url');
}

/** Never throws: malformed input is simply not a valid signature. */
export function verifyPayload(
  publicKey: KeyObject,
  domain: string,
  payload: string,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return verify(null, message(domain, payload), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
