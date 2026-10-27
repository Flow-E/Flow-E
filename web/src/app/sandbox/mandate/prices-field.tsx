'use client';

import { useId, useRef, useState } from 'react';
import { Download, Plus, Upload, X } from 'lucide-react';
import { buttonClass } from '@/components/ui';
import {
  emptyRow,
  isBlankRow,
  mergeRows,
  parsePriceCsv,
  type LineProblem,
  type PriceRow,
} from '@/lib/price-list';

export interface PriceSuggestion {
  item: string;
  /** The supplier it was paid to; empty when the requests named none. */
  supplier: string;
  /** Major units of the base currency, as typed into the list, e.g. "305" or "305.50". */
  price: string;
  /** e.g. "CHF 305.00, median of 6 purchases". */
  why: string;
}

const cell =
  'h-9 w-full min-w-0 rounded-lg border border-rule-strong bg-surface px-2.5 text-sm text-ink';
const COLUMNS: { field: keyof PriceRow; title: string; mono?: boolean }[] = [
  { field: 'item', title: 'Item' },
  { field: 'supplier', title: 'Supplier' },
  { field: 'price', title: 'Usual price', mono: true },
  { field: 'currency', title: 'Currency', mono: true },
  { field: 'unit', title: 'Unit' },
  { field: 'keywords', title: 'Other words' },
];

interface Keyed {
  key: string;
  row: PriceRow;
}

/**
 * The usual-prices table: typed, imported from a CSV price list, or taken from suggestions based
 * on what was paid. Each row posts as price.<key>.<field>, with the keys under price.row.
 */
export function PricesField({
  value,
  baseCurrency,
  rates,
  decimals,
  suggestions,
  disabled,
  errors = {},
}: {
  value: readonly PriceRow[];
  baseCurrency: string;
  /** Currencies with an exchange rate in the saved mandate. */
  rates: readonly string[];
  decimals?: Readonly<Record<string, number>>;
  suggestions: readonly PriceSuggestion[];
  disabled?: boolean;
  /** Problems by field: "price#<index among filled rows>.<field>". */
  errors?: Readonly<Record<string, string>>;
}) {
  // Row keys: r0… for the stored rows, then counting on for rows added here.
  const next = useRef(value.length);
  const keyed = (row: PriceRow): Keyed => ({ key: `r${String(next.current++)}`, row });
  const [rows, setRows] = useState<Keyed[]>(() =>
    value.map((row, i) => ({ key: `r${String(i)}`, row })),
  );
  const [summary, setSummary] = useState('');
  const [problems, setProblems] = useState<LineProblem[]>([]);
  const [used, setUsed] = useState<string[]>([]);
  const fileId = useId();
  const open = suggestions.filter((s) => !used.includes(`${s.item}\u0000${s.supplier}`));

  const merge = (incoming: readonly PriceRow[]) => {
    setRows((current) => {
      const merged = mergeRows(
        current.map((k) => k.row),
        incoming,
      );
      // Keep the keys of rows that stay, so typed values and focus survive.
      return merged.map((row) => current.find((k) => k.row === row) ?? keyed(row));
    });
  };
  const update = (key: string, field: keyof PriceRow, v: string) => {
    setRows((current) =>
      current.map((k) => (k.key === key ? { key, row: { ...k.row, [field]: v } } : k)),
    );
  };

  // Problems name rows by their place among the filled-in rows, as the form posts them.
  const filledIndex = new Map<string, number>();
  for (const k of rows) if (!isBlankRow(k.row)) filledIndex.set(k.key, filledIndex.size);
  return (
    <div className="space-y-3">
      <input type="hidden" name="prices_shown" value="1" />
      <div>
        <p className="text-sm font-medium text-ink">Usual prices</p>
        <p className="mt-0.5 text-xs text-ink-3">
          One row per item, and per supplier when suppliers charge differently. Leave the supplier
          empty for a price that applies to every supplier. The currency is {baseCurrency} unless
          you enter another one; other currencies need an exchange rate above. Other words are names
          an agent might use for the item, comma-separated.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-rule-strong px-3 py-3 text-sm text-ink-2">
          No usual prices yet. Add a row, import a price list, or take a suggestion below.
        </p>
      ) : (
        <div className="space-y-2">
          <div
            aria-hidden="true"
            className="hidden gap-2 px-0.5 text-xs font-medium text-ink-3 lg:grid lg:grid-cols-[2fr_1.4fr_1fr_0.7fr_0.8fr_1.4fr_2.25rem]"
          >
            {COLUMNS.map((c) => (
              <span key={c.field}>{c.title}</span>
            ))}
            <span />
          </div>
          <ul className="space-y-2">
            {rows.map(({ key, row }) => {
              const index = filledIndex.get(key) ?? -1;
              const rowErrors = COLUMNS.map((c) => errors[`price#${String(index)}.${c.field}`])
                .filter((e): e is string => e !== undefined)
                .filter((e, i, all) => all.indexOf(e) === i);
              return (
                <li key={key} className="rounded-lg border border-rule p-2.5 lg:border-0 lg:p-0">
                  <input type="hidden" name="price.row" value={key} />
                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-[2fr_1.4fr_1fr_0.7fr_0.8fr_1.4fr_2.25rem] lg:items-center">
                    {COLUMNS.map((c) => {
                      const bad = errors[`price#${String(index)}.${c.field}`] !== undefined;
                      return (
                        <label
                          key={c.field}
                          className={`block min-w-0 text-xs text-ink-3 ${
                            c.field === 'item' || c.field === 'supplier' || c.field === 'keywords'
                              ? 'col-span-2 lg:col-span-1'
                              : ''
                          }`}
                        >
                          <span className="lg:sr-only">{c.title}</span>
                          <input
                            name={`price.${key}.${c.field}`}
                            value={row[c.field]}
                            onChange={(e) => {
                              update(key, c.field, e.currentTarget.value);
                            }}
                            placeholder={c.field === 'currency' ? baseCurrency : undefined}
                            inputMode={c.field === 'price' ? 'decimal' : undefined}
                            aria-invalid={bad || undefined}
                            className={`${cell} mt-0.5 lg:mt-0 ${c.mono ? 'tabular font-mono' : ''} ${
                              bad ? 'border-decline' : ''
                            }`}
                          />
                        </label>
                      );
                    })}
                    {disabled ? null : (
                      <button
                        type="button"
                        onClick={() => {
                          setRows((current) => current.filter((k) => k.key !== key));
                        }}
                        className={`${buttonClass('quiet', 'sm')} col-span-2 justify-self-end lg:col-span-1`}
                        aria-label={`Remove ${row.item || 'this row'}`}
                      >
                        <X size={15} aria-hidden="true" />
                        <span className="lg:sr-only">Remove</span>
                      </button>
                    )}
                  </div>
                  {rowErrors.length > 0 ? (
                    <p className="mt-1 text-xs text-decline">{rowErrors.join(' ')}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {disabled ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => {
              setRows((current) => [...current, keyed(emptyRow())]);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            Add a row
          </button>
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
                setSummary(
                  'The file is larger than 1 MB. Split it, or keep only the columns needed.',
                );
                setProblems([]);
                return;
              }
              void file.text().then((content) => {
                const result = parsePriceCsv(content, { baseCurrency, rates, decimals });
                merge(result.rows);
                const n = result.rows.length;
                const p = result.problems.length;
                setSummary(
                  `${String(n)} ${n === 1 ? 'item' : 'items'} imported${
                    p > 0 ? `, ${String(p)} ${p === 1 ? 'line' : 'lines'} not imported (below)` : ''
                  }. Check them, then save.`,
                );
                setProblems(result.problems);
              });
            }}
          />
          <a href="/price-list-template.csv" download className={buttonClass('quiet', 'sm')}>
            <Download size={14} aria-hidden="true" />
            Template
          </a>
        </div>
      )}
      {disabled ? null : (
        <p className="text-xs text-ink-3">
          CSV columns: Supplier, Item, Unit, Price, Currency, and optionally Keywords (German
          headers such as Lieferant, Artikel, Einheit, Preis, Währung work too). Comma or semicolon
          separated. Rows for an item and supplier already in the table replace it.
        </p>
      )}
      <div aria-live="polite">
        {summary ? <p className="text-sm text-ink-2">{summary}</p> : null}
        {problems.length > 0 ? (
          <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-decline/30 bg-decline-soft px-3 py-2 text-sm text-decline">
            {problems.map((p) => (
              <li key={`${String(p.line)}-${p.reason}`}>
                Line {p.line}: {p.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {!disabled && open.length > 0 ? (
        <div className="rounded-lg border border-rule bg-sunken px-3 py-3">
          <p className="text-sm font-medium text-ink">Suggested from what you paid</p>
          <p className="text-xs text-ink-3">
            Items bought from the same supplier at least three times in the last 90 days that have
            no usual price yet. Add one to put it in the table, where you can still change it.
          </p>
          <ul className="mt-2 space-y-1.5">
            {open.map((s) => (
              <li
                key={`${s.item}-${s.supplier}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              >
                <span className="min-w-0 flex-1 text-ink">
                  {s.item}
                  {s.supplier ? <span className="text-ink-2"> from {s.supplier}</span> : null}{' '}
                  <span className="text-ink-3">· {s.why}</span>
                </span>
                <button
                  type="button"
                  className={buttonClass('quiet', 'sm')}
                  onClick={() => {
                    merge([{ ...emptyRow(), item: s.item, supplier: s.supplier, price: s.price }]);
                    setUsed((u) => [...u, `${s.item}\u0000${s.supplier}`]);
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
