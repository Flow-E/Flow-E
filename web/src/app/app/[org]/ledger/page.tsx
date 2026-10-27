import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleAlert, CircleCheck, Download } from 'lucide-react';
import { Panel, Pill, buttonClass } from '@/components/ui';
import { dateTime, money, shortHash } from '@/lib/format';
import { orgView } from '@/server/org-view';
import { AutoRefresh, VerifyForm } from '../../../sandbox/client';
import { verifyAction } from '../../actions';

export const metadata: Metadata = { title: 'Ledger' };

const TYPE_LABEL: Record<string, string> = {
  'payment.decision': 'Engine decision',
  'payment.resolved': 'Human decision',
  'payment.cancelled': 'Cancelled',
  'control.agent_freeze': 'Freeze change',
  'control.kill_switch': 'Kill switch',
  'config.updated': 'Mandate changed',
  'org.created': 'Organisation created',
  'org.renamed': 'Renamed',
  'member.invited': 'Invitation',
  'member.invitation_revoked': 'Invitation revoked',
  'member.added': 'Member added',
  'member.role_changed': 'Role changed',
  'member.removed': 'Member removed',
  'agent.created': 'Agent created',
  'agent.paused': 'Agent paused',
  'agent.resumed': 'Agent resumed',
  'agent.key_created': 'Key created',
  'agent.key_revoked': 'Key revoked',
  'invoice.recorded': 'Invoice',
  'invoice.resolved': 'Invoice decision',
};

const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function describe(
  type: string,
  data: Record<string, unknown>,
  decimals?: Readonly<Record<string, number>>,
): string {
  const req = data.request as { merchant?: string; amount?: number; currency?: string } | undefined;
  switch (type) {
    case 'payment.decision':
      return req?.merchant
        ? `${s(data.decision)}: ${money(req.amount ?? 0, req.currency ?? 'CHF', decimals)} to ${req.merchant}`
        : s(data.decision);
    case 'payment.resolved':
      return `${s(data.status)} by ${s(data.by)}`;
    case 'control.agent_freeze':
      return `${data.frozen ? 'frozen' : 'unfrozen'} by ${s(data.by)}`;
    case 'control.kill_switch':
      return `${data.on ? 'on' : 'off'}, by ${s(data.by)}`;
    case 'config.updated':
      return `by ${s(data.by)}: ${Array.isArray(data.changes) ? data.changes.map(s).join(', ') : ''}`;
    case 'org.created':
      return `“${s(data.name)}” by ${s(data.by)}`;
    case 'org.renamed':
      return `“${s(data.from)}” → “${s(data.to)}” by ${s(data.by)}`;
    case 'member.invited':
      return `${s(data.email)} as ${s(data.role)}, by ${s(data.by)}`;
    case 'member.invitation_revoked':
      return `${s(data.email)}, by ${s(data.by)}`;
    case 'member.added':
      return `${s(data.email)} as ${s(data.role)}`;
    case 'member.role_changed':
      return `${s(data.email)}: ${s(data.from)} → ${s(data.to)}, by ${s(data.by)}`;
    case 'member.removed':
      return `${s(data.email)}, by ${s(data.by)}`;
    case 'invoice.recorded':
      return `${s(data.number)} from ${s(data.supplier)}: ${s(data.match)}, by ${s(data.by)}`;
    case 'invoice.resolved':
      return `${s(data.outcome)} by ${s(data.by)}`;
    case 'agent.key_created':
    case 'agent.key_revoked':
      return `${s(data.prefix)}…, by ${s(data.by)}`;
    default:
      return data.by ? `by ${s(data.by)}` : '';
  }
}

export default async function LedgerPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { view } = await orgView(org);
  const base = `/app/${view.id}`;
  const entries = [...view.entries].reverse();
  const audit = view.audit;

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ledger</h1>
          <p className="mt-1 max-w-[70ch] text-ink-2">
            Every decision, every human action and every change to agents, keys, members and the
            mandate, append-only. Each entry stores the hash of the one before it and is signed with
            this organisation’s issuer key. Secrets are never recorded.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`${base}/export`} className={buttonClass('secondary', 'sm')}>
            <Download size={15} aria-hidden="true" /> Export CSV
          </a>
          <a href={`${base}/issuer.pub`} className={buttonClass('secondary', 'sm')}>
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
                const text = describe(e.type, data, view.currencyDecimals);
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
                            href={`${base}/payments/${paymentId}`}
                            className="text-ink hover:underline"
                          >
                            {text}
                          </Link>
                        ) : (
                          <span className="text-ink">{text}</span>
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
      </Panel>

      <Panel
        title="Verify a receipt"
        description="Paste any receipt from this organisation. Its signature is checked against the issuer public key, then its place in the chain."
      >
        <VerifyForm action={verifyAction.bind(null, view.id)} />
      </Panel>
    </div>
  );
}
