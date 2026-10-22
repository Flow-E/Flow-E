'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { path: '', label: 'Overview' },
  { path: '/agents', label: 'Agents' },
  { path: '/mandate', label: 'Mandate' },
  { path: '/members', label: 'Members' },
  { path: '/ledger', label: 'Ledger' },
  { path: '/settings', label: 'Settings' },
] as const;

export function OrgTabs({ base }: { base: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Organisation" className="-mb-px flex gap-1 overflow-x-auto">
      {TABS.map((t) => {
        const href = `${base}${t.path}`;
        const active = t.path === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={t.path}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${
              active ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
