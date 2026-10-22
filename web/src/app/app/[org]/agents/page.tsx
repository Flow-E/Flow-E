import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Panel, StatusPill } from '@/components/ui';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { createAgentAction } from '../../actions';
import { CreateAgentForm } from '../../client';

export const metadata: Metadata = { title: 'Agents' };

export default async function AgentsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { user, view } = await orgView(org);
  const base = `/app/${view.id}`;
  const killed = view.controls.killSwitch?.on === true;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 max-w-[70ch] text-ink-2">
          Each agent has a signed Know Your Agent credential from this organisation, its own
          mandate, and API keys that let it reach the MCP endpoint.
        </p>
      </div>

      {view.agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-rule-strong px-4 py-6 text-center text-ink-2">
          No agents yet.{' '}
          {can(view.role, 'agent.create')
            ? 'Create the first one below.'
            : 'An owner can create one.'}
        </p>
      ) : (
        <ul className="divide-y divide-rule rounded-xl border border-rule bg-surface">
          {view.agents.map((a) => {
            const active = a.keys.filter((k) => k.status === 'active').length;
            return (
              <li key={a.id}>
                <Link
                  href={`${base}/agents/${a.id}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-sunken sm:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{a.displayName}</span>
                    <span className="block truncate text-xs text-ink-3">
                      <span className="font-mono">{a.id}</span> · responsible: {a.owner} · {active}{' '}
                      active {active === 1 ? 'key' : 'keys'}
                    </span>
                  </span>
                  <StatusPill status={killed ? 'stopped' : a.effectiveStatus} />
                  <ArrowRight size={16} className="text-ink-3" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {can(view.role, 'agent.create') ? (
        <Panel
          title="Create an agent"
          description="Starts with these limits in the organisation's base currency. The credential is signed by this organisation's issuer and valid for 90 days; it renews itself."
        >
          <CreateAgentForm
            action={createAgentAction}
            org={view.id}
            baseCurrency={view.baseCurrency}
            defaultOwner={user.email}
          />
        </Panel>
      ) : null}
    </div>
  );
}
