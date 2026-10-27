import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { needsReview } from '@flow-e/mcp/core';
import { ResolveInvoiceForm } from '@/components/invoice-forms';
import { InvoiceDetail, InvoiceStatusPill, statusOf } from '@/components/invoices';
import { FictionalNote, Panel } from '@/components/ui';
import { money } from '@/lib/format';
import { sandboxView } from '@/server/view';
import { resolveSandboxInvoiceAction } from '../actions';

export const metadata: Metadata = { title: 'Invoice' };

export default async function SandboxInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, store, view } = await sandboxView();
  const detail = await store.invoiceDetail(session.userId, id);
  if (!detail) notFound();
  const { invoice: i, payment, seq } = detail;

  return (
    <div className="space-y-6">
      <Link
        href="/sandbox/invoices"
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
          <FictionalNote className="mt-1" />
        </div>
        <InvoiceStatusPill status={statusOf(i)} />
      </div>

      {needsReview(i) ? (
        <Panel
          title="Needs a decision"
          description="Accept it if it is right (for example an agreed price change), or reject it with a reason. Your decision is signed into the ledger."
        >
          <ResolveInvoiceForm action={resolveSandboxInvoiceAction} fields={{ id: i.invoiceId }} />
        </Panel>
      ) : null}

      <InvoiceDetail
        invoice={i}
        payment={payment}
        seq={seq}
        timezone={view.timezone}
        decimals={view.currencyDecimals}
        paymentBase="/sandbox/payments"
        ledgerHref="/sandbox/ledger"
      />
    </div>
  );
}
