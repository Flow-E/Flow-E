import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { PurchaseOrder } from '@/components/purchase-order';
import { siteOrigin } from '@/server/origin';
import { sandboxView } from '@/server/view';

export const metadata: Metadata = { title: 'Purchase order' };

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, store, view } = await sandboxView();
  const detail = await store.payment(session.userId, id);
  if (!detail || detail.payment.status !== 'approved') notFound();
  return (
    <div className="space-y-6">
      <Link
        href={`/sandbox/payments/${detail.payment.paymentId}`}
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink print:hidden"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Payment
      </Link>
      <PurchaseOrder
        payment={detail.payment}
        buyer={view.organisation ?? 'Fictional organisation'}
        issuer={view.issuer}
        timezone={view.timezone}
        decimals={view.currencyDecimals}
        origin={await siteOrigin()}
        fictional
      />
    </div>
  );
}
