import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { PurchaseOrder } from '@/components/purchase-order';
import { orgView } from '@/server/org-view';
import { siteOrigin } from '@/server/origin';

export const metadata: Metadata = { title: 'Purchase order' };

export default async function PurchaseOrderPage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const { user, store, view } = await orgView(org);
  const detail = await store.payment(view.id, user, id);
  if (!detail || detail.payment.status !== 'approved') notFound();
  return (
    <div className="space-y-6">
      <Link
        href={`/app/${view.id}/payments/${detail.payment.paymentId}`}
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink print:hidden"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Payment
      </Link>
      <PurchaseOrder
        payment={detail.payment}
        buyer={view.name}
        issuer={view.issuer}
        timezone={view.timezone}
        decimals={view.currencyDecimals}
        origin={await siteOrigin()}
        fictional={false}
      />
    </div>
  );
}
