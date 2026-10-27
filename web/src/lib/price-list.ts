import { findReference, normalizeName, type ReferencePrice } from '@flow-e/mcp/core';

/**
 * Usual prices as the Mandate page edits them: one line per item, "Item | price | other words |
 * unit". This module turns an uploaded price list (CSV) into such lines, and suggests usual
 * prices from what an organisation actually paid.
 */

export interface PriceLine {
  item: string;
  price: string;
  match: string;
  unit: string;
}

export function formatLine(l: PriceLine): string {
  return [l.item, l.price, l.match, l.unit].join(' | ').replace(/( \| )+$/, '');
}

export function parseLines(text: string): PriceLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [item = '', price = '', match = '', unit = ''] = line.split('|').map((p) => p.trim());
      return { item, price, match, unit };
    });
}

/** Lines in `next` replace lines for the same item in `current`; new items are added at the end. */
export function mergeLines(current: string, next: readonly PriceLine[]): string {
  const lines = parseLines(current);
  for (const n of next) {
    const at = lines.findIndex((l) => normalizeName(l.item) === normalizeName(n.item));
    if (at >= 0) lines[at] = n;
    else lines.push(n);
  }
  return lines.map(formatLine).join('\n');
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

const HEADERS = {
  item: ['item', 'product', 'name', 'article', 'description', 'artikel', 'produkt', 'bezeichnung'],
  price: ['price', 'unit price', 'usual price', 'preis', 'stückpreis', 'chf', 'eur', 'amount'],
  match: ['match', 'keywords', 'other words', 'aliases', 'stichworte'],
  unit: ['unit', 'pack', 'pack size', 'einheit'],
};

/** A price as the mandate wants it: "1250.50" from "1'250.50", "1,250.50" or "1250,50". */
function cleanPrice(raw: string): string | null {
  let p = raw.replace(/[^\d.,'-]/g, '').replace(/'/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(p)) p = p.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(p)) p = p.replace(',', '.');
  return /^\d+(\.\d{1,2})?$/.test(p) && Number(p) > 0 ? p : null;
}

export interface CsvResult {
  lines: PriceLine[];
  /** Rows that could not be read, with the reason, for the person uploading. */
  skipped: string[];
}

/**
 * A price list exported from a spreadsheet or a supplier: a header row naming at least an item
 * and a price column, then one item per row. Unknown columns are ignored.
 */
export function parsePriceCsv(text: string): CsvResult {
  const rows = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((r) => r.trim() !== '');
  const [head, ...body] = rows;
  if (head === undefined) return { lines: [], skipped: ['The file is empty.'] };
  const separator = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ',';
  const names = cells(head, separator).map((h) => h.toLowerCase());
  const column = (keys: readonly string[]) => names.findIndex((n) => keys.includes(n));
  const at = {
    item: column(HEADERS.item),
    price: column(HEADERS.price),
    match: column(HEADERS.match),
    unit: column(HEADERS.unit),
  };
  if (at.item < 0 || at.price < 0) {
    return {
      lines: [],
      skipped: ['The first row must name the columns, e.g. "Item,Price,Unit".'],
    };
  }
  const lines: PriceLine[] = [];
  const skipped: string[] = [];
  body.slice(0, 1000).forEach((row, i) => {
    const c = cells(row, separator);
    const item = (c[at.item] ?? '').replace(/\|/g, '/').slice(0, 200);
    const price = cleanPrice(c[at.price] ?? '');
    if (item === '' || price === null) {
      skipped.push(`Row ${String(i + 2)}: needs an item and a price above 0.`);
      return;
    }
    const get = (k: number) => (k < 0 ? '' : (c[k] ?? '').replace(/\|/g, '/'));
    lines.push({ item, price, match: get(at.match), unit: get(at.unit).slice(0, 40) });
  });
  if (body.length > 1000) skipped.push('Only the first 1,000 rows were read.');
  return { lines, skipped };
}

export interface PricedPayment {
  status: string;
  amountBase: number | null;
  createdAt: string;
  request: { item?: string; memo?: string; quantity?: number };
}

export interface Suggestion {
  item: string;
  /** Median unit price in base minor units. */
  priceBase: number;
  purchases: number;
}

const DAY = 86_400_000;

/**
 * Usual prices suggested from approved purchases of the last `days` days: the median unit price
 * of every item bought at least `min` times that no usual price covers yet.
 */
export function suggestPrices(
  payments: readonly PricedPayment[],
  references: readonly ReferencePrice[],
  now: number,
  { days = 90, min = 3 } = {},
): Suggestion[] {
  const groups = new Map<string, { item: string; units: number[] }>();
  for (const p of payments) {
    if (p.status !== 'approved' || p.amountBase === null) continue;
    if (Date.parse(p.createdAt) < now - days * DAY) continue;
    const item = (p.request.item ?? p.request.memo ?? '').trim();
    if (item === '' || findReference(references, item)) continue;
    const key = normalizeName(item);
    const g = groups.get(key) ?? { item, units: [] };
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
      return { item: g.item, priceBase: median, purchases: s.length };
    })
    .sort((a, b) => b.purchases - a.purchases || a.item.localeCompare(b.item))
    .slice(0, 20);
}
