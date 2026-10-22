import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FictionalNote, Logo } from '@/components/ui';
import { authMode, getSession } from '@/server/session';
import { DevLoginForm, EmailLinkForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (await getSession()) redirect('/sandbox');
  const mode = authMode();
  // Messages come from our own /auth/callback; cap the length and render as text only.
  const raw = (await searchParams).error;
  const callbackError = typeof raw === 'string' ? raw.slice(0, 200) : undefined;
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="Flow-E home" className="rounded-md">
          <Logo />
        </Link>
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">Open the sandbox</h1>
        <p className="mt-2 text-ink-2">
          Your own fictional company with two AI agents, a mandate, and a signed ledger to try
          everything Flow-E does.
        </p>
        {mode === 'dev' ? (
          <DevLoginForm />
        ) : mode === 'supabase' ? (
          <EmailLinkForm initialError={callbackError} />
        ) : (
          <p
            role="status"
            className="mt-6 rounded-lg border border-rule bg-surface px-4 py-3 text-sm text-ink-2"
          >
            Sign-in is not configured on this server.
          </p>
        )}
        <FictionalNote className="mt-6" />
      </div>
    </main>
  );
}
