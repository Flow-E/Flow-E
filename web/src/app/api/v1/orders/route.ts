import { newApiLimiter, withApiKey } from '@/server/api-auth';
import { listOrders } from '@/server/api-v1';
import { getV1Stores } from '@/server/runtime';

/** GET /api/v1/orders (scope read): approved payments with an order, newest first. */

export const dynamic = 'force-dynamic';
const limiter = newApiLimiter();

export async function GET(request: Request): Promise<Response> {
  const deps = { ...(await getV1Stores()), limiter };
  return withApiKey(request, deps, 'read', async (caller) =>
    listOrders(await deps.orgs.systemView(caller.orgId), new URL(request.url)),
  );
}
