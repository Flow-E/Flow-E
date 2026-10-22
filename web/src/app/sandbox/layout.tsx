import type { Metadata } from 'next';
import Link from 'next/link';
import { Power } from 'lucide-react';
import { Logo, Pill, buttonClass } from '@/components/ui';
import { sandboxView } from '@/server/view';
import { signOut } from '../login/actions';
import { SandboxTabs } from './nav';

export const metadata: Metadata = { title: { default: 'Sandbox', template: '%s · Flow-E' } };

export default async function SandboxLayout({ children }: { children: React.ReactNode }) {
  const { session, view } = await sandboxView();
  const killed = view.controls.killSwitch?.on === true;

  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 sm:px-6">
          <Link href="/" aria-label="Flow-E home" className="rounded-md">
            <Logo />
          </Link>
          <Pill tone="accent">Sandbox · fictional money</Pill>
          {killed ? (
            <Pill tone="declined">
              <Power size={12} aria-hidden="true" /> Kill switch on
            </Pill>
          ) : null}
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden max-w-[16rem] truncate text-ink-3 sm:inline">
              {session.email}
            </span>
            <form action={signOut}>
              <button type="submit" className={buttonClass('quiet', 'sm')}>
                Sign out
              </button>
            </form>
          </div>
          <div className="w-full">
            <SandboxTabs />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-ink-3 sm:px-6">
        {view.organisation ?? 'Fictional organisation'} · issuer{' '}
        <span className="font-mono">{view.issuer}</span> · Flow-E authorizes payments; it never
        moves money.
      </footer>
    </div>
  );
}
