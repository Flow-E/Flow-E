import type { Metadata } from 'next';
import { Pill, Panel, type Tone } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { orgView } from '@/server/org-view';
import { can } from '@/server/permissions';
import { MAX_STEPS, MAX_TOKENS, REORDER_MODEL, modelFromEnv } from '@/server/reorder-agent';
import type { RunRecord } from '@/server/reorder';
import { getReorderStore } from '@/server/runtime';
import {
  autoIncludeAction,
  decideSuggestionAction,
  linkSuggestionAction,
  runReorderAction,
  saveReorderAction,
} from './actions';
import { LinkForm, SmallAction } from './suggestions';
import { ReorderListForm, RunReorderForm, type Row } from './reorder-forms';

export const metadata: Metadata = { title: 'Reorder' };
/** A Claude run makes up to 12 tool calls; give it time. */
export const maxDuration = 120;

const STATUS: Record<RunRecord['status'], { label: string; tone: Tone }> = {
  running: { label: 'running', tone: 'accent' },
  finished: { label: 'finished', tone: 'approved' },
  stopped: { label: 'stopped early', tone: 'review' },
  failed: { label: 'failed', tone: 'declined' },
};

const LINE_TONE = {
  approved: 'text-approve',
  review: 'text-review',
  declined: 'text-decline',
  neutral: 'text-ink-2',
} as const;

export default async function ReorderPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { user, view } = await orgView(org);
  const reorder = await getReorderStore();
  const [items, runs, suggestions, settings] = await Promise.all([
    reorder.items(view.id, user),
    reorder.runs(view.id, user, 10),
    reorder.suggestions(view.id, user),
    reorder.settings(view.id, user),
  ]);
  const priceItems = (view.config.policy.referencePrices ?? []).map((r) => ({
    id: r.id ?? '',
    label: r.supplier ? `${r.item} (${r.supplier})` : r.item,
  }));
  const mode = modelFromEnv() ? 'claude' : 'simulated';
  const editable = can(view.role, 'reorder.manage');
  const rows: Row[] = items.map((i) => ({
    item: i.item,
    supplier: i.supplier ?? '',
    quantity: String(i.quantity),
    stock: i.stock === null ? '' : String(i.stock),
    minStock: i.minStock === null ? '' : String(i.minStock),
    category: i.category ?? '',
    country: i.country ?? '',
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reorder</h1>
        <p className="mt-1 max-w-2xl text-ink-2">
          Flow-E&apos;s own purchasing agent, so you can try Flow-E without building one. It asks
          for payments with the same tools as any agent, under your mandate: it cannot approve,
          change the mandate or unfreeze anything.
        </p>
      </div>

      <Panel
        title="Suggested by other systems"
        description={
          settings.autoIncludeSuggested
            ? 'Suggestions join the next run automatically, once. Nothing is bought without the agent asking Flow-E.'
            : 'An inventory system can suggest items through the API. Add them to the list, or dismiss them. Nothing is bought from a suggestion alone.'
        }
        action={
          editable ? (
            <SmallAction
              action={autoIncludeAction}
              fields={{ org: view.id, on: settings.autoIncludeSuggested ? 'false' : 'true' }}
              label={
                settings.autoIncludeSuggested
                  ? 'Turn off auto-include'
                  : 'Include in the next run automatically'
              }
              variant="quiet"
            />
          ) : undefined
        }
      >
        {suggestions.length === 0 ? (
          <p className="text-sm text-ink-2">
            No suggestions. Connect a system under{' '}
            <a href={`/app/${view.id}/integrations`} className="text-accent underline">
              Integrations
            </a>
            .
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {suggestions.map((s) => (
              <li key={s.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {s.quantity}
                      {s.unit ? ` ${s.unit}` : ''} × {s.item}
                      {s.supplier ? (
                        <span className="font-normal text-ink-2"> · {s.supplier}</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-ink-3">
                      suggested by {s.source} · {dateTime(s.createdAt, view.timezone)}
                      {s.reason ? ` · ${s.reason}` : ''}
                      {s.neededBy ? ` · needed by ${s.neededBy}` : ''}
                    </p>
                  </div>
                  <Pill tone={s.status === 'suggested' ? 'accent' : 'review'}>
                    {s.status === 'suggested' ? 'suggested' : 'needs matching'}
                  </Pill>
                </div>
                {editable ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {s.status === 'needs_matching' ? (
                      <LinkForm
                        action={linkSuggestionAction}
                        org={view.id}
                        id={s.id}
                        items={priceItems}
                      />
                    ) : (
                      <SmallAction
                        action={decideSuggestionAction}
                        fields={{ org: view.id, id: s.id, decision: 'accept' }}
                        label="Add to the list"
                      />
                    )}
                    <SmallAction
                      action={decideSuggestionAction}
                      fields={{ org: view.id, id: s.id, decision: 'dismiss' }}
                      label="Dismiss"
                      variant="quiet"
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Reorder list"
        description="An item is ordered when no stock is entered, or when the stock is below its minimum. The price comes from your price list on the Mandate page."
      >
        <ReorderListForm
          action={saveReorderAction}
          orgId={view.id}
          initial={rows}
          readOnly={!editable}
        />
      </Panel>

      <Panel
        title="Run"
        description={
          mode === 'claude'
            ? `Claude (${REORDER_MODEL}) reads the list and the price list and decides what to ask for. At most ${String(MAX_STEPS)} tool calls and ${MAX_TOKENS.toLocaleString('en')} tokens per run.`
            : 'No AI key is set, so the run is simulated: for each due item it asks for the usual price times the quantity, follows a supplier or project hint once, and records the order when approved. Clearly labelled “simulated” in the log.'
        }
      >
        {can(view.role, 'reorder.run') ? (
          <RunReorderForm
            action={runReorderAction}
            orgId={view.id}
            agents={view.agents.map((a) => ({ id: a.id, name: a.displayName }))}
            mode={mode}
          />
        ) : (
          <p className="text-sm text-ink-3">Owners and approvers can start a run.</p>
        )}
      </Panel>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-ink">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-ink-2">No runs yet.</p>
        ) : (
          <ol className="space-y-3">
            {runs.map((r) => (
              <li key={r.id} className="rounded-xl border border-rule bg-surface px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-ink">
                    {dateTime(r.startedAt, view.timezone)} · {r.agentId} · by {r.startedBy}
                  </p>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Pill tone={r.mode === 'claude' ? 'accent' : 'neutral'}>
                      {r.mode === 'claude' ? 'Claude' : 'simulated'}
                    </Pill>
                    <Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill>
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  {r.steps} tool {r.steps === 1 ? 'call' : 'calls'}
                  {r.mode === 'claude' ? ` · ${r.tokens.toLocaleString('en')} tokens` : ''}
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {r.log.map((l, i) => (
                    <li key={i} className={`break-words ${LINE_TONE[l.tone]}`}>
                      {l.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
