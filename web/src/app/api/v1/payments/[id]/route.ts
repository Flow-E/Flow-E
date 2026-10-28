import { newApiLimiter, withApiKey } from '@/server/api-auth';
import { getPayment } from '@/server/api-v1';
import { getV1Stores } from '@/server/runtime';

/** GET /api/v1/payments/{id} (scope read): one payment of the key's organisation. */

export const dynamic = 'force-dynamic';
const limiter = newApiLimiter();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const deps = { ...(await getV1Stores()), limiter };
  return withApiKey(request, deps, 'read', async (caller) =>
    getPayment(await deps.orgs.systemView(caller.orgId), id),
  );
}
