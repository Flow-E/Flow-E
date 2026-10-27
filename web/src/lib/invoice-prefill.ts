/**
 * "Add invoice" links from a payment carry the payment id as the reference, the supplier and
 * the currency in the query string. Pure and client-safe. The values only prefill the form;
 * the store validates whatever is submitted.
 */

export interface InvoicePrefill {
  supplier: string;
  number: string;
  invoiceDate: string;
  amount: string;
  currency: string;
  reference: string;
}

/** The link to the add-invoice page, prefilled for one payment. */
export function addInvoiceHref(
  invoicesBase: string,
  payment: { paymentId: string; request: { merchant: string; currency: string } },
): string {
  const q = new URLSearchParams({
    reference: payment.paymentId,
    supplier: payment.request.merchant,
    currency: payment.request.currency,
  });
  return `${invoicesBase}/new?${q.toString()}`;
}

function one(v: string | string[] | undefined, max: number): string {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

export function prefillFrom(
  query: Record<string, string | string[] | undefined>,
  baseCurrency: string,
): InvoicePrefill {
  const currency = one(query.currency, 5).toUpperCase();
  return {
    supplier: one(query.supplier, 200),
    number: '',
    invoiceDate: '',
    amount: '',
    currency: /^[A-Z]{3,5}$/.test(currency) ? currency : baseCurrency,
    reference: one(query.reference, 80),
  };
}
