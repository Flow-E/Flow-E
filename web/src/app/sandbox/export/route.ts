import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/** The signed-in user's whole sandbox ledger as formula-safe CSV. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  const csv = await (await getStore()).csv(session.userId);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="flow-e-sandbox-ledger-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
