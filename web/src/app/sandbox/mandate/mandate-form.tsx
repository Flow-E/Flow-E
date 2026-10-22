'use client';

import { useActionState } from 'react';
import { buttonClass } from '@/components/ui';
import type { ActionResult } from '../actions';
import { keepValues } from '../client';

export interface AgentFields {
  id: string;
  owner: string;
  status: string;
  daily_budget: string;
  per_payment_limit: string;
  approval_above: string;
  currencies: string;
  categories: string;
  supplier_mode: string;
  allow: string;
  block: string;
  blocked_countries: string;
  velocity_per_minute: string;
  business_hours_only: boolean;
}

export interface MandateFields {
  baseCurrency: string;
  timezone: string;
  fx: [string, string][];
  blocked_countries: string;
  blocked_suppliers: string;
  days: number[];
  start: string;
  end: string;
  agents: AgentFields[];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const input = 'mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 text-ink';
const area = 'mt-1.5 w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink';
const label = 'block text-sm font-medium text-ink';
const hint = 'mt-1 text-xs text-ink-3';

function Field({
  name,
  title,
  value,
  help,
  mono,
  inputMode,
}: {
  name: string;
  title: string;
  value: string;
  help?: string;
  mono?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
}) {
  return (
    <label className={label}>
      {title}
      <input
        name={name}
        defaultValue={value}
        inputMode={inputMode}
        className={`${input} ${mono ? 'tabular font-mono' : ''}`}
      />
      {help ? <span className={hint}>{help}</span> : null}
    </label>
  );
}

export function MandateForm({
  data,
  action,
  readOnly = false,
  fxAsText = false,
  baseHint = 'Fixed for a sandbox. Every limit is counted in it.',
}: {
  data: MandateFields;
  action: (p: ActionResult, f: FormData) => Promise<ActionResult>;
  /** Show the values without letting anyone change them (e.g. for viewers). */
  readOnly?: boolean;
  /** Exchange rates as one editable list ("EUR 0.94" per line), so new currencies can be added. */
  fxAsText?: boolean;
  baseHint?: string;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  return (
    <form onSubmit={keepValues(run)} className="space-y-6">
      <fieldset disabled={readOnly} className="contents">
        <fieldset className="rounded-xl border border-rule bg-surface px-4 py-5 sm:px-5">
          <legend className="px-1 text-base font-semibold">Organisation</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>
              Base currency
              <input
                value={data.baseCurrency}
                readOnly
                aria-readonly="true"
                className={`${input} bg-sunken text-ink-2`}
              />
              <span className={hint}>{baseHint}</span>
            </label>
            <Field
              name="timezone"
              title="Time zone"
              value={data.timezone}
              help="Defines “today” and business hours, e.g. Europe/Zurich."
            />
            {fxAsText ? (
              <label className={label}>
                Exchange rates to {data.baseCurrency}
                <textarea
                  name="fx_lines"
                  rows={2}
                  defaultValue={data.fx.map(([code, rate]) => `${code} ${rate}`).join('\n')}
                  placeholder="EUR 0.94"
                  className={`${area} tabular font-mono`}
                />
                <span className={hint}>
                  One per line: code and {data.baseCurrency} per 1 unit. Needed for every other
                  currency an agent may use.
                </span>
              </label>
            ) : null}
            {(fxAsText ? [] : data.fx).map(([code, rate]) => (
              <Field
                key={code}
                name={`fx.${code}`}
                title={`Exchange rate ${code} → ${data.baseCurrency}`}
                value={rate}
                mono
                inputMode="decimal"
                help={`${data.baseCurrency} per 1 ${code}. Static in this version.`}
              />
            ))}
            <Field
              name="blocked_countries"
              title="Always-blocked countries"
              value={data.blocked_countries}
              help="Two-letter codes, comma-separated. A demo list, not sanctions screening."
            />
            <label className={label}>
              Blocked suppliers
              <textarea
                name="blocked_suppliers"
                rows={2}
                defaultValue={data.blocked_suppliers}
                className={area}
              />
              <span className={hint}>One per line. No agent may pay them.</span>
            </label>
            <div className="sm:col-span-2">
              <span className={label}>Business hours</span>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                {DAYS.map((d, i) => (
                  <label key={d} className="inline-flex items-center gap-1.5 text-sm text-ink">
                    <input
                      type="checkbox"
                      name="days"
                      value={i + 1}
                      defaultChecked={data.days.includes(i + 1)}
                      className="size-4 accent-[var(--accent)]"
                    />
                    {d}
                  </label>
                ))}
                <label className="inline-flex items-center gap-2 text-sm text-ink">
                  from{' '}
                  <input
                    name="start"
                    defaultValue={data.start}
                    className="tabular h-9 w-20 rounded-lg border border-rule-strong bg-surface px-2 font-mono"
                  />
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-ink">
                  to{' '}
                  <input
                    name="end"
                    defaultValue={data.end}
                    className="tabular h-9 w-20 rounded-lg border border-rule-strong bg-surface px-2 font-mono"
                  />
                </label>
              </div>
            </div>
          </div>
        </fieldset>

        {data.agents.map((a) => (
          <fieldset
            key={a.id}
            className="rounded-xl border border-rule bg-surface px-4 py-5 sm:px-5"
          >
            <legend className="px-1 font-mono text-base font-semibold">{a.id}</legend>
            <input type="hidden" name="agent" value={a.id} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field name={`${a.id}.owner`} title="Responsible owner" value={a.owner} />
              <label className={label}>
                Status
                <select name={`${a.id}.status`} defaultValue={a.status} className={input}>
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="frozen">frozen</option>
                </select>
              </label>
              <Field
                name={`${a.id}.velocity_per_minute`}
                title="Requests per minute"
                value={a.velocity_per_minute}
                mono
                inputMode="numeric"
              />
              <Field
                name={`${a.id}.daily_budget`}
                title={`Daily budget (${data.baseCurrency})`}
                value={a.daily_budget}
                mono
                inputMode="decimal"
              />
              <Field
                name={`${a.id}.per_payment_limit`}
                title={`Per payment (${data.baseCurrency})`}
                value={a.per_payment_limit}
                mono
                inputMode="decimal"
              />
              <Field
                name={`${a.id}.approval_above`}
                title={`Human approval above (${data.baseCurrency})`}
                value={a.approval_above}
                mono
                inputMode="decimal"
                help="Leave empty for no human review."
              />
              <Field
                name={`${a.id}.currencies`}
                title="Currencies"
                value={a.currencies}
                help="Comma-separated, e.g. CHF, EUR."
              />
              <Field
                name={`${a.id}.categories`}
                title="Categories (MCC)"
                value={a.categories}
                mono
                help="Four-digit codes, comma-separated."
              />
              <Field
                name={`${a.id}.blocked_countries`}
                title="Blocked countries for this agent"
                value={a.blocked_countries}
              />
              <label className={label}>
                Suppliers
                <select
                  name={`${a.id}.supplier_mode`}
                  defaultValue={a.supplier_mode}
                  className={input}
                >
                  <option value="allowlist">Approved suppliers only</option>
                  <option value="any">Any supplier not blocked</option>
                </select>
              </label>
              <label className={label}>
                Approved suppliers
                <textarea name={`${a.id}.allow`} rows={3} defaultValue={a.allow} className={area} />
                <span className={hint}>One per line.</span>
              </label>
              <label className={label}>
                Blocked suppliers
                <textarea name={`${a.id}.block`} rows={3} defaultValue={a.block} className={area} />
              </label>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-ink sm:col-span-2 lg:col-span-3">
                <input
                  type="checkbox"
                  name={`${a.id}.business_hours_only`}
                  defaultChecked={a.business_hours_only}
                  className="size-4 accent-[var(--accent)]"
                />
                Outside business hours, a human must approve
              </label>
            </div>
          </fieldset>
        ))}
      </fieldset>

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <label className="min-w-0 flex-1 text-sm font-medium text-ink">
            <span className="sr-only">Note for the ledger (optional)</span>
            <input
              name="note"
              maxLength={500}
              placeholder="Why this change? (optional, recorded in the ledger)"
              className={`${input} mt-0`}
            />
          </label>
          <button type="submit" disabled={pending} className={buttonClass('primary')}>
            {pending ? 'Saving…' : 'Save mandate'}
          </button>
        </div>
      )}
      <div aria-live="polite">
        {state.error ? (
          <p
            role="alert"
            className="whitespace-pre-line rounded-lg border border-decline/30 bg-decline-soft px-4 py-3 text-sm text-decline"
          >
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p className="rounded-lg bg-approve-soft px-4 py-3 text-sm text-approve">{state.ok}</p>
        ) : null}
      </div>
    </form>
  );
}
