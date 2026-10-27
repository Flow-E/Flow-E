/**
 * Display formatting. Pure and client-safe (no core imports): amounts arrive as integer minor
 * units with their currency's number of decimals.
 */

const DECIMALS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  USDC: 6,
};

export function decimalsOf(currency: string, overrides?: Readonly<Record<string, number>>): number {
  return overrides?.[currency] ?? DECIMALS[currency] ?? 2;
}

/** 650000 CHF -> "CHF 6,500.00" */
export function money(
  minor: number | null,
  currency: string,
  overrides?: Readonly<Record<string, number>>,
): string {
  if (minor === null) return '—';
  const d = decimalsOf(currency, overrides);
  const negative = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const scale = 10n ** BigInt(d);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = d > 0 ? `.${(abs % scale).toString().padStart(d, '0')}` : '';
  return `${currency} ${negative ? '-' : ''}${whole}${fraction}`;
}

export function dateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

export function time(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Human names for the engine's rule ids. */
export const RULE_NAMES: Readonly<Record<string, string>> = {
  KILL_SWITCH: 'Kill switch',
  AGENT_STATUS: 'Agent status',
  KYA_CREDENTIAL: 'Know Your Agent credential',
  AMOUNT: 'Amount',
  CURRENCY: 'Currency',
  COUNTRY: 'Country',
  SUPPLIER: 'Supplier',
  CATEGORY: 'Category',
  PER_PAYMENT_LIMIT: 'Per-payment limit',
  DAILY_BUDGET: 'Daily budget',
  VELOCITY: 'Velocity',
  SPLIT_DETECTION: 'Split detection',
  FAIR_PRICE: 'Fair price',
  BUSINESS_HOURS: 'Business hours',
  APPROVAL_THRESHOLD: 'Approval threshold',
  COOLING_OFF: 'Cooling-off',
  INTERNAL: 'Internal error',
};

export function ruleName(rule: string | null): string {
  return rule ? (RULE_NAMES[rule] ?? rule) : 'All rules passed';
}
