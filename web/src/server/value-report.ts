import type { MandateConfig, StoredEntry } from '@flow-e/mcp/core';
import {
  buildDashboard,
  buildValueReport,
  invoiceStats,
  type DashboardAgent,
  type Period,
} from './analytics';
import { budgetOutlook } from './budget-outlook';

/**
 * Everything on the value report page, from the ledger and the mandate alone. Pure, so the
 * report can be tested on a fixed ledger with known numbers.
 */
export function valueReportData(input: {
  entries: readonly StoredEntry[];
  config: MandateConfig;
  agents: readonly DashboardAgent[];
  timezone: string;
  now: number;
  period: Period;
  minutesPerApproval: number;
}) {
  const dash = buildDashboard({
    entries: input.entries,
    agents: input.agents,
    timezone: input.timezone,
    now: input.now,
    period: input.period,
    agentId: null,
    policy: input.config.policy,
  });
  const invoices = invoiceStats({
    entries: input.entries,
    timezone: input.timezone,
    from: dash.from,
    to: dash.to,
  });
  return {
    from: dash.from,
    to: dash.to,
    report: buildValueReport(dash, { minutesPerApproval: input.minutesPerApproval, invoices }),
    outlook: budgetOutlook({
      entries: input.entries,
      config: input.config,
      now: input.now,
      names: Object.fromEntries(input.agents.map((a) => [a.id, a.name])),
    }),
  };
}
