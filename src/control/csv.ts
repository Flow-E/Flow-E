import { formatMoney } from '../engine/money.js';
import type { Entry, Ledger } from '../ledger/index.js';

/**
 * Ledger export as CSV, one row per entry. Merchant names and memos come from the agent, so every
 * cell is quoted and anything a spreadsheet would run as a formula is neutralised.
 */

const COLUMNS = [
  'seq',
  'created_at',
  'type',
  'agent_id',
  'payment_id',
  'decision_or_status',
  'merchant',
  'amount',
  'currency',
  'amount_base',
  'base_currency',
  'category',
  'country',
  'rule',
  'reason',
  'memo',
  'by',
  'note',
  'receipt_id',
  'hash',
] as const;

type Cell = string | number | boolean | null | undefined;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  // A leading = + - @ (or a tab/CR that hides one) makes Excel and Sheets evaluate a formula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Minor units → plain decimal text, e.g. 123456 CHF → "1234.56". */
function decimal(minor: unknown, currency: string | null): string | null {
  if (typeof minor !== 'number' || currency === null) return null;
  return formatMoney(minor, currency).slice(currency.length + 1);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function rowFor(e: Entry): Cell[] {
  const d = e.data;
  const request = (d.request ?? {}) as Record<string, unknown>;
  const status =
    str(d.decision) ?? str(d.status) ?? (e.type === 'payment.cancelled' ? 'cancelled' : null);
  const control =
    typeof d.frozen === 'boolean'
      ? d.frozen
        ? 'frozen'
        : 'unfrozen'
      : typeof d.on === 'boolean'
        ? d.on
          ? 'kill switch on'
          : 'kill switch off'
        : null;
  return [
    e.seq,
    e.created_at,
    e.type,
    e.agent_id,
    str(d.payment_id),
    status ?? control,
    str(request.merchant),
    decimal(request.amount, str(request.currency)),
    str(request.currency),
    decimal(d.amount_base, str(d.base_currency)),
    str(d.base_currency),
    str(request.category),
    str(request.country),
    str(d.rule),
    str(d.reason),
    str(request.memo),
    str(d.by) ?? (e.type === 'payment.decision' ? 'engine' : null),
    str(d.note),
    e.id,
    e.hash,
  ];
}

/** CSV text with a header row. Amounts are decimals in their currency. */
export function exportCsv(ledger: Ledger): string {
  const lines = [COLUMNS.map(csvCell).join(',')];
  for (const entry of ledger.entries()) lines.push(rowFor(entry).map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
