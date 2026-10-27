'use client';

import { useActionState, useMemo } from 'react';
import { CategoryPicker } from '@/components/category-picker';
import { explainProblems, fieldKey, type MandateFields } from '@/lib/mandate-form-data';
import { MandatePreview, type PreviewAction } from './preview';
import { PricesField, type PriceSuggestion } from './prices-field';
import { ProjectsField } from './projects-field';
import { buttonClass } from '@/components/ui';
import type { ActionResult } from '../actions';
import { keepValues } from '../client';

export type { AgentFields, MandateFields } from '@/lib/mandate-form-data';

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
  error,
}: {
  name: string;
  title: string;
  value: string;
  help?: string;
  mono?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  /** A problem with the saved value, in plain words. */
  error?: string;
}) {
  return (
    <label className={label}>
      {title}
      <input
        name={name}
        defaultValue={value}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        className={`${input} ${mono ? 'tabular font-mono' : ''} ${error ? 'border-decline' : ''}`}
      />
      {help ? <span className={hint}>{help}</span> : null}
      <FieldError error={error} />
    </label>
  );
}

function FieldError({ error }: { error?: string | undefined }) {
  return error ? (
    <span className="mt-1 block text-xs font-normal text-decline">{error}</span>
  ) : null;
}

export function MandateForm({
  data,
  action,
  readOnly = false,
  fxAsText = false,
  baseHint = 'Fixed for a sandbox. Every limit is counted in it.',
  suggestions = [],
  preview,
}: {
  data: MandateFields;
  action: (p: ActionResult, f: FormData) => Promise<ActionResult>;
  /** Show the values without letting anyone change them (e.g. for viewers). */
  readOnly?: boolean;
  /** Exchange rates as one editable list ("EUR 0.94" per line), so new currencies can be added. */
  fxAsText?: boolean;
  baseHint?: string;
  /** Usual prices suggested from what was paid. */
  suggestions?: readonly PriceSuggestion[];
  /** Replays recent requests against the typed rules, without saving. */
  preview?: PreviewAction;
}) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(action, {});
  // The store's "Not saved" message, one plain problem per setting, placed at its field.
  const problems = useMemo(() => (state.error ? explainProblems(state.error) : []), [state.error]);
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of problems) {
      const key = fieldKey(p.path);
      if (key !== null) out[key] = out[key] ? `${out[key]} ${p.message}` : p.message;
    }
    return out;
  }, [problems]);
  const rates = data.fx.map(([code]) => code);
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
              error={errors['timezone']}
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
                  aria-invalid={errors.fx ? true : undefined}
                  className={`${area} tabular font-mono`}
                />
                <FieldError error={errors.fx} />
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
                error={errors.fx}
                title={`Exchange rate ${code} → ${data.baseCurrency}`}
                value={rate}
                mono
                inputMode="decimal"
                help={`${data.baseCurrency} per 1 ${code}. Static in this version.`}
              />
            ))}
            <Field
              name="blocked_countries"
              error={errors['blocked_countries']}
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
              <FieldError error={errors.blocked_suppliers} />
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
              <FieldError error={errors.start} />
            </div>
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-rule bg-surface px-4 py-5 sm:px-5">
          <legend className="px-1 text-base font-semibold">Fair price</legend>
          <p className="text-sm text-ink-2">
            Usual prices for items your agents buy. A request well above the usual price goes to a
            person; one far below it too, because a suspiciously cheap offer is often the wrong
            product or pack size. Items without a usual price are not checked.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <PricesField
                value={data.prices}
                baseCurrency={data.baseCurrency}
                rates={rates}
                decimals={data.currencyDecimals}
                suggestions={suggestions}
                disabled={readOnly}
                errors={errors}
              />
            </div>
            <Field
              name="above_percent"
              error={errors['above_percent']}
              title="Flag above the usual price by more than (%)"
              value={data.above_percent}
              mono
              inputMode="numeric"
            />
            <label className={label}>
              Then
              <select name="price_action" defaultValue={data.price_action} className={input}>
                <option value="review">A person decides</option>
                <option value="decline">Decline</option>
              </select>
              <FieldError error={errors.price_action} />
            </label>
            <Field
              name="below_percent"
              error={errors['below_percent']}
              title="Flag below the usual price by more than (%)"
              value={data.below_percent}
              mono
              inputMode="numeric"
              help="Leave empty to never flag cheap offers."
            />
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-rule bg-surface px-4 py-5 sm:px-5">
          <legend className="px-1 text-base font-semibold">Invoices</legend>
          <p className="text-sm text-ink-2">
            How far an invoice may differ from the approved amount before a person has to look at
            it. The larger of the two counts: with 2% and {data.baseCurrency} 5, an invoice for an
            approved {data.baseCurrency} 100 may be between {data.baseCurrency} 95 and 105.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              name="tolerance_percent"
              error={errors.tolerance_percent}
              title="Tolerance (%)"
              value={data.tolerance_percent}
              mono
              inputMode="decimal"
              help="From 0 to 50."
            />
            <Field
              name="tolerance_min"
              error={errors.tolerance_min}
              title={`At least (${data.baseCurrency})`}
              value={data.tolerance_min}
              mono
              inputMode="decimal"
              help="So small invoices are not flagged for a few cents."
            />
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-rule bg-surface px-4 py-5 sm:px-5">
          <legend className="px-1 text-base font-semibold">Projects</legend>
          <p className="mb-4 text-sm text-ink-2">
            A project has its own budget that purchases are booked to. An agent names the project
            with each request; one that must name a project is declined without it.
          </p>
          <ProjectsField
            value={data.projects}
            agentIds={data.agents.map((a) => a.id)}
            baseCurrency={data.baseCurrency}
            disabled={readOnly}
            errors={errors}
          />
        </fieldset>

        {data.agents.map((a) => (
          <fieldset
            key={a.id}
            className="rounded-xl border border-rule bg-surface px-4 py-5 sm:px-5"
          >
            <legend className="px-1 font-mono text-base font-semibold">{a.id}</legend>
            <input type="hidden" name="agent" value={a.id} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                name={`${a.id}.owner`}
                error={errors[`${a.id}.owner`]}
                title="Responsible owner"
                value={a.owner}
              />
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
                error={errors[`${a.id}.velocity_per_minute`]}
                title="Requests per minute"
                value={a.velocity_per_minute}
                mono
                inputMode="numeric"
              />
              <Field
                name={`${a.id}.daily_budget`}
                error={errors[`${a.id}.daily_budget`]}
                title={`Daily budget (${data.baseCurrency})`}
                value={a.daily_budget}
                mono
                inputMode="decimal"
              />
              <Field
                name={`${a.id}.monthly_budget`}
                error={errors[`${a.id}.monthly_budget`]}
                title={`Monthly budget (${data.baseCurrency})`}
                value={a.monthly_budget}
                mono
                inputMode="decimal"
                help="Optional. Leave empty for no monthly limit."
              />
              <Field
                name={`${a.id}.per_payment_limit`}
                error={errors[`${a.id}.per_payment_limit`]}
                title={`Per payment (${data.baseCurrency})`}
                value={a.per_payment_limit}
                mono
                inputMode="decimal"
              />
              <Field
                name={`${a.id}.approval_above`}
                error={errors[`${a.id}.approval_above`]}
                title={`Human approval above (${data.baseCurrency})`}
                value={a.approval_above}
                mono
                inputMode="decimal"
                help="Leave empty for no human review."
              />
              <Field
                name={`${a.id}.currencies`}
                error={errors[`${a.id}.currencies`]}
                title="Currencies"
                value={a.currencies}
                help="Comma-separated, e.g. CHF, EUR."
              />
              <Field
                name={`${a.id}.blocked_countries`}
                error={errors[`${a.id}.blocked_countries`]}
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
                <FieldError error={errors[`${a.id}.supplier_mode`]} />
              </label>
              <label className={label}>
                Approved suppliers
                <textarea name={`${a.id}.allow`} rows={3} defaultValue={a.allow} className={area} />
                <span className={hint}>One per line.</span>
                <FieldError error={errors[`${a.id}.allow`]} />
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
              <div className="sm:col-span-2 lg:col-span-3">
                <input type="hidden" name={`${a.id}.require_project.shown`} value="1" />
                <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
                  <input
                    type="checkbox"
                    name={`${a.id}.require_project`}
                    defaultChecked={a.require_project}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Every purchase must name a project
                </label>
                <FieldError error={errors[`${a.id}.require_project`]} />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <CategoryPicker
                  name={`${a.id}.categories`}
                  defaultValue={a.categories}
                  title="Categories"
                />
                <FieldError error={errors[`${a.id}.categories`]} />
              </div>
            </div>
          </fieldset>
        ))}
      </fieldset>

      {readOnly || !preview ? null : (
        <MandatePreview action={preview} baseCurrency={data.baseCurrency} />
      )}
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
          <div
            role="alert"
            className="rounded-lg border border-decline/30 bg-decline-soft px-4 py-3 text-sm text-decline"
          >
            <p className="font-medium">
              Not saved.{' '}
              {problems.length === 1
                ? 'One thing to fix'
                : `${String(problems.length)} things to fix`}
              {Object.keys(errors).length > 0 ? ', also shown at each field:' : ':'}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {problems.map((p, i) => (
                <li key={`${p.path}-${String(i)}`}>
                  {p.label ? <span className="font-medium">{p.label}: </span> : null}
                  {p.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.ok ? (
          <p className="rounded-lg bg-approve-soft px-4 py-3 text-sm text-approve">{state.ok}</p>
        ) : null}
      </div>
    </form>
  );
}
