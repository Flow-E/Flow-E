import {
  AGENT_FREEZE,
  KILL_SWITCH,
  PAYMENT_CANCELLED,
  PAYMENT_DECISION,
  PAYMENT_RESOLVED,
  dailySpend,
  foldPayments,
  localTime,
  toBaseMinor,
  toEngineViews,
  type GlobalPolicy,
  type PaymentRecord,
  type StoredEntry,
} from '@flow-e/mcp/core';

/**
 * The dashboard's numbers, computed from the ledger alone. Pure: the caller passes the entries
 * (in sequence order), the agents, the time zone and `now`. Money stays in integer minor units of
 * the base currency; days are calendar days in the organisation's time zone.
 */

export const PERIODS = ['today', '7d', '30d', '90d'] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = '30d';

const PERIOD_DAYS: Readonly<Record<Period, number>> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

export const PERIOD_LABELS: Readonly<Record<Period, string>> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

export function parsePeriod(value: unknown): Period {
  return PERIODS.find((p) => p === value) ?? DEFAULT_PERIOD;
}

/** The agent filter from a search param: only ids that exist count. */
export function parseAgent(value: unknown, agents: readonly { id: string }[]): string | null {
  return typeof value === 'string' && agents.some((a) => a.id === value) ? value : null;
}

/** Why the engine said no, in words a manager uses. Unknown rule ids fall back to the id. */
export const DECLINE_LABELS: Readonly<Record<string, string>> = {
  KILL_SWITCH: 'Kill switch or frozen agent',
  AGENT_STATUS: 'Kill switch or frozen agent',
  KYA_CREDENTIAL: 'Agent credential',
  AMOUNT: 'Invalid amount',
  CURRENCY: 'Currency not allowed',
  COUNTRY: 'Blocked country',
  SUPPLIER: 'Blocked supplier',
  CATEGORY: 'Category not allowed',
  PER_PAYMENT_LIMIT: 'Per-payment limit',
  DAILY_BUDGET: 'Daily budget',
  MONTHLY_BUDGET: 'Monthly budget',
  PROJECT_BUDGET: 'Project budget',
  VELOCITY: 'Too many requests',
  SPLIT_DETECTION: 'Split payment',
  FAIR_PRICE: 'Far above the usual price',
  BUSINESS_HOURS: 'Outside business hours',
  INTERNAL: 'Internal error',
};

export function declineLabel(rule: string | null): string {
  return rule === null ? 'Other' : (DECLINE_LABELS[rule] ?? rule);
}

export interface DashboardAgent {
  id: string;
  name: string;
  dailyBudget: number;
}

export interface DashboardInput {
  entries: readonly StoredEntry[];
  agents: readonly DashboardAgent[];
  timezone: string;
  now: number;
  period: Period;
  agentId: string | null;
  /**
   * The mandate's policy, for its fx table: a request declined before the currency rule has no
   * base amount, and is converted here at the mandate's rate (rounded up, like the engine). The
   * ledger keeps no rate history, so this is the current rate. Without it, or without a rate,
   * such a request is counted but not summed (see `Declined.unconverted`).
   */
  policy?: GlobalPolicy;
}

export interface Amount {
  count: number;
  amount: number;
}

/** Declines: `amount` sums what has a base-currency amount; `unconverted` counts the rest. */
export interface Declined extends Amount {
  /** Declines in a foreign currency with no rate to convert them: counted, not in `amount`. */
  unconverted: number;
}

export interface DayPoint {
  /** The local day ("2026-10-26"), or the local hour ("09") when the period is today. */
  date: string;
  /** Approved spend per agent id. */
  byAgent: Record<string, number>;
  total: number;
  approved: number;
  review: number;
  declined: number;
}

export interface Activity {
  id: string;
  at: string;
  kind: 'decision' | 'resolved' | 'cancelled' | 'kill_switch' | 'freeze';
  agentId: string;
  paymentId: string | null;
  /** What happened, for the list: the supplier, or the control. */
  title: string;
  status: string;
  amount: number | null;
  currency: string | null;
  by: string;
}

export interface Dashboard {
  period: Period;
  agentId: string | null;
  /** First and last local calendar day of the period, inclusive. */
  from: string;
  to: string;
  today: string;
  /** Chart buckets are days, or hours of today. */
  unit: 'day' | 'hour';
  requests: number;
  approved: Amount;
  /** Requests the engine approved without a human, as a share of all requests (0..1). */
  autoApprovedShare: number | null;
  autoApproved: number;
  /** The engine's declines in the period. */
  declined: Declined;
  cancelled: Amount;
  /** Everything waiting for a human now, whatever the period. */
  pending: Amount;
  /** Agents that asked for at least one payment in the period. */
  activeAgents: number;
  totalAgents: number;
  todayBudget: { approved: number; pending: number; budget: number };
  days: DayPoint[];
  topSuppliers: (Amount & { merchant: string })[];
  declinesByRule: (Declined & { label: string; rules: string[] })[];
  budgetToday: {
    agentId: string;
    name: string;
    budget: number;
    approved: number;
    pending: number;
  }[];
  approvals: { decided: number; approved: number; declined: number; medianMs: number | null };
  priceCheck: PriceCheckStats;
  recent: Activity[];
}

/** What the fair-price rule found for requests in the period. Amounts in base minor units. */
export interface PriceCheckStats {
  /** Requests whose item matched a usual price. */
  checked: number;
  /** Flagged as above the usual price; `over` is how much more than usual they asked for. */
  above: { count: number; over: number };
  /** Flagged as suspiciously cheap. */
  below: number;
  /** The extra asked for by flagged requests that were not paid (declined or cancelled). */
  avoided: { count: number; over: number };
}

interface FairPriceStep {
  rule?: unknown;
  outcome?: unknown;
  data?: { matched?: unknown; differenceBase?: unknown };
}

/** The fair-price finding recorded in a decision entry's trace, if the item had a usual price. */
function fairPriceFinding(e: StoredEntry): { flagged: boolean; difference: number } | null {
  const data = JSON.parse(e.data) as { trace?: unknown };
  if (!Array.isArray(data.trace)) return null;
  const step = (data.trace as FairPriceStep[]).find((t) => t.rule === 'FAIR_PRICE');
  if (step?.data?.matched !== true || typeof step.data.differenceBase !== 'number') return null;
  return {
    flagged: step.outcome === 'review' || step.outcome === 'decline',
    difference: step.data.differenceBase,
  };
}

// Calendar days --------------------------------------------------------------------------------

/** "2026-10-26" plus n days, on the calendar (no time zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)).toISOString().slice(0, 10);
}

export function localDate(iso: string | number, timezone: string): string {
  return localTime(typeof iso === 'number' ? iso : Date.parse(iso), timezone).date;
}

export function periodDays(period: Period, now: number, timezone: string): string[] {
  const today = localDate(now, timezone);
  const n = PERIOD_DAYS[period];
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

/** Middle value of a list of numbers; the mean of the two middle ones for an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : Math.round(((s[mid - 1] ?? 0) + hi) / 2);
}

// Parsing entry data ---------------------------------------------------------------------------

interface HumanData {
  payment_id?: unknown;
  status?: unknown;
  by?: unknown;
  on?: unknown;
  frozen?: unknown;
}

function human(e: StoredEntry): HumanData {
  return JSON.parse(e.data) as HumanData;
}

function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// Base-currency amounts --------------------------------------------------------------------------

/**
 * A payment's amount in base-currency minor units, or null when it cannot be known honestly.
 * The engine records `amount_base` once the currency rule ran. A request stopped before that
 * (kill switch, credential, currency not allowed, no rate) has none: in the base currency the
 * requested amount is exact; otherwise it is converted through the mandate's fx table, rounded
 * up like the engine does, and stays null when there is no rate.
 */
export function baseAmount(policy: DashboardInput['policy']): (p: PaymentRecord) => number | null {
  return (p) => {
    if (p.amountBase !== null) return p.amountBase;
    const currency = p.request.currency.trim().toUpperCase();
    if (currency === p.baseCurrency) return p.request.amount;
    if (!policy || policy.baseCurrency !== p.baseCurrency || !Object.hasOwn(policy.fx, currency)) {
      return null;
    }
    try {
      return toBaseMinor(p.request.amount, currency, policy);
    } catch {
      return null;
    }
  };
}

// Agent colours -----------------------------------------------------------------------------------

/** Validated categorical colours; agents beyond these are grouped as "Other agents". */
export const AGENT_SLOTS = 8;
/** Series key of the grouped agents. Agent ids start with [a-z0-9], so it cannot clash. */
export const OTHER_AGENTS = '_other';

export interface SpendGroup {
  key: string;
  label: string;
  /** Index into the colour slots, or null for the grouped "Other agents". */
  slot: number | null;
  agentIds: string[];
}

/**
 * The per-agent spend series. Each of the first AGENT_SLOTS agents (by place in the full list,
 * so a colour follows its agent) gets its own series; any further agents share one series,
 * "Other agents", so no two agents ever look the same. A filter to one agent shows just it.
 */
export function spendGroups(
  agents: readonly { id: string; name: string }[],
  agentId: string | null,
): SpendGroup[] {
  const own = (a: { id: string; name: string }, i: number): SpendGroup => ({
    key: a.id,
    label: a.name,
    slot: i < AGENT_SLOTS ? i : null,
    agentIds: [a.id],
  });
  if (agentId !== null) {
    const i = agents.findIndex((a) => a.id === agentId);
    const a = agents[i];
    return a ? [own(a, i)] : [];
  }
  const groups = agents.slice(0, AGENT_SLOTS).map(own);
  const rest = agents.slice(AGENT_SLOTS);
  // One extra agent keeps its own (grey) series: no other series is grey, so it stays distinct.
  if (rest.length === 1 && rest[0]) groups.push(own(rest[0], AGENT_SLOTS));
  else if (rest.length > 1) {
    groups.push({
      key: OTHER_AGENTS,
      label: `Other agents (${String(rest.length)})`,
      slot: null,
      agentIds: rest.map((a) => a.id),
    });
  }
  return groups;
}

/** Items of one agent when the dashboard is filtered to it; all items otherwise. */
export function forAgent<T extends { agentId: string }>(
  items: readonly T[],
  agentId: string | null,
): T[] {
  return agentId === null ? [...items] : items.filter((p) => p.agentId === agentId);
}

// The computation ------------------------------------------------------------------------------

export function buildDashboard(input: DashboardInput): Dashboard {
  const { entries, timezone, now, period, agentId } = input;
  const agents = agentId === null ? input.agents : input.agents.filter((a) => a.id === agentId);
  const keep = (a: string) => agentId === null || a === agentId;
  const days = periodDays(period, now, timezone);
  const from = days[0] ?? '';
  const to = days.at(-1) ?? '';
  const inPeriod = (iso: string) => {
    const d = localDate(iso, timezone);
    return d >= from && d <= to;
  };

  const all = foldPayments(entries).filter((p) => keep(p.agentId));
  const byId = new Map(all.map((p) => [p.paymentId, p]));
  const payments = all.filter((p) => inPeriod(p.createdAt));
  const toBase = baseAmount(input.policy);
  const base = (p: PaymentRecord) => toBase(p) ?? 0;
  const sum = (list: readonly PaymentRecord[]): Amount => ({
    count: list.length,
    amount: list.reduce((s, p) => s + base(p), 0),
  });
  const sumDeclined = (list: readonly PaymentRecord[]): Declined => ({
    ...sum(list),
    unconverted: list.filter((p) => toBase(p) === null).length,
  });

  const unit = period === 'today' ? 'hour' : 'day';
  const bucket = (iso: string) => {
    const t = localTime(Date.parse(iso), timezone);
    return unit === 'hour' ? String(Math.floor(t.minutes / 60)).padStart(2, '0') : t.date;
  };
  const keys =
    unit === 'hour' ? Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')) : days;
  const points = new Map<string, DayPoint>(
    keys.map((date) => [
      date,
      { date, byAgent: {}, total: 0, approved: 0, review: 0, declined: 0 },
    ]),
  );
  const suppliers = new Map<string, Amount & { merchant: string }>();
  const rules = new Map<string, Declined & { label: string; rules: string[] }>();
  for (const p of payments) {
    const point = points.get(bucket(p.createdAt));
    if (point) point[p.engineDecision] += 1;
    if (p.status === 'approved') {
      if (point) {
        point.byAgent[p.agentId] = (point.byAgent[p.agentId] ?? 0) + base(p);
        point.total += base(p);
      }
      const key = p.request.merchant.trim();
      const s = suppliers.get(key) ?? { merchant: key, count: 0, amount: 0 };
      s.count += 1;
      s.amount += base(p);
      suppliers.set(key, s);
    }
    if (p.engineDecision === 'declined') {
      const label = declineLabel(p.rule);
      const r = rules.get(label) ?? { label, rules: [], count: 0, amount: 0, unconverted: 0 };
      r.count += 1;
      r.amount += base(p);
      if (toBase(p) === null) r.unconverted += 1;
      if (p.rule !== null && !r.rules.includes(p.rule)) r.rules.push(p.rule);
      rules.set(label, r);
    }
  }

  // Human decisions on reviews: when they happened decides the period, not the request.
  const waits: number[] = [];
  let humanApproved = 0;
  let humanDeclined = 0;
  for (const e of entries) {
    if (e.type !== PAYMENT_RESOLVED || !keep(e.agent_id) || !inPeriod(e.created_at)) continue;
    const d = human(e);
    const p = byId.get(text(d.payment_id));
    if (!p) continue;
    if (d.status === 'approved') humanApproved += 1;
    else if (d.status === 'declined') humanDeclined += 1;
    waits.push(Date.parse(e.created_at) - Date.parse(p.createdAt));
  }

  const priceCheck: PriceCheckStats = {
    checked: 0,
    above: { count: 0, over: 0 },
    below: 0,
    avoided: { count: 0, over: 0 },
  };
  for (const e of entries) {
    if (e.type !== PAYMENT_DECISION || !keep(e.agent_id) || !inPeriod(e.created_at)) continue;
    const finding = fairPriceFinding(e);
    if (!finding) continue;
    priceCheck.checked += 1;
    if (!finding.flagged) continue;
    if (finding.difference < 0) {
      priceCheck.below += 1;
      continue;
    }
    priceCheck.above.count += 1;
    priceCheck.above.over += finding.difference;
    const p = byId.get(text((JSON.parse(e.data) as { payment_id?: unknown }).payment_id));
    if (p && (p.status === 'declined' || p.status === 'cancelled')) {
      priceCheck.avoided.count += 1;
      priceCheck.avoided.over += finding.difference;
    }
  }

  const today = localDate(now, timezone);
  const budgetToday = agents.map((a) => {
    const spend = dailySpend(
      toEngineViews(all.filter((p) => p.agentId === a.id)),
      now,
      timezone,
      a.dailyBudget,
    );
    return {
      agentId: a.id,
      name: a.name,
      budget: a.dailyBudget,
      approved: spend.approved,
      pending: spend.pending,
    };
  });

  const engineApproved = payments.filter((p) => p.engineDecision === 'approved').length;
  return {
    period,
    agentId,
    from,
    to,
    today,
    unit,
    requests: payments.length,
    approved: sum(payments.filter((p) => p.status === 'approved')),
    autoApproved: engineApproved,
    autoApprovedShare: payments.length === 0 ? null : engineApproved / payments.length,
    declined: sumDeclined(payments.filter((p) => p.engineDecision === 'declined')),
    cancelled: sum(payments.filter((p) => p.status === 'cancelled')),
    pending: sum(all.filter((p) => p.status === 'review')),
    activeAgents: new Set(payments.map((p) => p.agentId)).size,
    totalAgents: agents.length,
    todayBudget: {
      approved: budgetToday.reduce((s, a) => s + a.approved, 0),
      pending: budgetToday.reduce((s, a) => s + a.pending, 0),
      budget: budgetToday.reduce((s, a) => s + a.budget, 0),
    },
    days: [...points.values()],
    topSuppliers: [...suppliers.values()]
      .sort(
        (a, b) => b.amount - a.amount || b.count - a.count || a.merchant.localeCompare(b.merchant),
      )
      .slice(0, 6),
    declinesByRule: [...rules.values()].sort(
      (a, b) => b.count - a.count || b.amount - a.amount || a.label.localeCompare(b.label),
    ),
    budgetToday,
    approvals: {
      decided: humanApproved + humanDeclined,
      approved: humanApproved,
      declined: humanDeclined,
      medianMs: median(waits),
    },
    priceCheck,
    recent: recentActivity(entries, byId, keep, inPeriod, 10),
  };
}

function recentActivity(
  entries: readonly StoredEntry[],
  payments: ReadonlyMap<string, PaymentRecord>,
  keep: (agentId: string) => boolean,
  inPeriod: (iso: string) => boolean,
  limit: number,
): Activity[] {
  const out: Activity[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (!e || !inPeriod(e.created_at)) continue;
    const common = { id: e.id, at: e.created_at, agentId: e.agent_id };
    if (e.type === KILL_SWITCH) {
      const d = human(e);
      out.push({
        ...common,
        kind: 'kill_switch',
        paymentId: null,
        title: d.on === true ? 'Kill switch on' : 'Kill switch released',
        status: d.on === true ? 'stopped' : 'active',
        amount: null,
        currency: null,
        by: text(d.by),
      });
      continue;
    }
    if (!keep(e.agent_id)) continue;
    if (e.type === AGENT_FREEZE) {
      const d = human(e);
      out.push({
        ...common,
        kind: 'freeze',
        paymentId: null,
        title: d.frozen === true ? `${e.agent_id} frozen` : `${e.agent_id} unfrozen`,
        status: d.frozen === true ? 'frozen' : 'active',
        amount: null,
        currency: null,
        by: text(d.by),
      });
      continue;
    }
    if (
      e.type !== PAYMENT_DECISION &&
      e.type !== PAYMENT_RESOLVED &&
      e.type !== PAYMENT_CANCELLED
    ) {
      continue;
    }
    const d = human(e);
    const p = payments.get(text(d.payment_id));
    if (!p) continue;
    const kind =
      e.type === PAYMENT_DECISION
        ? 'decision'
        : e.type === PAYMENT_RESOLVED
          ? 'resolved'
          : 'cancelled';
    out.push({
      ...common,
      kind,
      paymentId: p.paymentId,
      title: p.request.merchant,
      status:
        kind === 'decision'
          ? p.engineDecision
          : kind === 'cancelled'
            ? 'cancelled'
            : text(d.status),
      amount: p.request.amount,
      currency: p.request.currency,
      by: kind === 'decision' ? 'Flow-E' : text(d.by),
    });
  }
  return out;
}

/**
 * The ledger entries behind one dashboard view, for the CSV export: every payment entry
 * (decision, approval, cancellation) of the payments requested in the period, plus the
 * period's kill switch and freeze entries. Sequence order is kept.
 */
export function periodEntries(
  input: Pick<DashboardInput, 'entries' | 'timezone' | 'now' | 'period' | 'agentId'>,
): StoredEntry[] {
  const { entries, timezone, now, period, agentId } = input;
  const days = periodDays(period, now, timezone);
  const from = days[0] ?? '';
  const to = days.at(-1) ?? '';
  const inPeriod = (iso: string) => {
    const d = localDate(iso, timezone);
    return d >= from && d <= to;
  };
  const keep = (a: string) => agentId === null || a === agentId;
  const ids = new Set(
    foldPayments(entries)
      .filter((p) => keep(p.agentId) && inPeriod(p.createdAt))
      .map((p) => p.paymentId),
  );
  return entries.filter((e) => {
    if (
      e.type === PAYMENT_DECISION ||
      e.type === PAYMENT_RESOLVED ||
      e.type === PAYMENT_CANCELLED
    ) {
      return ids.has(text(human(e).payment_id));
    }
    if (e.type === KILL_SWITCH) return inPeriod(e.created_at);
    if (e.type === AGENT_FREEZE) return keep(e.agent_id) && inPeriod(e.created_at);
    return false;
  });
}

// The value report ------------------------------------------------------------------------------

/**
 * Minutes a person would spend on one manual approval: reading the request, checking the
 * supplier and the price, deciding. An assumption, shown next to every figure built on it.
 */
export const MINUTES_PER_APPROVAL = 4;

/** Above this share of its daily budget, an agent's average day counts as near its budget. */
export const NEAR_BUDGET_SHARE = 0.8;

export const STOP_CATEGORIES = [
  'blocked',
  'limit',
  'split',
  'category',
  'stopped',
  'credential',
  'price',
  'other',
] as const;
export type StopCategory = (typeof STOP_CATEGORIES)[number];

export const STOP_LABELS: Readonly<Record<StopCategory, string>> = {
  blocked: 'Blocked supplier or country',
  limit: 'Over a limit or budget',
  split: 'Split into smaller payments',
  category: 'Wrong category',
  stopped: 'Kill switch or frozen agent',
  credential: 'Credential problem',
  price: 'Far above the usual price',
  other: 'Other reasons',
};

const STOP_BY_RULE: Readonly<Record<string, StopCategory>> = {
  SUPPLIER: 'blocked',
  COUNTRY: 'blocked',
  CURRENCY: 'blocked',
  PER_PAYMENT_LIMIT: 'limit',
  DAILY_BUDGET: 'limit',
  VELOCITY: 'limit',
  SPLIT_DETECTION: 'split',
  CATEGORY: 'category',
  KILL_SWITCH: 'stopped',
  AGENT_STATUS: 'stopped',
  KYA_CREDENTIAL: 'credential',
  FAIR_PRICE: 'price',
};

/**
 * The plain category of a decline rule. Budget rules the core adds later (monthly, project)
 * fall under "over a limit or budget" by name, so they need no change here.
 */
export function stopCategory(rule: string | null | undefined): StopCategory {
  if (!rule) return 'other';
  return STOP_BY_RULE[rule] ?? (/BUDGET|LIMIT/.test(rule) ? 'limit' : 'other');
}

/** One agent's spend pace in the period, against its daily budget. */
export interface AgentOutlook {
  agentId: string;
  name: string;
  /** Approved spend in the period, base minor units. */
  approved: number;
  /** Approved spend divided by the working days (Monday to Friday) in the period. */
  perWorkingDay: number;
  dailyBudget: number;
  /** perWorkingDay / dailyBudget, or null without a budget. */
  dailyShare: number | null;
  /** The average working day is above NEAR_BUDGET_SHARE of the daily budget. */
  oftenNearDaily: boolean;
  // Seam: a monthly (or project) forecast goes here once the core has those budgets, e.g.
  // `monthly: { budget, spentSoFar, projected } | null`, computed from the same period spend.
}

export interface ValueReport {
  requests: number;
  /** Requests the engine approved or declined on its own, without a person. */
  autoDecided: number;
  /** Requests sent to a person. */
  sentToHuman: number;
  minutesPerApproval: number;
  /** autoDecided × minutesPerApproval: an estimate, not a measurement. */
  minutesSaved: number;
  /** Engine declines, grouped into plain categories (largest first). */
  stopped: Declined & { byCategory: (Declined & { category: StopCategory; label: string })[] };
  overpaymentAvoided: { count: number; over: number };
  workingDays: number;
  agents: AgentOutlook[];
}

/** Monday to Friday between two calendar days, inclusive; at least 1. */
export function workingDays(from: string, to: string): number {
  let n = 0;
  for (let d = from; d !== '' && d <= to; d = addDays(d, 1)) {
    const day = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return Math.max(n, 1);
}

/**
 * "What Flow-E did for you", derived from a built dashboard (so it follows its period and
 * agent filter). Pure; no second ledger read.
 */
export function buildValueReport(dash: Dashboard): ValueReport {
  const sentToHuman = dash.days.reduce((s, p) => s + p.review, 0);
  const autoDecided = Math.max(dash.requests - sentToHuman, 0);

  const cats = new Map<StopCategory, Declined & { category: StopCategory; label: string }>();
  for (const r of dash.declinesByRule) {
    const category = stopCategory(r.rules[0]);
    const c = cats.get(category) ?? {
      category,
      label: STOP_LABELS[category],
      count: 0,
      amount: 0,
      unconverted: 0,
    };
    c.count += r.count;
    c.amount += r.amount;
    c.unconverted += r.unconverted;
    cats.set(category, c);
  }

  const days = workingDays(dash.from, dash.to);
  const agents = dash.budgetToday.map((b): AgentOutlook => {
    const approved = dash.days.reduce((s, p) => s + (p.byAgent[b.agentId] ?? 0), 0);
    const perWorkingDay = Math.round(approved / days);
    const dailyShare = b.budget > 0 ? perWorkingDay / b.budget : null;
    return {
      agentId: b.agentId,
      name: b.name,
      approved,
      perWorkingDay,
      dailyBudget: b.budget,
      dailyShare,
      oftenNearDaily: dailyShare !== null && dailyShare > NEAR_BUDGET_SHARE,
    };
  });

  return {
    requests: dash.requests,
    autoDecided,
    sentToHuman,
    minutesPerApproval: MINUTES_PER_APPROVAL,
    minutesSaved: autoDecided * MINUTES_PER_APPROVAL,
    stopped: {
      ...dash.declined,
      byCategory: [...cats.values()].sort(
        (a, b) =>
          b.count - a.count ||
          STOP_CATEGORIES.indexOf(a.category) - STOP_CATEGORIES.indexOf(b.category),
      ),
    },
    overpaymentAvoided: { ...dash.priceCheck.avoided },
    workingDays: days,
    agents,
  };
}

/** "≈ 45 min", "≈ 4.3 h", "≈ 26 h" for the approval work saved. */
export function workSaved(minutes: number): string {
  if (minutes < 60) return `≈ ${String(minutes)} min`;
  const hours = minutes / 60;
  return `≈ ${hours < 10 ? String(Number(hours.toFixed(1))) : String(Math.round(hours))} h`;
}

/**
 * The value report in one sentence: "In the last 30 days Flow-E decided 64 of 75 requests on
 * its own, stopped 9 risky purchases and avoided CHF 210.00 of overpayment." `periodText` is
 * "today" or "the last 30 days", as the dashboard writes it.
 */
export function valueSummary(
  report: ValueReport,
  periodText: string,
  fmt: (minor: number) => string,
): string {
  const when = periodText === 'today' ? 'Today' : `In ${periodText}`;
  if (report.requests === 0) return `${when} no agent asked Flow-E for a payment.`;
  const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  const parts = [
    `decided ${String(report.autoDecided)} of ${plural(report.requests, 'request', 'requests')} on its own`,
  ];
  if (report.stopped.count > 0) {
    parts.push(`stopped ${plural(report.stopped.count, 'risky purchase', 'risky purchases')}`);
  }
  if (report.overpaymentAvoided.over > 0) {
    parts.push(`avoided ${fmt(report.overpaymentAvoided.over)} of overpayment`);
  }
  const last = parts.pop() ?? '';
  const list = parts.length === 0 ? last : `${parts.join(', ')} and ${last}`;
  return `${when} Flow-E ${list}.`;
}
