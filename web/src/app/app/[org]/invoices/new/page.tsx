import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { AddInvoice } from '@/components/invoice-forms';
import { Panel } from '@/components/ui';
import { prefillFrom } from '@/lib/invoice-prefill';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { addInvoiceAction } from '../actions';

export const metadata: Metadata = { title: 'Add invoice' };

export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await params;
  const { view } = await orgView(org);
  const base = `/app/${view.id}`;
  const initial = prefillFrom(await searchParams, view.baseCurrency);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href={`${base}/invoices`}
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Invoices
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Add invoice</h1>
      {can(view.role, 'invoice.record') ? (
        <Panel
          title="Supplier invoice"
          description="Flow-E matches it against the authorizations. It never pays: your accounts team pays matched invoices as usual."
        >
          <AddInvoice
            action={addInvoiceAction}
            fields={{ org: view.id }}
            initial={initial}
            uploadUrl={`${base}/invoices/upload`}
          />
        </Panel>
      ) : (
        <p className="rounded-xl border border-rule bg-surface px-4 py-4 text-sm text-ink-2">
          Your role can see invoices but not add them. An owner or approver adds invoices.
        </p>
      )}
    </div>
  );
}
