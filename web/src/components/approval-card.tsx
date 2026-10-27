import Link from 'next/link';
import type { ReactNode } from 'react';
import type { PaymentRecord } from '@flow-e/mcp/core';
import { dateTime, money } from '@/lib/format';
import {
  approvalContextFor,
  type ApprovalContext,
  type ApprovalSource,
  type SpendEffect,
} from '@/server/approval-context';
import type { TraceStep } from '@/server/store';
import { DecisionButtons } from './approval-actions';
import { StatusPill } from './ui';

/**
 * The approval card: why Flow-E asked, the effect on the day's, the month's and the project's
 * budget, the supplier's history,
 * similar purchases and the usual price, then Approve / Decline. Mobile first. The numbers
 * come from src/server/approval-context.ts; the buttons use the existing resolve action, which
 * checks the person's role, so `canDecide` only decides what is shown.
 */

type Resolve = (
  prev: { ok?: string; error?: string },
  form: FormData,
) => Promise<{
  ok?: string;
  error?: string;
}>;

export interface ApprovalView extends ApprovalSource {
  baseCurrency: string;
  currencyDecimals: Readonly<Record<string, number>> | undefined;
}

interface Common {
  view: ApprovalView;
  /** Owner or approver (organisations); always true in the sandbox. */
  canDecide: boolean;
  action: Resolve;
  /** Extra hidden fields for the action, e.g. { org: view.id }. */
  fields?: Record<string, string>;
  /** Payment links: `${paymentHref}/${paymentId}`. */
  paymentHref: string;
}

function day(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

function monthName(month: string): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function BudgetBar({ b }: { b: SpendEffect }) {
  const scale = Math.max(b.budget, b.total, 1);
  const pct = (n: number) => `${String(Math.min(100, (Math.max(0, n) * 100) / scale))}%`;
  return (
    <div
      aria-hidden="true"
      className="relative mt-2 flex h-2.5 overflow-hidden rounded-full bg-sunken"
    >
      <span className="h-full bg-approve" style={{ width: pct(b.approved) }} />
      <span className="h-full bg-approve/40" style={{ width: pct(b.pending) }} />
      <span
        className={`h-full ${b.overBy > 0 ? 'bg-decline' : 'bg-review'}`}
        style={{ width: pct(b.thisPayment ?? 0) }}
      />
      {b.total > b.budget ? (
        <span className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: pct(b.budget) }} />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      <div className="mt-1.5 text-sm text-ink-2">{children}</div>
    </section>
  );
}

/** Total with this payment, the bar, the breakdown and what is left (or how much over). */
function SpendLines({
  e,
  base,
  over,
  left,
}: {
  e: SpendEffect;
  base: (n: number | null) => string;
  over: string;
  left: string;
}) {
  return (
    <>
      <p className="tabular">
        <span className="font-mono text-ink">{base(e.total)}</span> of{' '}
        <span className="font-mono">{base(e.budget)}</span> with this payment
      </p>
      <BudgetBar b={e} />
      <p className="tabular mt-1.5 text-xs text-ink-3">
        {base(e.approved)} approved · {base(e.pending)} other waiting · this {base(e.thisPayment)}
      </p>
      {e.overBy > 0 ? (
        <p className="mt-1 text-sm font-medium text-decline">
          {base(e.overBy)} {over}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-3">
          {base(e.budget - e.total)} {left}
        </p>
      )}
    </>
  );
}

/** The facts an approver needs, without the buttons. */
export function ApprovalFacts({
  ctx,
  payment,
  view,
  paymentHref,
}: {
  ctx: ApprovalContext;
  payment: PaymentRecord;
  view: ApprovalView;
  paymentHref: string;
}) {
  const d = view.currencyDecimals;
  const base = (n: number | null) => money(n, ctx.baseCurrency, d);
  const b = ctx.budget;
  const fp = ctx.fairPrice;
  return (
    <div className="space-y-4">
      <Section title="Why Flow-E asked">
        <ul className="space-y-2">
          {ctx.reasons.map((r, i) => (
            <li key={`${r.rule}-${String(i)}`}>
              <span className="block font-medium text-ink">{r.title}</span>
              <span className="block break-words">{r.detail}</span>
            </li>
          ))}
        </ul>
      </Section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title={b && !b.isToday ? `Budget on ${day(b.day, 'UTC')}` : 'Today’s budget'}>
          {b ? (
            <>
              <p className="tabular">
                <span className="font-mono text-ink">{base(b.total)}</span> of{' '}
                <span className="font-mono">{base(b.budget)}</span> with this payment
              </p>
              <BudgetBar b={b} />
              <p className="tabular mt-1.5 text-xs text-ink-3">
                {base(b.approved)} approved · {base(b.pending)} other waiting · this{' '}
                {base(b.thisPayment)}
              </p>
              {b.overBy > 0 ? (
                <p className="mt-1 text-sm font-medium text-decline">
                  {base(b.overBy)} over {payment.agentId}’s daily budget.
                </p>
              ) : (
                <p className="mt-1 text-xs text-ink-3">
                  {base(b.budget - b.total)} left for {payment.agentId} that day.
                </p>
              )}
            </>
          ) : (
            <p>This agent is no longer in the mandate, so it has no budgets.</p>
          )}
        </Section>

        {ctx.monthly ? (
          <Section
            title={
              ctx.monthly.isThisMonth ? 'This month' : `Budget in ${monthName(ctx.monthly.month)}`
            }
          >
            <SpendLines
              e={ctx.monthly}
              base={base}
              over={`over ${payment.agentId}’s monthly budget.`}
              left={`left for ${payment.agentId} that month.`}
            />
          </Section>
        ) : null}

        {ctx.project ? (
          <Section title="Project">
            {ctx.project.found ? (
              <>
                <p className="font-medium text-ink">
                  {ctx.project.name}{' '}
                  <span className="font-mono text-xs font-normal text-ink-3">{ctx.project.id}</span>
                </p>
                <SpendLines
                  e={ctx.project}
                  base={base}
                  over={`over the project’s budget${ctx.project.period === 'month' ? ' this month' : ''}.`}
                  left={
                    ctx.project.period === 'month'
                      ? `left in the project${ctx.project.month ? ` in ${monthName(ctx.project.month)}` : ''}.`
                      : 'left in the project’s total budget.'
                  }
                />
                {ctx.project.ends ? (
                  <p
                    className={`mt-1 text-xs ${ctx.project.ended ? 'font-medium text-decline' : 'text-ink-3'}`}
                  >
                    {ctx.project.ended ? 'Project ended on ' : 'Project ends on '}
                    {day(`${ctx.project.ends}T12:00:00Z`, 'UTC')}.
                  </p>
                ) : null}
              </>
            ) : (
              <p>
                Booked to “<span className="break-words">{ctx.project.named}</span>”, which is not a
                project in the mandate.
              </p>
            )}
          </Section>
        ) : null}

        <Section title="This supplier">
          {ctx.supplier.approvedCount === 0 ? (
            <p>
              <span className="font-medium text-ink">New supplier.</span> No approved payments to{' '}
              {payment.request.merchant} yet.
            </p>
          ) : (
            <p className="tabular">
              <span className="font-medium text-ink">
                {ctx.supplier.approvedCount} approved{' '}
                {ctx.supplier.approvedCount === 1 ? 'payment' : 'payments'}
              </span>
              , <span className="font-mono">{base(ctx.supplier.approvedTotal)}</span> in total
              {ctx.supplier.lastApprovedAt
                ? `, last on ${day(ctx.supplier.lastApprovedAt, view.timezone)}`
                : ''}
              .
            </p>
          )}
        </Section>
      </div>

      {fp ? (
        <Section title="Usual price">
          <p className="tabular">
            {fp.quantity === 1 ? '' : `${String(fp.quantity)} × `}
            {fp.item}: usually <span className="font-mono text-ink">{base(fp.expectedBase)}</span>.
            This is{' '}
            <span
              className={`font-mono font-medium ${fp.differenceBase > 0 ? 'text-decline' : 'text-review'}`}
            >
              {base(Math.abs(fp.differenceBase))} ({String(Math.abs(fp.differencePercent))}%){' '}
              {fp.differenceBase >= 0 ? 'more' : 'less'}
            </span>
            .
          </p>
        </Section>
      ) : null}

      <Section title="Similar purchases">
        {ctx.similar.length === 0 ? (
          <p>None yet: no earlier payment to this supplier or for this item.</p>
        ) : (
          <ul className="divide-y divide-rule rounded-lg border border-rule">
            {ctx.similar.map((s) => (
              <li key={s.paymentId} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <Link
                    href={`${paymentHref}/${s.paymentId}`}
                    className="block truncate text-ink hover:underline"
                  >
                    {s.merchant}
                  </Link>
                  <span className="block truncate text-xs text-ink-3">
                    {day(s.createdAt, view.timezone)}
                    {s.what ? ` · ${s.what}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="tabular font-mono text-ink">
                    {money(s.amount, s.currency, d)}
                  </span>
                  <StatusPill status={s.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Decide({
  canDecide,
  action,
  fields,
  payment,
}: Pick<Common, 'canDecide' | 'action' | 'fields'> & { payment: PaymentRecord }) {
  return canDecide ? (
    <DecisionButtons action={action} fields={{ ...fields, id: payment.paymentId }} />
  ) : (
    <p className="text-sm text-ink-3">
      An owner or approver decides. You can see it, not change it.
    </p>
  );
}

/** The full card on a payment's own page (payment in review). */
export function ApprovalCard({
  payment,
  trace,
  ...common
}: Common & { payment: PaymentRecord; trace?: readonly TraceStep[] }) {
  const ctx = approvalContextFor(common.view, payment, trace);
  return (
    <section
      aria-labelledby="approval-title"
      className="rounded-xl border border-review/30 bg-surface"
    >
      <header className="rounded-t-xl border-b border-review/30 bg-review-soft px-4 py-3 sm:px-5">
        <h2 id="approval-title" className="font-semibold text-review">
          Waiting for a decision
        </h2>
        <p className="mt-0.5 text-sm text-ink-2">
          {payment.agentId} asked on {dateTime(payment.createdAt, common.view.timezone)}.
        </p>
      </header>
      <div className="space-y-5 px-4 py-4 sm:px-5">
        <ApprovalFacts
          ctx={ctx}
          payment={payment}
          view={common.view}
          paymentHref={common.paymentHref}
        />
        <div className="border-t border-rule pt-4">
          <Decide {...common} payment={payment} />
        </div>
      </div>
    </section>
  );
}

/** The dashboard's approval queue: one compact card per waiting payment. */
export function ApprovalQueue({ pending, ...common }: Common & { pending: PaymentRecord[] }) {
  const d = common.view.currencyDecimals;
  return (
    <ul className="divide-y divide-rule">
      {pending.map((p) => {
        const ctx = approvalContextFor(common.view, p);
        const b = ctx.budget;
        return (
          <li key={p.paymentId} className="space-y-3 py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <Link
                href={`${common.paymentHref}/${p.paymentId}`}
                className="min-w-0 font-medium text-ink hover:underline"
              >
                {p.request.merchant}
              </Link>
              <span className="tabular font-mono text-ink">
                {money(p.request.amount, p.request.currency, d)}
              </span>
            </div>
            <p className="text-sm text-ink-2">
              {p.agentId} · {dateTime(p.createdAt, common.view.timezone)}
              {p.request.memo ? ` · ${p.request.memo}` : ''}
            </p>
            <ul className="space-y-1 text-sm">
              {ctx.reasons.map((r, i) => (
                <li key={`${r.rule}-${String(i)}`} className="text-ink">
                  <span className="font-medium">{r.title}.</span>{' '}
                  <span className="text-ink-2">{r.detail}</span>
                </li>
              ))}
            </ul>
            {b ? (
              <p
                className={`tabular text-xs ${b.overBy > 0 ? 'font-medium text-decline' : 'text-ink-3'}`}
              >
                {b.isToday ? 'Today' : 'That day'}: {money(b.total, ctx.baseCurrency, d)} of{' '}
                {money(b.budget, ctx.baseCurrency, d)} budget with this payment
                {b.overBy > 0 ? ` (${money(b.overBy, ctx.baseCurrency, d)} over)` : ''} ·{' '}
                {ctx.supplier.approvedCount === 0
                  ? 'new supplier'
                  : `${String(ctx.supplier.approvedCount)} earlier approved ${ctx.supplier.approvedCount === 1 ? 'payment' : 'payments'} to this supplier`}
              </p>
            ) : null}
            {ctx.monthly && ctx.monthly.overBy > 0 ? (
              <p className="tabular text-xs font-medium text-decline">
                Month: {money(ctx.monthly.overBy, ctx.baseCurrency, d)} over the monthly budget
              </p>
            ) : null}
            {ctx.project?.found && (ctx.project.overBy > 0 || ctx.project.ended) ? (
              <p className="tabular text-xs font-medium text-decline">
                Project {ctx.project.name}:{' '}
                {ctx.project.ended
                  ? `ended on ${ctx.project.ends ?? ''}`
                  : `${money(ctx.project.overBy, ctx.baseCurrency, d)} over budget`}
              </p>
            ) : null}
            <details className="group rounded-lg border border-rule">
              <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-accent">
                Everything to decide{' '}
                <span className="text-ink-3 group-open:hidden">(budget, supplier, prices)</span>
              </summary>
              <div className="border-t border-rule px-3 py-3">
                <ApprovalFacts
                  ctx={ctx}
                  payment={p}
                  view={common.view}
                  paymentHref={common.paymentHref}
                />
              </div>
            </details>
            <Decide {...common} payment={p} />
          </li>
        );
      })}
    </ul>
  );
}
