import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo, buttonClass } from '@/components/ui';
import { safeNext } from '@/lib/next-path';
import { requireUser } from '@/server/org-view';
import { CHALLENGE_PATH, getMfaStore } from '@/server/strong-session';
import { signOut } from '../../login/actions';
import { verifyMfaAction } from '../actions';
import { VerifyForm } from '../client';

export const metadata: Metadata = { title: 'Enter code', robots: { index: false } };

/** The second-factor challenge: a code from the app (or a recovery code), then on to `next`. */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeNext((await searchParams).next, '/app');
  const user = await requireUser(`${CHALLENGE_PATH}?next=${encodeURIComponent(next)}`);
  // Nothing to check without an app; the protected action will ask to set one up.
  if (!(await (await getMfaStore()).isEnabled(user.userId))) redirect(next);

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link href="/app" aria-label="Flow-E" className="rounded-md">
          <Logo />
        </Link>
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">Enter your code</h1>
        <p className="mt-2 text-ink-2">
          Open your authenticator app and enter the 6-digit code for Flow-E. Lost your phone? Use
          one of your recovery codes.
        </p>
        <VerifyForm action={verifyMfaAction} next={next} />
        <div className="mt-8 flex items-center justify-between gap-3 text-xs text-ink-3">
          <span className="min-w-0 truncate">Signed in as {user.email}</span>
          <form action={signOut}>
            <button type="submit" className={buttonClass('quiet', 'sm')}>
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
