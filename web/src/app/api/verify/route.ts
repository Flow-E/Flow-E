import { handleVerify, newVerifyLimits } from '@/server/public-verify';
import { getDb } from '@/server/runtime';

/**
 * The public receipt check: POST /api/verify with the receipt as the body. No sign-in and no
 * site password (see gateExempt in src/server/gate.ts); rate-limited and size-capped. A route
 * handler on purpose: a Server Action on an ungated page could be used to call any other action.
 */

export const dynamic = 'force-dynamic';

const limits = newVerifyLimits();

export async function POST(request: Request): Promise<Response> {
  return handleVerify(request, { sql: await getDb(), limits });
}
