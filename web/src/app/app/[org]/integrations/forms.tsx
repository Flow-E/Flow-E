'use client';

import { useActionState, useId } from 'react';
import { buttonClass } from '@/components/ui';
import type { SecretResult } from '../../actions';
import { SecretOnce } from '../../client';

type SecretAct = (prev: SecretResult, form: FormData) => Promise<SecretResult>;

const field =
  'mt-1 w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3';

function Choices({ name, options }: { name: string; options: { value: string; label: string }[] }) {
  return (
    <fieldset className="space-y-1.5">
      {options.map((o) => (
        <label key={o.value} className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" name={name} value={o.value} className="mt-1" />
          <span>
            <span className="font-mono text-xs">{o.value}</span>
            <span className="block text-ink-2">{o.label}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function CreateApiKeyForm({
  action,
  org,
  scopes,
}: {
  action: SecretAct;
  org: string;
  scopes: { value: string; label: string }[];
}) {
  const [state, run, pending] = useActionState<SecretResult, FormData>(action, {});
  const id = useId();
  return (
    <div className="space-y-3">
      <form action={run} className="space-y-3">
        <input type="hidden" name="org" value={org} />
        <label htmlFor={id} className="block text-sm text-ink-2">
          Name
          <input
            id={id}
            name="name"
            required
            maxLength={80}
            placeholder="Inventory system"
            className={field}
          />
        </label>
        <Choices name="scope" options={scopes} />
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Creating…' : 'Create key'}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="text-sm text-decline">
          {state.error}
        </p>
      ) : (
        <SecretOnce state={state} kind="key" />
      )}
    </div>
  );
}

export function CreateWebhookForm({
  action,
  org,
  events,
}: {
  action: SecretAct;
  org: string;
  events: { value: string; label: string }[];
}) {
  const [state, run, pending] = useActionState<SecretResult, FormData>(action, {});
  const id = useId();
  return (
    <div className="space-y-3">
      <form action={run} className="space-y-3">
        <input type="hidden" name="org" value={org} />
        <label htmlFor={id} className="block text-sm text-ink-2">
          Address (https only)
          <input
            id={id}
            name="url"
            type="url"
            required
            maxLength={500}
            placeholder="https://erp.example.com/flow-e"
            className={field}
          />
        </label>
        <Choices name="event" options={events} />
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Adding…' : 'Add webhook'}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="text-sm text-decline">
          {state.error}
        </p>
      ) : (
        <SecretOnce state={state} kind="secret" />
      )}
    </div>
  );
}
