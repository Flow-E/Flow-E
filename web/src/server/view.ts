import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getStore } from './runtime';
import { getSession } from './session';

/** The signed-in user's sandbox view, loaded once per request (layout and page share it). */
export const sandboxView = cache(async () => {
  const session = await getSession();
  if (!session) redirect('/login');
  const store = await getStore();
  // Here, not in the layout: layouts and pages render in parallel, so creation must happen in
  // the one loader both of them await.
  await store.ensureSandbox(session.userId);
  return { session, store, view: await store.view(session.userId) };
});
