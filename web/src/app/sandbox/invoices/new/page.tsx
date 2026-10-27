import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { AddInvoice } from '@/components/invoice-forms';
import { FictionalNote, Panel } from '@/components/ui';
import { prefillFrom } from '@/lib/invoice-prefill';
import { sandboxView } from '@/server/view';
import { addSandboxInvoiceAction } from '../actions';

export const metadata: Metadata = { title: 'Add invoice' };

export default async function NewSandboxInvoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await sandboxView();
  const initial = prefillFrom(await searchParams, view.baseCurrency);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/sandbox/invoices"
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Invoices
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Add invoice</h1>
        <FictionalNote className="mt-1" />
      </div>
      <Panel
        title="Supplier invoice (typed in)"
        description="The sandbox takes typed-in invoices only. Try a total a little above the approved amount to see a mismatch."
      >
        <AddInvoice
          action={addSandboxInvoiceAction}
          fields={{}}
          initial={initial}
          uploadUrl={null}
        />
      </Panel>
    </div>
  );
}
