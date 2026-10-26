import { dashboardCsv } from '@/server/dashboard-export';
import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * The signed-in user's sandbox ledger as formula-safe CSV: the whole ledger, or with
 * `?period=…&agent=…` only what the dashboard shows for that view.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  const store = await getStore();
  const date = new Date().toISOString().slice(0, 10);
  const params = new URL(request.url).searchParams;
  const view = params.has('period') ? await store.view(session.userId) : null;
  const filtered = view ? dashboardCsv(view, params, Date.now()) : null;
  const csv = filtered?.body ?? (await store.csv(session.userId));
  const name = filtered
    ? `flow-e-sandbox-${filtered.suffix}-${date}`
    : `flow-e-sandbox-ledger-${date}`;
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
