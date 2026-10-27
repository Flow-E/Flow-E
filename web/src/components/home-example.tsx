import { CATALOG, DEMO_AGENT, DEMO_REFERENCE_PRICES } from '@flow-e/mcp/core';
import { Pill, type Tone } from './ui';
import { css } from './home-styles';

/**
 * The worked example on the home page: five requests from the sandbox's demo story, and what
 * Flow-E decided. A radio group switches between them with CSS alone (no script, so the CSP and
 * the no-JavaScript case need nothing extra). Amounts and usual prices come from the core's demo
 * content, so they stay in step with the sandbox. Everything in it is fictional.
 */

/** The sixteen rules, short names, in engine order. */
export const RULE_SHORT = [
  'Kill switch and agent status',
  'Know Your Agent credential',
  'Amount and currency',
  'Country',
  'Supplier',
  'Category',
  'Per-payment limit',
  'Daily budget',
  'Monthly budget',
  'Project budget',
  'Velocity',
  'Split detection',
  'Fair price',
  'Business hours',
  'Human-approval threshold',
  'Cooling-off',
] as const;

type Outcome = 'approved' | 'review' | 'declined';

interface Case {
  id: string;
  tab: string;
  /** Index into CATALOG. */
  item: number;
  outcome: Outcome;
  /** Index into RULE_SHORT of the rule that decided, or -1 when every rule passed. */
  rule: number;
  why: string;
  agentHears: string;
}

function chf(units: number): string {
  return `CHF ${units.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
}

function usual(match: string): number {
  return DEMO_REFERENCE_PRICES.find((r) => r.match === match)?.price ?? 0;
}

function percentAbove(price: number, reference: number): number {
  return Math.round(((price - reference) / reference) * 100);
}

const tips = Number(CATALOG[6]?.price ?? 0);
const buffer = Number(CATALOG[1]?.price ?? 0);

const CASES: readonly Case[] = [
  {
    id: 'approved',
    tab: 'Approved',
    item: 1,
    outcome: 'approved',
    rule: -1,
    why: `Within every limit and ${String(percentAbove(buffer, usual('phosphate buffer')))}% above the usual ${chf(usual('phosphate buffer'))}. It is the first payment to this supplier, so it stays cancellable for 10 minutes.`,
    agentHears: 'Approved, with a payment id and a signed receipt. The order can go out.',
  },
  {
    id: 'review',
    tab: 'A person decides',
    item: 2,
    outcome: 'review',
    rule: 14,
    why: 'Inside the CHF 8,000.00 per-payment limit and the day’s budget, but above CHF 5,000.00. The head of lab gets an approval card on their phone.',
    agentHears: 'Waiting for a person. Do not order yet; ask again later.',
  },
  {
    id: 'declined',
    tab: 'Declined',
    item: 3,
    outcome: 'declined',
    rule: 6,
    why: 'Above the CHF 8,000.00 per-payment limit. When the agent tries again with CHF 4,500.00 to the same supplier, split detection sends that to a person.',
    agentHears: 'Declined, and why: the most this agent may pay at once is CHF 8,000.00.',
  },
  {
    id: 'overpriced',
    tab: 'Overpriced',
    item: 6,
    outcome: 'review',
    rule: 12,
    why: `${String(percentAbove(tips, usual('pipette tips')))}% above the usual ${chf(usual('pipette tips'))} for this item. More than 20% above goes to a person, who can approve it or ask for another offer.`,
    agentHears: `Waiting for a person, with the usual price (${chf(usual('pipette tips'))}) to look for a better offer.`,
  },
  {
    id: 'blocked',
    tab: 'Blocked supplier',
    item: 0,
    outcome: 'declined',
    rule: 4,
    why: 'The cheapest offer, from a supplier on the blocked list. In the demo it stands in for a sanctions hit.',
    agentHears:
      'Declined, with the approved suppliers: Example Reagents AG and Example Labware AG.',
  },
];

const OUTCOME: Record<Outcome, { label: string; tone: Tone }> = {
  approved: { label: 'approved', tone: 'approved' },
  review: { label: 'a person decides', tone: 'review' },
  declined: { label: 'declined', tone: 'declined' },
};

function cellClass(c: Case, i: number): string {
  if (c.rule === -1) return i === 15 ? css.cellNote : css.cellPass;
  if (i < c.rule) return css.cellPass;
  if (i === c.rule) return c.outcome === 'declined' ? css.cellDecline : css.cellReview;
  return css.cellIdle;
}

function summary(c: Case): string {
  if (c.rule === -1) return 'All sixteen rules passed; cooling-off applies.';
  const passed = c.rule;
  return `${String(passed)} rules passed, then ${RULE_SHORT[c.rule] ?? ''} decided.`;
}

export function WorkedExample() {
  return (
    <div className={css.example}>
      <fieldset>
        <legend className="sr-only">Choose a request</legend>
        <div className="flex flex-wrap gap-2">
          {CASES.map((c) => (
            <label key={c.id} className={css.tab}>
              <input
                type="radio"
                name="example-case"
                value={c.id}
                defaultChecked={c.id === 'review'}
                className="sr-only"
              />
              {c.tab}
            </label>
          ))}
        </div>
      </fieldset>

      {CASES.map((c) => {
        const item = CATALOG[c.item];
        if (!item) return null;
        const amount = Number(item.price);
        return (
          <div key={c.id} data-case={c.id} className={css.panel}>
            <div data-ui className="min-w-0 rounded-xl border border-rule bg-surface p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-ink-3">{DEMO_AGENT} asks to pay</p>
                  <p className="tabular font-serif text-4xl leading-tight tracking-[-0.02em] text-ink sm:text-5xl">
                    {item.currency} {amount.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                  </p>
                  <p className="mt-1 text-ink-2">
                    {item.item} · {item.supplier} ({item.country})
                  </p>
                </div>
                <Pill tone={OUTCOME[c.outcome].tone}>{OUTCOME[c.outcome].label}</Pill>
              </div>
              <div className="mt-6">
                <p className="sr-only">{summary(c)}</p>
                <ol aria-hidden="true" className="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-1">
                  {RULE_SHORT.map((r, i) => (
                    <li key={r} title={r} className={`h-3 rounded-sm ${cellClass(c, i)}`} />
                  ))}
                </ol>
                <p aria-hidden="true" className="mt-2 text-sm text-ink-3">
                  {summary(c)}
                </p>
              </div>
            </div>
            <div className="min-w-0 space-y-5">
              <div>
                <h3 className="font-semibold text-ink">
                  {c.rule === -1 ? 'Why it passed' : `Decided by: ${RULE_SHORT[c.rule] ?? ''}`}
                </h3>
                <p className="mt-1 text-ink">{c.why}</p>
              </div>
              <div>
                <h3 className="font-semibold text-ink">What the agent hears back</h3>
                <p className="mt-1 text-ink">{c.agentHears}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
