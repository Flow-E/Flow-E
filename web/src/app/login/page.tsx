import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FictionalNote, Logo } from '@/components/ui';
import { safeNext } from '@/lib/next-path';
import { authMode, getSession } from '@/server/session';
import { DevLoginForm, EmailLinkForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  if (await getSession()) redirect(next);
  const mode = authMode();
  const sandbox = next.startsWith('/sandbox');
  // Messages come from our own /auth/callback; cap the length and render as text only.
  const raw = params.error;
  const callbackError = typeof raw === 'string' ? raw.slice(0, 200) : undefined;
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="Flow-E home" className="rounded-md">
          <Logo />
        </Link>
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">
          {sandbox ? 'Open the sandbox' : 'Sign in to Flow-E'}
        </h1>
        <p className="mt-2 text-ink-2">
          {sandbox
            ? 'Your own fictional company with two AI agents, a mandate, and a signed ledger to try everything Flow-E does.'
            : 'Sign in to continue to your organisation, invitation or approval.'}
        </p>
        {mode === 'dev' ? (
          <DevLoginForm next={next} />
        ) : mode === 'supabase' ? (
          <EmailLinkForm initialError={callbackError} next={next} />
        ) : (
          <p
            role="status"
            className="mt-6 rounded-lg border border-rule bg-surface px-4 py-3 text-sm text-ink-2"
          >
            Sign-in is not configured on this server.
          </p>
        )}
        {sandbox ? <FictionalNote className="mt-6" /> : null}
      </div>
    </main>
  );
}
