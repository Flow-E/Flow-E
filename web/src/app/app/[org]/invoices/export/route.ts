import { orgDownload } from '../../download';

/** Matched and accepted invoices as formula-safe CSV for accounting (any member). */
export async function GET(_request: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const date = new Date().toISOString().slice(0, 10);
  return orgDownload(async (store, user) => ({
    body: await store.invoiceCsv(org, user),
    type: 'text/csv; charset=utf-8',
    filename: `flow-e-invoices-${date}.csv`,
  }));
}
