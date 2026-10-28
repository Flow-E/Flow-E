import Link from 'next/link';
import type { ReactNode } from 'react';
import { Panel, Pill, toneOf } from '@/components/ui';
import { dateTime, decimalsOf, money } from '@/lib/format';
import {
  AGENT_SLOTS,
  NEAR_BUDGET_SHARE,
  PERIODS,
  PERIOD_LABELS,
  buildValueReport,
  spendGroups,
  valueSummary,
  workSaved,
  type Activity,
  type Dashboard,
  type DayPoint,
  type Declined,
  type Period,
  type ValueReport,
} from '@/server/analytics';

/**
 * The management dashboard, shared by the sandbox and organisations. Server components only:
 * the charts are plain SVG with no script, so the page keeps its strict CSP. Every chart has a
 * visible data table behind a disclosure and a short text summary for screen readers.
 */

export interface DashboardAgentRef {
  id: string;
  name: string;
}

interface Money {
  currency: string;
  decimals: Readonly<Record<string, number>> | undefined;
}

function slotColor(slot: number | null): string {
  return slot !== null && slot >= 0 && slot < AGENT_SLOTS
    ? `var(--viz-${String(slot + 1)})`
    : 'var(--viz-other)';
}

/**
 * Colour follows the agent (its place in the full list), never its rank in a filtered view.
 * Agents past the validated slots are grey: in the spend chart they are one "Other agents" series.
 */
export function agentColor(agents: readonly DashboardAgentRef[], id: string): string {
  return slotColor(agents.findIndex((a) => a.id === id));
}

/** "Showing Lab Agent only." when the dashboard is filtered to one agent, for panel notes. */
export function agentScopeNote(
  agents: readonly DashboardAgentRef[],
  agentId: string | null,
): string | null {
  const a = agentId === null ? undefined : agents.find((x) => x.id === agentId);
  return a ? `Showing ${a.name} only.` : null;
}

/** Joins a panel's description parts, leaving out the empty ones. */
export function panelNote(...parts: (string | null | undefined)[]): string | undefined {
  const text = parts.filter((x): x is string => Boolean(x)).join(' ');
  return text === '' ? undefined : text;
}

function href(basePath: string, period: Period, agent: string | null): string {
  const q = new URLSearchParams();
  q.set('period', period);
  if (agent) q.set('agent', agent);
  return `${basePath}?${q.toString()}`;
}

function chip(active: boolean): string {
  return `inline-flex h-8 items-center whitespace-nowrap rounded-full border px-3 text-sm font-medium transition-colors ${
    active
      ? 'border-ink bg-ink text-paper'
      : 'border-rule-strong bg-surface text-ink-2 hover:bg-sunken hover:text-ink'
  }`;
}

/** Period and agent filters: links, so a view is shareable and works without script. */
export function DashboardFilters({
  basePath,
  period,
  agentId,
  agents,
  exportHref,
}: {
  basePath: string;
  period: Period;
  agentId: string | null;
  agents: readonly DashboardAgentRef[];
  exportHref?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Period" className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={href(basePath, p, agentId)}
              aria-current={p === period ? 'true' : undefined}
              className={chip(p === period)}
            >
              {PERIOD_LABELS[p]}
            </Link>
          ))}
        </nav>
        {agents.length > 1 ? (
          <nav aria-label="Agent" className="flex flex-wrap gap-1.5">
            <Link
              href={href(basePath, period, null)}
              aria-current={agentId === null ? 'true' : undefined}
              className={chip(agentId === null)}
            >
              All agents
            </Link>
            {agents.map((a) => (
              <Link
                key={a.id}
                href={href(basePath, period, a.id)}
                aria-current={agentId === a.id ? 'true' : undefined}
                className={`${chip(agentId === a.id)} gap-1.5`}
              >
                <Swatch color={agentColor(agents, a.id)} />
                {a.name}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
      {exportHref ? (
        <a href={exportHref} className="text-sm text-accent underline">
          Export this view (CSV)
        </a>
      ) : null}
    </div>
  );
}

function Swatch({ color, shape = 'square' }: { color: string; shape?: 'square' | 'dot' }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
      {shape === 'dot' ? (
        <circle cx="5" cy="5" r="5" fill={color} />
      ) : (
        <rect width="10" height="10" rx="2" fill={color} />
      )}
    </svg>
  );
}

// Formatting --------------------------------------------------------------------------------------

function others(n: number, short: boolean): string {
  if (short) return `${String(n)} foreign`;
  return n === 1 ? '1 in another currency' : `${String(n)} in other currencies`;
}

/**
 * A decline sum that does not hide what it could not convert: "CHF 3,000.00 + 1 in another
 * currency", or only the count when nothing had a base amount.
 */
export function declinedText(d: Declined, fmt: (minor: number) => string, short = false): string {
  if (d.unconverted === 0) return fmt(d.amount);
  if (d.unconverted >= d.count) return others(d.unconverted, short);
  return `${fmt(d.amount)} + ${others(d.unconverted, short)}`;
}

function percent(share: number | null): string {
  return share === null ? '—' : `${String(Math.round(share * 100))}%`;
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : String(Math.round(hours))} h`;
  return `${String(Math.round(hours / 24))} days`;
}

/** Axis ticks in whole units, compact from 1,000: 0 / 500 / 1K / 12.5K / 1.2M. */
function compact(minor: number, m: Money): string {
  const units = minor / 10 ** decimalsOf(m.currency, m.decimals);
  const abs = Math.abs(units);
  const trim = (v: number) => String(Number(v.toFixed(v < 10 ? 1 : 0)));
  if (abs >= 1_000_000) return `${trim(units / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(units / 1_000)}K`;
  return String(Math.round(units));
}

/**
 * A round axis maximum and its ticks. `unit` is the smallest step that makes sense (1 for
 * counts, one whole currency unit for money), so an empty chart still has a scale and counts
 * never get fractional ticks.
 */
function scale(max: number, unit: number): { max: number; ticks: number[] } {
  const target = Math.max(max, unit) / 4;
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [1, 2, 2.5, 5, 10]
    .map((f) => f * pow)
    .filter((s) => Number.isInteger(s / unit))
    .find((s) => s >= target);
  const step = Math.max(nice ?? pow * 10, unit);
  const top = Math.max(Math.ceil(max / step) * step, step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { max: top, ticks };
}

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

function bucketLabel(key: string, unit: Dashboard['unit'], long = false): string {
  if (unit === 'hour') return long ? `${key}:00–${key}:59` : key;
  const d = new Date(`${key}T12:00:00Z`);
  return long ? `${WEEKDAY.format(d)} ${DAY_MONTH.format(d)}` : DAY_MONTH.format(d);
}

function labelEvery(n: number): number {
  if (n <= 8) return 1;
  if (n <= 24) return 3;
  if (n <= 31) return 5;
  return 15;
}

// Stacked columns ---------------------------------------------------------------------------------

export interface Series {
  key: string;
  label: string;
  color: string;
}

const W = 600;
const H = 176;
const GAP = 2;
const RADIUS = 4;

/** A bar with rounded data-end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(RADIUS, h, w / 2) : 0;
  return [
    `M${String(x)},${String(y + h)}`,
    `V${String(y + r)}`,
    `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}`,
    `H${String(x + w - r)}`,
    `Q${String(x + w)},${String(y)} ${String(x + w)},${String(y + r)}`,
    `V${String(y + h)}Z`,
  ].join(' ');
}

export function StackedColumns({
  title,
  points,
  series,
  value,
  unit,
  format,
  tick,
  summary,
  step0 = 1,
}: {
  title: string;
  points: readonly DayPoint[];
  series: readonly Series[];
  value: (p: DayPoint, key: string) => number;
  unit: Dashboard['unit'];
  format: (v: number) => string;
  tick: (v: number) => string;
  summary: string;
  step0?: number;
}) {
  const totals = points.map((p) => series.reduce((s, x) => s + value(p, x.key), 0));
  const { max, ticks } = scale(Math.max(0, ...totals), step0);
  const n = Math.max(points.length, 1);
  const slot = W / n;
  const barW = Math.max(2, Math.min(24, slot * 0.64));
  const every = labelEvery(n);
  const y = (v: number) => H - (v / max) * H;

  return (
    <figure className="min-w-0">
      {series.length > 1 ? (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-hidden="true">
          {series.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <Swatch color={s.color} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="sr-only">{summary}</p>
      <div className="flex gap-2" aria-hidden="true">
        <div
          className="tabular relative w-9 shrink-0 text-right text-[11px] text-ink-3"
          style={{ height: H }}
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 leading-none"
              style={{ top: `${String((1 - t / max) * 100)}%` }}
            >
              {tick(t)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${String(W)} ${String(H)}`}
            preserveAspectRatio="none"
            width="100%"
            height={H}
            className="block overflow-visible"
          >
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                x2={W}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {points.map((p, i) => {
              const x = i * slot + (slot - barW) / 2;
              let top = H;
              const parts = series
                .map((s) => ({ s, v: value(p, s.key) }))
                .filter((part) => part.v > 0);
              const label = `${bucketLabel(p.date, unit, true)}: ${format(totals[i] ?? 0)}${
                parts.length > 1
                  ? ` (${parts.map((part) => `${part.s.label} ${format(part.v)}`).join(', ')})`
                  : ''
              }`;
              return (
                <g key={p.date} className="viz-col">
                  <title>{label}</title>
                  <rect
                    className="viz-hit"
                    x={i * slot}
                    y={0}
                    width={slot}
                    height={H}
                    fill="transparent"
                  />
                  {parts.map((part, j) => {
                    const h = (part.v / max) * H;
                    const gap = j > 0 ? GAP : 0;
                    const segH = Math.max(h - gap, 1);
                    top -= h;
                    return (
                      <path
                        key={part.s.key}
                        d={columnPath(x, top, barW, segH, j === parts.length - 1)}
                        fill={part.s.color}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          <div
            className="tabular mt-1.5 grid text-[11px] leading-none text-ink-3"
            style={{ gridTemplateColumns: `repeat(${String(n)}, minmax(0, 1fr))` }}
          >
            {/* Flex alignment lets a label wider than its column overflow on both sides (centred),
                and keeps the first and last labels inside the plot on narrow screens. */}
            {points.map((p, i) => (
              <span
                key={p.date}
                className={`flex min-w-0 whitespace-nowrap ${
                  i === n - 1 && n > 1
                    ? 'justify-end'
                    : i === 0 && n > 1
                      ? 'justify-start'
                      : 'justify-center'
                }`}
              >
                {(n - 1 - i) % every === 0 ? bucketLabel(p.date, unit) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ink-3 hover:text-ink">Show data table</summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-rule text-ink-3">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {unit === 'hour' ? 'Hour' : 'Day'}
                </th>
                {series.length > 1
                  ? series.map((s) => (
                      <th key={s.key} scope="col" className="py-1.5 pr-3 text-right font-medium">
                        {s.label}
                      </th>
                    ))
                  : null}
                <th scope="col" className="py-1.5 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.date} className="border-b border-rule last:border-0">
                  <th scope="row" className="py-1 pr-3 font-normal text-ink-2">
                    {bucketLabel(p.date, unit, true)}
                  </th>
                  {series.length > 1
                    ? series.map((s) => (
                        <td key={s.key} className="py-1 pr-3 text-right font-mono text-ink-2">
                          {format(value(p, s.key))}
                        </td>
                      ))
                    : null}
                  <td className="py-1 text-right font-mono text-ink">{format(totals[i] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// Horizontal bars ---------------------------------------------------------------------------------

export function BarList({
  rows,
  color,
  label,
}: {
  rows: readonly { key: string; label: ReactNode; value: number; text: string; detail?: string }[];
  color: string;
  label: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="space-y-3">
      {rows.map((r) => {
        const w = Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0);
        return (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-ink">{r.label}</span>
              <span className="tabular shrink-0 font-mono text-ink">{r.text}</span>
            </div>
            <div className="mt-1 flex items-center gap-3">
              <svg
                viewBox="0 0 100 8"
                preserveAspectRatio="none"
                width="100%"
                height="8"
                aria-hidden="true"
                className="block min-w-0 flex-1"
              >
                <rect x="0" y="0" width={w} height="8" rx="1.2" fill={color} />
              </svg>
              {r.detail ? (
                <span className="tabular w-24 shrink-0 text-right text-xs text-ink-3">
                  {r.detail}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Budget meters -----------------------------------------------------------------------------------

function BudgetMeter({
  approved,
  pending,
  budget,
}: {
  approved: number;
  pending: number;
  budget: number;
}) {
  const part = (v: number) => (budget > 0 ? Math.min(100, (v / budget) * 100) : 0);
  const a = part(approved);
  const p = Math.min(100 - a, part(pending));
  return (
    <svg
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      width="100%"
      height="10"
      aria-hidden="true"
      className="block"
    >
      <rect x="0" y="0" width="100" height="10" rx="1.5" fill="var(--sunken)" />
      {a > 0 ? (
        <rect x="0" y="0" width={a} height="10" rx="1.5" fill="var(--viz-approved)" />
      ) : null}
      {p > 0 ? (
        <rect
          x={a + (a > 0 ? 0.6 : 0)}
          y="0"
          width={Math.max(p - (a > 0 ? 0.6 : 0), 0.5)}
          height="10"
          rx="1.5"
          fill="var(--viz-review)"
        />
      ) : null}
    </svg>
  );
}

// The value report --------------------------------------------------------------------------------

/** "What Flow-E did for you": what it decided, stopped and avoided in the period. */
export function ValueReportPanel({
  report,
  periodText,
  fmt,
  agents,
  reportHref,
}: {
  report: ValueReport;
  periodText: string;
  fmt: (minor: number) => string;
  agents: readonly DashboardAgentRef[];
  /** The printable report page, with its methods and budget forecasts. */
  reportHref?: string;
}) {
  const stopped = report.stopped;
  const near = report.agents.filter((a) => a.oftenNearDaily);
  return (
    <Panel
      title="What Flow-E did for you"
      description={valueSummary(report, periodText, fmt)}
      action={
        reportHref ? (
          <Link href={reportHref} className="text-sm text-accent underline">
            Full report
          </Link>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Overpayment avoided</dt>
          <dd className="break-words text-2xl font-semibold text-approve">
            {fmt(report.overpaymentAvoided.over)}
          </dd>
          <dd className="text-xs text-ink-2">
            {report.overpaymentAvoided.count > 0
              ? `${String(report.overpaymentAvoided.count)} overpriced ${report.overpaymentAvoided.count === 1 ? 'request' : 'requests'} not paid`
              : 'Above the usual price, not paid'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Risky purchases stopped</dt>
          <dd className="text-2xl font-semibold text-ink">{stopped.count}</dd>
          <dd className="text-xs text-ink-2">
            {stopped.count > 0 ? declinedText(stopped, fmt, true) : 'None needed'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Decided automatically</dt>
          <dd className="text-2xl font-semibold text-ink">
            {report.autoDecided}
            <span className="text-base font-normal text-ink-3"> of {report.requests}</span>
          </dd>
          <dd className="text-xs text-ink-2">{report.sentToHuman} sent to a person</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Approval work saved</dt>
          <dd className="break-words text-2xl font-semibold text-ink">
            {workSaved(report.minutesSaved)}
          </dd>
          <dd className="text-xs text-ink-2">
            Estimate: ≈ {report.minutesPerApproval} min per manual approval
          </dd>
        </div>
      </dl>

      {stopped.byCategory.length > 0 ? (
        <div className="mt-5 border-t border-rule pt-4">
          <h3 className="text-sm font-medium text-ink">What was stopped</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Stopped purchases by reason">
            {stopped.byCategory.map((c) => (
              <li key={c.category}>
                <Pill tone="declined">
                  {c.label} <span className="tabular">· {c.count}</span>
                </Pill>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.agents.length > 0 ? (
        <div className="mt-5 border-t border-rule pt-4">
          <h3 className="text-sm font-medium text-ink">Budget outlook</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Approved spend {periodText}, averaged over {report.workingDays} working{' '}
            {report.workingDays === 1 ? 'day' : 'days'} (Monday to Friday).
          </p>
          <ul className="mt-2 divide-y divide-rule">
            {report.agents.map((a) => (
              <li
                key={a.agentId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 text-ink">
                  <Swatch color={agentColor(agents, a.agentId)} shape="dot" />
                  <span className="truncate">{a.name}</span>
                </span>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="tabular font-mono text-ink-2">
                    {fmt(a.perWorkingDay)} / day
                    {a.dailyBudget > 0 ? (
                      <span className="text-ink-3"> of {fmt(a.dailyBudget)}</span>
                    ) : null}
                  </span>
                  {a.oftenNearDaily ? <Pill tone="review">Often near its daily budget</Pill> : null}
                </span>
              </li>
            ))}
          </ul>
          {near.length > 0 ? (
            <p className="mt-2 text-xs text-ink-3">
              Above {Math.round(NEAR_BUDGET_SHARE * 100)}% of the daily budget on an average working
              day. Requests past the budget are declined, so check the limit fits.
            </p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

// The page body -----------------------------------------------------------------------------------

function Tile({
  label,
  value,
  detail,
  children,
  className = '',
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border border-rule bg-surface px-4 py-4 sm:px-5 ${className}`}
    >
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="mt-1 break-words text-2xl font-semibold tracking-tight text-ink">{value}</dd>
      {detail ? <dd className="mt-1 text-sm text-ink-2">{detail}</dd> : null}
      {children}
    </div>
  );
}

function activityTone(a: Activity) {
  if (a.status === 'cancelled') return 'cancelled' as const;
  return toneOf(a.status);
}

const KIND_LABEL: Record<Activity['kind'], string> = {
  decision: 'Flow-E decided',
  resolved: 'Human decision',
  cancelled: 'Cancelled in cooling-off',
  kill_switch: 'Kill switch',
  freeze: 'Freeze',
};

export function DashboardBody({
  dash,
  agents,
  money: m,
  timezone,
  paymentHref,
  empty,
  afterKpis,
  reportHref,
}: {
  dash: Dashboard;
  agents: readonly DashboardAgentRef[];
  money: Money;
  timezone: string;
  paymentHref: (id: string) => string;
  /** What to offer when the period has no payments yet. */
  empty: ReactNode;
  /** Controls shown right below the key figures (approvals, cooling-off). */
  afterKpis?: ReactNode;
  reportHref?: string;
}) {
  const fmt = (minor: number) => money(minor, m.currency, m.decimals);
  const tick = (minor: number) => compact(minor, m);
  const groups = spendGroups(agents, dash.agentId);
  const spendSeries: Series[] = groups.map((g) => ({
    key: g.key,
    label: g.label,
    color: slotColor(g.slot),
  }));
  const groupOf = new Map(groups.map((g) => [g.key, g.agentIds]));
  const decisionSeries: Series[] = [
    { key: 'approved', label: 'Approved', color: 'var(--viz-approved)' },
    { key: 'review', label: 'Sent to a human', color: 'var(--viz-review)' },
    { key: 'declined', label: 'Declined', color: 'var(--viz-declined)' },
  ];
  const periodText =
    dash.period === 'today' ? 'today' : `the last ${PERIOD_LABELS[dash.period].toLowerCase()}`;
  const used = dash.todayBudget.approved + dash.todayBudget.pending;
  const busiest = dash.days.reduce<DayPoint | null>(
    (best, p) => (best === null || p.total > best.total ? p : best),
    null,
  );
  const decisions = dash.days.reduce(
    (s, p) => ({
      approved: s.approved + p.approved,
      review: s.review + p.review,
      declined: s.declined + p.declined,
    }),
    { approved: 0, review: 0, declined: 0 },
  );

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <div className="col-span-2 min-w-0 rounded-xl border border-rule bg-surface px-4 py-4 sm:px-5">
          <dt className="text-sm text-ink-3">Approved spend, {periodText}</dt>
          <dd className="mt-1 break-words text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            {fmt(dash.approved.amount)}
          </dd>
          <dd className="mt-1 text-sm text-ink-2">
            {dash.approved.count} {dash.approved.count === 1 ? 'payment' : 'payments'} ·{' '}
            {dash.requests} {dash.requests === 1 ? 'request' : 'requests'} in total
          </dd>
        </div>
        <Tile
          label="Today against budget"
          value={fmt(dash.todayBudget.approved)}
          detail={
            <>
              of {fmt(dash.todayBudget.budget)}
              {dash.todayBudget.pending > 0 ? ` · ${fmt(dash.todayBudget.pending)} waiting` : ''}
            </>
          }
          className="col-span-2 lg:col-span-1"
        >
          <dd className="mt-3">
            <BudgetMeter
              approved={dash.todayBudget.approved}
              pending={dash.todayBudget.pending}
              budget={dash.todayBudget.budget}
            />
            <span className="sr-only">
              {dash.todayBudget.budget > 0
                ? `${String(Math.round((used / dash.todayBudget.budget) * 100))}% of today's combined budget is used or waiting.`
                : ''}
            </span>
          </dd>
        </Tile>
        <Tile
          label="Active agents"
          value={`${String(dash.activeAgents)} of ${String(dash.totalAgents)}`}
          detail={`made requests ${periodText}`}
          className="col-span-2 lg:col-span-1"
        />
        <Tile
          label="Waiting for approval"
          value={dash.pending.count}
          detail={dash.pending.count > 0 ? fmt(dash.pending.amount) : 'Nothing waits for you'}
        />
        <Tile
          label="Approved without a human"
          value={percent(dash.autoApprovedShare)}
          detail={`${String(dash.autoApproved)} of ${String(dash.requests)} requests`}
        />
        <Tile
          label="Declined by Flow-E"
          value={dash.declined.count}
          detail={dash.declined.count > 0 ? declinedText(dash.declined, fmt) : 'None'}
        />
        <Tile
          label="Cancelled in cooling-off"
          value={dash.cancelled.count}
          detail={dash.cancelled.count > 0 ? fmt(dash.cancelled.amount) : 'None'}
        />
      </dl>

      {dash.requests > 0 ? (
        <ValueReportPanel
          report={buildValueReport(dash)}
          periodText={periodText}
          fmt={fmt}
          agents={agents}
          reportHref={reportHref}
        />
      ) : null}

      {dash.requests === 0 ? (
        <>
          <Panel>
            <div className="py-6 text-center">
              <p className="font-serif text-xl text-ink">No payments yet in this period</p>
              <div className="mx-auto mt-2 max-w-lg text-sm text-ink-2">{empty}</div>
            </div>
          </Panel>
          {afterKpis}
        </>
      ) : (
        <>
          {afterKpis}
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel
              title="Approved spend"
              description={dash.unit === 'hour' ? 'Per hour today, by agent' : 'Per day, by agent'}
            >
              <StackedColumns
                title="Approved spend"
                points={dash.days}
                series={spendSeries}
                value={(p, key) =>
                  (groupOf.get(key) ?? []).reduce((s, id) => s + (p.byAgent[id] ?? 0), 0)
                }
                unit={dash.unit}
                format={fmt}
                tick={tick}
                step0={10 ** decimalsOf(m.currency, m.decimals)}
                summary={`Approved spend ${periodText}: ${fmt(dash.approved.amount)}.${
                  busiest && busiest.total > 0
                    ? ` Highest: ${bucketLabel(busiest.date, dash.unit, true)} with ${fmt(busiest.total)}.`
                    : ''
                }`}
              />
            </Panel>
            <Panel title="Decisions" description="What Flow-E said when each request came in">
              <StackedColumns
                title="Decisions"
                points={dash.days}
                series={decisionSeries}
                value={(p, key) =>
                  key === 'approved' ? p.approved : key === 'review' ? p.review : p.declined
                }
                unit={dash.unit}
                format={(v) => String(v)}
                tick={(v) => String(v)}
                summary={`${String(decisions.approved)} approved, ${String(decisions.review)} sent to a human, ${String(decisions.declined)} declined ${periodText}.`}
              />
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Top suppliers" description="By approved spend">
              {dash.topSuppliers.length === 0 ? (
                <p className="text-sm text-ink-2">No approved payments in this period.</p>
              ) : (
                <BarList
                  label="Top suppliers by approved spend"
                  color="var(--viz-1)"
                  rows={dash.topSuppliers.map((s) => ({
                    key: s.merchant,
                    label: s.merchant,
                    value: s.amount,
                    text: fmt(s.amount),
                    detail: `${String(s.count)} ${s.count === 1 ? 'payment' : 'payments'}`,
                  }))}
                />
              )}
            </Panel>
            <Panel title="Why Flow-E said no" description="Declines by rule">
              {dash.declinesByRule.length === 0 ? (
                <p className="text-sm text-ink-2">No declines in this period.</p>
              ) : (
                <BarList
                  label="Declines by rule"
                  color="var(--viz-declined)"
                  rows={dash.declinesByRule.map((r) => ({
                    key: r.label,
                    label: r.label,
                    value: r.count,
                    text: `${String(r.count)}×`,
                    detail: declinedText(r, fmt, true),
                  }))}
                />
              )}
            </Panel>
          </div>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Budget today" description="Approved, and waiting for approval, per agent">
          {dash.budgetToday.length === 0 ? (
            <p className="text-sm text-ink-2">No agents yet.</p>
          ) : null}
          <ul className="space-y-4">
            {dash.budgetToday.map((b) => (
              <li key={b.agentId}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-ink">
                    <Swatch color={agentColor(agents, b.agentId)} shape="dot" />
                    <span className="truncate">{b.name}</span>
                  </span>
                  <span className="tabular font-mono text-ink-2">
                    {fmt(b.approved + b.pending)} / {fmt(b.budget)}
                  </span>
                </div>
                <div className="mt-1.5">
                  <BudgetMeter approved={b.approved} pending={b.pending} budget={b.budget} />
                </div>
                {b.pending > 0 ? (
                  <p className="mt-1 text-xs text-ink-3">{fmt(b.pending)} waiting for approval</p>
                ) : null}
              </li>
            ))}
          </ul>
          <ul
            className={`mt-4 flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2 ${dash.budgetToday.length === 0 ? 'hidden' : 'flex'}`}
            aria-hidden="true"
          >
            <li className="inline-flex items-center gap-1.5">
              <Swatch color="var(--viz-approved)" />
              Approved
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Swatch color="var(--viz-review)" />
              Waiting for approval
            </li>
          </ul>
        </Panel>
        <Panel title="Human approvals" description={`Reviews decided ${periodText}`}>
          <dl className="grid grid-cols-3 gap-3 text-center">
            <div>
              <dt className="text-xs text-ink-3">Decided</dt>
              <dd className="text-2xl font-semibold text-ink">{dash.approvals.decided}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Approved / declined</dt>
              <dd className="text-2xl font-semibold text-ink">
                {dash.approvals.approved} / {dash.approvals.declined}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Median wait</dt>
              <dd className="text-2xl font-semibold text-ink">
                {duration(dash.approvals.medianMs)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink-2">
            The time from an agent&rsquo;s request to a person&rsquo;s approve or decline.
          </p>
        </Panel>
      </div>

      <Panel
        title="Fair price"
        description={`Requests compared with the usual price of the item, ${periodText}`}
      >
        {dash.priceCheck.checked === 0 ? (
          <p className="text-sm text-ink-2">
            No request matched a usual price {periodText}. Add usual prices for the items your
            agents buy on the Mandate page, and Flow-E flags offers far above or below them.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-ink-3">Checked</dt>
              <dd className="text-2xl font-semibold text-ink">{dash.priceCheck.checked}</dd>
              <dd className="text-xs text-ink-2">matched a usual price</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Above the usual price</dt>
              <dd className="text-2xl font-semibold text-ink">{dash.priceCheck.above.count}</dd>
              <dd className="text-xs text-ink-2">
                {dash.priceCheck.above.count > 0
                  ? `${fmt(dash.priceCheck.above.over)} more than usual`
                  : 'None'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Overpayment avoided</dt>
              <dd className="text-2xl font-semibold text-approve">
                {fmt(dash.priceCheck.avoided.over)}
              </dd>
              <dd className="text-xs text-ink-2">
                {dash.priceCheck.avoided.count}{' '}
                {dash.priceCheck.avoided.count === 1 ? 'request' : 'requests'} not paid
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Suspiciously cheap</dt>
              <dd className="text-2xl font-semibold text-ink">{dash.priceCheck.below}</dd>
              <dd className="text-xs text-ink-2">checked by a person</dd>
            </div>
          </dl>
        )}
      </Panel>

      <Panel title="Recent activity" description="The latest decisions and human actions">
        {dash.recent.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing happened in this period.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {dash.recent.map((a) => {
              const row = (
                <>
                  <span className="tabular hidden font-mono text-xs text-ink-3 sm:block">
                    {dateTime(a.at, timezone)}
                  </span>
                  <span className="min-w-0 text-sm text-ink">
                    <span className="block truncate">{a.title}</span>
                    <span className="block truncate text-xs text-ink-3">
                      {KIND_LABEL[a.kind]}
                      {a.kind === 'decision' ? ` · ${a.agentId}` : a.by ? ` · ${a.by}` : ''}
                      <span className="sm:hidden"> · {dateTime(a.at, timezone)}</span>
                    </span>
                  </span>
                  <span className="tabular hidden font-mono text-sm text-ink-2 sm:block">
                    {a.amount !== null && a.currency !== null ? money(a.amount, a.currency) : ''}
                  </span>
                  <Pill tone={activityTone(a)}>{a.status}</Pill>
                </>
              );
              const cls =
                'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 py-2.5 sm:grid-cols-[9.5rem_1fr_auto_auto]';
              return (
                <li key={a.id}>
                  {a.paymentId ? (
                    <Link href={paymentHref(a.paymentId)} className={`${cls} hover:bg-sunken`}>
                      {row}
                    </Link>
                  ) : (
                    <div className={cls}>{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
