import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, issuerIdFor, publicKeyOf } from '../crypto/ed25519.js';
import { type CredentialFile, CredentialError, parseCredential } from './credential.js';

/**
 * On-disk state for the issuer, under the mandate home directory (default `.mandate/`):
 *
 *   issuer.key            Ed25519 private key, PKCS#8 PEM, mode 0600. Never printed or logged.
 *   issuer.pub            Public key, SPKI PEM. Enough to verify credentials and receipts offline.
 *   credentials/<id>.json One signed credential per agent.
 */

export class KeyStoreError extends Error {
  override name = 'KeyStoreError';
}

const isWindows = process.platform === 'win32';
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function storePaths(home: string) {
  return {
    home,
    privateKey: join(home, 'issuer.key'),
    publicKey: join(home, 'issuer.pub'),
    credentials: join(home, 'credentials'),
  };
}

export interface Issuer {
  id: string;
  publicKey: KeyObject;
}

export interface SigningIssuer extends Issuer {
  privateKey: KeyObject;
}

/** Create the issuer key pair. Refuses to replace an existing key: that would orphan every credential. */
export function initIssuer(home: string): Issuer {
  const p = storePaths(home);
  if (existsSync(p.privateKey) || existsSync(p.publicKey)) {
    throw new KeyStoreError(
      `An issuer key already exists in ${home}. Replacing it would invalidate every credential, ` +
        'so mandate will not overwrite it. Move the directory away first if you really mean to.',
    );
  }
  mkdirSync(p.credentials, { recursive: true, mode: 0o700 });
  // Keep the whole directory out of version control even if the project's .gitignore misses it.
  writeFileSync(join(home, '.gitignore'), '*\n', { flag: 'w' });
  const { publicKeyPem, privateKeyPem } = generateKeyPair();
  writeFileSync(p.privateKey, privateKeyPem, { mode: 0o600, flag: 'wx' });
  writeFileSync(p.publicKey, publicKeyPem, { mode: 0o644, flag: 'wx' });
  const publicKey = createPublicKey(publicKeyPem);
  return { id: issuerIdFor(publicKey), publicKey };
}

/** The public half only: all that verification needs. */
export function loadIssuer(home: string): Issuer {
  const p = storePaths(home);
  if (!existsSync(p.publicKey)) {
    throw new KeyStoreError(`No issuer key in ${home}. Run "mandate init" first.`);
  }
  try {
    const publicKey = createPublicKey(readFileSync(p.publicKey, 'utf8'));
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return { id: issuerIdFor(publicKey), publicKey };
  } catch {
    throw new KeyStoreError(`${p.publicKey} is not an Ed25519 public key.`);
  }
}

export function loadSigningIssuer(home: string): SigningIssuer {
  const p = storePaths(home);
  if (!existsSync(p.privateKey)) {
    throw new KeyStoreError(`No issuer key in ${home}. Run "mandate init" first.`);
  }
  // Like ssh: refuse a private key that other users can read. (POSIX only; Windows uses ACLs.)
  if (!isWindows && (statSync(p.privateKey).mode & 0o077) !== 0) {
    throw new KeyStoreError(
      `${p.privateKey} is readable by other users. Run: chmod 600 ${p.privateKey}`,
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(p.privateKey, 'utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  } catch {
    // Deliberately no detail: the error must never echo key material.
    throw new KeyStoreError(`${p.privateKey} is not an Ed25519 private key.`);
  }
  const issuer = loadIssuer(home);
  if (issuerIdFor(publicKeyOf(privateKey)) !== issuer.id) {
    throw new KeyStoreError(`${p.privateKey} and ${p.publicKey} are not a key pair.`);
  }
  return { ...issuer, privateKey };
}

function credentialPath(home: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new KeyStoreError(`"${agentId}" is not a valid agent id.`);
  return join(storePaths(home).credentials, `${agentId}.json`);
}

export function writeCredential(home: string, credential: CredentialFile, force = false): string {
  const path = credentialPath(home, credential.claims.agent_id);
  if (existsSync(path) && !force) {
    throw new KeyStoreError(
      `Agent "${credential.claims.agent_id}" already has a credential. Use --force to reissue it.`,
    );
  }
  mkdirSync(storePaths(home).credentials, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600 });
  return path;
}

export function readCredential(home: string, agentId: string): CredentialFile {
  const path = credentialPath(home, agentId);
  if (!existsSync(path)) {
    throw new CredentialError(
      `Agent "${agentId}" has no credential. Run "mandate agent add ${agentId}".`,
    );
  }
  return parseCredential(readFileSync(path, 'utf8'));
}
