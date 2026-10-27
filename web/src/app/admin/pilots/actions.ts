'use server';

import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PILOT_STATUSES, isPilotAdmin, setPilotStatus } from '@/server/pilot';
import { getDb } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * Mark a pilot request. A Server Action: the page is behind the preview password and sign-in,
 * and Next.js refuses Server Action posts whose Origin does not match the host (CSRF). Who may
 * act is read from the session and FLOWE_ADMIN_EMAILS here again, never from the form.
 */
const input = z.object({ id: z.uuid(), status: z.enum(PILOT_STATUSES) });

export async function markPilot(form: FormData): Promise<void> {
  const session = await getSession();
  if (!isPilotAdmin(session)) notFound();
  const parsed = input.safeParse({ id: form.get('id'), status: form.get('status') });
  if (!parsed.success || !session) return;
  await setPilotStatus(await getDb(), parsed.data.id, parsed.data.status, session.email);
  revalidatePath('/admin/pilots');
}
