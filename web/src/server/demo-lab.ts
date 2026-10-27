import { CATALOG } from '@flow-e/mcp/core';
import type { OrgStore, User } from './org-store';

/**
 * A ready-made, clearly fictional lab organisation for demos: the same company, agent, suppliers
 * and limits as the sandbox, but as a real organisation, so a real Claude can connect to it with
 * an agent key. It starts with an empty ledger: organisations never get sample history.
 */
export const DEMO_LAB_NAME = 'Example Labs AG (demo, fictional)';
export const DEMO_LAB_AGENT = 'lab-procurement';

export async function createDemoLab(store: OrgStore, user: User): Promise<string> {
  const orgId = await store.createOrg(user, {
    name: DEMO_LAB_NAME,
    baseCurrency: 'CHF',
    timezone: 'Europe/Zurich',
  });
  await store.createAgent(orgId, user, {
    agentId: DEMO_LAB_AGENT,
    displayName: 'Lab procurement agent (demo)',
    owner: 'Dr. A. Muster, Head of Lab (fictional)',
    dailyBudget: '20000',
    perPaymentLimit: '8000',
    approvalAbove: '5000',
    categories: ['5169', '5047'],
  });
  const raw = (await store.view(orgId, user)).raw;
  const agents = raw.agents as Record<string, Record<string, unknown>>;
  await store.updateConfig(
    orgId,
    user,
    {
      ...raw,
      fx: { EUR: 0.93, USD: 0.8 },
      // Demo list only. Not sanctions screening.
      blocked_countries: ['RU', 'BY', 'IR', 'KP'],
      blocked_suppliers: ['Example Chem Trading LLC'],
      agents: {
        ...agents,
        [DEMO_LAB_AGENT]: {
          ...agents[DEMO_LAB_AGENT],
          currencies: ['CHF', 'EUR'],
          suppliers: { mode: 'allowlist', allow: ['Example Reagents AG', 'Example Labware AG'] },
          velocity_per_minute: 10,
        },
      },
    },
    'Demo lab setup (fictional).',
  );
  return orgId;
}

/** The prompt to paste into Claude once it is connected to the demo lab's MCP address. */
export function demoLabPrompt(): string {
  const rows = CATALOG.map(
    (c) =>
      `| ${c.item} | ${c.supplier} | ${c.country} | ${c.currency} ${c.price} | ${c.category} |`,
  );
  return `You are the purchasing assistant for a lab at Example Labs AG. This is a demo: the company, suppliers and prices are fictional and no money moves.

Use the flow-e tools. Call check_mandate first. Before every purchase, call request_payment, and treat its decision as binding.

This week we need:
1. 10 L of phosphate buffer solution
2. a benchtop centrifuge
3. an HPLC column set
4. a borosilicate glassware kit
5. 10 boxes of nitrile gloves

Supplier catalog (fictional):

| Item | Supplier | Country | Price | Category (MCC) |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

For each item, pick the best offer, request the payment and tell me the decision, the reason and the payment_id. If a payment needs my approval, tell me and wait. Finish with a short summary table.`;
}
