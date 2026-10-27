'use client';

import { useId, useState } from 'react';
import { Upload } from 'lucide-react';
import { buttonClass } from '@/components/ui';
import { mergeLines, parsePriceCsv } from '@/lib/price-list';

export interface PriceSuggestion {
  item: string;
  /** Major units, as typed into the list, e.g. "305" or "305.50". */
  price: string;
  /** e.g. "CHF 305.00, median of 6 purchases". */
  why: string;
}

const area = 'mt-1.5 w-full rounded-lg border border-rule-strong bg-surface px-3 py-2 text-ink';

/**
 * The usual-prices list: typed, imported from a CSV price list, or taken from suggestions based
 * on what was paid. The form receives the lines under `prices`.
 */
export function PricesField({
  value,
  baseCurrency,
  suggestions,
  disabled,
}: {
  value: string;
  baseCurrency: string;
  suggestions: readonly PriceSuggestion[];
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const [notice, setNotice] = useState<string[]>([]);
  const [used, setUsed] = useState<string[]>([]);
  const fileId = useId();
  const open = suggestions.filter((s) => !used.includes(s.item));

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-ink">
        Usual prices ({baseCurrency})
        <textarea
          name="prices"
          rows={Math.min(14, Math.max(4, text.split('\n').length + 1))}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          placeholder={
            'Phosphate buffer solution, 10 L | 1150 | phosphate buffer\nPrinter paper, 5 reams | 24 | printer paper | box'
          }
          className={`${area} tabular font-mono text-sm`}
        />
        <span className="mt-1 block text-xs font-normal text-ink-3">
          One item per line: item | usual price per unit | other words that name it, comma-separated
          (optional) | unit (optional). Agents send the item and quantity with each request.
        </span>
      </label>

      {disabled ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={fileId} className={`${buttonClass('secondary', 'sm')} cursor-pointer`}>
            <Upload size={14} aria-hidden="true" />
            Import a price list (CSV)
          </label>
          <input
            id={fileId}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              if (file.size > 1_000_000) {
                setNotice([
                  'The file is larger than 1 MB. Split it, or keep only the columns needed.',
                ]);
                return;
              }
              void file.text().then((content) => {
                const { lines, skipped } = parsePriceCsv(content);
                setText((t) => mergeLines(t, lines));
                setNotice([
                  `${String(lines.length)} ${lines.length === 1 ? 'item' : 'items'} imported. Check them, then save.`,
                  ...skipped.slice(0, 5),
                  ...(skipped.length > 5
                    ? [`… and ${String(skipped.length - 5)} more rows skipped.`]
                    : []),
                ]);
              });
            }}
          />
          <span className="text-xs text-ink-3">
            Columns: Item, Price, and optionally Unit and Keywords. Comma or semicolon separated.
          </span>
        </div>
      )}
      {notice.length > 0 ? (
        <ul aria-live="polite" className="space-y-0.5 text-sm text-ink-2">
          {notice.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      {!disabled && open.length > 0 ? (
        <div className="rounded-lg border border-rule bg-sunken px-3 py-3">
          <p className="text-sm font-medium text-ink">Suggested from what you paid</p>
          <p className="text-xs text-ink-3">
            Items bought at least three times in the last 90 days that have no usual price yet.
          </p>
          <ul className="mt-2 space-y-1.5">
            {open.map((s) => (
              <li key={s.item} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="min-w-0 flex-1 text-ink">
                  {s.item} <span className="text-ink-3">· {s.why}</span>
                </span>
                <button
                  type="button"
                  className={buttonClass('quiet', 'sm')}
                  onClick={() => {
                    setText((t) =>
                      mergeLines(t, [{ item: s.item, price: s.price, match: '', unit: '' }]),
                    );
                    setUsed((u) => [...u, s.item]);
                  }}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
