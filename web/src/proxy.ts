import { NextResponse, type NextRequest } from 'next/server';
import { GATE_COOKIE, verifyGateToken } from './server/gate';

const MCP_PATH = '/api/mcp';

/**
 * Runs before every page: a per-request CSP nonce (no inline script runs without it), security
 * headers, and the site password gate while SITE_PASSWORD is set.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const password = process.env.SITE_PASSWORD;

  // /api/mcp is for agents, authenticated by their API key; it is the only path that skips the
  // password gate. Exact match: /api/mcp/anything is still gated.
  if (password && pathname !== '/gate' && pathname !== MCP_PATH) {
    const ok = await verifyGateToken(password, request.cookies.get(GATE_COOKIE)?.value, Date.now());
    if (!ok) {
      const url = request.nextUrl.clone();
      url.pathname = '/gate';
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return withSecurityHeaders(NextResponse.redirect(url, 303), csp(nonce()));
    }
  }

  const n = nonce();
  const policy = csp(n);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', n);
  requestHeaders.set('Content-Security-Policy', policy);
  return withSecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), policy);
}

function nonce(): string {
  return btoa(crypto.randomUUID());
}

function csp(n: string): string {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    // Scripts only with this request's nonce; React needs eval only in development.
    `script-src 'self' 'nonce-${n}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Next.js and React set inline style attributes; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

function withSecurityHeaders(response: NextResponse, policy: string): NextResponse {
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  return response;
}

// Prefetch requests are NOT excluded: a client controls that header, so excluding it would let
// anyone skip the password gate.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
