import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Panel, Pill, StatusPill } from '@/components/ui';
import { dateTime, money } from '@/lib/format';
import { categoryLabel } from '@/lib/mcc';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { DEMO_LAB_AGENT, DEMO_LAB_NAME, demoLabPrompt } from '@/server/demo-lab';
import { siteOrigin } from '@/server/origin';
import { ActionButton } from '../../../../sandbox/client';
import {
  createKeyAction,
  freezeAction,
  pauseAction,
  revokeKeyAction,
  rotateKeyAction,
} from '../../../actions';
import { CopyBlock, CreateKeyForm, RotateKeyButton } from '../../../client';

export const metadata: Metadata = { title: 'Agent' };

export default async function AgentPage({
  params,
}: {
  params: Promise<{ org: string; agent: string }>;
}) {
  const { org, agent: agentId } = await params;
  const { view } = await orgView(org);
  const a = view.agents.find((x) => x.id === agentId);
  if (!a) notFound();
  const mandate = view.config.agents[a.id]?.mandate;
  const fmt = (minor: number | null) => money(minor, view.baseCurrency, view.currencyDecimals);
  const keys = can(view.role, 'agent.keys');
  const killed = view.controls.killSwitch?.on === true;
  const endpoint = `${await siteOrigin()}/api/mcp`;
  const placeholder = 'flowe_ak_YOUR_KEY';
  const claude = `claude mcp add --transport http flow-e ${endpoint} --header "Authorization: Bearer ${placeholder}"`;
  const json = JSON.stringify(
    {
      mcpServers: {
        'flow-e': {
          type: 'http',
          url: endpoint,
          headers: { Authorization: `Bearer ${placeholder}` },
        },
      },
    },
    null,
    2,
  );
  const payments = view.payments.filter((p) => p.agentId === a.id).slice(0, 10);

  return (
    <div className="space-y-6">
      <Link
        href={`/app/${view.id}/agents`}
        className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Agents
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{a.displayName}</h1>
          <p className="mt-1 text-ink-2">
            <span className="font-mono">{a.id}</span> · responsible: {a.owner} · created by{' '}
            {a.createdBy} on {dateTime(a.createdAt, view.timezone)}
          </p>
        </div>
        <StatusPill status={killed ? 'stopped' : a.effectiveStatus} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Mandate today" description="Edit the full mandate on the Mandate page.">
          <dl className="tabular grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-3">Daily budget</dt>
            <dd className="text-right font-mono">{fmt(a.today.budget)}</dd>
            <dt className="text-ink-3">Remaining today</dt>
            <dd className="text-right font-mono">{fmt(a.today.remaining)}</dd>
            <dt className="text-ink-3">Per payment</dt>
            <dd className="text-right font-mono">{fmt(mandate?.perPaymentLimit ?? null)}</dd>
            <dt className="text-ink-3">Human approval above</dt>
            <dd className="text-right font-mono">
              {mandate?.approvalAbove === null || mandate === undefined
                ? 'never'
                : fmt(mandate.approvalAbove)}
            </dd>
            <dt className="text-ink-3">Categories</dt>
            <dd className="text-right">{mandate?.categories.map(categoryLabel).join(', ')}</dd>
            <dt className="text-ink-3">Credential valid until</dt>
            <dd className="text-right">
              {a.credentialExpires ? dateTime(a.credentialExpires, view.timezone) : '—'}
            </dd>
          </dl>
        </Panel>

        <Panel title="Controls">
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-ink-2">
                <span className="font-medium text-ink">Freeze</span>: declines every request from
                this agent at once.
                {a.frozenBy ? ` Frozen by ${a.frozenBy.by}.` : ''}
              </p>
              {can(view.role, 'agent.freeze') ? (
                a.frozenBy ? (
                  <ActionButton
                    action={freezeAction}
                    fields={{ org: view.id, agentId: a.id, frozen: 'false' }}
                    label="Unfreeze"
                  />
                ) : (
                  <ActionButton
                    action={freezeAction}
                    fields={{ org: view.id, agentId: a.id, frozen: 'true' }}
                    label="Freeze"
                    confirm="Click again to freeze"
                  />
                )
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-ink-2">
                <span className="font-medium text-ink">Pause</span>: the mandate status; the agent
                is declined until resumed.
              </p>
              {can(view.role, 'mandate.update') ? (
                a.configuredStatus === 'paused' ? (
                  <ActionButton
                    action={pauseAction}
                    fields={{ org: view.id, agentId: a.id, paused: 'false' }}
                    label="Resume"
                  />
                ) : (
                  <ActionButton
                    action={pauseAction}
                    fields={{ org: view.id, agentId: a.id, paused: 'true' }}
                    label="Pause"
                  />
                )
              ) : null}
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        title="API keys"
        description="A key lets an agent call the MCP endpoint as this agent, and nothing else. Only its fingerprint is stored: copy a new key when it is shown."
      >
        <div className="space-y-5">
          {a.keys.length === 0 ? (
            <p className="text-sm text-ink-2">No keys yet.</p>
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-ink-3">
                    <th className="py-2 pr-3 font-medium">Key</th>
                    <th className="py-2 pr-3 font-medium">Created</th>
                    <th className="py-2 pr-3 font-medium">Last used</th>
                    <th className="py-2 pr-3 font-medium">Expires</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.keys.map((k) => (
                    <tr key={k.id} className="border-b border-rule align-top last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-xs text-ink">{k.prefix}…</td>
                      <td className="py-2.5 pr-3 text-ink-2">
                        {dateTime(k.createdAt, view.timezone)}
                        <span className="block text-xs text-ink-3">{k.createdBy}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-ink-2">
                        {k.lastUsedAt ? dateTime(k.lastUsedAt, view.timezone) : 'never'}
                      </td>
                      <td className="py-2.5 pr-3 text-ink-2">
                        {k.expiresAt ? dateTime(k.expiresAt, view.timezone) : 'never'}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Pill tone={k.status === 'active' ? 'approved' : 'neutral'}>
                          {k.status}
                        </Pill>
                      </td>
                      <td className="py-2.5">
                        {keys && k.status === 'active' ? (
                          <div className="flex flex-wrap gap-2">
                            <RotateKeyButton action={rotateKeyAction} org={view.id} keyId={k.id} />
                            <ActionButton
                              action={revokeKeyAction}
                              fields={{ org: view.id, keyId: k.id }}
                              label="Revoke"
                              confirm="Click again to revoke"
                            />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {keys ? <CreateKeyForm action={createKeyAction} org={view.id} agentId={a.id} /> : null}
        </div>
      </Panel>

      <Panel
        title="Connect the agent"
        description="Replace flowe_ak_YOUR_KEY with the key you copied. The key is the only credential: keep it in the agent's secret store, not in code."
      >
        <div id="connect" className="space-y-5">
          <CopyBlock title="Claude Code" value={claude} />
          <CopyBlock title="Other MCP clients (JSON)" value={json} />
          {view.name === DEMO_LAB_NAME && a.id === DEMO_LAB_AGENT ? (
            <CopyBlock title="Demo prompt to paste into Claude" value={demoLabPrompt()} />
          ) : null}
          <p className="text-sm text-ink-3">
            Endpoint: <span className="font-mono">{endpoint}</span> · Streamable HTTP · POST only ·
            60 requests per minute per key.
          </p>
        </div>
      </Panel>

      <Panel title="Recent requests from this agent">
        {payments.length === 0 ? (
          <p className="text-sm text-ink-2">None yet.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {payments.map((p) => (
              <li key={p.paymentId} className="flex flex-wrap items-center gap-3 py-2.5">
                <Link
                  href={`/app/${view.id}/payments/${p.paymentId}`}
                  className="min-w-0 flex-1 truncate text-sm text-ink hover:underline"
                >
                  {p.request.merchant}
                </Link>
                <span className="tabular font-mono text-sm text-ink-2">
                  {money(p.request.amount, p.request.currency, view.currencyDecimals)}
                </span>
                <StatusPill status={p.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
