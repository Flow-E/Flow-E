import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { needsReview } from '@flow-e/mcp/core';
import { ResolveInvoiceForm } from '@/components/invoice-forms';
import { InvoiceDetail, InvoiceStatusPill, statusOf } from '@/components/invoices';
import { Panel, buttonClass } from '@/components/ui';
import { money } from '@/lib/format';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { resolveInvoiceAction } from '../actions';

export const metadata: Metadata = { title: 'Invoice' };

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const { user, store, view } = await orgView(org);
  const detail = await store.invoiceDetail(view.id, user, id);
  if (!detail) notFound();
  const { invoice: i, payment, file, seq } = detail;
  const base = `/app/${view.id}`;

  return (
    <div className="space-y-6">
      <Link
        href={`${base}/invoices`}
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Invoices
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-ink-3">{i.invoiceId}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            <span className="tabular font-mono">
              {money(i.amount, i.currency, view.currencyDecimals)}
            </span>{' '}
            from {i.supplier}
          </h1>
          <p className="mt-1 text-ink-2">
            Invoice <span className="font-mono">{i.number}</span> of {i.invoiceDate}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {file ? (
            <a
              href={`${base}/invoices/files/${file.id}`}
              className={buttonClass('secondary', 'sm')}
            >
              <Download size={15} aria-hidden="true" /> {file.filename}
            </a>
          ) : null}
          <InvoiceStatusPill status={statusOf(i)} />
        </div>
      </div>

      {needsReview(i) ? (
        <Panel
          title="Needs a decision"
          description="Accept it if it is right (for example an agreed price change), or reject it with a reason. Your decision is signed into the ledger."
        >
          {can(view.role, 'invoice.record') ? (
            <ResolveInvoiceForm
              action={resolveInvoiceAction}
              fields={{ org: view.id, id: i.invoiceId }}
            />
          ) : (
            <p className="text-sm text-ink-3">An owner or approver decides.</p>
          )}
        </Panel>
      ) : null}

      <InvoiceDetail
        invoice={i}
        payment={payment}
        seq={seq}
        timezone={view.timezone}
        decimals={view.currencyDecimals}
        paymentBase={`${base}/payments`}
        ledgerHref={`${base}/ledger`}
      />
    </div>
  );
}
