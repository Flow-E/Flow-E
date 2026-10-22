import type { Metadata } from 'next';
import { CATALOG, parseAmount } from '@flow-e/mcp/core';
import { Panel, FictionalNote } from '@/components/ui';
import { money } from '@/lib/format';
import { sandboxView } from '@/server/view';
import { requestPaymentAction, storyAction } from '../actions';
import { CatalogTable, CustomRequestForm, StoryButton, type CatalogRow } from '../client';

export const metadata: Metadata = { title: 'Fake agent' };

export default async function AgentPage() {
  const { view } = await sandboxView();
  const rows: CatalogRow[] = CATALOG.map((c, i) => ({
    n: i + 1,
    item: c.item,
    supplier: c.supplier,
    country: c.country,
    currency: c.currency,
    price: c.price,
    category: c.category,
    priceLabel: money(parseAmount(c.price, c.currency), c.currency),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fake agent</h1>
        <p className="mt-1 max-w-[70ch] text-ink-2">
          Act as the AI agent <span className="font-mono text-ink">lab-procurement</span>. Every
          request goes through the same thirteen rules a real agent meets over MCP, and lands in
          your signed ledger. Watch the decision, the reason and the full trace.
        </p>
        <FictionalNote className="mt-2" />
      </div>

      <Panel
        title="The demo story"
        description="Seven requests in a row: a blocked supplier, an approval, a review, a limit, a split attempt, an unapproved supplier and a small purchase."
      >
        <StoryButton action={storyAction} />
      </Panel>

      <Panel
        title="Supplier catalog"
        description="Request one item at a time. All suppliers are fictional."
      >
        <CatalogTable rows={rows} action={requestPaymentAction} />
      </Panel>

      <Panel
        title="Custom request"
        description="Try any rule: an amount above the limit, a blocked country such as RU, a category the agent may not buy, or another currency."
      >
        <CustomRequestForm action={requestPaymentAction} agents={view.agents.map((a) => a.id)} />
      </Panel>
    </div>
  );
}
