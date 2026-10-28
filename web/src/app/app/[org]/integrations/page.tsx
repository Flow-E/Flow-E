import type { Metadata } from 'next';
import Link from 'next/link';
import { Panel, Pill } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { API_SCOPES, SCOPE_LABEL } from '@/server/api-keys';
import { orgView } from '@/server/org-view';
import { can } from '@/server/permissions';
import { getApiKeyStore, getWebhookStore } from '@/server/runtime';
import { EVENT_LABEL, WEBHOOK_EVENTS } from '@/server/webhooks';
import { ActionButton } from '../../../sandbox/client';
import {
  createApiKeyAction,
  createWebhookAction,
  removeWebhookAction,
  resendDeliveryAction,
  revokeApiKeyAction,
  testWebhookAction,
} from './actions';
import { CreateApiKeyForm, CreateWebhookForm } from './forms';

export const metadata: Metadata = { title: 'Integrations' };

const DELIVERY_TONE = { delivered: 'approved', pending: 'review', failed: 'declined' } as const;

export default async function IntegrationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { user, view } = await orgView(org);
  const tz = view.timezone;
  const [keyStore, hookStore] = await Promise.all([getApiKeyStore(), getWebhookStore()]);
  const [keys, hooks, deliveries, log] = await Promise.all([
    keyStore.list(view.id, user),
    hookStore.list(view.id, user),
    hookStore.deliveries(view.id, user, 30),
    keyStore.accessLog(view.id, user, 20),
  ]);
  const manage = can(view.role, 'integrations.manage');
  const activeHooks = hooks.filter((h) => h.disabledAt === null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 max-w-2xl text-ink-2">
          Connect the systems around Flow-E: an inventory system can suggest what to reorder, and
          accounting or a supplier can be told when an order is approved. Nothing from outside can
          approve a purchase. How it works, with examples:{' '}
          <Link href="/developers" className="text-accent underline">
            Connect your systems
          </Link>
          .
        </p>
      </div>

      <Panel
        title="API keys"
        description="For other systems, separate from agent keys. A key belongs to this organisation and can only do what its permissions say."
      >
        {keys.length === 0 ? <p className="text-sm text-ink-2">No keys yet.</p> : null}
        <ul className="divide-y divide-rule">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {k.name} {k.revokedAt ? <Pill tone="neutral">revoked</Pill> : null}
                </p>
                <p className="text-xs text-ink-3">
                  <span className="font-mono">{k.prefix}…</span> · {k.scopes.join(', ')} · created{' '}
                  {dateTime(k.createdAt, tz)} by {k.createdBy} · last used{' '}
                  {k.lastUsedAt ? dateTime(k.lastUsedAt, tz) : 'never'}
                </p>
              </div>
              {manage && !k.revokedAt ? (
                <ActionButton
                  action={revokeApiKeyAction}
                  fields={{ org: view.id, key: k.id }}
                  label="Revoke"
                  confirm="Click again to revoke"
                  variant="danger"
                />
              ) : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <div className="mt-4 border-t border-rule pt-4">
            <CreateApiKeyForm
              action={createApiKeyAction}
              org={view.id}
              scopes={API_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-3">Owners create and revoke keys.</p>
        )}
      </Panel>

      <Panel
        title="Webhooks"
        description="Flow-E sends a signed message to your address when something happens. Sending never changes or slows a decision; failed deliveries are retried for a day."
      >
        {activeHooks.length === 0 ? <p className="text-sm text-ink-2">No webhooks yet.</p> : null}
        <ul className="divide-y divide-rule">
          {activeHooks.map((h) => (
            <li key={h.id} className="space-y-2 py-3">
              <p className="break-all font-mono text-sm text-ink">{h.url}</p>
              <p className="text-xs text-ink-3">
                {h.events.join(', ')} · added {dateTime(h.createdAt, tz)} by {h.createdBy}
              </p>
              {manage ? (
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    action={testWebhookAction}
                    fields={{ org: view.id, webhook: h.id }}
                    label="Send test event"
                  />
                  <ActionButton
                    action={removeWebhookAction}
                    fields={{ org: view.id, webhook: h.id }}
                    label="Remove"
                    confirm="Click again to remove"
                    variant="danger"
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <div className="mt-4 border-t border-rule pt-4">
            <CreateWebhookForm
              action={createWebhookAction}
              org={view.id}
              events={WEBHOOK_EVENTS.map((e) => ({ value: e, label: EVENT_LABEL[e] }))}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-3">Owners add and remove webhooks.</p>
        )}
      </Panel>

      <Panel title="Delivery log" description="The last 30 deliveries, newest first.">
        {deliveries.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing sent yet.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {deliveries.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="text-ink">
                    <span className="font-mono">{d.event}</span>{' '}
                    <span className="text-ink-3">→ {d.url}</span>
                  </p>
                  <p className="text-xs text-ink-3">
                    {dateTime(d.createdAt, tz)} · {d.attempts}{' '}
                    {d.attempts === 1 ? 'attempt' : 'attempts'}
                    {d.lastStatus ? ` · answered ${String(d.lastStatus)}` : ''}
                    {d.lastError ? ` · ${d.lastError}` : ''}
                    {d.status === 'pending' && d.attempts > 0
                      ? ` · next try ${dateTime(d.nextAttemptAt, tz)}`
                      : ''}
                  </p>
                </div>
                <span className="inline-flex items-center gap-2">
                  <Pill tone={DELIVERY_TONE[d.status]}>{d.status}</Pill>
                  {manage && d.status === 'failed' ? (
                    <ActionButton
                      action={resendDeliveryAction}
                      fields={{ org: view.id, delivery: d.id }}
                      label="Resend"
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="API access log"
        description="The last 20 calls made with this organisation's keys. Kept 90 days; never the key or the content."
      >
        {log.length === 0 ? (
          <p className="text-sm text-ink-2">No calls yet.</p>
        ) : (
          <ul className="divide-y divide-rule font-mono text-xs">
            {log.map((l, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5 text-ink-2">
                <span>
                  {l.method} {l.path} → {l.status}
                </span>
                <span className="text-ink-3">
                  {l.key_name} · {dateTime(l.created_at, tz)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
