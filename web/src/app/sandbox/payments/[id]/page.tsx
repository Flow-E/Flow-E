import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { ApprovalCard } from '@/components/approval-card';
import { ShareReceipt } from '@/components/share-receipt';
import { Panel, StatusPill, buttonClass } from '@/components/ui';
import { dateTime, money, ruleName } from '@/lib/format';
import { siteOrigin } from '@/server/origin';
import { sandboxView } from '@/server/view';
import { cancelAction, resolveAction, verifyAction } from '../../actions';
import { ActionButton, Trace, VerifyForm } from '../../client';

export const metadata: Metadata = { title: 'Payment' };

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, store, view } = await sandboxView();
  const detail = await store.payment(session.userId, id);
  if (!detail) notFound();
  const { payment: p, receipt, trace, cancellable } = detail;
  const receiptJson = JSON.stringify(receipt, null, 2);
  const origin = await siteOrigin();

  return (
    <div className="space-y-6">
      <Link
        href="/sandbox"
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Dashboard
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-ink-3">{p.paymentId}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            <span className="tabular font-mono">{money(p.request.amount, p.request.currency)}</span>{' '}
            to {p.request.merchant}
          </h1>
          <p className="mt-1 text-ink-2">
            Asked by <span className="font-mono">{p.agentId}</span> on{' '}
            {dateTime(p.createdAt, view.timezone)}
            {p.request.memo ? ` · ${p.request.memo}` : ''}
          </p>
        </div>
        <StatusPill status={p.status} />
      </div>

      {p.status === 'review' ? (
        <ApprovalCard
          view={view}
          payment={p}
          trace={trace}
          canDecide
          action={resolveAction}
          paymentHref="/sandbox/payments"
        />
      ) : null}
      {cancellable ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3">
          <p className="mr-auto text-sm text-ink-2">
            First payment to this supplier: cancellable until{' '}
            {dateTime(p.cancellableUntil ?? '', view.timezone)}.
          </p>
          <ActionButton
            action={cancelAction}
            fields={{ id: p.paymentId }}
            label="Cancel payment"
            confirm="Click again to cancel"
          />
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Panel title="Decision" description={`${ruleName(p.rule)} · ${p.reason}`}>
          <dl className="tabular mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-3">Engine decision</dt>
            <dd className="text-ink">{p.engineDecision}</dd>
            <dt className="text-ink-3">Status now</dt>
            <dd className="text-ink">
              {p.status}
              {p.decidedBy !== 'engine'
                ? ` (by ${p.decidedBy}${p.note ? `: “${p.note}”` : ''})`
                : ''}
            </dd>
            <dt className="text-ink-3">In base currency</dt>
            <dd className="font-mono text-ink">{money(p.amountBase, p.baseCurrency)}</dd>
            <dt className="text-ink-3">Category · country</dt>
            <dd className="font-mono text-ink">
              {p.request.category} · {p.request.country}
            </dd>
          </dl>
          <h3 className="mb-2 text-sm font-semibold">Rule by rule</h3>
          <Trace steps={trace} />
        </Panel>

        <div className="min-w-0 space-y-6">
          <Panel
            title="Signed receipt"
            action={
              <a
                href={`/sandbox/payments/${p.paymentId}/receipt`}
                className={buttonClass('secondary', 'sm')}
              >
                <Download size={15} aria-hidden="true" /> Download
              </a>
            }
          >
            <pre className="tabular max-h-80 overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs leading-relaxed text-ink-2">
              {receiptJson}
            </pre>
            <ShareReceipt origin={origin} />
            <p className="mt-2 text-sm text-ink-3">
              Verify it offline with the issuer public key:{' '}
              <span className="font-mono">
                flow-e verify receipt.json --pubkey issuer.pub --offline
              </span>
            </p>
          </Panel>
          <Panel title="Verify this receipt">
            <VerifyForm action={verifyAction} initial={receiptJson} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
