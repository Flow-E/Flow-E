import { orgDownload } from '../../../download';

/** Download one of the organisation's receipts as JSON (any member). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ org: string; id: string }> },
) {
  const { org, id } = await params;
  return orgDownload(async (store, user) => {
    const detail = await store.payment(org, user, id);
    if (!detail) return null;
    return {
      body: JSON.stringify(detail.receipt, null, 2) + '\n',
      type: 'application/json; charset=utf-8',
      filename: `receipt-${detail.payment.paymentId}.json`,
    };
  });
}
