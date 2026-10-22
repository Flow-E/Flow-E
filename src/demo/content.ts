/**
 * Demo content. Every organisation, person, supplier, product and price here is fictional.
 * Supplier names use the "Example …" prefix so they cannot be mistaken for real companies.
 */

export const DEMO_AGENT = 'lab-procurement';

export const DEMO_CONFIG_YAML = `# DEMO MANDATE. Every organisation, person, supplier and price in this file is fictional.
organisation: 'Example Labs AG (fictional)'
base_currency: CHF
timezone: Europe/Zurich
fx: { EUR: 0.93, USD: 0.80 } # static demo rates
# Demo list only. This is NOT sanctions screening: configure your own for real use.
blocked_countries: [RU, BY, IR, KP]
# Stands in for a sanctions-list hit. Fictional.
blocked_suppliers: ['Example Chem Trading LLC']
business_hours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }
agents:
  lab-procurement:
    owner: 'Dr. A. Muster, Head of Lab (fictional)'
    status: active
    daily_budget: 20000
    per_payment_limit: 8000
    approval_above: 5000
    currencies: [CHF, EUR]
    categories: ['5169', '5047'] # chemicals; lab and medical equipment
    suppliers: { mode: allowlist, allow: ['Example Reagents AG', 'Example Labware AG'] }
    velocity_per_minute: 10 # the demo makes about 8 requests in quick succession
    business_hours_only: false
  office-supplies:
    owner: 'B. Beispiel, Office Manager (fictional)'
    status: active
    daily_budget: 500
    per_payment_limit: 200
    currencies: [CHF]
    categories: ['5111', '5943'] # stationery; office supplies
    velocity_per_minute: 6
`;

export interface CatalogItem {
  item: string;
  supplier: string;
  country: string;
  price: string;
  currency: string;
  category: string;
}

export const CATALOG: readonly CatalogItem[] = [
  {
    item: 'Phosphate buffer solution, 10 L',
    supplier: 'Example Chem Trading LLC',
    country: 'AE',
    price: '640.00',
    currency: 'CHF',
    category: '5169',
  },
  {
    item: 'Phosphate buffer solution, 10 L',
    supplier: 'Example Reagents AG',
    country: 'CH',
    price: '1200.00',
    currency: 'CHF',
    category: '5169',
  },
  {
    item: 'Benchtop centrifuge',
    supplier: 'Example Labware AG',
    country: 'CH',
    price: '6500.00',
    currency: 'CHF',
    category: '5047',
  },
  {
    item: 'HPLC column set (10 columns)',
    supplier: 'Example Labware AG',
    country: 'CH',
    price: '9000.00',
    currency: 'CHF',
    category: '5047',
  },
  {
    item: 'Borosilicate glassware kit',
    supplier: 'Example Glass GmbH',
    country: 'DE',
    price: '380.00',
    currency: 'EUR',
    category: '5047',
  },
  {
    item: 'Nitrile gloves, 10 boxes',
    supplier: 'Example Labware AG',
    country: 'CH',
    price: '240.00',
    currency: 'CHF',
    category: '5047',
  },
];

export function catalogTable(): string {
  const rows = CATALOG.map(
    (c) =>
      `| ${c.item} | ${c.supplier} | ${c.country} | ${c.currency} ${c.price} | ${c.category} |`,
  );
  return [
    '| Item | Supplier | Country | Price | Category (MCC) |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** The prompt to paste into Claude once the mandate server is connected. */
export function demoPrompt(): string {
  return `You are the purchasing assistant for a lab at Example Labs AG. This is a demo: the company, suppliers and prices are fictional and no money moves.

Use the "mandate" tools. Call check_mandate first. Before every purchase, call request_payment, and treat its decision as binding.

This week we need:
1. 10 L of phosphate buffer solution
2. a benchtop centrifuge
3. an HPLC column set
4. a borosilicate glassware kit
5. 10 boxes of nitrile gloves

Supplier catalog (fictional):

${catalogTable()}

For each item, pick the best offer, request the payment and tell me the decision, the reason and the payment_id. If a payment needs my approval, tell me and wait. Finish with a short summary table.`;
}

/**
 * The fake agent's demo story: catalog item numbers (1-based) in order. Step 5 tries to split
 * the declined column set into a smaller payment.
 */
export const DEMO_STORY_STEPS: readonly { item: number; amount?: string }[] = [
  { item: 1 },
  { item: 2 },
  { item: 3 },
  { item: 4 },
  { item: 4, amount: '4500.00' },
  { item: 5 },
  { item: 6 },
];

/** Explains what the demo is expected to show, for the person running it. */
export const DEMO_STORY = [
  'Cheapest buffer (Example Chem Trading LLC): declined, the supplier is on the demo blocklist.',
  'Buffer from Example Reagents AG: approved; first payment to this supplier, so cancellable for 10 minutes.',
  'Centrifuge, CHF 6500: sent to you for review (above CHF 5000). Approve it in the panel.',
  'HPLC column set, CHF 9000: declined, above the CHF 8000 per-payment limit. Splitting it is caught too.',
  'Glassware kit (Example Glass GmbH): declined, not an approved supplier.',
  'Gloves, CHF 240: approved.',
];
