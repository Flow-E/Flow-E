'use client';

import { useId, useState } from 'react';
import { CATEGORY_GROUPS, KNOWN_CODES, splitCodes } from '@/lib/mcc';

/**
 * Checkboxes with plain names for the common categories, plus a field for any other code. The
 * form receives one comma-separated value under `name`, exactly as the old text field sent it.
 */
export function CategoryPicker({
  name,
  defaultValue = '',
  title = 'Allowed categories',
}: {
  name: string;
  defaultValue?: string;
  title?: string;
}) {
  const initial = splitCodes(defaultValue);
  const [picked, setPicked] = useState<string[]>(initial.filter((c) => KNOWN_CODES.has(c)));
  const [other, setOther] = useState(initial.filter((c) => !KNOWN_CODES.has(c)).join(', '));
  const otherId = useId();
  const value = [...picked, ...splitCodes(other)].join(', ');

  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium text-ink">{title}</legend>
      <p className="mt-1 text-xs text-ink-3">
        What this agent may buy. A request in any other category is declined.
      </p>
      <input type="hidden" name={name} value={value} />
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        {CATEGORY_GROUPS.map((g) => (
          <div key={g.title} className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{g.title}</p>
            <ul className="mt-1.5 space-y-1">
              {g.items.map((c) => (
                <li key={c.code}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                      checked={picked.includes(c.code)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setPicked((p) => (on ? [...p, c.code] : p.filter((x) => x !== c.code)));
                      }}
                    />
                    <span>
                      {c.name}{' '}
                      <span className="tabular font-mono text-xs text-ink-3">{c.code}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <label htmlFor={otherId} className="mt-3 block text-sm font-medium text-ink">
        Other codes
        <input
          id={otherId}
          value={other}
          onChange={(e) => {
            setOther(e.currentTarget.value);
          }}
          inputMode="numeric"
          placeholder="e.g. 5200, 5251"
          className="tabular mt-1.5 h-10 w-full rounded-lg border border-rule-strong bg-surface px-3 font-mono text-ink placeholder:text-ink-3 sm:w-72"
        />
        <span className="mt-1 block text-xs font-normal text-ink-3">
          Optional. Four-digit merchant category codes (MCC), comma-separated.
        </span>
      </label>
    </fieldset>
  );
}
