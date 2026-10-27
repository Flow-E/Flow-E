import { normalizeCode, normalizeName } from './normalize.js';
import { COOLING_OFF_MS, RULES, type Facts } from './rules.js';
import type {
  AgentState,
  EvaluationContext,
  EvaluationResult,
  Mandate,
  PaymentRequest,
  TraceEntry,
} from './types.js';

/**
 * Evaluate a payment request against an agent's mandate.
 *
 * Rules run in a fixed order. The first decline stops evaluation; later rules are traced as
 * skipped. Business hours and the approval threshold only flag `review`, which applies when
 * every hard rule passed. Any error inside the engine yields `declined` ("internal error").
 *
 * Pure: no I/O and no clock reads; everything comes in through the arguments.
 */
export function evaluate(
  agent: AgentState,
  mandate: Mandate,
  request: PaymentRequest,
  context: EvaluationContext,
): EvaluationResult {
  const trace: TraceEntry[] = [];
  const facts: Facts = {
    currency: '',
    country: '',
    merchantKey: '',
    amountBase: null,
  };
  try {
    facts.currency = normalizeCode(request.currency);
    facts.country = normalizeCode(request.country);
    facts.merchantKey = normalizeName(request.merchant);

    const reviews: TraceEntry[] = [];
    const hints = new Map<TraceEntry, string>();
    let newSupplier = false;

    for (const [index, [rule, run]] of RULES.entries()) {
      const { hint, ...result } = run({ agent, mandate, request, ctx: context, facts });
      const entry: TraceEntry = { rule, ...result };
      trace.push(entry);
      if (hint) hints.set(entry, hint);

      if (result.outcome === 'decline') {
        for (const [skipped] of RULES.slice(index + 1)) {
          trace.push({
            rule: skipped,
            outcome: 'skip',
            detail: 'Not evaluated: an earlier rule declined.',
          });
        }
        return {
          decision: 'declined',
          rule,
          reason: result.detail,
          trace,
          amountBase: facts.amountBase,
          ...(hint ? { guidance: hint } : {}),
        };
      }
      if (result.outcome === 'review') reviews.push(entry);
      if (rule === 'COOLING_OFF') newSupplier = result.data?.newSupplier === true;
    }

    const [firstReview] = reviews;
    if (firstReview) {
      if (newSupplier) {
        appendToLast(trace, ' Cooling-off will apply if a human approves.');
      }
      const guidance = reviews.flatMap((r) => hints.get(r) ?? []).join(' ');
      return {
        decision: 'review',
        rule: firstReview.rule,
        reason: reviews.map((r) => r.detail).join(' '),
        trace,
        amountBase: facts.amountBase,
        ...(guidance ? { guidance } : {}),
      };
    }

    const approved: EvaluationResult = {
      decision: 'approved',
      rule: null,
      reason: 'All rules passed.',
      trace,
      amountBase: facts.amountBase,
    };
    if (newSupplier) {
      const until = context.now + COOLING_OFF_MS;
      approved.cancellableUntil = until;
      approved.reason += ` First payment to this supplier: cancellable until ${new Date(until).toISOString()}.`;
      appendToLast(trace, ` Cancellable for 10 minutes, until ${new Date(until).toISOString()}.`);
    }
    return approved;
  } catch {
    // Fail closed. The error itself is not echoed: it could carry input the agent controls.
    trace.push({ rule: 'INTERNAL', outcome: 'decline', detail: 'internal error' });
    return {
      decision: 'declined',
      rule: 'INTERNAL',
      reason: 'internal error',
      trace,
      amountBase: facts.amountBase,
    };
  }
}

function appendToLast(trace: TraceEntry[], text: string): void {
  const last = trace.at(-1);
  if (last) last.detail += text;
}
