'use client';

import { startTransition, useActionState } from 'react';
import { History } from 'lucide-react';
import { Pill, buttonClass } from '@/components/ui';
import { money } from '@/lib/format';
import type { ReplayCounts, ReplayResult } from '@/server/replay';
import type { PreviewState } from '../../app/actions';

export type PreviewAction = (prev: PreviewState, form: FormData) => Promise<PreviewState>;

const TONE = { approved: 'approved', review: 'review', declined: 'declined' } as const;
const WORD = { approved: 'approved', review: 'to a person', declined: 'declined' } as const;

function delta(before: number, after: number): string {
  const d = after - before;
  return d === 0 ? 'no change' : d > 0 ? `+${String(d)}` : String(d);
}

function Row({
  label,
  pick,
  r,
  fmt,
}: {
  label: string;
  pick: (c: ReplayCounts) => number;
  r: ReplayResult;
  fmt?: (n: number) => string;
}) {
  const show = fmt ?? String;
  const b = pick(r.before);
  const a = pick(r.after);
  return (
    <tr className="border-b border-rule last:border-0">
      <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-2">
        {label}
      </th>
      <td className="tabular py-2 pr-3 text-right font-mono text-ink-2">{show(b)}</td>
      <td className="tabular py-2 pr-3 text-right font-mono text-ink">{show(a)}</td>
      <td className={`tabular py-2 text-right font-mono ${a === b ? 'text-ink-3' : 'text-ink'}`}>
        {fmt
          ? a === b
            ? 'no change'
            : `${a > b ? '+' : '−'}${show(Math.abs(a - b))}`
          : delta(b, a)}
      </td>
    </tr>
  );
}

/**
 * "What if": replays the last 30 days against the mandate as currently typed in the form,
 * without saving. Lives inside the mandate form and reads its values when clicked.
 */
export function MandatePreview({
  action,
  baseCurrency,
}: {
  action: PreviewAction;
  baseCurrency: string;
}) {
  const [state, run, pending] = useActionState<PreviewState, FormData>(action, {});
  const fmt = (n: number) => money(n, baseCurrency);
  const r = state.result;

  return (
    <div className="space-y-3 rounded-xl border border-rule bg-sunken px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">What if?</p>
          <p className="text-sm text-ink-2">
            Replays the last 30 days of requests against the rules as typed above, before you save.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          className={buttonClass('secondary', 'sm')}
          onClick={(e) => {
            const form = e.currentTarget.form;
            if (!form) return;
            const data = new FormData(form);
            startTransition(() => {
              run(data);
            });
          }}
        >
          <History size={14} aria-hidden="true" />
          {pending ? 'Replaying…' : 'Test against the last 30 days'}
        </button>
      </div>

      {state.error ? (
        <p role="alert" className="whitespace-pre-line text-sm text-decline">
          {state.error}
        </p>
      ) : null}

      {r ? (
        <div aria-live="polite" className="space-y-4">
          {r.requests === 0 ? (
            <p className="text-sm text-ink-2">No requests in the last {r.days} days to replay.</p>
          ) : (
            <>
              <p className="text-sm text-ink">
                {r.changes.length + r.more === 0
                  ? `All ${String(r.requests)} requests of the last ${String(r.days)} days would have been decided the same way.`
                  : `${String(r.changes.length + r.more)} of ${String(r.requests)} requests would have been decided differently.`}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] text-sm">
                  <thead>
                    <tr className="border-b border-rule text-left text-xs text-ink-3">
                      <th className="py-1.5 pr-3 font-medium">
                        <span className="sr-only">Figure</span>
                      </th>
                      <th className="py-1.5 pr-3 text-right font-medium">Current rules</th>
                      <th className="py-1.5 pr-3 text-right font-medium">With this change</th>
                      <th className="py-1.5 text-right font-medium">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="Approved automatically" pick={(c) => c.approved} r={r} />
                    <Row label="Sent to a person" pick={(c) => c.review} r={r} />
                    <Row label="Declined" pick={(c) => c.declined} r={r} />
                    <Row label="Approved spend" pick={(c) => c.approvedAmount} r={r} fmt={fmt} />
                  </tbody>
                </table>
              </div>
              {r.changes.length > 0 ? (
                <ul className="divide-y divide-rule rounded-lg border border-rule bg-surface">
                  {r.changes.map((c) => (
                    <li key={c.paymentId} className="space-y-1 px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {c.what || c.merchant}{' '}
                          <span className="text-ink-3">
                            · {c.merchant} · {c.agentId} · {c.createdAt.slice(0, 10)}
                          </span>
                        </span>
                        <span className="tabular font-mono text-ink-2">
                          {c.amountBase === null ? '' : fmt(c.amountBase)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={TONE[c.before]}>{WORD[c.before]}</Pill>
                        <span className="text-ink-3" aria-label="becomes">
                          →
                        </span>
                        <Pill tone={TONE[c.after]}>{WORD[c.after]}</Pill>
                        {c.reason ? <span className="text-xs text-ink-2">{c.reason}</span> : null}
                      </div>
                    </li>
                  ))}
                  {r.more > 0 ? (
                    <li className="px-3 py-2 text-xs text-ink-3">… and {r.more} more, older.</li>
                  ) : null}
                </ul>
              ) : null}
              <p className="text-xs text-ink-3">
                Assumes agents ask the same things in the same order. Requests stopped by the kill
                switch, a frozen agent or a credential problem keep their decision
                {r.kept > 0 ? ` (${String(r.kept)} here)` : ''}. A request the new rules send to a
                person counts as approved only if a person approved it at the time. Nothing is saved
                or recorded.
              </p>
              {r.inexact > 0 ? (
                <p className="text-xs text-ink-2">
                  {r.inexact === 1 ? '1 request was' : `${String(r.inexact)} requests were`} decided
                  before Flow-E recorded the item and project with each request, so usual prices and
                  project budgets could not be checked for {r.inexact === 1 ? 'it' : 'them'}. Their
                  result here may differ from a live decision.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
