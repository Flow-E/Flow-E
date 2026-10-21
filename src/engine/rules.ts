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

export type RuleResult = Omit<TraceEntry, 'rule'>;
export type Rule = (input: RuleInput) => RuleResult;

const pass = (detail: string, data?: TraceEntry['data']): RuleResult =>
  data ? { outcome: 'pass', detail, data } : { outcome: 'pass', detail };
const decline = (detail: string, data?: TraceEntry['data']): RuleResult =>
  data ? { outcome: 'decline', detail, data } : { outcome: 'decline', detail };
const review = (detail: string, data?: TraceEntry['data']): RuleResult =>
  data ? { outcome: 'review', detail, data } : { outcome: 'review', detail };

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
    ? decline('The global kill switch is on. All payments are blocked.')
    : pass('Kill switch is off.');

const agentStatus: Rule = ({ agent }) =>
  agent.status === 'active'
    ? pass(`Agent "${agent.id}" is active.`)
    : decline(`Agent "${agent.id}" is ${agent.status}.`, { status: agent.status });

// 2. Know Your Agent credential --------------------------------------------------------------

const kyaCredential: Rule = ({ agent, ctx }) => {
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
};

// 3. Amount and currency ---------------------------------------------------------------------

const amount: Rule = ({ request }) =>
  Number.isSafeInteger(request.amount) && request.amount > 0
    ? pass('Amount is above 0.', { amountMinor: request.amount })
    : decline('Amount must be a whole number of minor units above 0.', {
        amountMinor: Number.isFinite(request.amount) ? request.amount : null,
      });

const currency: Rule = ({ mandate, ctx, facts, request }) => {
  const allowed = mandate.currencies.map(normalizeCode);
  if (!allowed.includes(facts.currency)) {
    return decline(`Currency ${facts.currency} is not allowed. Allowed: ${allowed.join(', ')}.`);
  }
  if (!hasRate(facts.currency, ctx.policy)) {
    return decline(`No exchange rate is configured for ${facts.currency}.`);
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

const country: Rule = ({ mandate, ctx, facts }) => {
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
};

// 5. Supplier --------------------------------------------------------------------------------

const supplier: Rule = ({ mandate, ctx, facts, request }) => {
  if (facts.merchantKey === '') return decline('Supplier name is empty.');
  const name = request.merchant.trim();
  if (ctx.policy.blockedSuppliers.some((s) => normalizeName(s) === facts.merchantKey)) {
    return decline(`Supplier "${name}" is on the organisation's blocklist.`);
  }
  if (mandate.suppliers.block.some((s) => normalizeName(s) === facts.merchantKey)) {
    return decline(`Supplier "${name}" is blocked for this agent.`);
  }
  if (
    mandate.suppliers.mode === 'allowlist' &&
    !mandate.suppliers.allow.some((s) => normalizeName(s) === facts.merchantKey)
  ) {
    return decline(`Supplier "${name}" is not on this agent's approved supplier list.`);
  }
  return pass(
    mandate.suppliers.mode === 'allowlist'
      ? `Supplier "${name}" is on the approved list.`
      : `Supplier "${name}" is not blocked.`,
  );
};

// 6. Category --------------------------------------------------------------------------------

const category: Rule = ({ mandate, request }) => {
  const code = request.category.trim();
  if (!/^\d{4}$/.test(code)) return decline(`"${code}" is not a four-digit category code.`);
  return mandate.categories.includes(code)
    ? pass(`Category ${code} is allowed.`)
    : decline(`Category ${code} is not allowed. Allowed: ${mandate.categories.join(', ')}.`);
};

// 7. Per-payment limit -----------------------------------------------------------------------

const perPaymentLimit: Rule = ({ mandate, ctx, facts }) => {
  const amt = amountBase(facts);
  const data = { amountBase: amt, limitBase: mandate.perPaymentLimit };
  return amt > mandate.perPaymentLimit
    ? decline(
        `${base(amt, ctx)} is above the per-payment limit of ${base(mandate.perPaymentLimit, ctx)}.`,
        data,
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
    );
  }
  return pass(`${base(amt, ctx)} fits today's remaining budget of ${base(remaining, ctx)}.`, data);
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
      )
    : pass(`${recent} of ${mandate.velocityPerMinute} payment requests used this minute.`, data);
};

// 10. Split detection ------------------------------------------------------------------------

const splitDetection: Rule = ({ mandate, ctx, facts, request }) => {
  const amt = amountBase(facts);
  const since = ctx.now - SPLIT_WINDOW_MS;
  const prior = ctx.ledger.filter(
    (e) =>
      activeStatuses.has(e.status) &&
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
  if (prior.length > 0 && priorSum + amt > mandate.perPaymentLimit) {
    return decline(
      `Looks like a split payment: ${prior.length} earlier payment(s) to "${request.merchant.trim()}" ` +
        `in the last 10 minutes plus this one total ${base(priorSum + amt, ctx)}, above the ` +
        `per-payment limit of ${base(mandate.perPaymentLimit, ctx)}.`,
      data,
    );
  }
  return pass('No split pattern with this supplier in the last 10 minutes.', data);
};

// 11. Business hours (soft) ------------------------------------------------------------------

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
      );
};

// 12. Human-approval threshold (soft) --------------------------------------------------------

const approvalThreshold: Rule = ({ mandate, ctx, facts }) => {
  const amt = amountBase(facts);
  if (mandate.approvalAbove === null) return pass('No human-approval threshold is set.');
  const data = { amountBase: amt, thresholdBase: mandate.approvalAbove };
  return amt > mandate.approvalAbove
    ? review(
        `${base(amt, ctx)} is above the approval threshold of ${base(mandate.approvalAbove, ctx)}; ` +
          'a human must approve.',
        data,
      )
    : pass(`${base(amt, ctx)} is within the approval threshold.`, data);
};

// 13. Cooling-off (note only; the evaluator sets the cancellation window) --------------------

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
  ['VELOCITY', velocity],
  ['SPLIT_DETECTION', splitDetection],
  ['BUSINESS_HOURS', businessHours],
  ['APPROVAL_THRESHOLD', approvalThreshold],
  ['COOLING_OFF', coolingOff],
];
