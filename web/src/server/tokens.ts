import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Secrets handed to people or agents: agent API keys, invitation links, approval links. Each is
 * 32 random bytes; only its SHA-256 is stored, so a database leak reveals nothing usable.
 */

export const AGENT_KEY_PREFIX = 'flowe_ak_';
/** Characters of the key shown in lists so people can tell keys apart (prefix + 6). */
const VISIBLE = AGENT_KEY_PREFIX.length + 6;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function newAgentKey(): { key: string; hash: string; prefix: string } {
  const key = `${AGENT_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, VISIBLE) };
}

/** A string that could be an agent key (cheap check before hashing and a database lookup). */
export function looksLikeAgentKey(text: string): boolean {
  return /^flowe_ak_[A-Za-z0-9_-]{43}$/.test(text);
}

export function looksLikeToken(text: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(text);
}
