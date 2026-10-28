'use client';

import { useActionState } from 'react';
import { buttonClass } from '@/components/ui';
import type { ReorderResult } from './actions';

type Act = (prev: ReorderResult, form: FormData) => Promise<ReorderResult>;

function Message({ state }: { state: ReorderResult }) {
  if (state.error) {
    return (
      <p role="alert" className="text-xs text-decline">
        {state.error}
      </p>
    );
  }
  return state.ok ? (
    <p role="status" className="text-xs text-approve">
      {state.ok}
    </p>
  ) : null;
}

/** One small form with a button, for accept, dismiss and the auto-include switch. */
export function SmallAction({
  action,
  fields,
  label,
  variant = 'secondary',
}: {
  action: Act;
  fields: Record<string, string>;
  label: string;
  variant?: 'primary' | 'secondary' | 'quiet';
}) {
  const [state, run, pending] = useActionState<ReorderResult, FormData>(action, {});
  return (
    <form action={run} className="inline-flex flex-wrap items-center gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" disabled={pending} className={buttonClass(variant, 'sm')}>
        {label}
      </button>
      <Message state={state} />
    </form>
  );
}

/** Link a "needs matching" suggestion to an item of the price list. */
export function LinkForm({
  action,
  org,
  id,
  items,
}: {
  action: Act;
  org: string;
  id: string;
  items: { id: string; label: string }[];
}) {
  const [state, run, pending] = useActionState<ReorderResult, FormData>(action, {});
  return (
    <form action={run} className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={id} />
      <label className="sr-only" htmlFor={`link-${id}`}>
        Price-list item
      </label>
      <select
        id={`link-${id}`}
        name="price_item"
        className="w-full min-w-0 rounded-lg border border-rule-strong bg-surface px-2 py-1.5 text-sm text-ink sm:w-auto sm:max-w-md"
      >
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || items.length === 0}
        className={buttonClass('secondary', 'sm')}
      >
        Link
      </button>
      <Message state={state} />
    </form>
  );
}
