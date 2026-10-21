import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AmountError, parseAmount } from '../engine/money.js';
import { FxError, parseRate } from '../engine/fx.js';
import { parseClock } from '../engine/time.js';
import type { AgentStatus, GlobalPolicy, Mandate } from '../engine/types.js';

/**
 * mandate.yaml: human-readable, snake_case, money in major units of the base currency.
 * Loading converts it to the engine's types (integer minor units). Unknown keys are errors,
 * so a typo cannot silently drop a rule.
 */

const currencyCode = z
  .string()
  .regex(/^[A-Z]{3,5}$/, 'Use an upper-case currency code such as CHF');
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 code such as DE');
const categoryCode = z.string().regex(/^\d{4}$/, 'Use a four-digit merchant category code');
const money = z.union([z.number().nonnegative(), z.string()]);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const agentSchema = z.strictObject({
  owner: z.string().min(1),
  status: z.enum(['active', 'paused', 'frozen']).default('active'),
  daily_budget: money,
  per_payment_limit: money,
  approval_above: money.optional(),
  currencies: z.array(currencyCode).min(1),
  categories: z.array(categoryCode).min(1),
  suppliers: z
    .strictObject({
      mode: z.enum(['allowlist', 'any']).default('any'),
      allow: z.array(z.string().min(1)).default([]),
      block: z.array(z.string().min(1)).default([]),
    })
    .default({ mode: 'any', allow: [], block: [] }),
  blocked_countries: z.array(countryCode).default([]),
  velocity_per_minute: z.number().int().positive().default(10),
  business_hours_only: z.boolean().default(false),
});

export const configSchema = z.strictObject({
  organisation: z.string().min(1).optional(),
  base_currency: currencyCode,
  timezone: z.string().default('UTC'),
  fx: z.record(currencyCode, z.union([z.number().positive(), z.string()])).default({}),
  currency_decimals: z.record(currencyCode, z.number().int().min(0).max(18)).optional(),
  blocked_countries: z.array(countryCode).default([]),
  blocked_suppliers: z.array(z.string().min(1)).default([]),
  business_hours: z
    .strictObject({
      days: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
      start: clock.default('08:00'),
      end: clock.default('18:00'),
    })
    .default({ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }),
  agents: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'Agent ids use a-z, 0-9, "-" and "_"'),
    agentSchema,
  ),
});

export type RawConfig = z.infer<typeof configSchema>;

export interface AgentConfig {
  id: string;
  owner: string;
  status: AgentStatus;
  mandate: Mandate;
}

export interface MandateConfig {
  /** Shown on credentials issued for these agents. */
  organisation?: string;
  policy: GlobalPolicy;
  agents: Record<string, AgentConfig>;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parseConfig(yamlText: string): MandateConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError(`mandate.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`mandate.yaml is invalid:\n${z.prettifyError(result.error)}`);
  }
  return toEngine(result.data);
}

function toEngine(raw: RawConfig): MandateConfig {
  const problems: string[] = [];
  const baseCurrency = raw.base_currency;
  const decimals = raw.currency_decimals;

  for (const [code, rate] of Object.entries(raw.fx)) {
    try {
      parseRate(rate);
    } catch (err) {
      problems.push(`fx.${code}: ${(err as FxError).message}`);
    }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone });
  } catch {
    problems.push(`timezone: "${raw.timezone}" is not an IANA time zone`);
  }
  const startMinute = parseClock(raw.business_hours.start);
  const endMinute = parseClock(raw.business_hours.end);
  if (endMinute <= startMinute) problems.push('business_hours: end must be after start');

  const toMinor = (path: string, value: string | number): number => {
    try {
      return parseAmount(value, baseCurrency, decimals);
    } catch (err) {
      problems.push(`${path}: ${(err as AmountError).message}`);
      return 0;
    }
  };

  const agents: Record<string, AgentConfig> = {};
  for (const [id, a] of Object.entries(raw.agents)) {
    const path = `agents.${id}`;
    for (const c of a.currencies) {
      if (c !== baseCurrency && !Object.hasOwn(raw.fx, c)) {
        problems.push(`${path}.currencies: ${c} has no rate in fx`);
      }
    }
    if (a.suppliers.mode === 'allowlist' && a.suppliers.allow.length === 0) {
      problems.push(`${path}.suppliers: allowlist mode needs at least one supplier in allow`);
    }
    const mandate: Mandate = {
      dailyBudget: toMinor(`${path}.daily_budget`, a.daily_budget),
      perPaymentLimit: toMinor(`${path}.per_payment_limit`, a.per_payment_limit),
      approvalAbove:
        a.approval_above === undefined ? null : toMinor(`${path}.approval_above`, a.approval_above),
      currencies: a.currencies,
      categories: a.categories,
      suppliers: a.suppliers,
      blockedCountries: a.blocked_countries,
      velocityPerMinute: a.velocity_per_minute,
      businessHoursOnly: a.business_hours_only,
    };
    agents[id] = { id, owner: a.owner, status: a.status, mandate };
  }

  if (problems.length > 0) {
    throw new ConfigError(`mandate.yaml is invalid:\n${problems.map((p) => `✖ ${p}`).join('\n')}`);
  }

  const policy: GlobalPolicy = {
    baseCurrency,
    fx: raw.fx,
    blockedCountries: raw.blocked_countries,
    blockedSuppliers: raw.blocked_suppliers,
    timezone: raw.timezone,
    businessHours: { days: raw.business_hours.days, startMinute, endMinute },
  };
  if (decimals) policy.currencyDecimals = decimals;
  return raw.organisation ? { organisation: raw.organisation, policy, agents } : { policy, agents };
}
