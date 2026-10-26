import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleAlert, CircleCheck, Download } from 'lucide-react';
import { Panel, Pill, buttonClass } from '@/components/ui';
import { dateTime, money, shortHash } from '@/lib/format';
import { sandboxView } from '@/server/view';
import { verifyAction } from '../actions';
import { AutoRefresh, VerifyForm } from '../client';

export const metadata: Metadata = { title: 'Ledger' };

const TYPE_LABEL: Record<string, string> = {
  'payment.decision': 'Engine decision',
  'payment.resolved': 'Human decision',
  'payment.cancelled': 'Cancelled',
  'control.agent_freeze': 'Freeze change',
  'control.kill_switch': 'Kill switch',
  'config.updated': 'Mandate changed',
  'sandbox.sample_history': 'Sample history',
};

function describe(type: string, data: Record<string, unknown>): string {
  const req = data.request as { merchant?: string; amount?: number; currency?: string } | undefined;
  if (type === 'payment.decision' && req?.merchant) {
    return `${String(data.decision)}: ${money(req.amount ?? 0, req.currency ?? 'CHF')} to ${req.merchant}`;
  }
  if (type === 'payment.resolved') return `${String(data.status)} by ${String(data.by)}`;
  if (type === 'payment.cancelled') return `by ${String(data.by)}`;
  if (type === 'control.agent_freeze')
    return `${data.frozen ? 'frozen' : 'unfrozen'} by ${String(data.by)}`;
  if (type === 'control.kill_switch') return `${data.on ? 'on' : 'off'}, by ${String(data.by)}`;
  if (type === 'config.updated') return `by ${String(data.by)}`;
  if (type === 'sandbox.sample_history') {
    return `fictional, backdated entries follow (generated ${String(data.generated_at)})`;
  }
  return '';
}

export default async function LedgerPage() {
  const { view } = await sandboxView();
  const entries = [...view.entries].reverse();
  const audit = view.audit;

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ledger</h1>
          <p className="mt-1 max-w-[70ch] text-ink-2">
            Every decision and every human action, append-only. Each entry stores the hash of the
            one before it and is signed with this sandbox’s issuer key.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/sandbox/export" className={buttonClass('secondary', 'sm')}>
            <Download size={15} aria-hidden="true" /> Export CSV
          </a>
          <a href="/sandbox/issuer.pub" className={buttonClass('secondary', 'sm')}>
            <Download size={15} aria-hidden="true" /> Issuer public key
          </a>
        </div>
      </div>

      <section
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 sm:px-5 ${
          audit.ok
            ? 'border-approve/30 bg-approve-soft text-approve'
            : 'border-decline/40 bg-decline-soft text-decline'
        }`}
        aria-live="polite"
      >
        {audit.ok ? (
          <CircleCheck size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        ) : (
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        )}
        <p className="text-sm">
          {audit.ok
            ? `Intact: ${String(audit.entries)} ${audit.entries === 1 ? 'entry' : 'entries'}, every link and signature checked just now.`
            : `Broken at entry #${String(audit.firstBroken.seq)}: ${audit.firstBroken.reason}. Nothing from there on can be trusted.`}
        </p>
      </section>

      <Panel title={`Entries (${String(entries.length)})`}>
        {entries.length === 0 ? (
          <p className="text-sm text-ink-2">
            The ledger is empty. Requests from the{' '}
            <Link href="/sandbox/agent" className="text-accent underline">
              fake agent
            </Link>{' '}
            appear here.
          </p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-ink-3">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Entry</th>
                  <th className="py-2 pr-3 font-medium">Agent</th>
                  <th className="py-2 font-medium">Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const data = JSON.parse(e.data) as Record<string, unknown>;
                  const paymentId = typeof data.payment_id === 'string' ? data.payment_id : null;
                  return (
                    <tr key={e.seq} className="border-b border-rule align-top last:border-0">
                      <td className="tabular py-2.5 pr-3 font-mono text-ink-3">{e.seq}</td>
                      <td className="tabular whitespace-nowrap py-2.5 pr-3 text-ink-2">
                        {dateTime(e.created_at, view.timezone)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="flex flex-wrap items-center gap-2">
                          <Pill tone="neutral">{TYPE_LABEL[e.type] ?? e.type}</Pill>
                          {paymentId ? (
                            <Link
                              href={`/sandbox/payments/${paymentId}`}
                              className="text-ink hover:underline"
                            >
                              {describe(e.type, data)}
                            </Link>
                          ) : (
                            <span className="text-ink">{describe(e.type, data)}</span>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-ink-2">{e.agent_id}</td>
                      <td className="tabular py-2.5 font-mono text-xs text-ink-3" title={e.hash}>
                        {shortHash(e.hash)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Verify a receipt"
        description="Paste any receipt from this sandbox. Its signature is checked against the issuer public key, then its place in the chain."
      >
        <VerifyForm action={verifyAction} />
      </Panel>
    </div>
  );
}
