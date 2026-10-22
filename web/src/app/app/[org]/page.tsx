import Link from 'next/link';
import { CircleCheck, Circle } from 'lucide-react';
import { ButtonLink, Panel, Pill, StatusPill } from '@/components/ui';
import { dateTime, money, time } from '@/lib/format';
import { can } from '@/server/permissions';
import { orgView } from '@/server/org-view';
import { ActionButton, AutoRefresh } from '../../sandbox/client';
import { cancelAction, freezeAction, killSwitchAction, resolveAction } from '../actions';

export default async function OrgOverview({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { view } = await orgView(org);
  const base = `/app/${view.id}`;
  const fmt = (minor: number | null) => money(minor, view.baseCurrency, view.currencyDecimals);
  const killed = view.controls.killSwitch?.on === true;
  const decide = can(view.role, 'payment.resolve');
  const control = can(view.role, 'killswitch.set');
  const freeze = can(view.role, 'agent.freeze');
  const owner = can(view.role, 'agent.create');
  const recent = view.payments.slice(0, 8);
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
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-ink-2">
          What your agents asked for, what waits for a human, and what they may still spend today.
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title={`Waiting for approval${view.pending.length ? ` (${String(view.pending.length)})` : ''}`}
        >
          {view.pending.length === 0 ? (
            <p className="text-sm text-ink-2">Nothing waits for a human decision.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {view.pending.map((p) => (
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
          description="A first payment to a new supplier stays cancellable for 10 minutes."
        >
          {view.coolingOff.length === 0 ? (
            <p className="text-sm text-ink-2">No payment is in its cooling-off window right now.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {view.coolingOff.map((p) => (
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
                <dl className="tabular mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-3">Budget today</dt>
                  <dd className="text-right font-mono">{fmt(a.today.budget)}</dd>
                  <dt className="text-ink-3">Approved</dt>
                  <dd className="text-right font-mono">{fmt(a.today.approved)}</dd>
                  <dt className="text-ink-3">Waiting</dt>
                  <dd className="text-right font-mono">{fmt(a.today.pending)}</dd>
                  <dt className="font-medium text-ink">Remaining</dt>
                  <dd className="text-right font-mono font-medium text-ink">
                    {fmt(a.today.remaining)}
                  </dd>
                </dl>
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

      <Panel
        title="Recent requests"
        action={
          <Link href={`${base}/ledger`} className="text-sm text-accent underline">
            Full ledger
          </Link>
        }
      >
        {recent.length === 0 ? (
          <p className="text-sm text-ink-2">
            No requests yet. They appear here as soon as an agent asks.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {recent.map((p) => (
              <li key={p.paymentId}>
                <Link
                  href={`${base}/payments/${p.paymentId}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 py-2.5 hover:bg-sunken sm:grid-cols-[6rem_1fr_auto_auto]"
                >
                  <span className="tabular hidden font-mono text-xs text-ink-3 sm:block">
                    {time(p.createdAt, view.timezone)}
                  </span>
                  <span className="min-w-0 truncate text-sm text-ink">
                    {p.request.merchant}
                    <span className="block truncate text-xs text-ink-3">
                      {p.agentId} · {p.reason}
                    </span>
                  </span>
                  <span className="tabular hidden font-mono text-sm text-ink-2 sm:block">
                    {money(p.request.amount, p.request.currency, view.currencyDecimals)}
                  </span>
                  <Pill
                    tone={
                      p.status === 'approved'
                        ? 'approved'
                        : p.status === 'review'
                          ? 'review'
                          : p.status === 'cancelled'
                            ? 'cancelled'
                            : 'declined'
                    }
                  >
                    {p.status}
                  </Pill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
