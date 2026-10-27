import { buttonClass } from '@/components/ui';

/** A plain form: it posts to /api/gate (a route handler), so it works without JavaScript too. */
export function GateForm({ next, error }: { next: string; error: boolean }) {
  return (
    <form method="post" action="/api/gate" className="mt-6 space-y-4">
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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'password-error' : undefined}
          className="mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink"
        />
        {error ? (
          <p id="password-error" role="alert" className="mt-1.5 text-sm text-decline">
            That password is not right.
          </p>
        ) : null}
      </div>
      <button type="submit" className={`${buttonClass('primary')} w-full`}>
        Continue
      </button>
    </form>
  );
}
