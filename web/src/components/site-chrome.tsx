import Link from 'next/link';
import { ButtonLink, Logo } from './ui';

export const GITHUB_URL = 'https://github.com/Flow-E/Flow-E';

export function SiteHeader() {
  return (
    <header className="border-b border-rule bg-paper/90">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Flow-E home" className="rounded-md">
          <Logo />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 text-sm sm:gap-2">
          <Link href="/docs" className="rounded-md px-2 py-1.5 text-ink-2 hover:text-ink">
            Docs
          </Link>
          <a
            href={GITHUB_URL}
            className="hidden rounded-md px-2 py-1.5 text-ink-2 hover:text-ink sm:inline"
          >
            GitHub
          </a>
          <ButtonLink href="/sandbox" size="sm" className="ml-1">
            Try the sandbox
          </ButtonLink>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <Logo className="text-sm" />
          <span>Open source, MIT licence.</span>
        </div>
        <p className="max-w-xl">
          Flow-E authorizes payments; it never holds or moves money. The sandbox uses a fictional
          company, fictional suppliers and fictional money. Not legal advice and not a compliance
          product.
        </p>
      </div>
    </footer>
  );
}
