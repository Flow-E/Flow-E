import { csvFromEntries, fromStored, type StoredEntry } from '@flow-e/mcp/core';
import { parseAgent, parsePeriod, periodEntries } from './analytics';

/**
 * The CSV behind one dashboard view (`?period=…&agent=…`), or null when the request names no
 * period, in which case the caller exports the whole ledger as before. Same formula-safe CSV.
 */
export function dashboardCsv(
  view: { entries: StoredEntry[]; timezone: string; agents: readonly { id: string }[] },
  params: URLSearchParams,
  now: number,
): { body: string; suffix: string } | null {
  if (!params.has('period')) return null;
  const period = parsePeriod(params.get('period'));
  const agentId = parseAgent(params.get('agent'), view.agents);
  const entries = periodEntries({
    entries: view.entries,
    timezone: view.timezone,
    now,
    period,
    agentId,
  });
  return {
    body: csvFromEntries(entries.map(fromStored)),
    suffix: `${period}${agentId ? `-${agentId}` : ''}`,
  };
}
