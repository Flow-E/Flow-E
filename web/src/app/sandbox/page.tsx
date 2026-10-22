import Link from 'next/link';
import { Panel, Pill, StatusPill, ButtonLink } from '@/components/ui';
import { dateTime, money, time } from '@/lib/format';
import { sandboxView } from '@/server/view';
import { cancelAction, freezeAction, killSwitchAction, resolveAction } from './actions';
import { ActionButton, AutoRefresh } from './client';

export default async function OverviewPage() {
  const { view } = await sandboxView();
  const fmt = (minor: number | null) => money(minor, view.baseCurrency, view.currencyDecimals);
  const killed = view.controls.killSwitch?.on === true;
  const recent = view.payments.slice(0, 6);
  const threshold = view.config.agents['lab-procurement']?.mandate.approvalAbove ?? null;

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-ink-2">
            What your agents asked for, what waits for you, and how much they may still spend today.
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

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Approvals */}
        <Panel
          title={`Waiting for approval${view.pending.length ? ` (${String(view.pending.length)})` : ''}`}
          description={
            threshold === null ? undefined : `Payments above ${fmt(threshold)} need a human.`
          }
        >
          {view.pending.length === 0 ? (
            <p className="text-sm text-ink-2">
              Nothing waits for you.{' '}
              <Link href="/sandbox/agent" className="text-accent underline">
                Ask for the centrifuge
              </Link>{' '}
              to see a payment land here.
            </p>
          ) : (
            <ul className="divide-y divide-rule">
              {view.pending.map((p) => (
                <li key={p.paymentId} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href={`/sandbox/payments/${p.paymentId}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {p.request.merchant}
                    </Link>
                    <span className="tabular font-mono text-ink">
                      {money(p.request.amount, p.request.currency)}
                    </span>
                  </div>
                  <p className="text-sm text-ink-2">
                    {p.agentId} · {dateTime(p.createdAt, view.timezone)}
                    {p.request.memo ? ` · ${p.request.memo}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      action={resolveAction}
                      fields={{ id: p.paymentId, status: 'approved' }}
                      label="Approve"
                      variant="primary"
                      withNote
                    />
                    <ActionButton
                      action={resolveAction}
                      fields={{ id: p.paymentId, status: 'declined' }}
                      label="Decline"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Cooling-off */}
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
              <dl className="tabular mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-ink-3">Budget today</dt>
                <dd className="text-right font-mono">{fmt(a.today.budget)}</dd>
                <dt className="text-ink-3">Approved</dt>
                <dd className="text-right font-mono">{fmt(a.today.approved)}</dd>
                <dt className="text-ink-3">Waiting for approval</dt>
                <dd className="text-right font-mono">{fmt(a.today.pending)}</dd>
                <dt className="font-medium text-ink">Remaining</dt>
                <dd className="text-right font-mono font-medium text-ink">
                  {fmt(a.today.remaining)}
                </dd>
              </dl>
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

      {/* Recent */}
      <Panel
        title="Recent requests"
        action={
          <Link href="/sandbox/ledger" className="text-sm text-accent underline">
            Full ledger
          </Link>
        }
      >
        {recent.length === 0 ? (
          <p className="text-sm text-ink-2">
            No requests yet. Open the{' '}
            <Link href="/sandbox/agent" className="text-accent underline">
              fake agent
            </Link>{' '}
            and play the demo story: seven requests that touch most rules.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {recent.map((p) => (
              <li key={p.paymentId}>
                <Link
                  href={`/sandbox/payments/${p.paymentId}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 py-2.5 hover:bg-sunken sm:grid-cols-[6rem_1fr_auto_auto]"
                >
                  <span className="tabular hidden font-mono text-xs text-ink-3 sm:block">
                    {time(p.createdAt, view.timezone)}
                  </span>
                  <span className="min-w-0 truncate text-sm text-ink">
                    {p.request.merchant}
                    <span className="block truncate text-xs text-ink-3">{p.reason}</span>
                  </span>
                  <span className="tabular hidden font-mono text-sm text-ink-2 sm:block">
                    {money(p.request.amount, p.request.currency)}
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
