import { hasRate, toBaseMinor } from './fx.js';
import { formatMoney } from './money.js';
import { normalizeCode, normalizeName } from './normalize.js';
import { formatClock, localTime } from './time.js';
import type {
  AgentState,
  EvaluationContext,
  LedgerEntryView,
  Mandate,
  PaymentRequest,
  Project,
  ReferencePrice,
  RuleId,
  TraceEntry,
} from './types.js';

export const SPLIT_WINDOW_MS = 10 * 60_000;
export const VELOCITY_WINDOW_MS = 60_000;
export const COOLING_OFF_MS = 10 * 60_000;

/** Values derived while rules run. `amountBase` is set by the currency rule. */
export interface Facts {
  currency: string;
  country: string;
  merchantKey: string;
  amountBase: number | null;
}

export interface RuleInput {
  agent: AgentState;
  mandate: Mandate;
  request: PaymentRequest;
  ctx: EvaluationContext;
  facts: Facts;
}

/** A rule's trace entry, plus a hint for the agent when it says no or not yet. */
export type RuleResult = Omit<TraceEntry, 'rule'> & { hint?: string };
export type Rule = (input: RuleInput) => RuleResult;

const pass = (detail: string, data?: TraceEntry['data']): RuleResult =>
  data ? { outcome: 'pass', detail, data } : { outcome: 'pass', detail };
const decline = (detail: string, data?: TraceEntry['data'], hint?: string): RuleResult => ({
  outcome: 'decline',
  detail,
  ...(data ? { data } : {}),
  ...(hint ? { hint } : {}),
});
const review = (detail: string, data?: TraceEntry['data'], hint?: string): RuleResult => ({
  outcome: 'review',
  detail,
  ...(data ? { data } : {}),
  ...(hint ? { hint } : {}),
});

const DONT_RETRY = 'Do not retry; tell your human.';

function base(amount: number, ctx: EvaluationContext): string {
  return formatMoney(amount, ctx.policy.baseCurrency, ctx.policy.currencyDecimals);
}

/** Facts.amountBase is set by CURRENCY, which always runs before the rules that read it. */
function amountBase(facts: Facts): number {
  if (facts.amountBase === null) throw new Error('amountBase read before conversion');
  return facts.amountBase;
}

const activeStatuses = new Set<LedgerEntryView['status']>(['approved', 'review']);

// 1. Kill switch and agent status ------------------------------------------------------------

const killSwitch: Rule = ({ ctx }) =>
  ctx.killSwitch
    ? decline(
        'The global kill switch is on. All payments are blocked.',
        undefined,
        `A person has stopped all payments. ${DONT_RETRY}`,
      )
    : pass('Kill switch is off.');

const agentStatus: Rule = ({ agent }) =>
  agent.status === 'active'
    ? pass(`Agent "${agent.id}" is active.`)
    : decline(
        `Agent "${agent.id}" is ${agent.status}.`,
        { status: agent.status },
        `This agent is ${agent.status}. ${DONT_RETRY}`,
      );

// 2. Know Your Agent credential --------------------------------------------------------------

const kyaCredential: Rule = (input) => {
  const result = checkCredential(input);
  return result.outcome === 'decline'
    ? { ...result, hint: `Your agent credential is not valid. ${DONT_RETRY}` }
    : result;
};

function checkCredential({ agent, ctx }: RuleInput): RuleResult {
  const credential = agent.credential;
  if (!credential) return decline('No Know Your Agent credential was presented.');
  const { claims } = credential;
  if (claims.issuer !== ctx.kya.issuer) {
    return decline(`Credential was issued by "${claims.issuer}", not by "${ctx.kya.issuer}".`);
  }
  const signature = ctx.kya.verifySignature(credential);
  if (!signature.valid) {
    return decline(`Credential signature is not valid: ${signature.reason}`);
  }
  if (claims.agent_id !== agent.id) {
    return decline(`Credential belongs to agent "${claims.agent_id}", not "${agent.id}".`);
  }
  const issuedAt = Date.parse(claims.issued_at);
  const expiresAt = Date.parse(claims.expires_at);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return decline('Credential has an unreadable issue or expiry date.');
  }
  if (issuedAt > ctx.now) {
    return decline(`Credential is not valid before ${claims.issued_at}.`);
  }
  if (expiresAt <= ctx.now) {
    return decline(`Credential expired at ${claims.expires_at}.`);
  }
  if (!claims.scope.includes(ctx.kya.requiredScope)) {
    return decline(
      `Credential scope [${claims.scope.join(', ')}] does not include "${ctx.kya.requiredScope}".`,
    );
  }
  return pass(`Credential for "${claims.agent_name}" (owner ${claims.owner}) is valid.`, {
    expiresAt: claims.expires_at,
  });
}

// 3. Amount and currency ---------------------------------------------------------------------

const amount: Rule = ({ request }) =>
  Number.isSafeInteger(request.amount) && request.amount > 0
    ? pass('Amount is above 0.', { amountMinor: request.amount })
    : decline(
        'Amount must be a whole number of minor units above 0.',
        { amountMinor: Number.isFinite(request.amount) ? request.amount : null },
        'Send the total to pay as a positive decimal amount, e.g. "1250.50".',
      );

const currency: Rule = ({ mandate, ctx, facts, request }) => {
  const allowed = mandate.currencies.map(normalizeCode);
  if (!allowed.includes(facts.currency)) {
    return decline(
      `Currency ${facts.currency} is not allowed. Allowed: ${allowed.join(', ')}.`,
      undefined,
      `Ask the supplier for a price in ${allowed.join(' or ')}.`,
    );
  }
  if (!hasRate(facts.currency, ctx.policy)) {
    return decline(
      `No exchange rate is configured for ${facts.currency}.`,
      undefined,
      `Ask the supplier for a price in ${ctx.policy.baseCurrency}.`,
    );
  }
  facts.amountBase = toBaseMinor(request.amount, facts.currency, ctx.policy);
  const shown = formatMoney(request.amount, facts.currency, ctx.policy.currencyDecimals);
  return pass(
    facts.currency === ctx.policy.baseCurrency
      ? `${shown} is in the base currency.`
      : `${shown} is ${base(facts.amountBase, ctx)} at the configured rate.`,
    { amountBase: facts.amountBase },
  );
};

// 4. Country ---------------------------------------------------------------------------------

const country: Rule = (input) => {
  const result = checkCountry(input);
  return result.outcome === 'decline'
    ? { ...result, hint: 'Choose a supplier based in a country that is not blocked.' }
    : result;
};

function checkCountry({ mandate, ctx, facts }: RuleInput): RuleResult {
  if (!/^[A-Z]{2}$/.test(facts.country)) {
    return decline(`"${facts.country}" is not an ISO 3166-1 alpha-2 country code.`);
  }
  if (ctx.policy.blockedCountries.map(normalizeCode).includes(facts.country)) {
    return decline(
      `Country ${facts.country} is on the organisation's always-blocked list. ` +
        '(This list is configuration, not sanctions screening.)',
    );
  }
  if (mandate.blockedCountries.map(normalizeCode).includes(facts.country)) {
    return decline(`Country ${facts.country} is blocked for this agent.`);
  }
  return pass(`Country ${facts.country} is not blocked.`);
}

// 5. Supplier --------------------------------------------------------------------------------

const supplier: Rule = ({ mandate, ctx, facts, request }) => {
  if (facts.merchantKey === '') return decline('Supplier name is empty.');
  const name = request.merchant.trim();
  if (ctx.policy.blockedSuppliers.some((s) => normalizeName(s) === facts.merchantKey)) {
    return decline(
      `Supplier "${name}" is on the organisation's blocklist.`,
      undefined,
      approvedSuppliers(mandate) ?? 'Buy from another supplier; never rename this one.',
    );
  }
  if (mandate.suppliers.block.some((s) => normalizeName(s) === facts.merchantKey)) {
    return decline(
      `Supplier "${name}" is blocked for this agent.`,
      undefined,
      approvedSuppliers(mandate) ?? 'Buy from another supplier; never rename this one.',
    );
  }
  if (
    mandate.suppliers.mode === 'allowlist' &&
    !mandate.suppliers.allow.some((s) => normalizeName(s) === facts.merchantKey)
  ) {
    return decline(
      `Supplier "${name}" is not on this agent's approved supplier list.`,
      undefined,
      approvedSuppliers(mandate),
    );
  }
  return pass(
    mandate.suppliers.mode === 'allowlist'
      ? `Supplier "${name}" is on the approved list.`
      : `Supplier "${name}" is not blocked.`,
  );
};

function approvedSuppliers(mandate: Mandate): string | undefined {
  return mandate.suppliers.mode === 'allowlist' && mandate.suppliers.allow.length > 0
    ? `Approved suppliers: ${mandate.suppliers.allow.join(', ')}.`
    : undefined;
}

// 6. Category --------------------------------------------------------------------------------

const category: Rule = ({ mandate, request }) => {
  const code = request.category.trim();
  if (!/^\d{4}$/.test(code)) return decline(`"${code}" is not a four-digit category code.`);
  return mandate.categories.includes(code)
    ? pass(`Category ${code} is allowed.`)
    : decline(
        `Category ${code} is not allowed. Allowed: ${mandate.categories.join(', ')}.`,
        undefined,
        `You may buy in categories ${mandate.categories.join(', ')}. Never re-label a purchase.`,
      );
};

// 7. Per-payment limit -----------------------------------------------------------------------

const perPaymentLimit: Rule = ({ mandate, ctx, facts }) => {
  const amt = amountBase(facts);
  const data = { amountBase: amt, limitBase: mandate.perPaymentLimit };
  return amt > mandate.perPaymentLimit
    ? decline(
        `${base(amt, ctx)} is above the per-payment limit of ${base(mandate.perPaymentLimit, ctx)}.`,
        data,
        `Payments up to ${base(mandate.perPaymentLimit, ctx)} are within your limit. Larger ` +
          'purchases need your human; never split them into smaller payments.',
      )
    : pass(
        `${base(amt, ctx)} is within the per-payment limit of ${base(mandate.perPaymentLimit, ctx)}.`,
        data,
      );
};

// 8. Daily budget ----------------------------------------------------------------------------

export interface DailySpend {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  approved: number;
  pending: number;
  remaining: number;
}

/** Today's committed spend in base minor units: approved plus pending review. */
export function dailySpend(
  ledger: readonly LedgerEntryView[],
  now: number,
  timezone: string,
  dailyBudgetBase: number,
): DailySpend {
  const date = localTime(now, timezone).date;
  let approved = 0;
  let pending = 0;
  for (const e of ledger) {
    if (localTime(e.createdAt, timezone).date !== date) continue;
    if (e.status === 'approved') approved += e.amountBase;
    else if (e.status === 'review') pending += e.amountBase;
  }
  return { date, approved, pending, remaining: Math.max(0, dailyBudgetBase - approved - pending) };
}

const dailyBudget: Rule = ({ mandate, ctx, facts }) => {
  const amt = amountBase(facts);
  const {
    date: today,
    approved,
    pending,
    remaining,
  } = dailySpend(ctx.ledger, ctx.now, ctx.policy.timezone, mandate.dailyBudget);
  const committed = approved + pending;
  const data = {
    date: today,
    approvedTodayBase: approved,
    pendingReviewBase: pending,
    budgetBase: mandate.dailyBudget,
    remainingBase: remaining,
    amountBase: amt,
  };
  if (committed + amt > mandate.dailyBudget) {
    return decline(
      `${base(amt, ctx)} exceeds today's remaining budget of ${base(remaining, ctx)} ` +
        `(budget ${base(mandate.dailyBudget, ctx)}, approved ${base(approved, ctx)}, ` +
        `pending review ${base(pending, ctx)}).`,
      data,
      `Remaining today: ${base(remaining, ctx)}. The daily budget starts again tomorrow.`,
    );
  }
  return pass(`${base(amt, ctx)} fits today's remaining budget of ${base(remaining, ctx)}.`, data);
};

// 8b. Monthly budget ------------------------------------------------------------------------

/** Committed spend (approved plus pending review) in a set of payments. */
function committed(entries: readonly LedgerEntryView[], keep: (e: LedgerEntryView) => boolean) {
  let approved = 0;
  let pending = 0;
  for (const e of entries) {
    if (!keep(e)) continue;
    if (e.status === 'approved') approved += e.amountBase;
    else if (e.status === 'review') pending += e.amountBase;
  }
  return { approved, pending };
}

const monthOf = (at: number, timezone: string) => localTime(at, timezone).date.slice(0, 7);

/** "2026-11-01" after a "2026-10" month. */
function nextMonthStart(month: string): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export interface MonthlySpend {
  /** YYYY-MM in the organisation's time zone. */
  month: string;
  approved: number;
  pending: number;
  remaining: number;
}

/** This calendar month's committed spend in base minor units. */
export function monthlySpend(
  ledger: readonly LedgerEntryView[],
  now: number,
  timezone: string,
  monthlyBudgetBase: number,
): MonthlySpend {
  const month = monthOf(now, timezone);
  const { approved, pending } = committed(ledger, (e) => monthOf(e.createdAt, timezone) === month);
  return {
    month,
    approved,
    pending,
    remaining: Math.max(0, monthlyBudgetBase - approved - pending),
  };
}

const monthlyBudget: Rule = ({ mandate, ctx, facts }) => {
  const budget = mandate.monthlyBudget ?? null;
  if (budget === null) return pass('No monthly budget is set.');
  const amt = amountBase(facts);
  const spend = monthlySpend(ctx.ledger, ctx.now, ctx.policy.timezone, budget);
  const data = {
    month: spend.month,
    approvedBase: spend.approved,
    pendingReviewBase: spend.pending,
    budgetBase: budget,
    remainingBase: spend.remaining,
    amountBase: amt,
  };
  if (spend.approved + spend.pending + amt > budget) {
    return decline(
      `${base(amt, ctx)} exceeds this month's remaining budget of ${base(spend.remaining, ctx)} ` +
        `(budget ${base(budget, ctx)}, approved ${base(spend.approved, ctx)}, ` +
        `pending review ${base(spend.pending, ctx)}).`,
      data,
      `Remaining this month: ${base(spend.remaining, ctx)}. The monthly budget starts again on ` +
        `${nextMonthStart(spend.month)}.`,
    );
  }
  return pass(
    `${base(amt, ctx)} fits this month's remaining budget of ${base(spend.remaining, ctx)}.`,
    data,
  );
};

// 8c. Project budget ------------------------------------------------------------------------

/** The project a request names, by id or by name, case- and whitespace-insensitively. */
export function findProject(projects: readonly Project[], name: string): Project | undefined {
  const key = normalizeName(name);
  return projects.find((p) => normalizeName(p.id) === key || normalizeName(p.name) === key);
}

export interface ProjectSpend {
  approved: number;
  pending: number;
  remaining: number;
  /** YYYY-MM for monthly projects; null for a budget over the project's whole life. */
  month: string | null;
}

/** A project's committed spend across every agent, in its budget period. */
export function projectSpend(
  project: Project,
  ledger: readonly LedgerEntryView[],
  now: number,
  timezone: string,
): ProjectSpend {
  const month = project.period === 'month' ? monthOf(now, timezone) : null;
  const { approved, pending } = committed(
    ledger,
    (e) => e.project === project.id && (month === null || monthOf(e.createdAt, timezone) === month),
  );
  return {
    approved,
    pending,
    month,
    remaining: Math.max(0, project.budgetBase - approved - pending),
  };
}

const projectBudget: Rule = ({ agent, mandate, request, ctx, facts }) => {
  const projects = ctx.policy.projects ?? [];
  const mine = projects.filter((p) => p.agents.length === 0 || p.agents.includes(agent.id));
  const choose =
    mine.length > 0
      ? `Name one of your projects: ${mine.map((p) => `${p.id} (${p.name})`).join(', ')}.`
      : 'No project is open to this agent; tell your human.';
  const named = request.project?.trim() ?? '';
  if (named === '') {
    return mandate.requireProject === true
      ? decline('This agent must book every purchase to a project.', undefined, choose)
      : pass('No project named.');
  }
  const project = findProject(projects, named);
  if (!project) {
    return decline(`There is no project "${named}".`, { project: named }, choose);
  }
  if (!mine.includes(project)) {
    return decline(
      `This agent may not book to project "${project.name}".`,
      { project: project.id },
      choose,
    );
  }
  const amt = amountBase(facts);
  const spend = projectSpend(
    project,
    ctx.organisationLedger ?? ctx.ledger,
    ctx.now,
    ctx.policy.timezone,
  );
  const period = project.period === 'month' ? 'this month' : 'in total';
  const data = {
    project: project.id,
    period: project.period,
    approvedBase: spend.approved,
    pendingReviewBase: spend.pending,
    budgetBase: project.budgetBase,
    remainingBase: spend.remaining,
    amountBase: amt,
  };
  if (spend.approved + spend.pending + amt > project.budgetBase) {
    return decline(
      `${base(amt, ctx)} exceeds the remaining budget of project "${project.name}" ` +
        `(${base(spend.remaining, ctx)} left of ${base(project.budgetBase, ctx)} ${period}).`,
      data,
      `Project "${project.name}" has ${base(spend.remaining, ctx)} left ${period}. Book to ` +
        'another project only if the purchase really belongs to it.',
    );
  }
  return pass(
    `${base(amt, ctx)} fits project "${project.name}" (${base(spend.remaining, ctx)} left ${period}).`,
    data,
  );
};

// 9. Velocity --------------------------------------------------------------------------------

const velocity: Rule = ({ mandate, ctx }) => {
  const since = ctx.now - VELOCITY_WINDOW_MS;
  const recent = ctx.ledger.filter((e) => e.createdAt > since && e.createdAt <= ctx.now).length;
  const data = { requestsLastMinute: recent, limitPerMinute: mandate.velocityPerMinute };
  return recent >= mandate.velocityPerMinute
    ? decline(
        `${recent} payment requests in the last minute; the limit is ${mandate.velocityPerMinute}.`,
        data,
        'Wait a minute before the next request.',
      )
    : pass(`${recent} of ${mandate.velocityPerMinute} payment requests used this minute.`, data);
};

// 10. Split detection ------------------------------------------------------------------------

const splitDetection: Rule = ({ mandate, ctx, facts, request }) => {
  const amt = amountBase(facts);
  const since = ctx.now - SPLIT_WINDOW_MS;
  // A payment still waiting because it looked like a split is not counted again: otherwise one
  // split attempt would send every later order to the same supplier to a person too.
  const prior = ctx.ledger.filter(
    (e) =>
      activeStatuses.has(e.status) &&
      !(e.status === 'review' && e.rule === 'SPLIT_DETECTION') &&
      e.createdAt > since &&
      e.createdAt <= ctx.now &&
      normalizeName(e.merchant) === facts.merchantKey,
  );
  const priorSum = prior.reduce((sum, e) => sum + e.amountBase, 0);
  const data = {
    priorPayments: prior.length,
    priorSumBase: priorSum,
    totalBase: priorSum + amt,
    limitBase: mandate.perPaymentLimit,
  };
  // A person decides: a genuine second order looks the same as a split, and only they can tell.
  if (prior.length > 0 && priorSum + amt > mandate.perPaymentLimit) {
    return review(
      `Looks like a split payment: ${prior.length} earlier payment(s) to "${request.merchant.trim()}" ` +
        `in the last 10 minutes plus this one total ${base(priorSum + amt, ctx)}, above the ` +
        `per-payment limit of ${base(mandate.perPaymentLimit, ctx)}; a human must approve.`,
      data,
      'A person will check this together with the earlier payments. Never split a purchase ' +
        'to stay under a limit.',
    );
  }
  return pass('No split pattern with this supplier in the last 10 minutes.', data);
};

// 11. Fair price -----------------------------------------------------------------------------

/** The reference whose name or match words appear in the text; the longest match wins. */
export function findReference(
  refs: readonly ReferencePrice[],
  text: string,
): ReferencePrice | undefined {
  const haystack = normalizeName(text);
  if (haystack === '') return undefined;
  let best: ReferencePrice | undefined;
  let bestLength = 0;
  for (const ref of refs) {
    for (const word of [ref.item, ...ref.match]) {
      const needle = normalizeName(word);
      if (needle.length > bestLength && haystack.includes(needle)) {
        best = ref;
        bestLength = needle.length;
      }
    }
  }
  return best;
}

const fairPrice: Rule = ({ request, ctx, facts }) => {
  const refs = ctx.policy.referencePrices ?? [];
  const check = ctx.policy.priceCheck;
  if (refs.length === 0 || !check) return pass('No reference prices are set.');
  const quantity = request.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return decline('Quantity must be a whole number of at least 1.', {
      quantity: String(quantity),
    });
  }
  const ref = findReference(refs, request.item ?? request.memo ?? '');
  if (!ref) return pass('No reference price for this item.', { matched: false });

  const amt = amountBase(facts);
  const expected = ref.priceBase * quantity;
  const percent = Math.round(((amt - expected) * 100) / expected);
  const what = `${quantity === 1 ? '' : `${String(quantity)} × `}${ref.item}`;
  const usual =
    `the usual ${base(expected, ctx)}` +
    (quantity === 1 ? '' : ` (${base(ref.priceBase, ctx)} each)`);
  const data = {
    matched: true,
    item: ref.item,
    quantity,
    referenceBase: ref.priceBase,
    expectedBase: expected,
    differenceBase: amt - expected,
    differencePercent: percent,
  };
  if (amt * 100 > expected * (100 + check.abovePercent)) {
    const detail =
      `${base(amt, ctx)} for ${what} is ${String(percent)}% above ${usual}` +
      ` (tolerance ${String(check.abovePercent)}%)`;
    const ceiling = Math.floor((expected * (100 + check.abovePercent)) / 100);
    const hint =
      `The usual price is ${base(expected, ctx)}; offers up to ${base(ceiling, ctx)} pass this ` +
      'check. Look for a better offer, or name the item and quantity exactly.';
    return check.above === 'decline'
      ? decline(`${detail}.`, data, hint)
      : review(`${detail}; a human must approve.`, data, hint);
  }
  if (check.belowPercent !== null && amt * 100 < expected * (100 - check.belowPercent)) {
    return review(
      `${base(amt, ctx)} for ${what} is ${String(-percent)}% below ${usual}: unusually cheap, ` +
        'a human must check it is the right product and supplier.',
      data,
      'Check the product, pack size and quantity; a person will confirm the offer.',
    );
  }
  return pass(`${base(amt, ctx)} for ${what} is in line with ${usual}.`, data);
};

// 12. Business hours (soft) ------------------------------------------------------------------

const businessHours: Rule = ({ mandate, ctx }) => {
  if (!mandate.businessHoursOnly) return pass('Business hours are not enforced for this agent.');
  const hours = ctx.policy.businessHours;
  const local = localTime(ctx.now, ctx.policy.timezone);
  const window = `${formatClock(hours.startMinute)}–${formatClock(hours.endMinute)}`;
  const inside =
    hours.days.includes(local.weekday) &&
    local.minutes >= hours.startMinute &&
    local.minutes < hours.endMinute;
  const data = { localTime: formatClock(local.minutes), weekday: local.weekday };
  return inside
    ? pass(`Inside business hours (${window} ${ctx.policy.timezone}).`, data)
    : review(
        `Outside business hours (${window} ${ctx.policy.timezone}); a human must approve.`,
        data,
        `Requests inside business hours (${window} ${ctx.policy.timezone}) skip this check.`,
      );
};

// 13. Human-approval threshold (soft) --------------------------------------------------------

const approvalThreshold: Rule = ({ mandate, ctx, facts }) => {
  const amt = amountBase(facts);
  if (mandate.approvalAbove === null) return pass('No human-approval threshold is set.');
  const data = { amountBase: amt, thresholdBase: mandate.approvalAbove };
  return amt > mandate.approvalAbove
    ? review(
        `${base(amt, ctx)} is above the approval threshold of ${base(mandate.approvalAbove, ctx)}; ` +
          'a human must approve.',
        data,
        `Payments up to ${base(mandate.approvalAbove, ctx)} are approved without a person.`,
      )
    : pass(`${base(amt, ctx)} is within the approval threshold.`, data);
};

// 14. Cooling-off (note only; the evaluator sets the cancellation window) --------------------

const coolingOff: Rule = ({ ctx, facts }) => {
  const known = ctx.ledger.some(
    (e) => e.status === 'approved' && normalizeName(e.merchant) === facts.merchantKey,
  );
  return known
    ? pass('Supplier has been paid before; no cooling-off.', { newSupplier: false })
    : { outcome: 'note', detail: 'First payment to this supplier.', data: { newSupplier: true } };
};

export const RULES: readonly (readonly [RuleId, Rule])[] = [
  ['KILL_SWITCH', killSwitch],
  ['AGENT_STATUS', agentStatus],
  ['KYA_CREDENTIAL', kyaCredential],
  ['AMOUNT', amount],
  ['CURRENCY', currency],
  ['COUNTRY', country],
  ['SUPPLIER', supplier],
  ['CATEGORY', category],
  ['PER_PAYMENT_LIMIT', perPaymentLimit],
  ['DAILY_BUDGET', dailyBudget],
  ['MONTHLY_BUDGET', monthlyBudget],
  ['PROJECT_BUDGET', projectBudget],
  ['VELOCITY', velocity],
  ['SPLIT_DETECTION', splitDetection],
  ['FAIR_PRICE', fairPrice],
  ['BUSINESS_HOURS', businessHours],
  ['APPROVAL_THRESHOLD', approvalThreshold],
  ['COOLING_OFF', coolingOff],
];
