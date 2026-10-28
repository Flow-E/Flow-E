import type { ReactNode } from 'react';
import Link from 'next/link';
import { Pill, buttonClass } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { declinedText } from '@/components/dashboard';
import { dateTime, money } from '@/lib/format';
import {
  MAX_MINUTES_PER_APPROVAL,
  MINUTES_PER_APPROVAL,
  PERIOD_LABELS,
  workSaved,
  type Period,
  type ValueReport,
} from '@/server/analytics';
import type { BudgetOutlook } from '@/server/budget-outlook';

const REPORT_PERIODS: readonly Period[] = ['7d', '30d', '90d'];

/** One figure with the way it was counted right under it. Never a number without its method. */
function Figure({
  label,
  value,
  detail,
  method,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  method: string;
}) {
  return (
    <div className="min-w-0 break-inside-avoid rounded-xl border border-rule bg-surface px-4 py-4 print:border-ink-3 sm:px-5">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="mt-1 break-words text-2xl font-semibold tracking-tight text-ink">{value}</dd>
      {detail ? <dd className="mt-1 text-sm text-ink-2">{detail}</dd> : null}
      <dd className="mt-2 border-t border-rule pt-2 text-xs text-ink-3">
        <span className="font-medium text-ink-2">How it is counted: </span>
        {method}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 break-inside-avoid">
      <h2 className="font-serif text-xl text-ink">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The printable value report: what Flow-E decided, stopped and caught in a period, computed from
 * the ledger alone, with the method next to every number.
 */
export function ValueReportPage({
  organisation,
  report,
  outlook,
  period,
  from,
  to,
  generatedAt,
  timezone,
  currency,
  decimals,
  basePath,
  fictional,
}: {
  organisation: string;
  report: ValueReport;
  outlook: readonly BudgetOutlook[];
  period: Period;
  from: string;
  to: string;
  generatedAt: string;
  timezone: string;
  currency: string;
  decimals?: Readonly<Record<string, number>>;
  /** The report's own path, for the period links and the minutes form. */
  basePath: string;
  fictional: boolean;
}) {
  const fmt = (minor: number) => money(minor, currency, decimals);
  const minutes = report.minutesPerApproval;
  const inv = report.invoices;
  const caught = inv ? inv.mismatch + inv.unmatched + inv.duplicate : 0;
  const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  const href = (p: Period) =>
    `${basePath}?${new URLSearchParams({
      period: p,
      ...(minutes === MINUTES_PER_APPROVAL ? {} : { minutes: String(minutes) }),
    }).toString()}`;

  return (
    <article className="mx-auto max-w-4xl space-y-8 text-ink">
      <header className="space-y-2">
        <p className="text-sm text-ink-3">
          Flow-E value report{fictional ? ' · fictional data' : ''}
        </p>
        <h1 className="font-serif text-3xl tracking-tight sm:text-4xl">{organisation}</h1>
        <p className="text-ink-2">
          {from === to ? from : `${from} to ${to}`} ({PERIOD_LABELS[period].toLowerCase()}).
          Computed only from the signed ledger. Generated {dateTime(generatedAt, timezone)} (
          {timezone}).
        </p>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-rule bg-sunken px-4 py-4 print:hidden sm:px-5">
        <nav aria-label="Period" className="flex flex-wrap gap-1.5">
          {REPORT_PERIODS.map((p) => (
            <Link
              key={p}
              href={href(p)}
              aria-current={p === period ? 'page' : undefined}
              className={buttonClass(p === period ? 'primary' : 'secondary', 'sm')}
            >
              {PERIOD_LABELS[p]}
            </Link>
          ))}
        </nav>
        <form method="get" action={basePath} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="period" value={period} />
          <label className="text-sm text-ink-2">
            <span className="block">Minutes per manual approval</span>
            <input
              type="number"
              name="minutes"
              min={0}
              max={MAX_MINUTES_PER_APPROVAL}
              step={1}
              defaultValue={minutes}
              className="mt-1 w-24 rounded-lg border border-rule-strong bg-surface px-3 py-1.5 font-mono text-ink"
            />
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Recalculate
          </button>
        </form>
        <PrintButton />
      </div>

      {report.requests === 0 ? (
        <p className="rounded-xl border border-rule bg-surface px-4 py-6 text-center text-ink-2">
          No agent asked Flow-E for a payment in this period, so there is nothing to report yet.
        </p>
      ) : (
        <>
          <Section title="Decisions">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Figure
                label="Decided automatically"
                value={
                  <>
                    {report.autoDecided}
                    <span className="text-base font-normal text-ink-3"> of {report.requests}</span>
                  </>
                }
                method="Requests Flow-E approved or declined on its own: every request in the period minus those sent to a person."
              />
              <Figure
                label="Sent to a person"
                value={report.sentToHuman}
                method="Requests the rules held for a human decision (above the approval threshold, a possible split, a price far from usual)."
              />
              <Figure
                label="Approval work saved"
                value={workSaved(report.minutesSaved)}
                detail={`${String(report.autoDecided)} × ${String(minutes)} min`}
                method={`An estimate, not a measurement: decided automatically × ${String(minutes)} minutes per manual approval. That figure is an assumption; change it above.`}
              />
            </dl>
          </Section>

          <Section title="What was stopped">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Figure
                label="Declined by Flow-E"
                value={report.stopped.count}
                detail={report.stopped.count > 0 ? declinedText(report.stopped, fmt) : 'None'}
                method="Requests the engine declined, by the first rule that said no. Amounts in other currencies are converted at the mandate's rate; ones without a rate are counted but not summed."
              />
              <Figure
                label="Overpayment avoided"
                value={fmt(report.overpaymentAvoided.over)}
                detail={plural(report.overpaymentAvoided.count, 'request', 'requests')}
                method="Only items with a usual price: for requests flagged as far above it and then declined or cancelled (never paid), the amount above the usual price, summed in the base currency."
              />
            </dl>
            {report.stopped.byCategory.length > 0 ? (
              <ul className="divide-y divide-rule rounded-xl border border-rule bg-surface">
                {report.stopped.byCategory.map((c) => (
                  <li
                    key={c.category}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                  >
                    <span className="text-ink">{c.label}</span>
                    <span className="tabular font-mono text-ink-2">
                      {c.count} · {fmt(c.amount)}
                      {c.unconverted > 0 ? ` + ${String(c.unconverted)} not converted` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </>
      )}

      {inv ? (
        <Section title="Invoices">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Figure
              label="Invoice problems caught"
              value={
                <>
                  {caught}
                  <span className="text-base font-normal text-ink-3"> of {inv.recorded}</span>
                </>
              }
              detail={
                inv.recorded === 0
                  ? 'No invoices recorded in this period'
                  : `${plural(inv.mismatch, 'amount mismatch', 'amount mismatches')}, ${plural(inv.unmatched, 'without an authorization', 'without an authorization')}, ${plural(inv.duplicate, 'duplicate', 'duplicates')}`
              }
              method="Invoices recorded in the period that did not match what Flow-E authorized: a different amount beyond the tolerance, no authorization found, or the same supplier and number twice."
            />
            <Figure
              label="Billed above the authorization"
              value={
                inv.overBilled.length === 0
                  ? fmt(0)
                  : inv.overBilled.map((o) => money(o.amount, o.currency, decimals)).join(' + ')
              }
              method="For amount mismatches not accepted by a person: the invoice amount minus the authorized amount, where the invoice is higher, summed per currency."
            />
          </dl>
        </Section>
      ) : null}

      <Section title="Budgets">
        {report.agents.length > 0 ? (
          <div className="break-inside-avoid rounded-xl border border-rule bg-surface px-4 py-4 sm:px-5">
            <h3 className="text-sm font-medium text-ink">Daily budgets</h3>
            <ul className="mt-2 divide-y divide-rule">
              {report.agents.map((a) => (
                <li
                  key={a.agentId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="text-ink">{a.name}</span>
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className="tabular font-mono text-ink-2">
                      {fmt(a.perWorkingDay)} / day
                      {a.dailyBudget > 0 ? (
                        <span className="text-ink-3"> of {fmt(a.dailyBudget)}</span>
                      ) : null}
                    </span>
                    {a.oftenNearDaily ? <Pill tone="review">Often near its budget</Pill> : null}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-rule pt-2 text-xs text-ink-3">
              <span className="font-medium text-ink-2">How it is counted: </span>
              approved spend in the period divided by its {report.workingDays} working{' '}
              {report.workingDays === 1 ? 'day' : 'days'} (Monday to Friday). Daily budgets reset
              every day, so they have no run-out day.
            </p>
          </div>
        ) : null}

        {outlook.length === 0 ? (
          <p className="text-sm text-ink-2">
            No monthly or project budgets are set, so there is no run-out day to project. Set them
            on the Mandate page.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-rule bg-surface">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs text-ink-3">
                  <th className="px-4 py-2 font-medium">Budget</th>
                  <th className="px-3 py-2 text-right font-medium">Used</th>
                  <th className="px-3 py-2 text-right font-medium">Pace per day</th>
                  <th className="px-4 py-2 text-right font-medium">Runs out</th>
                </tr>
              </thead>
              <tbody>
                {outlook.map((b) => (
                  <tr key={`${b.kind}:${b.label}`} className="border-b border-rule last:border-0">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <span className="block text-ink">{b.label}</span>
                      <span className="block text-xs text-ink-3">
                        {b.kind === 'month' ? 'Monthly budget' : 'Project'}
                        {b.windowEnds && b.kind === 'project' ? `, until ${b.windowEnds}` : ''}
                      </span>
                      <span className="block text-xs text-ink-3">{b.method}</span>
                    </th>
                    <td className="tabular px-3 py-2.5 text-right align-top font-mono text-ink-2">
                      {fmt(b.used)}
                      <span className="block text-xs text-ink-3">of {fmt(b.budget)}</span>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right align-top font-mono text-ink-2">
                      {fmt(b.perDay)}
                    </td>
                    <td className="px-4 py-2.5 text-right align-top">
                      {b.runsOut !== null ? (
                        <Pill tone={b.remaining === 0 ? 'declined' : 'review'}>
                          {b.remaining === 0 ? 'Used up' : b.runsOut}
                        </Pill>
                      ) : b.perDay === 0 ? (
                        <span className="text-ink-3">No spend yet</span>
                      ) : (
                        <span className="text-ink-2">
                          {b.windowEnds ? `Lasts until ${b.windowEnds}` : 'No end in sight'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="border-t border-rule pt-4 text-xs text-ink-3">
        Flow-E authorizes, matches and records purchases; it does not move money. Every number above
        is recomputed from the organisation&apos;s hash-chained ledger when the page loads.
      </p>
    </article>
  );
}
