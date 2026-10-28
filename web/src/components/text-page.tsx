import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

/** A plain text page (legal drafts, security): site header, one column of prose, footer. */
export function TextPage({
  title,
  intro,
  draft = false,
  children,
}: {
  title: string;
  intro?: ReactNode;
  /** A draft for a lawyer: shows a banner and the open points marked [TO CONFIRM]. */
  draft?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-12 sm:px-6 sm:py-16">
        {draft ? (
          <p
            role="note"
            className="rounded-lg border border-review/40 bg-review-soft px-4 py-2.5 text-sm text-ink"
          >
            <strong className="font-semibold">Draft, not yet reviewed by a lawyer.</strong> Points
            marked [TO CONFIRM] are open. Do not rely on this text yet.
          </p>
        ) : null}
        <h1 className="font-serif text-3xl tracking-[-0.015em] sm:text-4xl">{title}</h1>
        {intro ? <div className="text-lg text-ink-2">{intro}</div> : null}
        <div className="space-y-5 text-ink-2 [&_h2]:pt-4 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:text-ink [&_li]:mt-1 [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
