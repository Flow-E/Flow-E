import {
  foldPayments,
  localTime,
  monthlySpend,
  projectSpend,
  toEngineViews,
  type MandateConfig,
  type StoredEntry,
} from '@flow-e/mcp/core';
import { addDays } from './analytics';

/**
 * Burn rate and projected run-out day for each monthly and project budget, from the ledger
 * alone. Pure. Spend is counted as the engine counts it: approved plus waiting for a person,
 * so the forecast matches the day requests would start to be declined.
 */

/** Project budgets over their whole life are paced on the last this-many days. */
export const TOTAL_PACE_DAYS = 30;

export interface BudgetOutlook {
  kind: 'month' | 'project';
  /** The agent's name for a monthly budget; the project's name for a project. */
  label: string;
  /** Base minor units. */
  budget: number;
  /** Approved plus waiting, in the budget's window. */
  used: number;
  remaining: number;
  /** Base minor units per calendar day. */
  perDay: number;
  /**
   * The local day the budget is projected to run out at this pace; null when it lasts its
   * window (the month, or the project's end date) or nothing has been spent yet.
   */
  runsOut: string | null;
  /** The last day of the window: the month's last day, a project's end date, or null (open). */
  windowEnds: string | null;
  /** How `perDay` and `runsOut` were computed, in plain words. */
  method: string;
}

function lastDayOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).toISOString().slice(0, 10);
}

function project(input: {
  used: number;
  budget: number;
  perDay: number;
  today: string;
  windowEnds: string | null;
}): { remaining: number; runsOut: string | null } {
  const remaining = Math.max(0, input.budget - input.used);
  if (input.used >= input.budget) return { remaining, runsOut: input.today };
  if (input.perDay <= 0) return { remaining, runsOut: null };
  // The day the last of the remaining budget is used: today plus the whole days it lasts.
  const runsOut = addDays(input.today, Math.floor(remaining / input.perDay));
  return {
    remaining,
    runsOut: input.windowEnds !== null && runsOut > input.windowEnds ? null : runsOut,
  };
}

export function budgetOutlook(input: {
  entries: readonly StoredEntry[];
  config: MandateConfig;
  now: number;
  /** Display names by agent id; the id otherwise. */
  names?: Readonly<Record<string, string>>;
}): BudgetOutlook[] {
  const { config, now } = input;
  const tz = config.policy.timezone;
  const today = localTime(now, tz).date;
  const dayOfMonth = Number(today.slice(8, 10));
  const monthEnds = lastDayOfMonth(today);
  const payments = foldPayments(input.entries);
  const out: BudgetOutlook[] = [];

  for (const [id, agent] of Object.entries(config.agents)) {
    const budget = agent.mandate.monthlyBudget ?? null;
    if (budget === null) continue;
    const views = toEngineViews(payments.filter((p) => p.agentId === id));
    const spend = monthlySpend(views, now, tz, budget);
    const used = spend.approved + spend.pending;
    const perDay = Math.round(used / dayOfMonth);
    out.push({
      kind: 'month',
      label: input.names?.[id] ?? id,
      budget,
      used,
      perDay,
      windowEnds: monthEnds,
      ...project({ used, budget, perDay, today, windowEnds: monthEnds }),
      method: `Approved and waiting this month, divided by the ${String(dayOfMonth)} ${dayOfMonth === 1 ? 'day' : 'days'} so far; the remaining budget divided by that pace.`,
    });
  }

  const views = toEngineViews(payments);
  for (const p of config.policy.projects ?? []) {
    const spend = projectSpend(p, views, now, tz);
    const used = spend.approved + spend.pending;
    let perDay: number;
    let windowEnds: string | null;
    let method: string;
    if (p.period === 'month') {
      perDay = Math.round(used / dayOfMonth);
      windowEnds = p.ends !== undefined && p.ends < monthEnds ? p.ends : monthEnds;
      method = `Approved and waiting this month, divided by the ${String(dayOfMonth)} ${dayOfMonth === 1 ? 'day' : 'days'} so far; the remaining budget divided by that pace.`;
    } else {
      const since = addDays(today, -(TOTAL_PACE_DAYS - 1));
      const recent = projectSpend(
        p,
        views.filter((v) => localTime(v.createdAt, tz).date >= since),
        now,
        tz,
      );
      perDay = Math.round((recent.approved + recent.pending) / TOTAL_PACE_DAYS);
      windowEnds = p.ends ?? null;
      method = `Approved and waiting in the last ${String(TOTAL_PACE_DAYS)} days, divided by ${String(TOTAL_PACE_DAYS)}; the remaining budget divided by that pace.`;
    }
    out.push({
      kind: 'project',
      label: p.name,
      budget: p.budgetBase,
      used,
      perDay,
      windowEnds,
      ...project({ used, budget: p.budgetBase, perDay, today, windowEnds }),
      method,
    });
  }
  return out;
}
