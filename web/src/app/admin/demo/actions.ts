'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { leaveDemoOrgs, seedDemoOrg } from '@/server/demo-org';
import { encryptionKeyFromEnv } from '@/server/keys';
import { isPilotAdmin } from '@/server/pilot';
import { getDb } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * Create, or reset, the demo organisation "Lab Alpha (fictional)". Admins only
 * (FLOWE_ADMIN_EMAILS), read from the session here again, never from the form. Reset leaves
 * the earlier Lab Alpha (its ledger stays, unreachable) and builds a fresh one up to now.
 */
export async function seedDemoAction(form: FormData): Promise<void> {
  const session = await getSession();
  if (!session || !isPilotAdmin(session)) notFound();
  const db = await getDb();
  const user = { userId: session.userId, email: session.email };
  if (form.get('reset') === 'true') await leaveDemoOrgs(db, user);
  const orgId = await seedDemoOrg({
    db,
    encryptionKey: encryptionKeyFromEnv(),
    user,
    now: Date.now(),
  });
  revalidatePath('/app', 'layout');
  redirect(`/app/${orgId}`);
}
