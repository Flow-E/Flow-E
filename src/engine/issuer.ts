/**
 * Issuer ids, as plain strings: "<prefix><16 hex fingerprint of the public key>". Pure, so the
 * engine can compare ids without crypto.
 *
 * Data signed before the product was renamed to Mandate (ledger and credential version 1) names
 * its issuer "flow-e-issuer:…"; everything written now uses "mandate-issuer:…". Both forms of the
 * same fingerprint are the same issuer.
 */

/** Issuer ids written today (version 2). */
export const ISSUER_PREFIX = 'mandate-issuer:';
/** Issuer ids in version 1 data, signed under the product's earlier name. */
export const LEGACY_ISSUER_PREFIX = 'flow-e-issuer:';

/** The fingerprint inside an issuer id, or null if it has neither prefix. */
export function issuerFingerprint(issuer: string): string | null {
  for (const prefix of [ISSUER_PREFIX, LEGACY_ISSUER_PREFIX]) {
    if (issuer.startsWith(prefix)) return issuer.slice(prefix.length);
  }
  return null;
}

/** The same issuer id with the prefix of the given data version. Unknown forms are unchanged. */
export function issuerIdForVersion(issuer: string, version: 1 | 2): string {
  const fingerprint = issuerFingerprint(issuer);
  if (fingerprint === null) return issuer;
  return `${version === 1 ? LEGACY_ISSUER_PREFIX : ISSUER_PREFIX}${fingerprint}`;
}

/** True when both ids name the same issuer, whichever form each is in. */
export function sameIssuer(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = issuerFingerprint(a);
  return fa !== null && fa !== '' && fa === issuerFingerprint(b);
}
