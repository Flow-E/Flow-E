/**
 * Site password gate, shared by the proxy (every request) and the /gate form. Web Crypto only,
 * so it runs anywhere. The cookie holds an expiry and an HMAC of it keyed with SITE_PASSWORD:
 * changing the password invalidates every cookie, and nothing secret is stored in the browser.
 */

export const GATE_COOKIE = 'flowe_gate';
export const GATE_MAX_AGE_S = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function gateToken(password: string, expiresAtMs: number): Promise<string> {
  const exp = String(Math.floor(expiresAtMs / 1000));
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(password),
    encoder.encode(`flow-e-gate-v1.${exp}`),
  );
  return `${exp}.${toBase64Url(sig)}`;
}

/** Constant-time signature check (crypto.subtle.verify) plus expiry. */
export async function verifyGateToken(
  password: string,
  token: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= nowMs) return false;
  const bytes = fromBase64Url(sig);
  if (!bytes) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(password),
    bytes,
    encoder.encode(`flow-e-gate-v1.${exp}`),
  );
}

/** Compare a typed password with the real one without leaking timing. */
export async function passwordMatches(input: string, password: string): Promise<boolean> {
  // HMAC both under a per-call random key, then compare the fixed-length digests in constant time.
  const key = await hmacKey(toBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer));
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(input)),
    crypto.subtle.sign('HMAC', key, encoder.encode(password)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Only same-site paths may be redirect targets after unlocking. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

/** The agents' MCP endpoint: authenticated by API key, never by the site password. */
export const MCP_PATH = '/api/mcp';
/** The public receipt check page, for suppliers and auditors without the preview password. */
export const VERIFY_PATH = '/verify';
/** Where the /verify page posts receipts (a route handler, not a Server Action). */
export const VERIFY_API_PATH = '/api/verify';
/** The password page, and where its form posts (a route handler, not a Server Action). */
export const GATE_PATH = '/gate';
/** Published issuer public keys, one file each: /keys/<issuer>.pub and .json. */
export const KEYS_PREFIX = '/keys/';
/** The API for other systems: authenticated by an organisation API key, never by the password. */
export const API_V1_PREFIX = '/api/v1/';
/** Called by Vercel Cron with CRON_SECRET; it sends webhook deliveries. */
export const CRON_WEBHOOKS_PATH = '/api/cron/webhooks';
export const GATE_API_PATH = '/api/gate';

/**
 * Which requests skip the site password gate. Exact paths only: /api/mcp/x or /verify/x are
 * still gated; under /keys/ only one file name deep. The public pages (/gate, /verify) are exempt for reading only: a POST there with
 * a Next-Action header could name any Server Action of the site, so they have none and post to
 * route handlers (/api/gate, /api/verify), which never dispatch Server Actions.
 */
export function gateExempt(pathname: string, method: string, nextAction: boolean): boolean {
  if (pathname === MCP_PATH) return true;
  if (pathname === GATE_PATH || pathname === VERIFY_PATH) {
    return (method === 'GET' || method === 'HEAD') && !nextAction;
  }
  if (pathname.startsWith(KEYS_PREFIX) && !pathname.slice(KEYS_PREFIX.length).includes('/')) {
    return (method === 'GET' || method === 'HEAD') && !nextAction;
  }
  if (pathname.startsWith(API_V1_PREFIX)) return !nextAction;
  if (pathname === CRON_WEBHOOKS_PATH) return method === 'GET' && !nextAction;
  if (pathname === GATE_API_PATH || pathname === VERIFY_API_PATH) {
    return method === 'POST' && !nextAction;
  }
  return false;
}
