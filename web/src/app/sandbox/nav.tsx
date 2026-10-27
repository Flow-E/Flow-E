'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/sandbox', label: 'Dashboard' },
  { href: '/sandbox/agent', label: 'Fake agent' },
  { href: '/sandbox/invoices', label: 'Invoices' },
  { href: '/sandbox/ledger', label: 'Ledger' },
  { href: '/sandbox/mandate', label: 'Mandate' },
] as const;

/** `reviewCount`: invoices waiting for a person, shown on the Invoices tab. */
export function SandboxTabs({ reviewCount = 0 }: { reviewCount?: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sandbox" className="-mb-px flex gap-1 overflow-x-auto">
      {TABS.map((t) => {
        const active =
          t.href === '/sandbox' ? pathname === '/sandbox' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${
              active ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            {t.label}
            {t.href === '/sandbox/invoices' && reviewCount > 0 ? (
              <span className="ml-1.5 rounded-full bg-review-soft px-1.5 text-xs text-review">
                {reviewCount}
                <span className="sr-only"> need review</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
