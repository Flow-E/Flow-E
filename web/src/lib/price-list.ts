import {
  AmountError,
  currencyDecimals,
  findReference,
  normalizeName,
  parseAmount,
  type ReferencePrice,
} from '@flow-e/mcp/core';

/**
 * Usual prices as the Mandate page edits them: one row per item and supplier. This module turns
 * an uploaded price list (CSV) into such rows, and suggests usual prices from what an
 * organisation actually paid.
 */

/** One usual price as the form shows it. Every field is text; empty means "not set". */
export interface PriceRow {
  item: string;
  /** Empty: the price applies to every supplier. */
  supplier: string;
  /** Major units of `currency`, e.g. "1150" or "24.50". */
  price: string;
  /** Empty: the organisation's base currency. */
  currency: string;
  unit: string;
  /** Other words that name the item, comma-separated. */
  keywords: string;
}

export const emptyRow = (): PriceRow => ({
  item: '',
  supplier: '',
  price: '',
  currency: '',
  unit: '',
  keywords: '',
});

/** A row nobody typed anything into; the form ignores it. */
export const isBlankRow = (r: PriceRow) =>
  [r.item, r.supplier, r.price, r.currency, r.unit, r.keywords].every((v) => v.trim() === '');

const rowKey = (r: { item: string; supplier: string }) =>
  `${normalizeName(r.item)}\u0000${normalizeName(r.supplier)}`;

/** Rows in `next` replace rows for the same item and supplier; new ones are added at the end. */
export function mergeRows(current: readonly PriceRow[], next: readonly PriceRow[]): PriceRow[] {
  const rows = current.filter((r) => !isBlankRow(r));
  for (const n of next) {
    const at = rows.findIndex((r) => rowKey(r) === rowKey(n));
    if (at >= 0) rows[at] = n;
    else rows.push(n);
  }
  return rows;
}

/** One CSV row into cells: comma or semicolon separated, with "quoted, cells". */
function cells(row: string, separator: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row.charAt(i);
    if (quoted) {
      if (c === '"' && row[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === separator) {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

/** Header names, in English and German, lower case. */
const HEADERS = {
  supplier: ['supplier', 'vendor', 'seller', 'lieferant', 'anbieter', 'händler', 'haendler'],
  item: [
    'item',
    'product',
    'name',
    'article',
    'description',
    'artikel',
    'produkt',
    'bezeichnung',
    'artikelbezeichnung',
    'beschreibung',
  ],
  unit: ['unit', 'pack', 'pack size', 'einheit', 'packung', 'verpackungseinheit', 'menge'],
  price: [
    'price',
    'unit price',
    'usual price',
    'amount',
    'preis',
    'stückpreis',
    'stueckpreis',
    'einzelpreis',
    'betrag',
  ],
  currency: ['currency', 'ccy', 'währung', 'waehrung'],
  keywords: [
    'keywords',
    'match',
    'other words',
    'aliases',
    'stichworte',
    'stichwörter',
    'schlagworte',
    'suchbegriffe',
  ],
} as const;

const CODE = /^[A-Z]{3,5}$/;

/**
 * A price as typed in a spreadsheet, as a plain decimal: "1250.50" from "1'250.50",
 * "1,250.50", "1.250,50" or "1250,50". Null when it is not a number at all.
 */
function cleanPrice(raw: string): string | null {
  let p = raw.replace(/[^\d.,'-]/g, '').replace(/'/g, '');
  if (p === '' || p.startsWith('-')) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(p)) p = p.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(p)) p = p.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d+$/.test(p)) p = p.replace(',', '.');
  return /^\d+(\.\d+)?$/.test(p) ? p : null;
}

/** Integer minor units back to the major-unit text the form shows, e.g. 131050 → "1310.50". */
export function majorUnits(minor: number, decimals: number): string {
  if (decimals === 0) return String(minor);
  const s = String(minor).padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

export interface ImportedRow extends PriceRow {
  /** The price in integer minor units of its currency (base currency when `currency` is empty). */
  priceMinor: number;
  /** The line of the file it came from. */
  line: number;
}

export interface LineProblem {
  /** Line number in the file (the header is line 1). */
  line: number;
  reason: string;
}

export interface CsvResult {
  rows: ImportedRow[];
  /** Every line that could not be read, with the reason. Nothing is dropped without one. */
  problems: LineProblem[];
}

export interface CsvContext {
  baseCurrency: string;
  /** Currencies with an exchange rate in the mandate. */
  rates: readonly string[];
  /** The mandate's `currency_decimals`, if any. */
  decimals?: Readonly<Record<string, number>>;
}

export const MAX_ROWS = 1000;

/**
 * A price list exported from a spreadsheet or a supplier: a header row naming at least an item
 * and a price column, then one item per line. Columns: supplier, item, unit, price, currency
 * and keywords, in English or German. Unknown columns are ignored.
 */
export function parsePriceCsv(text: string, ctx: CsvContext): CsvResult {
  const all = text.replace(/^﻿/, '').split(/\r?\n/);
  const headAt = all.findIndex((r) => r.trim() !== '');
  if (headAt < 0) return { rows: [], problems: [{ line: 1, reason: 'The file is empty.' }] };
  const head = all[headAt] ?? '';
  const separator = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ',';
  const names = cells(head, separator).map((h) => h.toLowerCase().replace(/\s+/g, ' '));
  // "Price (EUR)" or "Preis CHF": a price column whose currency is in the header.
  let headerCurrency = '';
  const column = (keys: readonly string[]) =>
    names.findIndex((n) => {
      if (keys.includes(n)) return true;
      const m = /^(.+?)[\s(]+([a-z]{3})\)?$/.exec(n);
      if (m?.[1] && m[2] && keys === HEADERS.price && keys.includes(m[1])) {
        headerCurrency = m[2].toUpperCase();
        return true;
      }
      return false;
    });
  const at = {
    supplier: column(HEADERS.supplier),
    item: column(HEADERS.item),
    unit: column(HEADERS.unit),
    price: column(HEADERS.price),
    currency: column(HEADERS.currency),
    keywords: column(HEADERS.keywords),
  };
  if (at.item < 0 || at.price < 0) {
    return {
      rows: [],
      problems: [
        {
          line: headAt + 1,
          reason:
            'The first line must name the columns, at least an item and a price, e.g. "Supplier,Item,Unit,Price,Currency".',
        },
      ],
    };
  }

  const rows: ImportedRow[] = [];
  const problems: LineProblem[] = [];
  const seen = new Map<string, number>();
  for (let i = headAt + 1; i < all.length; i++) {
    const raw = all[i] ?? '';
    const line = i + 1;
    if (raw.trim() === '') continue;
    if (rows.length >= MAX_ROWS) {
      problems.push({
        line,
        reason: `Not read: a price list holds at most ${MAX_ROWS.toLocaleString('en-GB')} items.`,
      });
      continue;
    }
    const c = cells(raw, separator);
    if (c.every((v) => v === '')) continue;
    const get = (k: number) => (k < 0 ? '' : (c[k] ?? '').trim());
    const item = get(at.item);
    const supplier = get(at.supplier);
    const unit = get(at.unit);
    const priceCell = get(at.price);
    const reasons: string[] = [];

    if (item === '') reasons.push('the item is missing');
    else if (item.length > 200) reasons.push('the item name is longer than 200 characters');
    if (supplier.length > 200) reasons.push('the supplier name is longer than 200 characters');
    if (unit.length > 40) reasons.push('the unit is longer than 40 characters');

    // The currency: its own column, else a code in the price cell or header, else the base.
    const inCell = /\d/.test(priceCell)
      ? (/\b([A-Za-z]{3})\b/.exec(priceCell)?.[1]?.toUpperCase() ?? '')
      : '';
    const currency = (get(at.currency) || inCell || headerCurrency || ctx.baseCurrency)
      .trim()
      .toUpperCase();
    let currencyOk = true;
    if (!CODE.test(currency)) {
      reasons.push(`"${currency}" is not a currency code such as CHF or EUR`);
      currencyOk = false;
    } else if (currency !== ctx.baseCurrency && !ctx.rates.includes(currency)) {
      reasons.push(
        `the mandate has no exchange rate for ${currency}; add one under Exchange rates, save, then import again`,
      );
      currencyOk = false;
    }

    let priceMinor = 0;
    let price = '';
    const clean = cleanPrice(priceCell);
    if (priceCell === '') reasons.push('the price is missing');
    else if (clean === null) reasons.push(`"${priceCell}" is not a price`);
    else if (currencyOk) {
      try {
        priceMinor = parseAmount(clean, currency, ctx.decimals);
        if (priceMinor === 0) reasons.push('the price must be above 0');
        price = majorUnits(priceMinor, currencyDecimals(currency, ctx.decimals));
      } catch (err) {
        reasons.push(
          err instanceof AmountError && /decimal places/.test(err.message)
            ? `${currency} prices have ${String(currencyDecimals(currency, ctx.decimals))} decimal places; "${priceCell}" has more`
            : `"${priceCell}" is not a price`,
        );
      }
    }

    const words = get(at.keywords)
      .split(/\s*[,;|]\s*/)
      .map((w) => w.trim())
      .filter((w) => w !== '');
    const short = words.find((w) => w.length < 2 || w.length > 100);
    if (short !== undefined) {
      reasons.push(`the keyword "${short}" must be 2 to 100 characters long`);
    }
    if (words.length > 20) reasons.push('more than 20 keywords');

    const key = rowKey({ item, supplier });
    const first = seen.get(key);
    if (item !== '' && first !== undefined) {
      reasons.push(
        `${supplier ? `"${item}" from ${supplier}` : `"${item}"`} is already on line ${String(first)}`,
      );
    }

    if (reasons.length > 0) {
      const text = reasons.join('; ');
      problems.push({ line, reason: text.charAt(0).toUpperCase() + text.slice(1) + '.' });
      continue;
    }
    seen.set(key, line);
    rows.push({
      item,
      supplier,
      price,
      currency: currency === ctx.baseCurrency ? '' : currency,
      unit,
      keywords: words.join(', '),
      priceMinor,
      line,
    });
  }
  return { rows, problems };
}

export interface PricedPayment {
  status: string;
  amountBase: number | null;
  createdAt: string;
  request: { item?: string; memo?: string; quantity?: number; merchant?: string };
}

export interface Suggestion {
  item: string;
  /** The supplier it was paid to; empty when the requests named none. */
  supplier: string;
  /** Median unit price in base minor units. */
  priceBase: number;
  purchases: number;
}

const DAY = 86_400_000;

/**
 * Usual prices suggested from approved purchases of the last `days` days: the median unit price
 * of every item bought from the same supplier at least `min` times that no usual price covers
 * yet.
 */
export function suggestPrices(
  payments: readonly PricedPayment[],
  references: readonly ReferencePrice[],
  now: number,
  { days = 90, min = 3 } = {},
): Suggestion[] {
  const groups = new Map<string, { item: string; supplier: string; units: number[] }>();
  for (const p of payments) {
    if (p.status !== 'approved' || p.amountBase === null) continue;
    if (Date.parse(p.createdAt) < now - days * DAY) continue;
    const item = (p.request.item ?? p.request.memo ?? '').trim();
    const supplier = (p.request.merchant ?? '').trim();
    if (item === '' || findReference(references, item, supplier || undefined)) continue;
    const key = rowKey({ item, supplier });
    const g = groups.get(key) ?? { item, supplier, units: [] };
    g.units.push(Math.round(p.amountBase / Math.max(1, p.request.quantity ?? 1)));
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.units.length >= min)
    .map((g) => {
      const s = [...g.units].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      const median =
        s.length % 2 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
      return { item: g.item, supplier: g.supplier, priceBase: median, purchases: s.length };
    })
    .sort((a, b) => b.purchases - a.purchases || a.item.localeCompare(b.item))
    .slice(0, 20);
}
