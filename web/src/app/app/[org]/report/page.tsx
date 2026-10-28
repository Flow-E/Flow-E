import type { Metadata } from 'next';
import { ValueReportPage } from '@/components/value-report';
import { parseMinutes, parsePeriod } from '@/server/analytics';
import { orgView } from '@/server/org-view';
import { valueReportData } from '@/server/value-report';

export const metadata: Metadata = { title: 'Value report' };

export default async function OrgReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await params;
  const { view } = await orgView(org);
  const query = await searchParams;
  const parsed = parsePeriod(query.period);
  const period = parsed === 'today' ? '30d' : parsed;
  const data = valueReportData({
    entries: view.entries,
    config: view.config,
    agents: view.agents.map((a) => ({
      id: a.id,
      name: a.displayName,
      dailyBudget: a.today.budget,
    })),
    timezone: view.timezone,
    now: view.now,
    period,
    minutesPerApproval: parseMinutes(query.minutes),
  });
  return (
    <ValueReportPage
      organisation={view.name}
      {...data}
      period={period}
      generatedAt={new Date(view.now).toISOString()}
      timezone={view.timezone}
      currency={view.config.policy.baseCurrency}
      decimals={view.currencyDecimals}
      basePath={`/app/${view.id}/report`}
      fictional={false}
    />
  );
}
