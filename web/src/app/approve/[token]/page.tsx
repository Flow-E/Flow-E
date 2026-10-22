import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo, StatusPill } from '@/components/ui';
import { dateTime, money } from '@/lib/format';
import { requireUser } from '@/server/org-view';
import { getOrgStore } from '@/server/runtime';
import { confirmApprovalAction } from '../../app/actions';
import { ConfirmForm } from '../../app/client';

export const metadata: Metadata = { title: 'Confirm', robots: { index: false } };

/**
 * Where an approval email's link lands. Opening it changes nothing (mail scanners open links):
 * it asks the recipient to sign in, shows the payment, and acts only on the POST of the confirm
 * button, which re-checks the link, the person, their role and the payment's status.
 */
export default async function ApprovePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/approve/${token}`);
  const preview = await (await getOrgStore()).approvalPreview(token, user);

  let body: React.ReactNode;
  if ('error' in preview) {
    body = (
      <p role="alert" className="mt-8 rounded-lg bg-decline-soft px-4 py-3 text-sm text-decline">
        {preview.error}
      </p>
    );
  } else {
    const p = preview.payment;
    const verb = preview.action;
    body = (
      <>
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">
          {verb === 'approve' ? 'Approve' : 'Decline'} this payment?
        </h1>
        <div className="mt-4 rounded-xl border border-rule bg-surface px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-lg font-semibold">
              <span className="tabular font-mono">
                {money(p.request.amount, p.request.currency, preview.currencyDecimals)}
              </span>{' '}
              to {p.request.merchant}
            </p>
            <StatusPill status={p.status} />
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-3">Organisation</dt>
            <dd className="text-ink">{preview.orgName}</dd>
            <dt className="text-ink-3">Agent</dt>
            <dd className="font-mono text-ink">{p.agentId}</dd>
            <dt className="text-ink-3">Asked</dt>
            <dd className="text-ink">{dateTime(p.createdAt, 'UTC')} UTC</dd>
            <dt className="text-ink-3">Why a human</dt>
            <dd className="text-ink">{p.reason}</dd>
            {p.request.memo ? (
              <>
                <dt className="text-ink-3">Memo</dt>
                <dd className="text-ink">{p.request.memo}</dd>
              </>
            ) : null}
          </dl>
          <Link
            href={`/app/${preview.orgId}/payments/${p.paymentId}`}
            className="mt-3 inline-block text-sm text-accent underline"
          >
            Full details and rule trace
          </Link>
        </div>
        <div className="mt-6">
          {p.status === 'review' ? (
            <ConfirmForm action={confirmApprovalAction} token={token} verb={verb} />
          ) : (
            <p className="text-sm text-ink-2">This payment is already {p.status}; nothing to do.</p>
          )}
        </div>
      </>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/app" aria-label="Flow-E" className="rounded-md">
          <Logo />
        </Link>
        {body}
        <p className="mt-6 text-xs text-ink-3">
          Signed in as {user.email}. Flow-E never moves money.
        </p>
      </div>
    </main>
  );
}
