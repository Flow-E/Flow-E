import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronDown, Power } from 'lucide-react';
import { Logo, Pill, buttonClass } from '@/components/ui';
import { ROLE_LABEL } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { signOut } from '../../login/actions';
import { OrgTabs } from './nav';

export const metadata: Metadata = { title: { default: 'Organisation', template: '%s · Flow-E' } };

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const { user, store, view } = await orgView(org);
  const orgs = await store.listOrgs(user);
  const killed = view.controls.killSwitch?.on === true;

  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule bg-surface print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 sm:px-6">
          <Link href="/app" aria-label="All organisations" className="rounded-md">
            <Logo />
          </Link>
          {/* Organisation switcher: plain links, works without JavaScript. */}
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg px-2 py-1 font-medium text-ink hover:bg-sunken">
              <span className="max-w-[12rem] truncate sm:max-w-[20rem]">{view.name}</span>
              <ChevronDown size={14} aria-hidden="true" />
              <span className="sr-only">Switch organisation</span>
            </summary>
            <ul className="absolute left-0 z-10 mt-1 w-64 rounded-lg border border-rule bg-surface py-1 shadow-sm">
              {orgs.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/app/${o.id}`}
                    aria-current={o.id === view.id ? 'page' : undefined}
                    className="block truncate px-3 py-2 text-sm text-ink hover:bg-sunken aria-[current=page]:font-semibold"
                  >
                    {o.name}
                  </Link>
                </li>
              ))}
              <li className="border-t border-rule">
                <Link href="/app" className="block px-3 py-2 text-sm text-accent hover:bg-sunken">
                  New organisation…
                </Link>
              </li>
              <li>
                <Link
                  href="/sandbox"
                  className="block px-3 py-2 text-sm text-ink-2 hover:bg-sunken"
                >
                  Sandbox
                </Link>
              </li>
            </ul>
          </details>
          <Pill tone={view.role === 'viewer' ? 'neutral' : 'accent'}>{ROLE_LABEL[view.role]}</Pill>
          {killed ? (
            <Pill tone="declined">
              <Power size={12} aria-hidden="true" /> Kill switch on
            </Pill>
          ) : null}
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden max-w-[16rem] truncate text-ink-3 sm:inline">{user.email}</span>
            <form action={signOut}>
              <button type="submit" className={buttonClass('quiet', 'sm')}>
                Sign out
              </button>
            </form>
          </div>
          <div className="w-full">
            <OrgTabs base={`/app/${view.id}`} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-ink-3 sm:px-6">
        {view.name} · issuer <span className="font-mono">{view.issuer}</span> · Flow-E authorizes
        payments; it never moves money.
      </footer>
    </div>
  );
}
