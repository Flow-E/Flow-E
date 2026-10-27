import Link from 'next/link';
import { Panel } from '@/components/ui';
import { dateTime } from '@/lib/format';
import type { MandateChangeView } from '@/lib/mandate-changes';

/** The latest saved changes to the mandate, from the ledger. */
export function MandateChanges({
  changes,
  timezone,
  ledgerHref,
}: {
  changes: readonly MandateChangeView[];
  timezone: string;
  ledgerHref: string;
}) {
  return (
    <Panel
      title="Recent changes"
      description="Every saved change is signed into the ledger with who made it and the values before and after."
      action={
        <Link href={ledgerHref} className="text-sm text-accent underline">
          Full ledger
        </Link>
      }
    >
      {changes.length === 0 ? (
        <p className="text-sm text-ink-2">No changes saved yet.</p>
      ) : (
        <ol className="divide-y divide-rule">
          {changes.map((c, i) => (
            <li key={`${c.at}-${String(i)}`} className="py-3 text-sm first:pt-0 last:pb-0">
              <p className="text-ink">
                <span className="font-medium">{c.by}</span>{' '}
                <span className="text-ink-3">· {dateTime(c.at, timezone)}</span>
              </p>
              {c.note ? <p className="mt-0.5 text-ink-2">“{c.note}”</p> : null}
              {c.lines.length === 0 ? null : (
                <ul className="mt-1.5 space-y-1">
                  {c.lines.map((l, j) => (
                    <li key={`${l.label}-${String(j)}`} className="min-w-0 break-words text-ink-2">
                      <span className="text-ink">{l.label}</span>
                      {l.before === null ? (
                        <span className="text-ink-3"> changed</span>
                      ) : (
                        <>
                          : <span className="tabular text-ink-3 line-through">{l.before}</span>{' '}
                          <span aria-label="changed to">→</span>{' '}
                          <span className="tabular text-ink">{l.after}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
