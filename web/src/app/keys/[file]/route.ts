import { handleKey } from '@/server/published-keys';
import { getDb } from '@/server/runtime';

/**
 * Published issuer public keys: /keys/<issuer>.pub (PEM) and /keys/<issuer>.json. Public, no
 * sign-in and no site password (see gateExempt in src/server/gate.ts).
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  return handleKey(decodeURIComponent(file), await getDb());
}
