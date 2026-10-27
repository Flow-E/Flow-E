import { mailerFromEnv } from '@/server/email';
import { siteOrigin } from '@/server/origin';
import { handlePilot, newPilotLimits } from '@/server/pilot';
import { getDb } from '@/server/runtime';

/**
 * The pilot request form on the home page posts here and is sent back with a 303. A route
 * handler on purpose: it works without JavaScript, and route handlers never dispatch Server
 * Actions (see the note in src/server/gate.ts). Still behind the preview password.
 */

export const dynamic = 'force-dynamic';

const limits = newPilotLimits();

export async function POST(request: Request): Promise<Response> {
  const sql = await getDb();
  return handlePilot(request, {
    sql,
    limits,
    mailer: () => mailerFromEnv(sql),
    origin: await siteOrigin().catch(() => null),
  });
}
