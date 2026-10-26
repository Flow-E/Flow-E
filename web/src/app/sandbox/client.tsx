'use client';

import { useRouter } from 'next/navigation';
import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useState,
  type SyntheticEvent,
} from 'react';
import { CircleCheck, CircleMinus, CircleX, Clock, Info } from 'lucide-react';
import { Pill, buttonClass } from '@/components/ui';
import { RULE_NAMES } from '@/lib/format';
import type { ActionResult, OutcomeView, RequestState, VerifyState } from './actions';

type Act = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

/**
 * Submit a form to an action WITHOUT React's automatic form reset, so what someone typed stays
 * in the fields when the server says it is not valid. Use as the form's onSubmit.
 */
export function keepValues(run: (form: FormData) => void) {
  return (e: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    startTransition(() => {
      run(form);
    });
  };
}

/** A small form that runs one owner action and reports the result next to the button. */
export function ActionButton({
  action,
  fields,
  label,
  pendingLabel,
  variant = 'secondary',
  withNote = false,
  confirm,
}: {
  action: Act;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  withNote?: boolean;
  /** Ask once more before acting; the second click runs it. */
  confirm?: string;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const [armed, setArmed] = useState(false);
  const noteId = useId();
  return (
    <form
      action={run}
      onSubmit={(e) => {
        if (confirm && !armed) {
          e.preventDefault();
          setArmed(true);
        }
      }}
      className="flex flex-wrap items-center gap-2"
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {withNote ? (
        <>
          <label htmlFor={noteId} className="sr-only">
            Note for the ledger (optional)
          </label>
          <input
            id={noteId}
            name="note"
            maxLength={500}
            placeholder="Note (optional)"
            className="h-8 w-40 min-w-0 rounded-lg border border-rule-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink-3"
          />
        </>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className={buttonClass(armed ? 'danger' : variant, 'sm')}
        onBlur={() => {
          setArmed(false);
        }}
      >
        {pending ? (pendingLabel ?? 'Working…') : armed && confirm ? confirm : label}
      </button>
      <span aria-live="polite" className="text-sm">
        {state.error ? <span className="text-decline">{state.error}</span> : null}
      </span>
    </form>
  );
}

/** Keeps a page current while it is visible, like a live dashboard. */
export function AutoRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, everyMs);
    return () => {
      clearInterval(id);
    };
  }, [router, everyMs]);
  return null;
}

const OUTCOME_ICON = {
  pass: <CircleCheck size={16} className="mt-0.5 shrink-0 text-approve" aria-label="passed" />,
  decline: <CircleX size={16} className="mt-0.5 shrink-0 text-decline" aria-label="declined" />,
  review: <Clock size={16} className="mt-0.5 shrink-0 text-review" aria-label="needs review" />,
  note: <Info size={16} className="mt-0.5 shrink-0 text-accent" aria-label="note" />,
  skip: <CircleMinus size={16} className="mt-0.5 shrink-0 text-ink-3" aria-label="not evaluated" />,
} as const;

export function Trace({ steps }: { steps: OutcomeView['trace'] }) {
  return (
    <ol className="divide-y divide-rule rounded-lg border border-rule">
      {steps.map((t, i) => (
        <li
          key={`${t.rule}-${String(i)}`}
          className={`flex gap-3 px-3 py-2 text-sm ${t.outcome === 'skip' ? 'opacity-60' : ''}`}
        >
          {OUTCOME_ICON[t.outcome]}
          <span className="min-w-0">
            <span className="font-medium text-ink">{RULE_NAMES[t.rule] ?? t.rule}</span>
            <span className="block break-words text-ink-2">{t.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function OutcomeCard({ o, open }: { o: OutcomeView; open: boolean }) {
  return (
    <li className="rounded-xl border border-rule bg-surface">
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
          <Pill
            tone={
              o.decision === 'approved'
                ? 'approved'
                : o.decision === 'review'
                  ? 'review'
                  : 'declined'
            }
          >
            {o.decision}
          </Pill>
          <span className="min-w-0 flex-1 font-medium text-ink">{o.label}</span>
          <span className="tabular font-mono text-sm text-ink-2">{o.amount}</span>
          <span className="w-full text-sm text-ink-2">{o.reason}</span>
        </summary>
        <div className="space-y-3 border-t border-rule px-4 py-3">
          <p className="text-sm text-ink-3">
            Decided by: <span className="text-ink-2">{o.rule}</span> ·{' '}
            <a href={`/sandbox/payments/${o.paymentId}`} className="text-accent underline">
              Open payment and receipt
            </a>
          </p>
          <Trace steps={o.trace} />
        </div>
      </details>
    </li>
  );
}

export function Outcomes({ state }: { state: RequestState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="whitespace-pre-line rounded-lg border border-decline/30 bg-decline-soft px-4 py-3 text-sm text-decline"
      >
        {state.error}
      </p>
    );
  }
  if (!state.outcomes) return null;
  return (
    <ol aria-live="polite" className="space-y-2">
      {state.outcomes.map((o) => (
        <OutcomeCard key={o.paymentId} o={o} open={state.outcomes?.length === 1} />
      ))}
    </ol>
  );
}

type Req = (prev: RequestState, form: FormData) => Promise<RequestState>;

export function StoryButton({ action }: { action: (prev: RequestState) => Promise<RequestState> }) {
  const [state, run, pending] = useActionState<RequestState>(action, {});
  return (
    <div className="space-y-4">
      <form action={run}>
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Playing the story…' : 'Play the demo story'}
        </button>
      </form>
      <Outcomes state={state} />
    </div>
  );
}

/** Fills an empty sandbox with 30 days of fictional history (one click, no confirm needed). */
export function SampleHistoryButton({
  action,
}: {
  action: (prev: ActionResult) => Promise<ActionResult>;
}) {
  const [state, run, pending] = useActionState<ActionResult>(action, {});
  return (
    <form action={run} className="flex flex-col items-center gap-2">
      <button type="submit" disabled={pending} className={buttonClass('primary')}>
        {pending ? 'Writing 30 days into the ledger…' : 'Fill with 30 days of sample history'}
      </button>
      <span aria-live="polite" className="text-sm">
        {state.error ? <span className="text-decline">{state.error}</span> : null}
      </span>
    </form>
  );
}

export interface CatalogRow {
  n: number;
  item: string;
  supplier: string;
  country: string;
  currency: string;
  price: string;
  category: string;
  priceLabel: string;
}

export function CatalogTable({ rows, action }: { rows: CatalogRow[]; action: Req }) {
  const [state, run, pending] = useActionState<RequestState, FormData>(action, {});
  return (
    <div className="space-y-4">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-ink-3">
              <th className="py-2 pr-3 font-medium">Item</th>
              <th className="py-2 pr-3 font-medium">Supplier</th>
              <th className="py-2 pr-3 font-medium">Price</th>
              <th className="py-2 font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.n} className="border-b border-rule last:border-0">
                <td className="py-2.5 pr-3 text-ink">{r.item}</td>
                <td className="py-2.5 pr-3 text-ink-2">
                  {r.supplier} <span className="text-ink-3">· {r.country}</span>
                </td>
                <td className="tabular py-2.5 pr-3 font-mono text-ink-2">{r.priceLabel}</td>
                <td className="py-2.5 text-right">
                  <form action={run}>
                    <input type="hidden" name="agentId" value="lab-procurement" />
                    <input type="hidden" name="merchant" value={r.supplier} />
                    <input type="hidden" name="amount" value={r.price} />
                    <input type="hidden" name="currency" value={r.currency} />
                    <input type="hidden" name="category" value={r.category} />
                    <input type="hidden" name="country" value={r.country} />
                    <input type="hidden" name="note" value={r.item} />
                    <input type="hidden" name="label" value={r.item} />
                    <button
                      type="submit"
                      disabled={pending}
                      className={buttonClass('secondary', 'sm')}
                    >
                      Request payment
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Outcomes state={state} />
    </div>
  );
}

const field =
  'mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink placeholder:text-ink-3';

export function CustomRequestForm({ action, agents }: { action: Req; agents: string[] }) {
  const [state, run, pending] = useActionState<RequestState, FormData>(action, {});
  return (
    <div className="space-y-4">
      <form onSubmit={keepValues(run)} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-ink">
          Agent
          <select name="agentId" className={field} defaultValue={agents[0]}>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-ink">
          Supplier
          <input
            name="merchant"
            required
            maxLength={200}
            placeholder="Example Labware AG"
            className={field}
          />
        </label>
        <label className="text-sm font-medium text-ink">
          Amount
          <input
            name="amount"
            required
            inputMode="decimal"
            placeholder="1250.00"
            className={`${field} tabular font-mono`}
          />
        </label>
        <label className="text-sm font-medium text-ink">
          Currency
          <input
            name="currency"
            required
            maxLength={5}
            defaultValue="CHF"
            className={`${field} uppercase`}
          />
        </label>
        <label className="text-sm font-medium text-ink">
          Category (MCC)
          <input
            name="category"
            required
            inputMode="numeric"
            maxLength={4}
            placeholder="5047"
            className={`${field} tabular font-mono`}
          />
        </label>
        <label className="text-sm font-medium text-ink">
          Supplier country
          <input
            name="country"
            required
            maxLength={2}
            defaultValue="CH"
            className={`${field} uppercase`}
          />
        </label>
        <label className="text-sm font-medium text-ink sm:col-span-2">
          Memo
          <input
            name="note"
            maxLength={500}
            placeholder="What is being bought and why"
            className={field}
          />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" disabled={pending} className={buttonClass('primary')}>
            {pending ? 'Asking Flow-E…' : 'Request payment'}
          </button>
        </div>
      </form>
      <Outcomes state={state} />
    </div>
  );
}

export function VerifyForm({
  action,
  initial,
}: {
  action: (p: VerifyState, f: FormData) => Promise<VerifyState>;
  initial?: string;
}) {
  const [state, run, pending] = useActionState<VerifyState, FormData>(action, {});
  const id = useId();
  return (
    <form onSubmit={keepValues(run)} className="space-y-3">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        Receipt JSON
      </label>
      <textarea
        id={id}
        name="receipt"
        rows={6}
        defaultValue={initial}
        spellCheck={false}
        className="tabular w-full rounded-lg border border-rule-strong bg-surface p-3 font-mono text-xs text-ink"
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Verifying…' : 'Verify receipt'}
      </button>
      <div aria-live="polite">
        {state.error ? <p className="text-sm text-decline">{state.error}</p> : null}
        {state.checks ? (
          <div
            className={`rounded-lg px-4 py-3 text-sm ${state.valid ? 'bg-approve-soft text-approve' : 'bg-decline-soft text-decline'}`}
          >
            <p className="font-semibold">{state.valid ? 'Valid receipt' : 'Invalid receipt'}</p>
            <ul className="mt-1 space-y-0.5">
              {state.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </form>
  );
}

export function ResetForm({ action }: { action: Act }) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const id = useId();
  return (
    <form action={run} className="flex flex-wrap items-end gap-3">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        Type <span className="font-mono">reset</span> to confirm
        <input
          id={id}
          name="confirm"
          autoComplete="off"
          className="mt-1.5 block h-10 w-40 rounded-lg border border-rule-strong bg-surface px-3 text-ink"
        />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('danger')}>
        {pending ? 'Starting over…' : 'Start over'}
      </button>
      <p aria-live="polite" className="w-full text-sm">
        {state.error ? <span className="text-decline">{state.error}</span> : null}
        {state.ok ? <span className="text-approve">{state.ok}</span> : null}
      </p>
    </form>
  );
}
