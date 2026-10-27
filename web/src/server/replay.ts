import {
  evaluate,
  foldPayments,
  type Credential,
  type Decision,
  type LedgerEntryView,
  type MandateConfig,
  type PaymentRecord,
  type StoredEntry,
} from '@flow-e/mcp/core';

/**
 * "What if": replay the requests of the last days against a proposed mandate, with the same
 * engine, before the change is saved. Pure: nothing is written.
 *
 * Assumptions, shown to the person with the result:
 * - Requests stopped for reasons a mandate cannot change (kill switch, a frozen or paused agent,
 *   a credential problem) keep their original decision.
 * - A request the new rules send to a person counts as approved only if a person approved it
 *   at the time, and as waiting otherwise; budgets count it either way, as they do live.
 * - Agents ask the same things in the same order; in reality an agent would adapt.
 */

export const REPLAY_DAYS = 30;
const DAY = 86_400_000;
const KEEP_RULES = new Set(['KILL_SWITCH', 'AGENT_STATUS', 'KYA_CREDENTIAL', 'INTERNAL']);

export interface ReplayCounts {
  approved: number;
  review: number;
  declined: number;
  /** Base minor units of the requests counted as approved. */
  approvedAmount: number;
}

export interface ReplayChange {
  paymentId: string;
  agentId: string;
  merchant: string;
  what: string;
  amountBase: number | null;
  createdAt: string;
  before: Decision;
  after: Decision;
  /** The new rules' reason, when it is not an approval. */
  reason: string | null;
}

export interface ReplayResult {
  days: number;
  requests: number;
  before: ReplayCounts;
  after: ReplayCounts;
  changes: ReplayChange[];
  /** More changes than listed. */
  more: number;
}

function credentialFor(config: MandateConfig, agentId: string, issuer: string): Credential {
  return {
    claims: {
      issuer,
      agent_id: agentId,
      agent_name: agentId,
      owner: config.agents[agentId]?.owner ?? '',
      organisation: config.organisation ?? '',
      scope: ['payments:request'],
      issued_at: '1970-01-01T00:00:00Z',
      expires_at: '9999-12-31T00:00:00Z',
    },
    signature: 'replay',
  };
}

function count(list: readonly { decision: Decision; counted: boolean; amount: number }[]) {
  const c: ReplayCounts = { approved: 0, review: 0, declined: 0, approvedAmount: 0 };
  for (const x of list) {
    c[x.decision === 'approved' ? 'approved' : x.decision === 'review' ? 'review' : 'declined'] +=
      1;
    if (x.counted) c.approvedAmount += x.amount;
  }
  return c;
}

export function replay(input: {
  entries: readonly StoredEntry[];
  proposed: MandateConfig;
  now: number;
  days?: number;
  limit?: number;
}): ReplayResult {
  const days = input.days ?? REPLAY_DAYS;
  const since = input.now - days * DAY;
  const all = foldPayments(input.entries);
  const window = all.filter((p) => Date.parse(p.createdAt) >= since);
  // Earlier payments still count towards budgets and split windows as they stand.
  const history: { agentId: string; view: LedgerEntryView }[] = all
    .filter((p) => Date.parse(p.createdAt) < since)
    .map((p) => ({ agentId: p.agentId, view: view(p, p.status, p.amountBase ?? 0) }));

  const issuer = 'replay';
  const before: { decision: Decision; counted: boolean; amount: number }[] = [];
  const after: { decision: Decision; counted: boolean; amount: number }[] = [];
  const changes: ReplayChange[] = [];

  for (const p of window) {
    const amount = p.amountBase ?? 0;
    before.push({ decision: p.engineDecision, counted: p.status === 'approved', amount });
    const agent = input.proposed.agents[p.agentId];
    let decision: Decision = p.engineDecision;
    let reason: string | null = p.engineDecision === 'approved' ? null : p.reason;
    let amountBase = p.amountBase;
    if (agent && !(p.rule !== null && KEEP_RULES.has(p.rule))) {
      const at = Date.parse(p.createdAt);
      const result = evaluate(
        {
          id: agent.id,
          status: 'active',
          credential: credentialFor(input.proposed, agent.id, issuer),
        },
        { ...agent.mandate },
        { ...p.request },
        {
          now: at,
          killSwitch: false,
          ledger: history.filter((h) => h.agentId === p.agentId).map((h) => h.view),
          organisationLedger: history.map((h) => h.view),
          policy: input.proposed.policy,
          kya: {
            issuer,
            requiredScope: 'payments:request',
            verifySignature: () => ({ valid: true }),
          },
        },
      );
      decision = result.decision;
      reason = decision === 'approved' ? null : result.reason;
      amountBase = result.amountBase ?? p.amountBase;
    }
    // A review counts as approved only if a person approved it at the time; else it waits.
    const status: LedgerEntryView['status'] =
      decision === 'declined'
        ? 'declined'
        : decision === 'approved'
          ? 'approved'
          : p.status === 'approved' && p.engineDecision === 'review'
            ? 'approved'
            : 'review';
    history.push({ agentId: p.agentId, view: view(p, status, amountBase ?? 0) });
    after.push({ decision, counted: status === 'approved', amount: amountBase ?? 0 });
    if (decision !== p.engineDecision) {
      changes.push({
        paymentId: p.paymentId,
        agentId: p.agentId,
        merchant: p.request.merchant,
        what: p.request.item ?? p.request.memo ?? '',
        amountBase: amountBase,
        createdAt: p.createdAt,
        before: p.engineDecision,
        after: decision,
        reason,
      });
    }
  }

  const limit = input.limit ?? 12;
  const newest = changes.reverse();
  return {
    days,
    requests: window.length,
    before: count(before),
    after: count(after),
    changes: newest.slice(0, limit),
    more: Math.max(0, newest.length - limit),
  };
}

function view(p: PaymentRecord, status: LedgerEntryView['status'], amountBase: number) {
  return {
    id: p.paymentId,
    merchant: p.request.merchant,
    amountBase,
    status,
    createdAt: Date.parse(p.createdAt),
    rule: p.rule,
    ...(p.request.project === undefined ? {} : { project: p.request.project }),
  } satisfies LedgerEntryView;
}
