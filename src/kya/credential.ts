import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../crypto/canonical.js';
import { issuerIdFor, signPayload, verifyPayload } from '../crypto/ed25519.js';
import type { Credential, CredentialClaims, SignatureCheck } from '../engine/types.js';

/**
 * Know Your Agent credentials. The issuer signs the canonical claims; the signature is checked
 * against the issuer public key held by the owner, never against a key carried in the credential.
 */

export const CREDENTIAL_FORMAT = 'mandate-credential/v1';
export const CREDENTIAL_DOMAIN = 'mandate-credential-v1';
export const PAYMENT_SCOPE = 'payments:request';
export const MAX_VALID_DAYS = 3650;

export interface CredentialFile extends Credential {
  format: typeof CREDENTIAL_FORMAT;
}

export class CredentialError extends Error {
  override name = 'CredentialError';
}

export interface IssueOptions {
  privateKey: KeyObject;
  publicKey: KeyObject;
  agentId: string;
  agentName: string;
  owner: string;
  organisation: string;
  scope: readonly string[];
  /** Epoch milliseconds. */
  now: number;
  validDays: number;
}

export function issueCredential(o: IssueOptions): CredentialFile {
  if (!Number.isInteger(o.validDays) || o.validDays < 1 || o.validDays > MAX_VALID_DAYS) {
    throw new CredentialError(`Validity must be 1–${MAX_VALID_DAYS} whole days.`);
  }
  if (o.scope.length === 0) throw new CredentialError('A credential needs at least one scope.');
  const claims: CredentialClaims = {
    issuer: issuerIdFor(o.publicKey),
    agent_id: o.agentId,
    agent_name: o.agentName,
    owner: o.owner,
    organisation: o.organisation,
    scope: [...o.scope],
    issued_at: new Date(o.now).toISOString(),
    expires_at: new Date(o.now + o.validDays * 86_400_000).toISOString(),
  };
  return {
    format: CREDENTIAL_FORMAT,
    claims,
    signature: signPayload(o.privateKey, CREDENTIAL_DOMAIN, canonicalJson(claims)),
  };
}

/** The engine's signature check, bound to the trusted issuer public key. */
export function signatureCheck(publicKey: KeyObject): SignatureCheck {
  return (credential) =>
    verifyPayload(
      publicKey,
      CREDENTIAL_DOMAIN,
      canonicalJson(credential.claims),
      credential.signature,
    )
      ? { valid: true }
      : {
          valid: false,
          reason: 'it does not match the issuer key (tampered or signed by another key).',
        };
}

const claimsSchema = z.strictObject({
  issuer: z.string().min(1),
  agent_id: z.string().min(1),
  agent_name: z.string().min(1),
  owner: z.string().min(1),
  organisation: z.string().min(1),
  scope: z.array(z.string().min(1)),
  issued_at: z.string(),
  expires_at: z.string(),
});

const fileSchema = z.strictObject({
  format: z.literal(CREDENTIAL_FORMAT),
  claims: claimsSchema,
  signature: z.string(),
});

/** Parse a credential file. Shape only: validity is the engine's job, at every request. */
export function parseCredential(text: string): CredentialFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CredentialError('Credential file is not valid JSON.');
  }
  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    throw new CredentialError(`Credential file is malformed:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
