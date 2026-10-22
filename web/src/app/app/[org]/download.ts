import 'server-only';
import type { OrgStore, User } from '@/server/org-store';
import { ForbiddenError } from '@/server/permissions';
import { getOrgStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/** A file download for members of one organisation; 404 for everyone else. */
export async function orgDownload(
  build: (
    store: OrgStore,
    user: User,
  ) => Promise<{ body: string; type: string; filename: string } | null>,
): Promise<Response> {
  const session = await getSession();
  if (!session) return new Response('Sign in first.', { status: 401 });
  try {
    const file = await build(await getOrgStore(), { userId: session.userId, email: session.email });
    if (!file) return new Response('Not found.', { status: 404 });
    return new Response(file.body, {
      headers: {
        'Content-Type': file.type,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response('Not found.', { status: 404 });
    throw err;
  }
}
