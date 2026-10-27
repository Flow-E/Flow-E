'use client';

import { useActionState } from 'react';
import { buttonClass } from '@/components/ui';

type Result = { ok?: string; error?: string };
type Act = (prev: Result, form: FormData) => Promise<Result>;

const input =
  'mt-1 h-9 w-full rounded-lg border border-rule-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3';
const label = 'block text-xs font-medium text-ink-2';

function Status({ state }: { state: Result }) {
  return (
    <p aria-live="polite" className="text-sm empty:hidden">
      {state.error ? (
        <span role="alert" className="text-decline">
          {state.error}
        </span>
      ) : null}
      {state.ok ? <span className="text-approve">{state.ok}</span> : null}
    </p>
  );
}

/** "We ordered it": the supplier's order number, as the agent would send it with record_order. */
export function OrderForm({ action, fields }: { action: Act; fields: Record<string, string> }) {
  const [state, run, pending] = useActionState<Result, FormData>(action, {});
  return (
    <form action={run} className="space-y-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <label className={`${label} min-w-0 flex-1`}>
          Supplier&rsquo;s order number (optional)
          <input name="reference" maxLength={80} placeholder="SO-2026-118" className={input} />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Mark as ordered'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}
