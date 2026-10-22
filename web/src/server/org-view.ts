import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { loginUrl } from '@/lib/next-path';
import type { User } from './org-store';
import { ForbiddenError } from './permissions';
import { getOrgStore } from './runtime';
import { getSession } from './session';

/** The signed-in user, or a redirect to sign in that comes back to `next`. */
export async function requireUser(next: string): Promise<User> {
  const session = await getSession();
  if (!session) redirect(loginUrl(next));
  return { userId: session.userId, email: session.email };
}

/**
 * One organisation as the signed-in user may see it, loaded once per request (layout and page
 * share it). Not a member, or no such organisation: 404, the same either way.
 */
export const orgView = cache(async (orgId: string) => {
  const user = await requireUser(`/app/${orgId}`);
  const store = await getOrgStore();
  try {
    return { user, store, view: await store.view(orgId, user) };
  } catch (err) {
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
});
