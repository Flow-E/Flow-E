import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-chrome';
import { Logo } from '@/components/ui';
import { OfflineSteps, PublicVerifyForm, WhatItProves } from './verify-form';

export const metadata: Metadata = {
  title: 'Check a receipt',
  description: 'Was this purchase authorized? Check a Flow-E receipt. No sign-in needed.',
};

/**
 * Public: no sign-in and no site password (see gateExempt in src/server/gate.ts). The page has
 * no Server Actions; the form posts to /api/verify.
 */
export default function VerifyPage() {
  return (
    <>
      <header className="border-b border-rule bg-paper/90">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-4 sm:px-6">
          <Logo />
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6 sm:py-14">
        <div>
          <h1 className="font-serif text-3xl tracking-[-0.015em] sm:text-4xl">
            Was this purchase authorized?
          </h1>
          <p className="mt-3 text-ink-2">
            Paste a Flow-E receipt or open the receipt file. You see whether Flow-E really signed
            it, and what it says: who asked, how much, to which supplier, and the decision. No
            sign-in needed.
          </p>
          <p className="mt-3 rounded-lg border border-rule bg-surface px-4 py-3 text-sm text-ink-2">
            <strong className="font-semibold text-ink">
              Flow-E authorizes payments; it never moves money.
            </strong>{' '}
            A valid receipt shows what the buyer’s rules decided. It is not proof that money was
            paid.
          </p>
        </div>

        <PublicVerifyForm />

        <section className="space-y-3 border-t border-rule pt-6">
          <h2 className="text-base font-semibold text-ink">What a receipt proves, and what not</h2>
          <WhatItProves />
        </section>

        <section className="space-y-3 border-t border-rule pt-6">
          <h2 className="text-base font-semibold text-ink">What this check uses</h2>
          <p className="text-sm text-ink-2">
            Only the receipt you paste and the organisation’s public key: the one it published on
            this site at <span className="font-mono text-xs">/keys/&lt;issuer id&gt;.pub</span>, or
            one you paste. The name shown is the one published with that key. No account data is
            looked up, nothing is searched, and your receipt is not kept. Checks are limited per
            minute.
          </p>
          <details className="rounded-lg border border-rule bg-surface px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Check a receipt yourself, offline
            </summary>
            <div className="mt-3">
              <OfflineSteps />
            </div>
          </details>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
