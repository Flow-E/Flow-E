import { hasRate, toBaseMinor } from './fx.js';
import { formatMoney } from './money.js';
import { normalizeCode, normalizeName } from './normalize.js';
import { formatClock, localTime } from './time.js';
import type {
  AgentState,
  Comply,
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
  /** The id of the project the request named, once PROJECT_BUDGET recognised it. */
  projectId?: string;
}

export interface RuleInput {
  agent: AgentState;
  mandate: Mandate;
  request: PaymentRequest;
  ctx: EvaluationContext;
  facts: Facts;
}

/** What the agent is told when a rule says no or not yet: in words, and as data. */
export interface Hint {
  text: string;
  comply: Comply;
}

/** A rule's trace entry, plus a hint for the agent when it says no or not yet. */
export type RuleResult = Omit<TraceEntry, 'rule'> & { hint?: Hint };
export type Rule = (input: RuleInput) => RuleResult;

const pass = (detail: string, data?: TraceEntry['data']): RuleResult =>
  data ? { outcome: 'pass', detail, data } : { outcome: 'pass', detail };
const decline = (detail: string, data?: TraceEntry['data'], hint?: Hint): RuleResult => ({
  outcome: 'decline',
  detail,
  ...(data ? { data } : {}),
  ...(hint ? { hint } : {}),
});
const review = (detail: string, data?: TraceEntry['data'], hint?: Hint): RuleResult => ({
  outcome: 'review',
  detail,
  ...(data ? { data } : {}),
  ...(hint ? { hint } : {}),
});

const DONT_RETRY = 'Do not retry; tell your human.';

const stop = (text: string, reason: string): Hint => ({
  text: `${text} ${DONT_RETRY}`,
  comply: { action: 'stop', reason },
});

/** The next calendar day, "2026-10-28" after "2026-10-27". */
function nextDay(date: string): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function money(minor: number, ctx: EvaluationContext) {
  return { text: base(minor, ctx), minor, currency: ctx.policy.baseCurrency };
}

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
        stop('A person has stopped all payments.', 'kill_switch'),
      )
    : pass('Kill switch is off.');

const agentStatus: Rule = ({ agent }) =>
  agent.status === 'active'
    ? pass(`Agent "${agent.id}" is active.`)
    : decline(
        `Agent "${agent.id}" is ${agent.status}.`,
        { status: agent.status },
        stop(`This agent is ${agent.status}.`, `agent_${agent.status}`),
      );

// 2. Know Your Agent credential --------------------------------------------------------------

const kyaCredential: Rule = (input) => {
  const result = checkCredential(input);
  return result.outcome === 'decline'
    ? { ...result, hint: stop('Your agent credential is not valid.', 'credential') }
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
        {
          text: 'Send the total to pay as a positive decimal amount, e.g. "1250.50".',
          comply: { action: 'fix_request', field: 'amount' },
        },
      );

const currency: Rule = ({ mandate, ctx, facts, request }) => {
  const allowed = mandate.currencies.map(normalizeCode);
  if (!allowed.includes(facts.currency)) {
    return decline(
      `Currency ${facts.currency} is not allowed. Allowed: ${allowed.join(', ')}.`,
      undefined,
      {
        text: `Ask the supplier for a price in ${allowed.join(' or ')}.`,
        comply: { action: 'use_currency', currencies: allowed },
      },
    );
  }
  if (!hasRate(facts.currency, ctx.policy)) {
    return decline(`No exchange rate is configured for ${facts.currency}.`, undefined, {
      text: `Ask the supplier for a price in ${ctx.policy.baseCurrency}.`,
      comply: { action: 'use_currency', currencies: [ctx.policy.baseCurrency] },
    });
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
    ? {
        ...result,
        hint: {
          text: 'Choose a supplier based in a country that is not blocked.',
          comply: { action: 'choose_supplier', avoid_country: input.facts.country },
        },
      }
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
      otherSupplier(mandate),
    );
  }
  if (mandate.suppliers.block.some((s) => normalizeName(s) === facts.merchantKey)) {
    return decline(
      `Supplier "${name}" is blocked for this agent.`,
      undefined,
      otherSupplier(mandate),
    );
  }
  if (
    mandate.suppliers.mode === 'allowlist' &&
    !mandate.suppliers.allow.some((s) => normalizeName(s) === facts.merchantKey)
  ) {
    return decline(
      `Supplier "${name}" is not on this agent's approved supplier list.`,
      undefined,
      otherSupplier(mandate),
    );
  }
  return pass(
    mandate.suppliers.mode === 'allowlist'
      ? `Supplier "${name}" is on the approved list.`
      : `Supplier "${name}" is not blocked.`,
  );
};

/** Another supplier: the agent's approved list if it has one. Never other agents' lists. */
function otherSupplier(mandate: Mandate): Hint {
  const approved =
    mandate.suppliers.mode === 'allowlist' && mandate.suppliers.allow.length > 0
      ? mandate.suppliers.allow
      : null;
  return {
    text: approved
      ? `Approved suppliers: ${approved.join(', ')}.`
      : 'Buy from another supplier; never rename this one.',
    comply: { action: 'choose_supplier', approved_suppliers: approved },
  };
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
        {
          text: `You may buy in categories ${mandate.categories.join(', ')}. Never re-label a purchase.`,
          comply: { action: 'choose_category', categories: mandate.categories },
        },
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
        {
          text:
            `Payments up to ${base(mandate.perPaymentLimit, ctx)} are within your limit. Larger ` +
            'purchases need your human; never split them into smaller payments.',
          comply: {
            action: 'stay_within_limit',
            max_amount: base(mandate.perPaymentLimit, ctx),
            max_amount_minor: mandate.perPaymentLimit,
            currency: ctx.policy.baseCurrency,
            split_allowed: false,
          },
        },
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
      budgetHint(
        'daily',
        remaining,
        nextDay(today),
        ctx,
        `Remaining today: ${base(remaining, ctx)}. The daily budget starts again tomorrow.`,
      ),
    );
  }
  return pass(`${base(amt, ctx)} fits today's remaining budget of ${base(remaining, ctx)}.`, data);
};

function budgetHint(
  budget: 'daily' | 'monthly' | 'project',
  remaining: number,
  resetsOn: string | null,
  ctx: EvaluationContext,
  text: string,
): Hint {
  const left = money(remaining, ctx);
  return {
    text,
    comply: {
      action: 'wait_for_budget',
      budget,
      remaining: left.text,
      remaining_minor: left.minor,
      currency: left.currency,
      resets_on: resetsOn,
    },
  };
}

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
      budgetHint(
        'monthly',
        spend.remaining,
        nextMonthStart(spend.month),
        ctx,
        `Remaining this month: ${base(spend.remaining, ctx)}. The monthly budget starts again on ` +
          `${nextMonthStart(spend.month)}.`,
      ),
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
  const today = localTime(ctx.now, ctx.policy.timezone).date;
  const open = (p: Project) => p.ends === undefined || today <= p.ends;
  const mine = projects.filter(
    (p) => (p.agents.length === 0 || p.agents.includes(agent.id)) && open(p),
  );
  const choose: Hint = {
    text:
      mine.length > 0
        ? `Name one of your projects: ${mine.map((p) => `${p.id} (${p.name})`).join(', ')}.`
        : 'No project is open to this agent; tell your human.',
    comply: {
      action: 'name_project',
      projects: mine.map((p) => ({ id: p.id, name: p.name })),
    },
  };
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
  if (!open(project)) {
    return decline(
      `Project "${project.name}" ended on ${project.ends ?? ''}.`,
      { project: project.id, ends: project.ends ?? null },
      choose,
    );
  }
  if (!mine.includes(project)) {
    return decline(
      `This agent may not book to project "${project.name}".`,
      { project: project.id },
      choose,
    );
  }
  facts.projectId = project.id;
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
      budgetHint(
        'project',
        spend.remaining,
        project.period === 'month' && spend.month ? nextMonthStart(spend.month) : null,
        ctx,
        `Project "${project.name}" has ${base(spend.remaining, ctx)} left ${period}. Book to ` +
          'another project only if the purchase really belongs to it.',
      ),
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
        { text: 'Wait a minute before the next request.', comply: { action: 'wait', seconds: 60 } },
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
  const related = prior.map((e) => e.id);
  const data = {
    priorPayments: prior.length,
    relatedPayments: related.join(', '),
    priorSumBase: priorSum,
    totalBase: priorSum + amt,
    limitBase: mandate.perPaymentLimit,
  };
  // A person decides: a genuine second order looks the same as a split, and only they can tell.
  if (prior.length > 0 && priorSum + amt > mandate.perPaymentLimit) {
    return review(
      `Looks like a split payment: ${prior.length} earlier payment(s) to "${request.merchant.trim()}" ` +
        `in the last 10 minutes (${related.join(', ')}) plus this one total ` +
        `${base(priorSum + amt, ctx)}, above the per-payment limit of ` +
        `${base(mandate.perPaymentLimit, ctx)}; a human must approve.`,
      data,
      {
        text:
          'A person will check this together with the earlier payments. Never split a purchase ' +
          'to stay under a limit.',
        comply: { action: 'wait_for_human', reason: 'possible_split', related_payments: related },
      },
    );
  }
  return pass('No split pattern with this supplier in the last 10 minutes.', data);
};

// 11. Fair price -----------------------------------------------------------------------------

/**
 * The reference whose name or match words appear in the text; the longest match wins, and at
 * equal length a price for this supplier beats a general one. A price for another supplier
 * never applies. Without `supplier`, every reference is considered.
 */
export function findReference(
  refs: readonly ReferencePrice[],
  text: string,
  supplier?: string,
): ReferencePrice | undefined {
  const haystack = normalizeName(text);
  if (haystack === '') return undefined;
  const merchant = supplier === undefined ? undefined : normalizeName(supplier);
  let best: ReferencePrice | undefined;
  let bestScore = 0;
  for (const ref of refs) {
    const own = ref.supplier !== undefined && normalizeName(ref.supplier) === merchant;
    if (ref.supplier !== undefined && merchant !== undefined && !own) continue;
    for (const word of [ref.item, ...ref.match]) {
      const needle = normalizeName(word);
      const score = needle.length * 2 + (own ? 1 : 0);
      if (needle !== '' && score > bestScore && haystack.includes(needle)) {
        best = ref;
        bestScore = score;
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
  const ref = findReference(refs, request.item ?? request.memo ?? '', request.merchant);
  if (!ref) return pass('No reference price for this item.', { matched: false });

  const amt = amountBase(facts);
  // In the base currency, through the fx table, rounded up like every other conversion.
  const unitBase = toBaseMinor(ref.priceMinor, normalizeCode(ref.currency), ctx.policy);
  const expected = unitBase * quantity;
  const percent = Math.round(((amt - expected) * 100) / expected);
  const what = `${quantity === 1 ? '' : `${String(quantity)} × `}${ref.item}`;
  const usual =
    `the usual ${base(expected, ctx)}` + (quantity === 1 ? '' : ` (${base(unitBase, ctx)} each)`);
  const data = {
    matched: true,
    item: ref.item,
    quantity,
    referenceBase: unitBase,
    expectedBase: expected,
    differenceBase: amt - expected,
    differencePercent: percent,
  };
  if (amt * 100 > expected * (100 + check.abovePercent)) {
    const detail =
      `${base(amt, ctx)} for ${what} is ${String(percent)}% above ${usual}` +
      ` (tolerance ${String(check.abovePercent)}%)`;
    const ceiling = Math.floor((expected * (100 + check.abovePercent)) / 100);
    const hint: Hint = {
      text:
        `The usual price is ${base(expected, ctx)}; offers up to ${base(ceiling, ctx)} pass this ` +
        'check. Look for a better offer, or name the item and quantity exactly.',
      comply: {
        action: check.above === 'decline' ? 'find_better_offer' : 'wait_for_human',
        reason: 'price_above_usual',
        usual_price: base(expected, ctx),
        usual_price_minor: expected,
        passes_up_to: base(ceiling, ctx),
        passes_up_to_minor: ceiling,
        currency: ctx.policy.baseCurrency,
      },
    };
    return check.above === 'decline'
      ? decline(`${detail}.`, data, hint)
      : review(`${detail}; a human must approve.`, data, hint);
  }
  if (check.belowPercent !== null && amt * 100 < expected * (100 - check.belowPercent)) {
    return review(
      `${base(amt, ctx)} for ${what} is ${String(-percent)}% below ${usual}: unusually cheap, ` +
        'a human must check it is the right product and supplier.',
      data,
      {
        text: 'Check the product, pack size and quantity; a person will confirm the offer.',
        comply: {
          action: 'wait_for_human',
          reason: 'price_below_usual',
          usual_price: base(expected, ctx),
          usual_price_minor: expected,
          currency: ctx.policy.baseCurrency,
        },
      },
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
        {
          text: `Requests inside business hours (${window} ${ctx.policy.timezone}) skip this check.`,
          comply: {
            action: 'wait_for_human',
            reason: 'outside_business_hours',
            business_hours: `${window} ${ctx.policy.timezone}`,
          },
        },
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
        {
          text: `Payments up to ${base(mandate.approvalAbove, ctx)} are approved without a person.`,
          comply: {
            action: 'wait_for_human',
            reason: 'approval_threshold',
            approved_without_a_person_up_to: base(mandate.approvalAbove, ctx),
            approved_without_a_person_up_to_minor: mandate.approvalAbove,
            currency: ctx.policy.baseCurrency,
          },
        },
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
