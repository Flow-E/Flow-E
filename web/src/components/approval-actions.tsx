'use client';

import { useActionState, useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import { buttonClass } from './ui';

interface ActionResult {
  ok?: string;
  error?: string;
}

type Resolve = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

const input =
  'mt-1 block h-11 w-full min-w-0 rounded-lg border border-rule-strong bg-surface px-3 text-base text-ink placeholder:text-ink-3 sm:h-10 sm:text-sm';

/**
 * Approve or decline one payment with the existing resolve action (which checks the person's
 * role). Approve takes an optional note; decline asks for a short reason first (the action
 * requires it too). Big, full-width buttons on a phone.
 */
export function DecisionButtons({
  action,
  fields,
}: {
  action: Resolve;
  /** Hidden fields: the payment id, and the organisation id where there is one. */
  fields: Record<string, string>;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const [declining, setDeclining] = useState(false);
  const noteId = useId();
  const reasonId = useId();
  const hidden = Object.entries(fields).map(([k, v]) => (
    <input key={k} type="hidden" name={k} value={v} />
  ));
  const big = 'h-11 w-full sm:h-10 sm:w-auto sm:min-w-32';

  return (
    <div className="space-y-2">
      {declining ? (
        <form action={run} className="space-y-2">
          {hidden}
          <input type="hidden" name="status" value="declined" />
          <label htmlFor={reasonId} className="block text-sm font-medium text-ink">
            Why decline?{' '}
            <span className="font-normal text-ink-3">(required, goes in the ledger)</span>
            <input
              id={reasonId}
              name="note"
              required
              maxLength={500}
              autoFocus
              autoComplete="off"
              placeholder="e.g. Wrong supplier, order from the usual one"
              className={input}
            />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <button type="submit" disabled={pending} className={`${buttonClass('danger')} ${big}`}>
              <X size={16} aria-hidden="true" />
              {pending ? 'Declining…' : 'Decline payment'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setDeclining(false);
              }}
              className={`${buttonClass('secondary')} ${big}`}
            >
              Back
            </button>
          </div>
        </form>
      ) : (
        <form action={run} className="space-y-2">
          {hidden}
          <input type="hidden" name="status" value="approved" />
          <label htmlFor={noteId} className="block text-sm font-medium text-ink">
            Note <span className="font-normal text-ink-3">(optional, goes in the ledger)</span>
            <input id={noteId} name="note" maxLength={500} autoComplete="off" className={input} />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <button type="submit" disabled={pending} className={`${buttonClass('primary')} ${big}`}>
              <Check size={16} aria-hidden="true" />
              {pending ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setDeclining(true);
              }}
              className={`${buttonClass('secondary')} ${big}`}
            >
              <X size={16} aria-hidden="true" />
              Decline…
            </button>
          </div>
        </form>
      )}
      <p aria-live="polite" className="text-sm">
        {state.error ? <span className="text-decline">{state.error}</span> : null}
      </p>
    </div>
  );
}
