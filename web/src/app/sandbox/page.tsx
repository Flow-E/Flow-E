import type { Metadata } from 'next';
import Link from 'next/link';
import { ApprovalQueue } from '@/components/approval-card';
import { DashboardBody, DashboardFilters, agentScopeNote, panelNote } from '@/components/dashboard';
import { Panel, StatusPill, ButtonLink } from '@/components/ui';
import { money, time } from '@/lib/format';
import { buildDashboard, forAgent, parseAgent, parsePeriod } from '@/server/analytics';
import { sandboxView } from '@/server/view';
import {
  cancelAction,
  freezeAction,
  killSwitchAction,
  resolveAction,
  sampleHistoryAction,
} from './actions';
import { ActionButton, AutoRefresh, SampleHistoryButton } from './client';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await sandboxView();
  const params = await searchParams;
  const fmt = (minor: number | null) => money(minor, view.baseCurrency, view.currencyDecimals);
  const killed = view.controls.killSwitch?.on === true;
  const threshold = view.config.agents['lab-procurement']?.mandate.approvalAbove ?? null;
  const agents = view.agents.map((a) => ({ id: a.id, name: a.id }));
  const period = parsePeriod(params.period);
  const agentId = parseAgent(params.agent, agents);
  const dash = buildDashboard({
    entries: view.entries,
    agents: view.agents.map((a) => ({ id: a.id, name: a.id, dailyBudget: a.today.budget })),
    timezone: view.timezone,
    now: view.now,
    period,
    agentId,
    policy: view.config.policy,
  });
  const pending = forAgent(view.pending, agentId);
  const coolingOff = forAgent(view.coolingOff, agentId);
  const scope = agentScopeNote(agents, agentId);
  const query = new URLSearchParams({ period, ...(agentId ? { agent: agentId } : {}) });

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">Dashboard</h1>
          <p className="mt-1 text-ink-2">
            What your agents spend, where, how often Flow-E says no, and what waits for you.
          </p>
        </div>
        <ButtonLink href="/sandbox/agent" variant="secondary">
          Act as the agent
        </ButtonLink>
      </div>

      {/* Kill switch */}
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
              : 'One click declines every request from every agent until you release it.'}
          </p>
        </div>
        {killed ? (
          <ActionButton
            action={killSwitchAction}
            fields={{ on: 'false' }}
            label="Release"
            withNote
          />
        ) : (
          <ActionButton
            action={killSwitchAction}
            fields={{ on: 'true' }}
            label="Stop all agents"
            confirm="Click again to stop all"
            variant="danger"
            withNote
          />
        )}
      </section>

      <DashboardFilters
        basePath="/sandbox"
        period={period}
        agentId={agentId}
        agents={agents}
        exportHref={`/sandbox/export?${query.toString()}`}
      />

      <DashboardBody
        dash={dash}
        agents={agents}
        reportHref={`/sandbox/report?period=${period === 'today' ? '30d' : period}`}
        money={{ currency: view.baseCurrency, decimals: view.currencyDecimals }}
        timezone={view.timezone}
        paymentHref={(id) => `/sandbox/payments/${id}`}
        empty={
          view.entries.length === 0 ? (
            <div className="space-y-4">
              <p>
                Connect an agent or run the demo story, or fill this sandbox with 30 days of
                fictional lab purchasing to see the dashboard at work.
              </p>
              <SampleHistoryButton action={sampleHistoryAction} />
              <p className="text-xs text-ink-3">
                Every sample request goes through the real rules and lands in your signed ledger,
                with backdated times. Start over (Mandate tab) empties it again.
              </p>
            </div>
          ) : (
            <p>
              Choose a longer period, or open the{' '}
              <Link href="/sandbox/agent" className="text-accent underline">
                fake agent
              </Link>{' '}
              and run the demo story.
            </p>
          )
        }
        afterKpis={
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Approvals */}
            <Panel
              title={`Waiting for approval${pending.length ? ` (${String(pending.length)})` : ''}`}
              description={panelNote(
                threshold === null ? null : `Payments above ${fmt(threshold)} need a human.`,
                scope,
              )}
            >
              {pending.length === 0 ? (
                <p className="text-sm text-ink-2">
                  Nothing waits for you.{' '}
                  <Link href="/sandbox/agent" className="text-accent underline">
                    Ask for the centrifuge
                  </Link>{' '}
                  to see a payment land here.
                </p>
              ) : (
                <ApprovalQueue
                  view={view}
                  pending={pending}
                  canDecide
                  action={resolveAction}
                  paymentHref="/sandbox/payments"
                />
              )}
            </Panel>

            {/* Cooling-off */}
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
                          href={`/sandbox/payments/${p.paymentId}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {money(p.request.amount, p.request.currency)} to {p.request.merchant}
                        </Link>
                        <p className="text-sm text-ink-2">
                          Cancellable until {time(p.cancellableUntil ?? p.createdAt, view.timezone)}
                        </p>
                      </div>
                      <ActionButton
                        action={cancelAction}
                        fields={{ id: p.paymentId }}
                        label="Cancel payment"
                        confirm="Click again to cancel"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        }
      />

      {/* Agents */}
      <Panel
        title="Agents"
        description="Each agent spends within its own mandate. Freezing one declines its requests at once."
      >
        <ul className="grid gap-4 md:grid-cols-2">
          {view.agents.map((a) => (
            <li key={a.id} className="rounded-lg border border-rule p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-ink">{a.id}</p>
                  <p className="truncate text-sm text-ink-2">{a.owner}</p>
                </div>
                <StatusPill status={killed ? 'stopped' : a.effectiveStatus} />
              </div>
              <div className="mt-4">
                {a.configuredStatus !== 'active' ? (
                  <p className="text-sm text-ink-3">Set to {a.configuredStatus} in the mandate.</p>
                ) : a.frozenBy ? (
                  <ActionButton
                    action={freezeAction}
                    fields={{ agentId: a.id, frozen: 'false' }}
                    label="Unfreeze"
                  />
                ) : (
                  <ActionButton
                    action={freezeAction}
                    fields={{ agentId: a.id, frozen: 'true' }}
                    label="Freeze"
                    confirm={`Click again to freeze ${a.id}`}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
