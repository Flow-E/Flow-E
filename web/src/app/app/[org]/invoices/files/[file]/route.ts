import { getOrgStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * Download a stored invoice file (any member of the organisation; 404 for everyone else).
 * Always as an attachment, never shown inline, so an uploaded file cannot run in this site.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ org: string; file: string }> },
) {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  const { org, file } = await params;
  try {
    const store = await getOrgStore();
    const found = await store.invoiceFile(
      org,
      { userId: session.userId, email: session.email },
      file,
    );
    if (!found) return new Response('Not found.', { status: 404 });
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        'Content-Type': found.mime,
        'Content-Length': String(found.bytes.length),
        // The stored name is already reduced to [A-Za-z0-9._-].
        'Content-Disposition': `attachment; filename="${found.filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    // By name: in development the cached store can come from an older copy of the modules.
    if (err instanceof Error && err.name === 'ForbiddenError') {
      return new Response('Not found.', { status: 404 });
    }
    throw err;
  }
}
