import { evaluate } from '../../src/engine/evaluate.js';
import type {
  AgentState,
  Credential,
  EvaluationContext,
  EvaluationResult,
  GlobalPolicy,
  LedgerEntryView,
  Mandate,
  PaymentRequest,
} from '../../src/engine/types.js';

/** Wednesday 21 Oct 2026, 12:00 in Zurich (10:00 UTC). */
export const NOW = Date.parse('2026-10-21T10:00:00Z');
export const MINUTE = 60_000;

export const ISSUER = 'local-issuer:test';

export function credential(overrides: Partial<Credential['claims']> = {}): Credential {
  return {
    claims: {
      issuer: ISSUER,
      agent_id: 'lab-procurement',
      agent_name: 'Lab procurement agent',
      owner: 'M. Keller, Head of Lab',
      organisation: 'Example Labs (fictional)',
      scope: ['payments:request'],
      issued_at: '2026-10-01T00:00:00Z',
      expires_at: '2027-10-01T00:00:00Z',
      ...overrides,
    },
    signature: 'valid',
  };
}

export function policy(overrides: Partial<GlobalPolicy> = {}): GlobalPolicy {
  return {
    baseCurrency: 'CHF',
    fx: { EUR: 0.93, USD: '0.80', USDC: 0.8 },
    blockedCountries: ['RU', 'BY', 'IR', 'KP'],
    blockedSuppliers: ['Shadow Chemicals Ltd'],
    timezone: 'Europe/Zurich',
    businessHours: { days: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 18 * 60 },
    ...overrides,
  };
}

export function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    dailyBudget: 2_000_000,
    perPaymentLimit: 800_000,
    approvalAbove: 500_000,
    currencies: ['CHF', 'EUR'],
    categories: ['5169', '5047'],
    suppliers: { mode: 'allowlist', allow: ['Alpine Reagents AG', 'Basel Labware AG'], block: [] },
    blockedCountries: [],
    velocityPerMinute: 6,
    businessHoursOnly: false,
    ...overrides,
  };
}

export function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    merchant: 'Alpine Reagents AG',
    amount: 120_000,
    currency: 'CHF',
    category: '5169',
    country: 'CH',
    memo: 'Buffer solution, 10 L',
    ...overrides,
  };
}

let seq = 0;
export function entry(overrides: Partial<LedgerEntryView> = {}): LedgerEntryView {
  seq += 1;
  return {
    id: `pay_${seq}`,
    merchant: 'Alpine Reagents AG',
    amountBase: 10_000,
    status: 'approved',
    createdAt: NOW - 3 * 60 * MINUTE,
    ...overrides,
  };
}

export interface Scenario {
  agent?: Partial<AgentState>;
  mandate?: Partial<Mandate>;
  request?: Partial<PaymentRequest>;
  context?: Partial<EvaluationContext>;
  policy?: Partial<GlobalPolicy>;
}

export function context(s: Scenario = {}): EvaluationContext {
  return {
    now: NOW,
    killSwitch: false,
    ledger: [],
    policy: policy(s.policy),
    kya: {
      issuer: ISSUER,
      requiredScope: 'payments:request',
      verifySignature: (c) =>
        c.signature === 'valid'
          ? { valid: true }
          : { valid: false, reason: 'signature does not match the issuer key' },
    },
    ...s.context,
  };
}

export function run(s: Scenario = {}): EvaluationResult {
  const agent: AgentState = {
    id: 'lab-procurement',
    status: 'active',
    credential: credential(),
    ...s.agent,
  };
  return evaluate(agent, mandate(s.mandate), request(s.request), context(s));
}

export function traceOf(result: EvaluationResult, rule: string) {
  const found = result.trace.find((t) => t.rule === rule);
  if (!found) throw new Error(`no trace entry for ${rule}`);
  return found;
}
