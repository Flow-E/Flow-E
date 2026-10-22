import { getStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/** The sandbox's issuer PUBLIC key (PEM): all an auditor needs to verify receipts offline. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  const view = await (await getStore()).view(session.userId);
  return new Response(view.publicKeyPem, {
    headers: {
      'Content-Type': 'application/x-pem-file; charset=utf-8',
      'Content-Disposition': 'attachment; filename="issuer.pub"',
      'Cache-Control': 'no-store',
    },
  });
}
