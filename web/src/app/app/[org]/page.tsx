import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleCheck, Circle } from 'lucide-react';
import { DashboardBody, DashboardFilters, agentScopeNote, panelNote } from '@/components/dashboard';
import { ButtonLink, Panel, StatusPill } from '@/components/ui';
import { dateTime, money, time } from '@/lib/format';
import { buildDashboard, forAgent, parseAgent, parsePeriod } from '@/server/analytics';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { ActionButton, AutoRefresh } from '../../sandbox/client';
import { cancelAction, freezeAction, killSwitchAction, resolveAction } from '../actions';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function OrgDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await params;
  const { view } = await orgView(org);
  const query = await searchParams;
  const base = `/app/${view.id}`;
  const killed = view.controls.killSwitch?.on === true;
  const decide = can(view.role, 'payment.resolve');
  const control = can(view.role, 'killswitch.set');
  const freeze = can(view.role, 'agent.freeze');
  const owner = can(view.role, 'agent.create');
  const agents = view.agents.map((a) => ({ id: a.id, name: a.displayName }));
  const period = parsePeriod(query.period);
  const agentId = parseAgent(query.agent, agents);
  const dash = buildDashboard({
    entries: view.entries,
    agents: view.agents.map((a) => ({
      id: a.id,
      name: a.displayName,
      dailyBudget: a.today.budget,
    })),
    timezone: view.timezone,
    now: view.now,
    period,
    agentId,
    policy: view.config.policy,
  });
  const pending = forAgent(view.pending, agentId);
  const coolingOff = forAgent(view.coolingOff, agentId);
  const scope = agentScopeNote(agents, agentId);
  const exportQuery = new URLSearchParams({ period, ...(agentId ? { agent: agentId } : {}) });
  const hasKey = view.agents.some((a) => a.keys.some((k) => k.status === 'active'));
  const used = view.agents.some((a) => a.keys.some((k) => k.lastUsedAt !== null));

  const steps = [
    {
      done: view.agents.length > 0,
      label: 'Create an agent with a starting mandate',
      href: `${base}/agents`,
    },
    {
      done: hasKey,
      label: 'Create an API key for it',
      href: view.agents[0] ? `${base}/agents/${view.agents[0].id}` : `${base}/agents`,
    },
    {
      done: used,
      label: 'Connect the agent to the MCP endpoint',
      href: view.agents[0] ? `${base}/agents/${view.agents[0].id}#connect` : `${base}/agents`,
    },
    { done: view.members.length > 1, label: 'Invite an approver', href: `${base}/members` },
  ];

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Dashboard</h1>
        <p className="mt-1 text-ink-2">
          What your agents spend, where, how often Flow-E says no, and what waits for a human.
        </p>
      </div>

      {steps.some((s) => !s.done) ? (
        <Panel
          title="Get started"
          description="Four steps from an empty organisation to a governed agent."
        >
          <ol className="space-y-2">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-2 text-sm">
                {s.done ? (
                  <CircleCheck size={16} className="shrink-0 text-approve" aria-label="done" />
                ) : (
                  <Circle size={16} className="shrink-0 text-ink-3" aria-label="to do" />
                )}
                {s.done || (!owner && s.label !== 'Invite an approver') ? (
                  <span className={s.done ? 'text-ink-3 line-through' : 'text-ink'}>{s.label}</span>
                ) : (
                  <Link href={s.href} className="text-accent underline">
                    {s.label}
                  </Link>
                )}
              </li>
            ))}
          </ol>
          {owner ? null : (
            <p className="mt-3 text-sm text-ink-3">Only owners can create agents and keys.</p>
          )}
        </Panel>
      ) : null}

      <section
        className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-4 sm:px-5 ${
          killed ? 'border-decline/40 bg-decline-soft' : 'border-rule bg-surface'
        }`}
      >
        <div className="min-w-0">
          <h2 className="font-semibold">
            Kill switch:{' '}
            <span className={killed ? 'text-decline' : 'text-ink-2'}>{killed ? 'on' : 'off'}</span>
          </h2>
          <p className="text-sm text-ink-2">
            {killed
              ? `Every request from every agent is declined. Set by ${view.controls.killSwitch?.by ?? ''} at ${time(view.controls.killSwitch?.at ?? new Date().toISOString(), view.timezone)}.`
              : 'Declines every request from every agent at once, until released.'}
          </p>
        </div>
        {!control ? (
          <p className="text-sm text-ink-3">Owners and approvers can use it.</p>
        ) : killed ? (
          <ActionButton
            action={killSwitchAction}
            fields={{ org: view.id, on: 'false' }}
            label="Release"
            withNote
          />
        ) : (
          <ActionButton
            action={killSwitchAction}
            fields={{ org: view.id, on: 'true' }}
            label="Stop all agents"
            confirm="Click again to stop all"
            variant="danger"
            withNote
          />
        )}
      </section>

      <DashboardFilters
        basePath={base}
        period={period}
        agentId={agentId}
        agents={agents}
        exportHref={`${base}/export?${exportQuery.toString()}`}
      />

      <DashboardBody
        dash={dash}
        agents={agents}
        money={{ currency: view.baseCurrency, decimals: view.currencyDecimals }}
        timezone={view.timezone}
        paymentHref={(id) => `${base}/payments/${id}`}
        empty={
          <p>
            Payments appear here as soon as a connected agent asks. Connect an agent to the MCP
            endpoint, or choose a longer period.
          </p>
        }
        afterKpis={
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title={`Waiting for approval${pending.length ? ` (${String(pending.length)})` : ''}`}
              description={panelNote(scope)}
            >
              {pending.length === 0 ? (
                <p className="text-sm text-ink-2">Nothing waits for a human decision.</p>
              ) : (
                <ul className="divide-y divide-rule">
                  {pending.map((p) => (
                    <li key={p.paymentId} className="space-y-2 py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <Link
                          href={`${base}/payments/${p.paymentId}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {p.request.merchant}
                        </Link>
                        <span className="tabular font-mono text-ink">
                          {money(p.request.amount, p.request.currency, view.currencyDecimals)}
                        </span>
                      </div>
                      <p className="text-sm text-ink-2">
                        {p.agentId} · {dateTime(p.createdAt, view.timezone)} · {p.reason}
                      </p>
                      {decide ? (
                        <div className="flex flex-wrap gap-2">
                          <ActionButton
                            action={resolveAction}
                            fields={{ org: view.id, id: p.paymentId, status: 'approved' }}
                            label="Approve"
                            variant="primary"
                            withNote
                          />
                          <ActionButton
                            action={resolveAction}
                            fields={{ org: view.id, id: p.paymentId, status: 'declined' }}
                            label="Decline"
                          />
                        </div>
                      ) : (
                        <p className="text-xs text-ink-3">An owner or approver decides.</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Cooling-off"
              description={panelNote(
                'A first payment to a new supplier stays cancellable for 10 minutes.',
                scope,
              )}
            >
              {coolingOff.length === 0 ? (
                <p className="text-sm text-ink-2">
                  No payment is in its cooling-off window right now.
                </p>
              ) : (
                <ul className="divide-y divide-rule">
                  {coolingOff.map((p) => (
                    <li
                      key={p.paymentId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`${base}/payments/${p.paymentId}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {money(p.request.amount, p.request.currency, view.currencyDecimals)} to{' '}
                          {p.request.merchant}
                        </Link>
                        <p className="text-sm text-ink-2">
                          Cancellable until {time(p.cancellableUntil ?? p.createdAt, view.timezone)}
                        </p>
                      </div>
                      {decide ? (
                        <ActionButton
                          action={cancelAction}
                          fields={{ org: view.id, id: p.paymentId }}
                          label="Cancel payment"
                          confirm="Click again to cancel"
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        }
      />

      <Panel
        title="Agents"
        action={
          owner ? (
            <ButtonLink href={`${base}/agents`} variant="secondary" size="sm">
              Add an agent
            </ButtonLink>
          ) : undefined
        }
      >
        {view.agents.length === 0 ? (
          <p className="text-sm text-ink-2">No agents yet.</p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {view.agents.map((a) => (
              <li key={a.id} className="rounded-lg border border-rule p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`${base}/agents/${a.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {a.displayName}
                    </Link>
                    <p className="truncate font-mono text-xs text-ink-3">{a.id}</p>
                  </div>
                  <StatusPill status={killed ? 'stopped' : a.effectiveStatus} />
                </div>
                {freeze && a.configuredStatus === 'active' ? (
                  <div className="mt-4">
                    {a.frozenBy ? (
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
                        confirm={`Click again to freeze ${a.id}`}
                      />
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
