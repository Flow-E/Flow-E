import type { Metadata } from 'next';
import { ValueReportPage } from '@/components/value-report';
import { parseMinutes, parsePeriod } from '@/server/analytics';
import { sandboxView } from '@/server/view';
import { valueReportData } from '@/server/value-report';

export const metadata: Metadata = { title: 'Value report' };

export default async function SandboxReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await sandboxView();
  const query = await searchParams;
  const parsed = parsePeriod(query.period);
  const period = parsed === 'today' ? '30d' : parsed;
  const data = valueReportData({
    entries: view.entries,
    config: view.config,
    agents: view.agents.map((a) => ({ id: a.id, name: a.id, dailyBudget: a.today.budget })),
    timezone: view.timezone,
    now: view.now,
    period,
    minutesPerApproval: parseMinutes(query.minutes),
  });
  return (
    <ValueReportPage
      organisation={view.organisation ?? 'Your sandbox (fictional)'}
      {...data}
      period={period}
      generatedAt={new Date(view.now).toISOString()}
      timezone={view.timezone}
      currency={view.baseCurrency}
      decimals={view.currencyDecimals}
      basePath="/sandbox/report"
      fictional
    />
  );
}
