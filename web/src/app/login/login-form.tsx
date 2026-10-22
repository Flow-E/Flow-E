'use client';

import { useActionState } from 'react';
import { buttonClass } from '@/components/ui';
import { devLogin, sendLink, type LoginState } from './actions';

/** Email sign-in link (Supabase Auth). */
export function EmailLinkForm({ initialError }: { initialError?: string | undefined }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    sendLink,
    initialError ? { error: initialError } : {},
  );
  if (state.sentTo) {
    return (
      <div
        role="status"
        className="mt-6 rounded-lg border border-rule bg-surface px-4 py-4 text-sm text-ink-2"
      >
        <p className="font-medium text-ink">Check your inbox</p>
        <p className="mt-1">
          We sent a sign-in link to <span className="font-medium text-ink">{state.sentTo}</span>.
          Open it in this browser within an hour. It works once.
        </p>
        <p className="mt-2 text-xs text-ink-3">
          Nothing arrived after a few minutes? Check your spam folder, then reload this page to try
          again.
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="mt-6 space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@example.com"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'email-error' : 'email-hint'}
          className="mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink placeholder:text-ink-3"
        />
        <p id="email-hint" className="mt-1.5 text-xs text-ink-3">
          We email you a one-time sign-in link. No password. Each address gets its own sandbox.
        </p>
        {state.error ? (
          <p id="email-error" role="alert" className="mt-1.5 text-sm text-decline">
            {state.error}
          </p>
        ) : null}
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('primary')} w-full`}>
        {pending ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </form>
  );
}

export function DevLoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(devLogin, {});
  return (
    <form action={action} className="mt-6 space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@example.com"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'email-error' : 'email-hint'}
          className="mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink placeholder:text-ink-3"
        />
        <p id="email-hint" className="mt-1.5 text-xs text-ink-3">
          Development sign-in: no email is sent. Each address gets its own sandbox.
        </p>
        {state.error ? (
          <p id="email-error" role="alert" className="mt-1.5 text-sm text-decline">
            {state.error}
          </p>
        ) : null}
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('primary')} w-full`}>
        {pending ? 'Signing in…' : 'Open my sandbox'}
      </button>
    </form>
  );
}
