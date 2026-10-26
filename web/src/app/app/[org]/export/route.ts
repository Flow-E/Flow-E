import { dashboardCsv } from '@/server/dashboard-export';
import { orgDownload } from '../download';

/**
 * The organisation's ledger as formula-safe CSV (any member): the whole ledger, or with
 * `?period=…&agent=…` only what the dashboard shows for that view.
 */
export async function GET(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const query = new URL(request.url).searchParams;
  const date = new Date().toISOString().slice(0, 10);
  return orgDownload(async (store, user) => {
    if (query.has('period')) {
      const filtered = dashboardCsv(await store.view(org, user), query, Date.now());
      if (filtered) {
        return {
          body: filtered.body,
          type: 'text/csv; charset=utf-8',
          filename: `flow-e-${filtered.suffix}-${date}.csv`,
        };
      }
    }
    return {
      body: await store.csv(org, user),
      type: 'text/csv; charset=utf-8',
      filename: `flow-e-ledger-${date}.csv`,
    };
  });
}
