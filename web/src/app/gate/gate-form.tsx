'use client';

import { useActionState } from 'react';
import { buttonClass } from '@/components/ui';
import { unlock, type GateState } from './actions';

export function GateForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<GateState, FormData>(unlock, {});
  return (
    <form action={action} className="mt-6 space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-ink">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'password-error' : undefined}
          className="mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink"
        />
        {state.error ? (
          <p id="password-error" role="alert" className="mt-1.5 text-sm text-decline">
            {state.error}
          </p>
        ) : null}
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('primary')} w-full`}>
        {pending ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}
