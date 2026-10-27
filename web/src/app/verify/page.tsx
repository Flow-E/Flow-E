import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-chrome';
import { Logo } from '@/components/ui';
import { OfflineSteps, PublicVerifyForm } from './verify-form';

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
          <h2 className="text-base font-semibold text-ink">What this check uses</h2>
          <p className="text-sm text-ink-2">
            Only the receipt you paste. This site confirms whether the receipt’s issuer is a Flow-E
            organisation here, shows that organisation’s name, and checks the signature with its
            public key. It shows nothing else about the organisation, and it does not keep your
            receipt.
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
