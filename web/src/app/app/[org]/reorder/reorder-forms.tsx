'use client';

import { useActionState, useState } from 'react';
import { Play, Plus, Trash2 } from 'lucide-react';
import { buttonClass } from '@/components/ui';
import type { ReorderResult } from './actions';

type Act = (prev: ReorderResult, form: FormData) => Promise<ReorderResult>;

export interface Row {
  item: string;
  supplier: string;
  quantity: string;
  stock: string;
  minStock: string;
  category: string;
  country: string;
}

const EMPTY: Row = {
  item: '',
  supplier: '',
  quantity: '1',
  stock: '',
  minStock: '',
  category: '',
  country: '',
};

const COLUMNS: { key: keyof Row; label: string; hint?: string; width: string; mode?: 'numeric' }[] =
  [
    { key: 'item', label: 'Item', width: 'sm:col-span-3' },
    {
      key: 'supplier',
      label: 'Supplier',
      hint: 'From the price list if empty',
      width: 'sm:col-span-3',
    },
    { key: 'quantity', label: 'Reorder qty', width: 'sm:col-span-1', mode: 'numeric' },
    { key: 'stock', label: 'In stock', hint: 'Optional', width: 'sm:col-span-1', mode: 'numeric' },
    {
      key: 'minStock',
      label: 'Reorder below',
      hint: 'Optional',
      width: 'sm:col-span-1',
      mode: 'numeric',
    },
    {
      key: 'category',
      label: 'Category',
      hint: 'e.g. 5169',
      width: 'sm:col-span-1',
      mode: 'numeric',
    },
    { key: 'country', label: 'Country', hint: 'e.g. CH', width: 'sm:col-span-1' },
  ];

function Message({ state }: { state: ReorderResult }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-decline">
        {state.error}
      </p>
    );
  }
  return state.ok ? (
    <p role="status" className="text-sm text-approve">
      {state.ok}
    </p>
  ) : null;
}

/** The reorder list as editable rows; saved as a whole. */
export function ReorderListForm({
  action,
  orgId,
  initial,
  readOnly,
}: {
  action: Act;
  orgId: string;
  initial: Row[];
  readOnly: boolean;
}) {
  const [state, run, pending] = useActionState<ReorderResult, FormData>(action, {});
  const [rows, setRows] = useState<Row[]>(initial.length > 0 ? initial : [{ ...EMPTY }]);
  const set = (i: number, key: keyof Row, value: string) => {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, [key]: value } : row)));
  };

  return (
    <form action={run} className="space-y-3">
      <input type="hidden" name="org" value={orgId} />
      <ol className="space-y-3">
        {rows.map((row, i) => (
          <li
            key={i}
            className="grid grid-cols-2 gap-2 rounded-lg border border-rule bg-surface p-3 sm:grid-cols-12 sm:items-end"
          >
            {COLUMNS.map((c) => (
              <label
                key={c.key}
                className={`min-w-0 text-xs text-ink-3 ${c.key === 'item' || c.key === 'supplier' ? 'col-span-2' : ''} ${c.width}`}
              >
                <span className="block truncate">
                  {c.label}
                  {c.hint ? <span className="sr-only"> ({c.hint})</span> : null}
                </span>
                <input
                  name={c.key}
                  value={row[c.key]}
                  inputMode={c.mode}
                  placeholder={c.hint ?? ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    set(i, c.key, e.target.value);
                  }}
                  className="mt-1 w-full rounded-md border border-rule-strong bg-paper px-2 py-1.5 text-sm text-ink placeholder:text-ink-3"
                />
              </label>
            ))}
            {!readOnly ? (
              <button
                type="button"
                aria-label={`Remove line ${String(i + 1)}`}
                onClick={() => {
                  setRows((r) => (r.length === 1 ? [{ ...EMPTY }] : r.filter((_, j) => j !== i)));
                }}
                className={`${buttonClass('quiet', 'sm')} col-span-2 justify-self-end sm:col-span-12`}
              >
                <Trash2 size={14} aria-hidden="true" /> Remove
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => {
              setRows((r) => [...r, { ...EMPTY }]);
            }}
          >
            <Plus size={14} aria-hidden="true" /> Add item
          </button>
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : 'Save list'}
          </button>
          <Message state={state} />
        </div>
      ) : null}
    </form>
  );
}

/** Pick an agent and start a run. */
export function RunReorderForm({
  action,
  orgId,
  agents,
  mode,
}: {
  action: Act;
  orgId: string;
  agents: { id: string; name: string }[];
  mode: 'claude' | 'simulated';
}) {
  const [state, run, pending] = useActionState<ReorderResult, FormData>(action, {});
  return (
    <form action={run} className="space-y-3">
      <input type="hidden" name="org" value={orgId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-2">
          <span className="block">Run as agent</span>
          <select
            name="agent"
            className="mt-1 rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending || agents.length === 0}
          className={buttonClass('primary')}
        >
          <Play size={15} aria-hidden="true" />
          {pending ? 'Running…' : mode === 'claude' ? 'Run reorder' : 'Run reorder (simulated)'}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}
