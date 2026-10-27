import type { PaymentRecord } from '@flow-e/mcp/core';
import { PrintButton } from '@/components/print-button';
import { dateTime, money } from '@/lib/format';

/**
 * A purchase order for an approved payment, to send to the supplier or file with the invoice.
 * It confirms that the purchase is authorized; it is not a payment. Printable (the app's
 * header and footer hide in print), so "Save as PDF" in the print dialog gives a PDF.
 */
export function PurchaseOrder({
  payment: p,
  buyer,
  issuer,
  timezone,
  decimals,
  origin,
  fictional,
}: {
  payment: PaymentRecord;
  buyer: string;
  issuer: string;
  timezone: string;
  decimals: Readonly<Record<string, number>> | undefined;
  origin: string;
  fictional: boolean;
}) {
  const approvedBy =
    p.decidedBy === 'engine' ? 'Approved by the mandate rules' : `Approved by ${p.decidedBy}`;
  const approvedAt = p.updatedAt ?? p.createdAt;
  const qty = p.request.quantity ?? 1;
  const what = p.request.item ?? p.request.memo ?? '—';
  const total = money(p.request.amount, p.request.currency, decimals);

  return (
    <article className="mx-auto max-w-3xl space-y-8 rounded-xl border border-rule bg-surface px-6 py-8 text-ink print:border-0 print:px-0 print:py-0 sm:px-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-ink-3">Purchase order</p>
          <h1 className="mt-1 font-serif text-3xl tracking-tight">{buyer}</h1>
          {fictional ? (
            <p className="mt-1 text-sm text-review">Sandbox: fictional company and supplier.</p>
          ) : null}
        </div>
        <dl className="tabular grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-3">Reference</dt>
          <dd className="font-mono">{p.paymentId}</dd>
          <dt className="text-ink-3">Date</dt>
          <dd>{dateTime(approvedAt, timezone)}</dd>
          {p.request.project ? (
            <>
              <dt className="text-ink-3">Project</dt>
              <dd>{p.request.project}</dd>
            </>
          ) : null}
        </dl>
      </header>

      <section className="grid gap-6 sm:grid-cols-2">
        <div>
          <h2 className="text-xs uppercase tracking-wide text-ink-3">Supplier</h2>
          <p className="mt-1">{p.request.merchant}</p>
          <p className="text-sm text-ink-2">Country: {p.request.country}</p>
        </div>
        <div>
          <h2 className="text-xs uppercase tracking-wide text-ink-3">Ordered by</h2>
          <p className="mt-1">{buyer}</p>
          <p className="text-sm text-ink-2">
            Through its purchasing agent <span className="font-mono">{p.agentId}</span>
          </p>
        </div>
      </section>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink-3">
            <th className="py-2 pr-3 font-medium">Item</th>
            <th className="py-2 pr-3 text-right font-medium">Quantity</th>
            <th className="py-2 pr-3 font-medium">Category</th>
            <th className="py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-rule align-top">
            <td className="py-3 pr-3">{what}</td>
            <td className="tabular py-3 pr-3 text-right font-mono">{qty}</td>
            <td className="tabular py-3 pr-3 font-mono">{p.request.category}</td>
            <td className="tabular py-3 text-right font-mono">{total}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3} className="py-3 pr-3 text-right font-medium">
              Total authorized
            </th>
            <td className="tabular py-3 text-right font-mono font-semibold">{total}</td>
          </tr>
        </tfoot>
      </table>

      <section className="space-y-2 rounded-lg bg-sunken px-4 py-4 text-sm print:bg-transparent print:px-0">
        <p>
          <strong>Please quote {p.paymentId} on your invoice.</strong> Invoices above the total
          authorized need a new approval.
        </p>
        <p className="text-ink-2">
          {approvedBy}, {dateTime(approvedAt, timezone)}. Signed receipt{' '}
          <span className="font-mono">{p.receiptId}</span> from issuer{' '}
          <span className="break-all font-mono">{issuer}</span>. Anyone can check it at{' '}
          <span className="font-mono">{origin}/verify</span>.
        </p>
        <p className="text-ink-3">
          This order confirms that the purchase is authorized. It is not a payment: the invoice is
          paid by {buyer} through its usual channel. Issued with Flow-E.
        </p>
      </section>

      {p.fulfilment?.invoice ? (
        <p className="text-sm text-ink-2 print:hidden">
          Invoice <span className="font-mono">{p.fulfilment.invoice.number}</span> recorded:{' '}
          {p.fulfilment.invoice.match}.
        </p>
      ) : null}

      <div className="print:hidden">
        <PrintButton />
      </div>
    </article>
  );
}
