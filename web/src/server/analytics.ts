import {
  AGENT_FREEZE,
  KILL_SWITCH,
  PAYMENT_CANCELLED,
  PAYMENT_DECISION,
  PAYMENT_RESOLVED,
  dailySpend,
  foldPayments,
  localTime,
  toEngineViews,
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
  VELOCITY: 'Too many requests',
  SPLIT_DETECTION: 'Split payment',
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
}

export interface Amount {
  count: number;
  amount: number;
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
  declined: Amount;
  cancelled: Amount;
  /** Everything waiting for a human now, whatever the period. */
  pending: Amount;
  /** Agents that asked for at least one payment in the period. */
  activeAgents: number;
  totalAgents: number;
  todayBudget: { approved: number; pending: number; budget: number };
  days: DayPoint[];
  topSuppliers: (Amount & { merchant: string })[];
  declinesByRule: (Amount & { label: string; rules: string[] })[];
  budgetToday: {
    agentId: string;
    name: string;
    budget: number;
    approved: number;
    pending: number;
  }[];
  approvals: { decided: number; approved: number; declined: number; medianMs: number | null };
  recent: Activity[];
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
  // A request stopped before the amount rule (kill switch, credential) has no amount_base; in
  // the base currency the requested amount is exact, otherwise it is left out of sums.
  const base = (p: PaymentRecord) =>
    p.amountBase ?? (p.request.currency === p.baseCurrency ? p.request.amount : 0);
  const sum = (list: readonly PaymentRecord[]): Amount => ({
    count: list.length,
    amount: list.reduce((s, p) => s + base(p), 0),
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
  const rules = new Map<string, Amount & { label: string; rules: string[] }>();
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
      const r = rules.get(label) ?? { label, rules: [], count: 0, amount: 0 };
      r.count += 1;
      r.amount += base(p);
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
    declined: sum(payments.filter((p) => p.engineDecision === 'declined')),
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
