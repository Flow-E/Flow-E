import { HONEYPOT_FIELD, PILOT_LIMITS, PILOT_SIZES } from '@/lib/pilot-fields';
import { buttonClass } from './ui';

/**
 * The pilot request form. A plain HTML form that posts to /api/pilot (a route handler) and is
 * sent back to /?pilot=sent|error|limited#pilot, so it works without JavaScript. The browser's
 * own checks (required, type, maxLength) catch most mistakes before sending; the server checks
 * everything again.
 */

export type PilotNotice = 'sent' | 'error' | 'limited' | null;

const field =
  'mt-1.5 block w-full rounded-lg border border-rule-strong bg-surface px-3 py-2.5 text-base text-ink placeholder:text-ink-3 focus:border-accent';
const label = 'block text-sm font-medium text-ink';

export function PilotForm({ notice }: { notice: PilotNotice }) {
  if (notice === 'sent') {
    return (
      <div role="status" className="rounded-xl bg-surface p-6 text-ink sm:p-8">
        <p className="font-serif text-3xl tracking-[-0.015em]">Thank you. Your request is in.</p>
        <p className="mt-3 text-ink-2">
          You will get a reply by email from the founder. If something was missing, that reply will
          ask for it.
        </p>
      </div>
    );
  }
  return (
    <form
      action="/api/pilot"
      method="post"
      className="rounded-xl bg-surface p-5 text-ink sm:p-8"
      aria-describedby={notice ? 'pilot-notice' : undefined}
    >
      {notice ? (
        <p
          id="pilot-notice"
          role="alert"
          className="mb-6 rounded-lg bg-decline-soft px-4 py-3 text-sm text-decline"
        >
          {notice === 'limited'
            ? 'Too many requests from this connection. Please try again in a few minutes.'
            : 'That did not go through. Check the required fields and send it again.'}
        </p>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="pilot-name" className={label}>
            Name
          </label>
          <input
            id="pilot-name"
            name="name"
            required
            maxLength={PILOT_LIMITS.name}
            autoComplete="name"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="pilot-email" className={label}>
            Work email
          </label>
          <input
            id="pilot-email"
            name="email"
            type="email"
            required
            maxLength={PILOT_LIMITS.email}
            autoComplete="email"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="pilot-company" className={label}>
            Company
          </label>
          <input
            id="pilot-company"
            name="company"
            required
            maxLength={PILOT_LIMITS.company}
            autoComplete="organization"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="pilot-role" className={label}>
            Role
          </label>
          <input
            id="pilot-role"
            name="role"
            required
            maxLength={PILOT_LIMITS.role}
            autoComplete="organization-title"
            placeholder="e.g. Head of Procurement"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="pilot-size" className={label}>
            Company size
          </label>
          <select id="pilot-size" name="size" required defaultValue="" className={field}>
            <option value="" disabled>
              Choose…
            </option>
            {PILOT_SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pilot-country" className={label}>
            Country <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <input
            id="pilot-country"
            name="country"
            maxLength={PILOT_LIMITS.country}
            autoComplete="country-name"
            className={field}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pilot-buying" className={label}>
            What should your agents buy?
          </label>
          <textarea
            id="pilot-buying"
            name="buying"
            required
            rows={3}
            maxLength={PILOT_LIMITS.buying}
            placeholder="e.g. lab reagents and consumables from three regular suppliers, about CHF 15,000 a month"
            className={field}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pilot-message" className={label}>
            Message <span className="font-normal text-ink-3">(optional)</span>
          </label>
          <textarea
            id="pilot-message"
            name="message"
            rows={3}
            maxLength={PILOT_LIMITS.message}
            className={field}
          />
        </div>
        {/* People never see or fill this; simple bots do. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor="pilot-website">Leave this empty</label>
          <input id="pilot-website" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-2">
          We use these details only to contact you about a pilot.
        </p>
        <button type="submit" className={`${buttonClass('primary')} h-11 px-6`}>
          Request a pilot
        </button>
      </div>
    </form>
  );
}
