'use client';

import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { buttonClass } from '@/components/ui';
import type { ProjectFields } from '@/lib/mandate-form-data';

const input =
  'mt-1 h-10 w-full min-w-0 rounded-lg border border-rule-strong bg-surface px-3 text-ink';
const label = 'block min-w-0 text-sm font-medium text-ink';

interface Keyed extends ProjectFields {
  key: string;
}

/**
 * Organisation-wide projects: a budget per month or in total, an optional end date, and the
 * agents that may book to it. Each row posts as project.<key>.<field>, keys under project.row.
 */
export function ProjectsField({
  value,
  agentIds,
  baseCurrency,
  disabled,
  errors = {},
}: {
  value: readonly ProjectFields[];
  agentIds: readonly string[];
  baseCurrency: string;
  disabled?: boolean;
  /** Problems by field: "project@<id>.<field>". */
  errors?: Readonly<Record<string, string>>;
}) {
  // Row keys: r0… for the stored rows, then counting on for rows added here.
  const next = useRef(value.length);
  const [rows, setRows] = useState<Keyed[]>(() =>
    value.map((p, i) => ({ ...p, key: `r${String(i)}` })),
  );
  const set = (key: string, change: Partial<ProjectFields>) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...change } : r)));
  };

  return (
    <div className="space-y-3">
      <input type="hidden" name="projects_shown" value="1" />
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-rule-strong px-3 py-3 text-sm text-ink-2">
          No projects yet. Add one to give a piece of work its own budget.
        </p>
      ) : null}
      <ul className="space-y-3">
        {rows.map((r) => {
          const err = (field: string) => errors[`project@${r.id || '(new)'}.${field}`];
          const rowProblems = ['id', 'name', 'budget', 'period', 'ends', 'agents']
            .map(err)
            .filter((e): e is string => e !== undefined);
          const k = r.key;
          return (
            <li key={k} className="rounded-lg border border-rule p-3">
              <input type="hidden" name="project.row" value={k} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.6fr_1fr_1fr_1fr]">
                <label className={label}>
                  Id
                  <input
                    name={`project.${k}.id`}
                    value={r.id}
                    onChange={(e) => {
                      set(k, { id: e.currentTarget.value });
                    }}
                    placeholder="lab-2027"
                    aria-invalid={err('id') ? true : undefined}
                    className={`${input} font-mono`}
                  />
                </label>
                <label className={label}>
                  Name
                  <input
                    name={`project.${k}.name`}
                    value={r.name}
                    onChange={(e) => {
                      set(k, { name: e.currentTarget.value });
                    }}
                    placeholder="New lab wing"
                    aria-invalid={err('name') ? true : undefined}
                    className={input}
                  />
                </label>
                <label className={label}>
                  Budget ({baseCurrency})
                  <input
                    name={`project.${k}.budget`}
                    value={r.budget}
                    onChange={(e) => {
                      set(k, { budget: e.currentTarget.value });
                    }}
                    inputMode="decimal"
                    aria-invalid={err('budget') ? true : undefined}
                    className={`${input} tabular font-mono`}
                  />
                </label>
                <label className={label}>
                  Budget is
                  <select
                    name={`project.${k}.period`}
                    value={r.period}
                    onChange={(e) => {
                      set(k, { period: e.currentTarget.value });
                    }}
                    className={input}
                  >
                    <option value="month">per month</option>
                    <option value="total">in total</option>
                  </select>
                </label>
                <label className={label}>
                  Ends (optional)
                  <input
                    type="date"
                    name={`project.${k}.ends`}
                    value={r.ends}
                    onChange={(e) => {
                      set(k, { ends: e.currentTarget.value });
                    }}
                    aria-invalid={err('ends') ? true : undefined}
                    className={input}
                  />
                </label>
              </div>
              <fieldset className="mt-3">
                <legend className="text-sm font-medium text-ink">Agents that may book to it</legend>
                {agentIds.length === 0 ? (
                  <p className="mt-1 text-xs text-ink-3">No agents yet.</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
                    {agentIds.map((id) => (
                      <label key={id} className="inline-flex items-center gap-1.5 text-sm text-ink">
                        <input
                          type="checkbox"
                          name={`project.${k}.agents`}
                          value={id}
                          checked={r.agents.includes(id)}
                          onChange={(e) => {
                            const on = e.currentTarget.checked;
                            set(k, {
                              agents: on ? [...r.agents, id] : r.agents.filter((a) => a !== id),
                            });
                          }}
                          className="size-4 accent-[var(--accent)]"
                        />
                        <span className="font-mono">{id}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-xs text-ink-3">
                  None ticked: every agent may book to it. Purchases stop once the budget is used,
                  and after the end date.
                </p>
              </fieldset>
              {rowProblems.length > 0 ? (
                <p className="mt-2 text-xs text-decline">{rowProblems.join(' ')}</p>
              ) : null}
              {disabled ? null : (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    className={buttonClass('quiet', 'sm')}
                    onClick={() => {
                      setRows((current) => current.filter((x) => x.key !== k));
                    }}
                  >
                    <X size={15} aria-hidden="true" />
                    Remove project
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {disabled ? null : (
        <button
          type="button"
          className={buttonClass('secondary', 'sm')}
          onClick={() => {
            setRows((current) => [
              ...current,
              {
                key: `r${String(next.current++)}`,
                id: '',
                name: '',
                budget: '',
                period: 'month',
                ends: '',
                agents: [],
              },
            ]);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add a project
        </button>
      )}
    </div>
  );
}
