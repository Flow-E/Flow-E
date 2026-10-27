import type { Metadata } from 'next';
import { Download, Plus } from 'lucide-react';
import { needsReview } from '@flow-e/mcp/core';
import { EmailPlaceholder, InvoiceFilters, InvoiceList, type Filter } from '@/components/invoices';
import { ButtonLink, buttonClass } from '@/components/ui';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { filterInvoices, invoiceFilter } from '@/server/invoices';

export const metadata: Metadata = { title: 'Invoices' };

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await params;
  const show: Filter = invoiceFilter((await searchParams).show);
  const { user, store, view } = await orgView(org);
  const all = await store.invoices(view.id, user);
  const base = `/app/${view.id}`;
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
            Supplier invoices, matched against what Flow-E authorized. Anything that does not match
            waits here for a person.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`${base}/invoices/export`} className={buttonClass('secondary', 'sm')}>
            <Download size={15} aria-hidden="true" /> CSV for accounting
          </a>
          {can(view.role, 'invoice.record') ? (
            <ButtonLink href={`${base}/invoices/new`} size="sm">
              <Plus size={15} aria-hidden="true" /> Add invoice
            </ButtonLink>
          ) : null}
        </div>
      </div>

      <InvoiceFilters base={`${base}/invoices`} active={show} counts={counts} />
      <InvoiceList
        invoices={filterInvoices(all, show)}
        base={`${base}/invoices`}
        paymentBase={`${base}/payments`}
        decimals={view.currencyDecimals}
        empty={
          show === 'review'
            ? 'Nothing needs review.'
            : show === 'matched'
              ? 'No matched invoices yet.'
              : 'No invoices yet. Add one when a supplier sends it.'
        }
      />
      <EmailPlaceholder />
    </div>
  );
}
