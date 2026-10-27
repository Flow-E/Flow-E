import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { ApprovalCard } from '@/components/approval-card';
import { Fulfilment } from '@/components/fulfilment';
import { ShareReceipt } from '@/components/share-receipt';
import { Panel, StatusPill, buttonClass } from '@/components/ui';
import { dateTime, money, ruleName } from '@/lib/format';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { siteOrigin } from '@/server/origin';
import { ActionButton, Trace, VerifyForm } from '../../../../sandbox/client';
import {
  cancelAction,
  invoiceAction,
  orderAction,
  resolveAction,
  verifyAction,
} from '../../../actions';

export const metadata: Metadata = { title: 'Payment' };

export default async function PaymentPage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const { user, store, view } = await orgView(org);
  const detail = await store.payment(view.id, user, id);
  if (!detail) notFound();
  const { payment: p, receipt, trace, cancellable } = detail;
  const receiptJson = JSON.stringify(receipt, null, 2);
  const decide = can(view.role, 'payment.resolve');
  const base = `/app/${view.id}`;
  const d = view.currencyDecimals;
  const origin = await siteOrigin();

  return (
    <div className="space-y-6">
      <Link
        href={base}
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Dashboard
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-ink-3">{p.paymentId}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            <span className="tabular font-mono">
              {money(p.request.amount, p.request.currency, d)}
            </span>{' '}
            to {p.request.merchant}
          </h1>
          <p className="mt-1 text-ink-2">
            Asked by{' '}
            <Link href={`${base}/agents/${p.agentId}`} className="font-mono hover:underline">
              {p.agentId}
            </Link>{' '}
            on {dateTime(p.createdAt, view.timezone)}
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
          canDecide={decide}
          action={resolveAction}
          fields={{ org: view.id }}
          paymentHref={`${base}/payments`}
        />
      ) : null}
      {cancellable && decide ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-3">
          <p className="mr-auto text-sm text-ink-2">
            First payment to this supplier: cancellable until{' '}
            {dateTime(p.cancellableUntil ?? '', view.timezone)}.
          </p>
          <ActionButton
            action={cancelAction}
            fields={{ org: view.id, id: p.paymentId }}
            label="Cancel payment"
            confirm="Click again to cancel"
          />
        </section>
      ) : null}

      <Fulfilment
        payment={p}
        now={view.now}
        timezone={view.timezone}
        decimals={d}
        canAct={can(view.role, 'payment.fulfil')}
        poHref={`${base}/payments/${p.paymentId}/po`}
        orderAction={orderAction}
        invoiceAction={invoiceAction}
        fields={{ org: view.id }}
      />

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
            <dd className="font-mono text-ink">{money(p.amountBase, p.baseCurrency, d)}</dd>
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
                href={`${base}/payments/${p.paymentId}/receipt`}
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
          </Panel>
          <Panel title="Verify this receipt">
            <VerifyForm action={verifyAction.bind(null, view.id)} initial={receiptJson} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
