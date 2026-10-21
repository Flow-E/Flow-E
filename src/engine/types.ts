/**
 * Types for the policy engine. All money is in integer minor units (cents, rappen, …).
 * Amounts named `*Base` are in the base currency; everything else is in the request currency.
 */

export type Decision = 'approved' | 'declined' | 'review';
export type AgentStatus = 'active' | 'paused' | 'frozen';

/** Rule ids, in evaluation order. */
export const RULE_ORDER = [
  'KILL_SWITCH',
  'AGENT_STATUS',
  'KYA_CREDENTIAL',
  'AMOUNT',
  'CURRENCY',
  'COUNTRY',
  'SUPPLIER',
  'CATEGORY',
  'PER_PAYMENT_LIMIT',
  'DAILY_BUDGET',
  'VELOCITY',
  'SPLIT_DETECTION',
  'BUSINESS_HOURS',
  'APPROVAL_THRESHOLD',
  'COOLING_OFF',
] as const;
export type RuleId = (typeof RULE_ORDER)[number];

export interface PaymentRequest {
  merchant: string;
  /** Integer minor units of `currency`. */
  amount: number;
  currency: string;
  /** Merchant category code, four digits. */
  category: string;
  /** ISO 3166-1 alpha-2 country of the supplier. */
  country: string;
  memo?: string;
}

export interface SupplierPolicy {
  /** `allowlist`: only suppliers in `allow`. `any`: every supplier not blocked. */
  mode: 'allowlist' | 'any';
  allow: readonly string[];
  block: readonly string[];
}

/** One agent's mandate. Limits are integer minor units of the base currency. */
export interface Mandate {
  dailyBudget: number;
  perPaymentLimit: number;
  /** Payments above this go to human review. `null` means never. */
  approvalAbove: number | null;
  currencies: readonly string[];
  categories: readonly string[];
  suppliers: SupplierPolicy;
  blockedCountries: readonly string[];
  velocityPerMinute: number;
  businessHoursOnly: boolean;
}

/** Claims of a Know Your Agent credential. Signed by the local issuer (see src/kya). */
export interface CredentialClaims {
  issuer: string;
  agent_id: string;
  agent_name: string;
  owner: string;
  organisation: string;
  scope: readonly string[];
  /** ISO 8601 timestamps. */
  issued_at: string;
  expires_at: string;
}

export interface Credential {
  claims: CredentialClaims;
  /** Base64url Ed25519 signature over the canonical claims. */
  signature: string;
}

export interface AgentState {
  id: string;
  /** Effective status, after any freeze applied by a human. */
  status: AgentStatus;
  credential: Credential | null;
}

export type SignatureCheck = (
  credential: Credential,
) => { valid: true } | { valid: false; reason: string };

export interface BusinessHours {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: readonly number[];
  /** Minutes after local midnight; the window is [startMinute, endMinute). */
  startMinute: number;
  endMinute: number;
}

/** Organisation-wide settings shared by every agent. */
export interface GlobalPolicy {
  baseCurrency: string;
  /** Base-currency units per one unit of the key currency, as a decimal (e.g. EUR: "0.93"). */
  fx: Readonly<Record<string, string | number>>;
  /** Overrides for currency minor-unit digits (defaults: 2, JPY 0, USDC 6, …). */
  currencyDecimals?: Readonly<Record<string, number>>;
  /** Always-blocked countries. Demo list only; not a sanctions screening. */
  blockedCountries: readonly string[];
  /** Suppliers no agent may pay. */
  blockedSuppliers: readonly string[];
  /** IANA time zone used for "today" and business hours. */
  timezone: string;
  businessHours: BusinessHours;
}

/** What the engine needs to know about one prior payment of this agent. */
export interface LedgerEntryView {
  id: string;
  merchant: string;
  amountBase: number;
  status: 'approved' | 'declined' | 'review' | 'cancelled';
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface EvaluationContext {
  /** Epoch milliseconds. The engine never reads the clock itself. */
  now: number;
  killSwitch: boolean;
  /** This agent's prior payments. */
  ledger: readonly LedgerEntryView[];
  policy: GlobalPolicy;
  kya: {
    issuer: string;
    requiredScope: string;
    verifySignature: SignatureCheck;
  };
}

export type TraceOutcome = 'pass' | 'decline' | 'review' | 'note' | 'skip';

export interface TraceEntry {
  rule: RuleId | 'INTERNAL';
  outcome: TraceOutcome;
  detail: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface EvaluationResult {
  decision: Decision;
  /** The rule that decided a decline or review; `null` when approved. */
  rule: RuleId | 'INTERNAL' | null;
  reason: string;
  trace: TraceEntry[];
  /** Request amount converted to base minor units, once known. */
  amountBase: number | null;
  /** Set on the first approved payment to a new supplier. Epoch milliseconds. */
  cancellableUntil?: number;
}
