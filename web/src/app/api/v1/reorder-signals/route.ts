import { newApiLimiter, withApiKey } from '@/server/api-auth';
import { postSignal } from '@/server/api-v1';
import { getV1Stores } from '@/server/runtime';

/** POST /api/v1/reorder-signals (scope reorder:write): adds a suggestion, never buys. */

export const dynamic = 'force-dynamic';
const limiter = newApiLimiter();

export async function POST(request: Request): Promise<Response> {
  const deps = { ...(await getV1Stores()), limiter };
  return withApiKey(request, deps, 'reorder:write', (caller) => postSignal(request, caller, deps));
}
