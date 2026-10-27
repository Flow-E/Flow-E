'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';
import { buttonClass } from '@/components/ui';
import { CopyButton } from '../app/client';
import type { MfaState } from './actions';

type Act = (prev: MfaState, form: FormData) => Promise<MfaState>;
type Bare = (prev: MfaState) => Promise<MfaState>;

const field =
  'mt-1.5 h-11 w-full rounded-lg border border-rule-strong bg-surface px-3 font-mono text-lg tracking-widest text-ink placeholder:text-ink-3';
const label = 'block text-sm font-medium text-ink';

function Message({ state }: { state: MfaState }) {
  return (
    <p aria-live="polite" className="text-sm empty:hidden">
      {state.error ? (
        <span role="alert" className="text-decline">
          {state.error}
        </span>
      ) : null}
      {state.ok && !state.codes ? <span className="text-approve">{state.ok}</span> : null}
    </p>
  );
}

/** One code field: digits from the app or, where allowed, a recovery code. */
function CodeField({ recovery = false }: { recovery?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={label}>
      {recovery ? 'Code from your app, or a recovery code' : 'Code from your app'}
      <input
        id={id}
        name="code"
        required
        autoComplete="one-time-code"
        inputMode={recovery ? 'text' : 'numeric'}
        pattern={recovery ? undefined : '[0-9 ]{6,7}'}
        maxLength={recovery ? 20 : 7}
        placeholder="123456"
        spellCheck={false}
        autoCapitalize="none"
        className={field}
      />
    </label>
  );
}

function BareButton({
  action,
  text,
  variant = 'secondary',
}: {
  action: Bare;
  text: string;
  variant?: 'primary' | 'secondary' | 'quiet';
}) {
  const [state, run, pending] = useActionState<MfaState>(action, {});
  return (
    <form action={run} className="space-y-2">
      <button type="submit" disabled={pending} className={buttonClass(variant)}>
        {pending ? 'Working…' : text}
      </button>
      <Message state={state} />
    </form>
  );
}

function RecoveryCodes({ codes, next }: { codes: string[]; next: string }) {
  return (
    <div className="space-y-4">
      <p role="status" className="rounded-lg bg-approve-soft px-4 py-3 text-sm text-approve">
        Authenticator app set up. This session is verified.
      </p>
      <div className="space-y-3 rounded-lg border border-review/40 bg-review-soft px-4 py-4">
        <p className="text-sm font-medium text-ink">
          Save these 10 recovery codes now. They are shown once.
        </p>
        <p className="text-sm text-ink-2">
          Each works once, in place of a code from your app, if you lose your phone.
        </p>
        <ul className="tabular grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm text-ink">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <CopyButton value={codes.join('\n')} label="Copy all" />
      </div>
      <Link href={next} className={buttonClass('primary')}>
        Continue
      </Link>
    </div>
  );
}

/**
 * The whole security panel in one client component, so the recovery codes stay on screen
 * when the page refreshes after set-up (the codes live only in this component's state).
 */
export function SecurityPanel({
  status,
  secret,
  qrSvg,
  enabledAt,
  recoveryLeft,
  next,
  start,
  cancel,
  confirm,
  disable,
}: {
  status: 'off' | 'pending' | 'on';
  secret: string | null;
  qrSvg: string | null;
  enabledAt: string | null;
  recoveryLeft: number;
  next: string;
  start: Bare;
  cancel: Bare;
  confirm: Act;
  disable: Act;
}) {
  const [confirmed, runConfirm, confirming] = useActionState<MfaState, FormData>(confirm, {});
  const [disabled, runDisable, disabling] = useActionState<MfaState, FormData>(disable, {});

  if (confirmed.codes) return <RecoveryCodes codes={confirmed.codes} next={next} />;

  if (status === 'on') {
    return (
      <div className="space-y-5">
        <p className="text-sm text-ink-2">
          <span className="font-medium text-approve">On</span> since {enabledAt ?? 'set-up'}.{' '}
          {recoveryLeft} of 10 recovery codes left.
        </p>
        <form action={runDisable} className="space-y-3 border-t border-rule pt-5">
          <h2 className="font-medium text-ink">Turn off or reset</h2>
          <p className="text-sm text-ink-2">
            Enter a current code to turn it off. To move to a new phone, turn it off, then set it up
            again. Without it, you cannot approve payments or change the mandate.
          </p>
          <CodeField recovery />
          <button type="submit" disabled={disabling} className={buttonClass('danger')}>
            {disabling ? 'Working…' : 'Turn off'}
          </button>
          <Message state={disabled} />
        </form>
      </div>
    );
  }

  if (status === 'pending' && secret && qrSvg) {
    return (
      <div className="space-y-5">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li>Open an authenticator app on your phone (any app that supports TOTP).</li>
          <li>Scan the QR code, or type the key below.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <div
            className="w-48 shrink-0 rounded-lg bg-white p-2"
            role="img"
            aria-label="QR code for your authenticator app"
            // Server-rendered SVG from the qrcode package: markup only, no script.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium text-ink">Key</p>
            <p className="tabular break-all rounded-lg border border-rule bg-sunken px-3 py-2 font-mono text-sm text-ink">
              {secret.match(/.{1,4}/g)?.join(' ') ?? secret}
            </p>
            <CopyButton value={secret} label="Copy key" />
          </div>
        </div>
        <form action={runConfirm} className="space-y-3">
          <CodeField />
          <button type="submit" disabled={confirming} className={buttonClass('primary')}>
            {confirming ? 'Checking…' : 'Confirm'}
          </button>
          <Message state={confirmed} />
        </form>
        <BareButton action={cancel} text="Cancel set-up" variant="quiet" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        Owners and approvers enter a code from an authenticator app before they approve or decline
        payments, change the mandate, manage keys or members, or use the kill switch. Once per
        sign-in, at most every 12 hours.
      </p>
      <BareButton action={start} text="Set up authenticator app" variant="primary" />
    </div>
  );
}

/** The challenge: one code, then back to where the person was going. */
export function VerifyForm({ action, next }: { action: Act; next: string }) {
  const [state, run, pending] = useActionState<MfaState, FormData>(action, {});
  return (
    <form action={run} className="mt-6 space-y-3">
      <input type="hidden" name="next" value={next} />
      <CodeField recovery />
      <button type="submit" disabled={pending} className={buttonClass('primary')}>
        {pending ? 'Checking…' : 'Continue'}
      </button>
      <Message state={state} />
    </form>
  );
}
