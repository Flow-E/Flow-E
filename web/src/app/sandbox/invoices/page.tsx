import type { Metadata } from 'next';
import { Download, Plus } from 'lucide-react';
import { needsReview } from '@flow-e/mcp/core';
import { EmailPlaceholder, InvoiceFilters, InvoiceList, type Filter } from '@/components/invoices';
import { ButtonLink, FictionalNote, buttonClass } from '@/components/ui';
import { filterInvoices, invoiceFilter } from '@/server/invoices';
import { sandboxView } from '@/server/view';

export const metadata: Metadata = { title: 'Invoices' };

/** A CSV download (route handler), not a page: a plain link, not next/link. */
const EXPORT_HREF = '/sandbox/invoices/export';

export default async function SandboxInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const show: Filter = invoiceFilter((await searchParams).show);
  const { session, store, view } = await sandboxView();
  const all = await store.invoices(session.userId);
  const counts = {
    review: all.filter(needsReview).length,
    matched: filterInvoices(all, 'matched').length,
    all: all.length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Type in a supplier invoice and see how Flow-E matches it against the sandbox&rsquo;s
            authorizations. Uploading files works in organisations only.
          </p>
          <FictionalNote className="mt-2" />
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={EXPORT_HREF} className={buttonClass('secondary', 'sm')}>
            <Download size={15} aria-hidden="true" /> CSV for accounting
          </a>
          <ButtonLink href="/sandbox/invoices/new" size="sm">
            <Plus size={15} aria-hidden="true" /> Add invoice
          </ButtonLink>
        </div>
      </div>

      <InvoiceFilters base="/sandbox/invoices" active={show} counts={counts} />
      <InvoiceList
        invoices={filterInvoices(all, show)}
        base="/sandbox/invoices"
        paymentBase="/sandbox/payments"
        decimals={view.currencyDecimals}
        empty={
          show === 'review'
            ? 'Nothing needs review.'
            : show === 'matched'
              ? 'No matched invoices yet.'
              : 'No invoices yet. Approve a payment, then add its invoice from the payment page.'
        }
      />
      <EmailPlaceholder />
    </div>
  );
}
