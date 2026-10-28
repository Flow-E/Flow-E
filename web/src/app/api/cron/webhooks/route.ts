import { timingSafeEqual } from 'node:crypto';
import { getApiKeyStore, getWebhookStore } from '@/server/runtime';

/**
 * Vercel Cron, every minute (vercel.json): turns new ledger entries into webhook deliveries,
 * sends what is due (first tries and retries) and deletes access-log rows older than 90 days.
 * Vercel sends "Authorization: Bearer <CRON_SECRET>"; without that secret nothing runs.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return new Response('Not allowed.\n', { status: 401 });
  const webhooks = await getWebhookStore();
  const queued = await webhooks.enqueue();
  const sent = await webhooks.deliverDue();
  await (await getApiKeyStore()).purgeAccessLog();
  return Response.json({ queued, sent }, { headers: { 'cache-control': 'no-store' } });
}
