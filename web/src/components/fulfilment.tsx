import Link from 'next/link';
import { Check, Circle, FileText, TriangleAlert } from 'lucide-react';
import type { PaymentRecord } from '@flow-e/mcp/core';
import { InvoiceForm, OrderForm } from '@/components/fulfilment-forms';
import { Panel, buttonClass } from '@/components/ui';
import { dateTime, money } from '@/lib/format';

type Act = (
  prev: { ok?: string; error?: string },
  form: FormData,
) => Promise<{
  ok?: string;
  error?: string;
}>;

/** "1250.5" style: the approved amount as typed into a form. */
function plain(minor: number, decimals: number): string {
  return (minor / 10 ** decimals).toFixed(decimals);
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      {done ? (
        <Check size={16} className="mt-0.5 shrink-0 text-approve" aria-label="Done" />
      ) : (
        <Circle size={16} className="mt-0.5 shrink-0 text-ink-3" aria-label="Not yet" />
      )}
      <div className="min-w-0 text-sm">{children}</div>
    </li>
  );
}

/**
 * What happens after approval: the purchase order, the order with the supplier and the matched
 * invoice. Flow-E never pays; the company pays the invoice as usual, with the payment id as the
 * reference.
 */
export function Fulfilment({
  payment: p,
  now,
  timezone,
  decimals,
  canAct,
  poHref,
  orderAction,
  invoiceAction,
  fields,
}: {
  payment: PaymentRecord;
  /** When the page was read (epoch ms), for the cooling-off check. */
  now: number;
  timezone: string;
  decimals: Readonly<Record<string, number>> | undefined;
  canAct: boolean;
  poHref: string;
  orderAction: Act;
  invoiceAction: Act;
  fields: Record<string, string>;
}) {
  if (p.status !== 'approved') return null;
  const ordered = p.fulfilment?.ordered ?? null;
  const invoice = p.fulfilment?.invoice ?? null;
  const cooling = p.cancellableUntil !== null && Date.parse(p.cancellableUntil) > now;
  const fmt = (n: number) => money(n, p.request.currency, decimals);
  const digits = decimals?.[p.request.currency] ?? (p.request.currency === 'JPY' ? 0 : 2);

  return (
    <Panel
      title="Order and invoice"
      description="Flow-E never pays. Order through your usual channel with the payment id as the reference; your accounts team pays the invoice as usual."
      action={
        <Link href={poHref} className={buttonClass('secondary', 'sm')}>
          <FileText size={15} aria-hidden="true" /> Purchase order
        </Link>
      }
    >
      <ol className="space-y-4">
        <Step done>
          <p className="text-ink">Approved</p>
          <p className="text-ink-3">
            {p.decidedBy === 'engine' ? 'By the rules' : `By ${p.decidedBy}`}
            {p.updatedAt
              ? `, ${dateTime(p.updatedAt, timezone)}`
              : `, ${dateTime(p.createdAt, timezone)}`}
          </p>
        </Step>
        <Step done={ordered !== null}>
          {ordered ? (
            <>
              <p className="text-ink">
                Ordered
                {ordered.reference ? (
                  <>
                    {' '}
                    · <span className="font-mono">{ordered.reference}</span>
                  </>
                ) : null}
              </p>
              <p className="text-ink-3">
                By {ordered.by}, {dateTime(ordered.at, timezone)}
              </p>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-ink">Not ordered yet</p>
              {cooling ? (
                <p className="text-ink-3">
                  Order after the cooling-off window closes, at{' '}
                  {dateTime(p.cancellableUntil ?? '', timezone)}.
                </p>
              ) : canAct ? (
                <OrderForm action={orderAction} fields={{ ...fields, id: p.paymentId }} />
              ) : (
                <p className="text-ink-3">The agent or an approver records the order.</p>
              )}
            </div>
          )}
        </Step>
        <Step done={invoice !== null}>
          {invoice ? (
            <>
              <p className="text-ink">
                Invoice <span className="font-mono">{invoice.number}</span> matched ·{' '}
                <span className="tabular font-mono">{fmt(invoice.amount)}</span>
              </p>
              {invoice.difference > 0 ? (
                <p className="mt-1 inline-flex items-start gap-1.5 text-review">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {fmt(invoice.difference)} more than approved. Check it before paying.
                </p>
              ) : invoice.difference < 0 ? (
                <p className="text-ink-3">{fmt(-invoice.difference)} less than approved.</p>
              ) : (
                <p className="text-ink-3">Same as approved.</p>
              )}
              <p className="text-ink-3">
                By {invoice.by}, {dateTime(invoice.at, timezone)}
              </p>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-ink">No invoice matched yet</p>
              {canAct ? (
                <InvoiceForm
                  action={invoiceAction}
                  fields={{ ...fields, id: p.paymentId }}
                  currency={p.request.currency}
                  suggested={plain(p.request.amount, digits)}
                />
              ) : null}
            </div>
          )}
        </Step>
      </ol>
    </Panel>
  );
}
