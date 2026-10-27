import 'server-only';
import { z } from 'zod';
import {
  ActionError,
  csvCell,
  formatMoney,
  needsReview,
  parseAmount,
  type InvoiceInput,
  type InvoiceRecord,
} from '@flow-e/mcp/core';

/**
 * Supplier invoices on the website: the form input both stores accept, the file checks for
 * uploads, and the accounting CSV. Matching itself is the core's (src/control/invoices.ts).
 */

/** Uploads: PDF, PNG or JPEG, at most 4 MB. */
export const MAX_INVOICE_FILE_BYTES = 4 * 1024 * 1024;
export type InvoiceMime = 'application/pdf' | 'image/png' | 'image/jpeg';

/** An invoice as typed into the form (or read from a file and checked by a person). */
export const invoiceFormSchema = z.object({
  supplier: z.string().trim().min(1, 'Enter the supplier.').max(200),
  number: z.string().trim().min(1, 'Enter the invoice number.').max(80),
  invoiceDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the invoice date as YYYY-MM-DD.'),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,6})?$/, 'Enter the total as a plain number such as 1250.50.'),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3,5}$/, 'Use a currency code such as CHF.')
    .transform((c) => c.toUpperCase()),
  reference: z.string().trim().max(80).optional(),
  source: z.enum(['manual', 'extracted']).default('manual'),
  /** An uploaded file this invoice was read from (organisations only). */
  fileId: z.uuid().optional(),
  note: z.string().trim().max(500).optional(),
});
export type InvoiceFormInput = z.input<typeof invoiceFormSchema>;
export type InvoiceForm = z.output<typeof invoiceFormSchema>;

/** The core's input: amount parsed in the invoice currency (minor units). */
export function toInvoiceInput(
  form: InvoiceForm,
  decimals: Readonly<Record<string, number>> | undefined,
): InvoiceInput {
  let amount: number;
  try {
    amount = parseAmount(form.amount, form.currency, decimals);
  } catch (err) {
    throw new ActionError(`Invoice total: ${(err as Error).message}`);
  }
  return {
    supplier: form.supplier,
    number: form.number,
    invoiceDate: form.invoiceDate,
    amount,
    currency: form.currency,
    ...(form.reference ? { reference: form.reference } : {}),
    source: form.source,
  };
}

/** The file type from its first bytes, never from the name or the browser's claim. */
export function sniffInvoiceFile(bytes: Uint8Array): InvoiceMime | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

/** Checks an upload; throws ActionError with a message for the person. */
export function checkInvoiceFile(bytes: Uint8Array): InvoiceMime {
  if (bytes.length === 0) throw new ActionError('The file is empty.');
  if (bytes.length > MAX_INVOICE_FILE_BYTES) {
    throw new ActionError('The file is larger than 4 MB.');
  }
  const mime = sniffInvoiceFile(bytes);
  if (!mime) throw new ActionError('Upload a PDF, PNG or JPEG file.');
  return mime;
}

/** A safe download name: letters, digits, dot, dash and underscore; at most 120 characters. */
export function safeFilename(name: string, mime: InvoiceMime): string {
  const ext = mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
  const base = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return `${base || 'invoice'}${ext}`;
}

/** What a person sees: the match, or their decision on it. */
export type InvoiceStatus =
  'matched' | 'mismatch' | 'unmatched' | 'duplicate' | 'accepted' | 'rejected';

export function invoiceStatus(i: InvoiceRecord): InvoiceStatus {
  return i.resolution?.outcome ?? i.match;
}

export type InvoiceFilter = 'review' | 'matched' | 'all';

export function filterInvoices(list: readonly InvoiceRecord[], f: InvoiceFilter): InvoiceRecord[] {
  if (f === 'review') return list.filter(needsReview);
  if (f === 'matched') {
    return list.filter((i) => i.match === 'matched' || i.resolution?.outcome === 'accepted');
  }
  return [...list];
}

export function invoiceFilter(value: unknown): InvoiceFilter {
  return value === 'review' || value === 'matched' ? value : 'all';
}

const CSV_COLUMNS = [
  'invoice_id',
  'supplier',
  'number',
  'date',
  'amount',
  'currency',
  'reference',
  'payment_id',
  'status',
  'matched_at',
  'by',
] as const;

/**
 * Matched and accepted invoices for accounting, oldest first. Supplier names and numbers come
 * from outside, so every cell goes through the core's formula-safe csvCell.
 */
export function invoiceCsv(
  list: readonly InvoiceRecord[],
  decimals: Readonly<Record<string, number>> | undefined,
): string {
  const lines = [CSV_COLUMNS.map((c) => csvCell(c)).join(',')];
  for (const i of filterInvoices(list, 'matched')) {
    const accepted = i.resolution?.outcome === 'accepted' ? i.resolution : null;
    const amount = formatMoney(i.amount, i.currency, decimals).slice(i.currency.length + 1);
    lines.push(
      [
        i.invoiceId,
        i.supplier,
        i.number,
        i.invoiceDate,
        amount,
        i.currency,
        i.reference,
        i.paymentId,
        invoiceStatus(i),
        accepted ? accepted.at : i.recordedAt,
        accepted ? accepted.by : i.recordedBy,
      ]
        .map((v) => csvCell(v))
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
