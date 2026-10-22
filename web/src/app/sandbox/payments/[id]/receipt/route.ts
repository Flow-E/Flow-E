import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/** Download one of the signed-in user's receipts as JSON. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  const { id } = await params;
  const detail = await (await getStore()).payment(session.userId, id);
  if (!detail) return new Response('No such payment.', { status: 404 });
  return new Response(JSON.stringify(detail.receipt, null, 2) + '\n', {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="receipt-${detail.payment.paymentId}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
