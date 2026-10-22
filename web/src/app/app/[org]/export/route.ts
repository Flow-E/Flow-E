import { orgDownload } from '../download';

/** The organisation's whole ledger as formula-safe CSV (any member). */
export async function GET(_request: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  return orgDownload(async (store, user) => ({
    body: await store.csv(org, user),
    type: 'text/csv; charset=utf-8',
    filename: `flow-e-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
  }));
}
