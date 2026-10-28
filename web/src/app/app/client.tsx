'use client';

import { useActionState, useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { CategoryPicker } from '@/components/category-picker';
import { buttonClass } from '@/components/ui';
import { keepValues } from '../sandbox/client';
import type { ActionResult, SecretResult } from './actions';

type Act = (prev: ActionResult, form: FormData) => Promise<ActionResult>;
type SecretAct = (prev: SecretResult, form: FormData) => Promise<SecretResult>;

export const field =
  'mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink placeholder:text-ink-3';
const label = 'block text-sm font-medium text-ink';
const hint = 'mt-1 block text-xs font-normal text-ink-3';

function Status({ state }: { state: ActionResult }) {
  return (
    <p aria-live="polite" className="text-sm empty:hidden">
      {state.error ? (
        <span role="alert" className="whitespace-pre-line text-decline">
          {state.error}
        </span>
      ) : null}
      {state.ok ? <span className="text-approve">{state.ok}</span> : null}
    </p>
  );
}

export function CopyButton({ value, label: what = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass('secondary', 'sm')}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => {
            setDone(false);
          }, 2000);
        });
      }}
    >
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {done ? 'Copied' : what}
    </button>
  );
}

/** A block of copy-ready text (a command or JSON). */
export function CopyBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{title}</p>
        <CopyButton value={value} />
      </div>
      <pre className="tabular mt-2 overflow-x-auto rounded-lg border border-rule bg-sunken p-3 font-mono text-xs text-ink">
        {value}
      </pre>
    </div>
  );
}

/** A secret shown exactly once, with a warning and a copy button. */
export function SecretOnce({
  state,
  kind,
}: {
  state: SecretResult;
  kind: 'key' | 'link' | 'secret';
}) {
  if (!state.secret) return null;
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-review/40 bg-review-soft px-4 py-3 text-sm"
    >
      <p className="font-medium text-ink">
        {kind === 'key' || kind === 'secret'
          ? `Copy this ${kind === 'key' ? 'key' : 'signing secret'} now. It is shown once and cannot be recovered.`
          : `Invitation link for ${state.label ?? ''}. It is shown once.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="tabular min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1.5 font-mono text-xs text-ink">
          {state.secret}
        </code>
        <CopyButton value={state.secret} />
      </div>
      {state.ok ? <p className="text-ink-2">{state.ok}</p> : null}
    </div>
  );
}

export function CreateOrgForm({ action, timezone }: { action: Act; timezone: string }) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  return (
    <form onSubmit={keepValues(run)} className="grid gap-4 sm:grid-cols-3">
      <label className={`${label} sm:col-span-3`}>
        Name
        <input
          name="name"
          required
          maxLength={100}
          placeholder="Example Labs AG"
          className={field}
        />
      </label>
      <label className={label}>
        Base currency
        <select name="baseCurrency" defaultValue="CHF" className={field}>
          <option>CHF</option>
          <option>EUR</option>
        </select>
        <span className={hint}>Every limit is counted in it. Cannot be changed later.</span>
      </label>
      <label className={`${label} sm:col-span-2`}>
        Time zone
        <input name="timezone" required defaultValue={timezone} className={field} />
        <span className={hint}>Defines “today” for budgets, e.g. Europe/Zurich.</span>
      </label>
      <div className="space-y-2 sm:col-span-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Creating…' : 'Create organisation'}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function RenameForm({ action, org, name }: { action: Act; org: string; name: string }) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const id = useId();
  return (
    <form onSubmit={keepValues(run)} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="org" value={org} />
      <label htmlFor={id} className={`${label} min-w-0 flex-1`}>
        Name
        <input id={id} name="name" required maxLength={100} defaultValue={name} className={field} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>
        {pending ? 'Saving…' : 'Rename'}
      </button>
      <div className="w-full">
        <Status state={state} />
      </div>
    </form>
  );
}

export function CreateAgentForm({
  action,
  org,
  baseCurrency,
  defaultOwner,
}: {
  action: Act;
  org: string;
  baseCurrency: string;
  defaultOwner: string;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  return (
    <form onSubmit={keepValues(run)} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="org" value={org} />
      <label className={label}>
        Agent id
        <input
          name="agentId"
          required
          maxLength={63}
          pattern="[a-z0-9][a-z0-9_\-]{0,62}"
          placeholder="lab-procurement"
          className={`${field} font-mono`}
        />
        <span className={hint}>Lower-case letters, digits, “-” and “_”. Cannot change.</span>
      </label>
      <label className={label}>
        Display name
        <input
          name="displayName"
          required
          maxLength={100}
          placeholder="Lab procurement agent"
          className={field}
        />
      </label>
      <label className={label}>
        Responsible owner
        <input
          name="owner"
          required
          maxLength={100}
          defaultValue={defaultOwner}
          className={field}
        />
        <span className={hint}>The person accountable for what this agent buys.</span>
      </label>
      <label className={label}>
        Daily budget ({baseCurrency})
        <input
          name="dailyBudget"
          required
          inputMode="decimal"
          defaultValue="2000"
          className={`${field} tabular font-mono`}
        />
      </label>
      <label className={label}>
        Per payment ({baseCurrency})
        <input
          name="perPaymentLimit"
          required
          inputMode="decimal"
          defaultValue="1000"
          className={`${field} tabular font-mono`}
        />
      </label>
      <label className={label}>
        Human approval above ({baseCurrency})
        <input
          name="approvalAbove"
          inputMode="decimal"
          defaultValue="500"
          className={`${field} tabular font-mono`}
        />
        <span className={hint}>Optional. Above this, an owner or approver decides.</span>
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <CategoryPicker name="categories" />
        <p className={hint}>
          Suppliers, countries, currencies and business hours can be refined on the Mandate page
          afterwards.
        </p>
      </div>
      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Creating…' : 'Create agent'}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function CreateKeyForm({
  action,
  org,
  agentId,
}: {
  action: SecretAct;
  org: string;
  agentId: string;
}) {
  const [state, run, pending] = useActionState<SecretResult, FormData>(action, {});
  const id = useId();
  return (
    <div className="space-y-3">
      <form action={run} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="agentId" value={agentId} />
        <label htmlFor={id} className={label}>
          Expires
          <select id={id} name="expires" defaultValue="90" className={`${field} w-40`}>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in a year</option>
            <option value="never">never</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Creating…' : 'Create key'}
        </button>
      </form>
      {state.error ? <Status state={state} /> : <SecretOnce state={state} kind="key" />}
    </div>
  );
}

/** Rotate one key: a confirm click, then the new key shown once. */
export function RotateKeyButton({
  action,
  org,
  keyId,
}: {
  action: SecretAct;
  org: string;
  keyId: string;
}) {
  const [state, run, pending] = useActionState<SecretResult, FormData>(action, {});
  const [armed, setArmed] = useState(false);
  return (
    <div className="space-y-2">
      <form
        action={run}
        onSubmit={(e) => {
          if (!armed) {
            e.preventDefault();
            setArmed(true);
          }
        }}
      >
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="keyId" value={keyId} />
        <button
          type="submit"
          disabled={pending}
          className={buttonClass(armed ? 'danger' : 'secondary', 'sm')}
          onBlur={() => {
            setArmed(false);
          }}
        >
          {pending ? 'Rotating…' : armed ? 'Click again: the old key stops working' : 'Rotate'}
        </button>
      </form>
      {state.error ? <Status state={state} /> : <SecretOnce state={state} kind="key" />}
    </div>
  );
}

export function InviteForm({ action, org }: { action: SecretAct; org: string }) {
  const [state, run, pending] = useActionState<SecretResult, FormData>(action, {});
  return (
    <div className="space-y-3">
      <form
        onSubmit={keepValues(run)}
        className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
      >
        <input type="hidden" name="org" value={org} />
        <label className={label}>
          Email
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            placeholder="colleague@example.com"
            className={field}
          />
        </label>
        <label className={label}>
          Role
          <select name="role" defaultValue="approver" className={field}>
            <option value="approver">Approver</option>
            <option value="viewer">Viewer</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Inviting…' : 'Invite'}
        </button>
      </form>
      {state.error ? <Status state={state} /> : <SecretOnce state={state} kind="link" />}
    </div>
  );
}

export function RoleForm({
  action,
  org,
  memberId,
  role,
  who,
}: {
  action: Act;
  org: string;
  memberId: string;
  role: string;
  who: string;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const id = useId();
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="memberId" value={memberId} />
      <label htmlFor={id} className="sr-only">
        Role of {who}
      </label>
      <select
        id={id}
        name="role"
        defaultValue={role}
        className="h-8 rounded-lg border border-rule-strong bg-surface px-2 text-sm text-ink"
      >
        <option value="owner">Owner</option>
        <option value="approver">Approver</option>
        <option value="viewer">Viewer</option>
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Change'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function ConfirmForm({
  action,
  token,
  verb,
}: {
  action: Act;
  token: string;
  verb: 'approve' | 'decline' | 'accept';
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  const id = useId();
  if (state.ok) {
    return (
      <p role="status" className="rounded-lg bg-approve-soft px-4 py-3 text-sm text-approve">
        {state.ok}
      </p>
    );
  }
  const text = {
    approve: 'Approve payment',
    decline: 'Decline payment',
    accept: 'Accept invitation',
  }[verb];
  return (
    <form action={run} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {verb === 'accept' ? null : (
        <label htmlFor={id} className={label}>
          Note for the ledger (optional)
          <input id={id} name="note" maxLength={500} className={field} />
        </label>
      )}
      <button
        type="submit"
        disabled={pending}
        className={buttonClass(verb === 'decline' ? 'danger' : 'primary')}
      >
        {pending ? 'Working…' : text}
      </button>
      <Status state={state} />
    </form>
  );
}
