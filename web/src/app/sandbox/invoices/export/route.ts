import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/** The sandbox's matched and accepted invoices as formula-safe CSV (fictional data). */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  const store = await getStore();
  await store.ensureSandbox(session.userId);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(await store.invoiceCsv(session.userId), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="flow-e-sandbox-invoices-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
