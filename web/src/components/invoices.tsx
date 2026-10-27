import Link from 'next/link';
import { Check, Circle, Mail, TriangleAlert } from 'lucide-react';
import type { InvoiceRecord, PaymentRecord } from '@flow-e/mcp/core';
import { Panel, Pill, type Tone } from '@/components/ui';
import { dateTime, money } from '@/lib/format';

/** Invoice views shared by organisations and the sandbox. Server-safe: no hooks. */

type Decimals = Readonly<Record<string, number>> | undefined;
type Status = 'matched' | 'mismatch' | 'unmatched' | 'duplicate' | 'accepted' | 'rejected';

/** The match, or a person's decision on it. */
export function statusOf(i: InvoiceRecord): Status {
  return i.resolution?.outcome ?? i.match;
}

const STATUS_TONE: Record<Status, Tone> = {
  matched: 'approved',
  accepted: 'approved',
  mismatch: 'review',
  unmatched: 'review',
  duplicate: 'declined',
  rejected: 'declined',
};

export function InvoiceStatusPill({ status }: { status: Status }) {
  return <Pill tone={STATUS_TONE[status]}>{status}</Pill>;
}

export type Filter = 'review' | 'matched' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'review', label: 'Needs review' },
  { key: 'matched', label: 'Matched' },
  { key: 'all', label: 'All' },
];

export function InvoiceFilters({
  base,
  active,
  counts,
}: {
  base: string;
  active: Filter;
  counts: Record<Filter, number>;
}) {
  return (
    <nav aria-label="Filter invoices" className="flex flex-wrap gap-2">
      {FILTERS.map((f) => (
        <Link
          key={f.key}
          href={f.key === 'all' ? base : `${base}?show=${f.key}`}
          aria-current={active === f.key ? 'page' : undefined}
          className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm ${
            active === f.key
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-rule-strong text-ink-2 hover:bg-sunken'
          }`}
        >
          {f.label}
          <span className="tabular font-mono text-xs">{counts[f.key]}</span>
        </Link>
      ))}
    </nav>
  );
}

/** One row per invoice; stacks on a phone. */
export function InvoiceList({
  invoices,
  base,
  paymentBase,
  decimals,
  empty,
}: {
  invoices: readonly InvoiceRecord[];
  /** Invoice pages live at `${base}/${invoiceId}`. */
  base: string;
  /** Payment pages live at `${paymentBase}/${paymentId}`. */
  paymentBase: string;
  decimals: Decimals;
  empty: string;
}) {
  if (invoices.length === 0) {
    return (
      <p className="rounded-xl border border-rule bg-surface px-4 py-6 text-sm text-ink-3">
        {empty}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-rule rounded-xl border border-rule bg-surface">
      {invoices.map((i) => (
        <li
          key={i.invoiceId}
          className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] sm:items-center"
        >
          <div className="min-w-0">
            <Link
              href={`${base}/${i.invoiceId}`}
              className="block truncate font-medium text-ink hover:underline"
            >
              {i.supplier}
            </Link>
            <p className="truncate text-sm text-ink-3">
              <span className="font-mono">{i.number}</span> · {i.invoiceDate}
            </p>
          </div>
          <p className="min-w-0 truncate text-sm text-ink-2">
            {i.paymentId ? (
              <Link href={`${paymentBase}/${i.paymentId}`} className="font-mono hover:underline">
                {i.paymentId}
              </Link>
            ) : (
              <span className="text-ink-3">No payment linked</span>
            )}
          </p>
          <p className="tabular font-mono text-sm text-ink sm:text-right">
            {money(i.amount, i.currency, decimals)}
          </p>
          <div className="sm:justify-self-end">
            <InvoiceStatusPill status={statusOf(i)} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-2.5">
      {done ? (
        <Check size={16} className="mt-0.5 shrink-0 text-approve" aria-label="Done" />
      ) : (
        <Circle size={16} className="mt-0.5 shrink-0 text-ink-3" aria-label="Not yet" />
      )}
      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">{title}</p>
        <div className="text-ink-3">{children}</div>
      </div>
    </li>
  );
}

/** What the match means, the difference, and the chain request → … → status. */
export function InvoiceDetail({
  invoice: i,
  payment: p,
  seq,
  timezone,
  decimals,
  paymentBase,
  ledgerHref,
}: {
  invoice: InvoiceRecord;
  payment: PaymentRecord | null;
  seq: number | null;
  timezone: string;
  decimals: Decimals;
  paymentBase: string;
  ledgerHref: string;
}) {
  const fmt = (n: number) => money(n, i.currency, decimals);
  const status = statusOf(i);
  const paymentHref = p ? `${paymentBase}/${p.paymentId}` : null;
  const ordered = p?.fulfilment?.ordered ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Match" description="How Flow-E compared this invoice with what it authorized.">
        <p className="text-sm text-ink">{i.explanation}</p>
        {i.difference !== null ? (
          i.difference > 0 ? (
            <p className="mt-3 inline-flex items-start gap-1.5 text-sm text-review">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              {fmt(i.difference)} more than approved.
            </p>
          ) : i.difference < 0 ? (
            <p className="mt-3 text-sm text-ink-2">{fmt(-i.difference)} less than approved.</p>
          ) : (
            <p className="mt-3 text-sm text-ink-2">Same amount as approved.</p>
          )
        ) : null}
        <dl className="tabular mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-3">Invoice total</dt>
          <dd className="font-mono text-ink">{fmt(i.amount)}</dd>
          {p ? (
            <>
              <dt className="text-ink-3">Approved</dt>
              <dd className="font-mono text-ink">
                {money(p.request.amount, p.request.currency, decimals)}
              </dd>
            </>
          ) : null}
          <dt className="text-ink-3">Reference</dt>
          <dd className="break-all font-mono text-ink">{i.reference ?? '—'}</dd>
          <dt className="text-ink-3">Entered</dt>
          <dd className="text-ink">
            {i.source === 'extracted' ? 'Read from the file, checked by a person' : 'Typed in'}
          </dd>
        </dl>
      </Panel>

      <Panel title="From request to invoice">
        <ol className="space-y-4">
          <Step done={p !== null} title="Request">
            {p && paymentHref ? (
              <p>
                <Link href={paymentHref} className="font-mono hover:underline">
                  {p.paymentId}
                </Link>{' '}
                · {money(p.request.amount, p.request.currency, decimals)} to {p.request.merchant} ·
                asked by <span className="font-mono">{p.agentId}</span>,{' '}
                {dateTime(p.createdAt, timezone)}
              </p>
            ) : (
              <p>No payment request is linked to this invoice.</p>
            )}
          </Step>
          <Step done={p?.status === 'approved'} title="Authorization">
            {p && paymentHref ? (
              <p>
                {p.status}
                {p.decidedBy === 'engine' ? ' by the rules' : ` by ${p.decidedBy}`} ·{' '}
                <Link href={`${paymentHref}/receipt`} className="hover:underline">
                  signed receipt
                </Link>
              </p>
            ) : (
              <p>No authorization.</p>
            )}
          </Step>
          <Step done={ordered !== null} title="Order">
            {ordered && paymentHref ? (
              <p>
                By {ordered.by}, {dateTime(ordered.at, timezone)}
                {ordered.reference ? (
                  <>
                    {' '}
                    · <span className="font-mono">{ordered.reference}</span>
                  </>
                ) : null}{' '}
                ·{' '}
                <Link href={`${paymentHref}/po`} className="hover:underline">
                  purchase order
                </Link>
              </p>
            ) : (
              <p>No order recorded.</p>
            )}
          </Step>
          <Step done title="Invoice">
            <p>
              <span className="font-mono">{i.number}</span> of {i.invoiceDate}, recorded by{' '}
              {i.recordedBy}, {dateTime(i.recordedAt, timezone)}
              {seq !== null ? (
                <>
                  {' '}
                  ·{' '}
                  <Link href={ledgerHref} className="hover:underline">
                    ledger entry #{seq}
                  </Link>
                </>
              ) : null}
            </p>
          </Step>
          <Step done={status === 'matched' || status === 'accepted'} title="Status">
            <p className="flex flex-wrap items-center gap-2">
              <InvoiceStatusPill status={status} />
              {i.resolution ? (
                <span>
                  by {i.resolution.by}, {dateTime(i.resolution.at, timezone)}
                  {i.resolution.note ? `: “${i.resolution.note}”` : ''}
                </span>
              ) : i.match === 'matched' ? (
                <span>Ready for your accounts team to pay as usual.</span>
              ) : (
                <span>Waiting for a person to accept or reject it.</span>
              )}
            </p>
          </Step>
        </ol>
      </Panel>
    </div>
  );
}

export function EmailPlaceholder() {
  return (
    <section className="flex items-start gap-3 rounded-xl border border-dashed border-rule-strong px-4 py-4 text-sm">
      <Mail size={18} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
      <div>
        <p className="font-medium text-ink">Invoices by email — coming later</p>
        <p className="text-ink-3">
          A forwarding address that turns supplier emails into invoices here. Not built yet: use
          &ldquo;Add invoice&rdquo; for now.
        </p>
      </div>
    </section>
  );
}
