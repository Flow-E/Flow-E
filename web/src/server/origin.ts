import 'server-only';
import { headers } from 'next/headers';

/**
 * This site's origin for links in emails and connection instructions. FLOWE_SITE_URL wins when
 * set (set it in production, so a forged Host header cannot change links); otherwise the
 * request's host.
 */
export async function siteOrigin(): Promise<string> {
  const fixed = process.env.FLOWE_SITE_URL?.replace(/\/+$/, '');
  if (fixed) return fixed;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3150';
  const proto =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
