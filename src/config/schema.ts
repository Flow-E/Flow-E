import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AmountError, parseAmount } from '../engine/money.js';
import { FxError, parseRate } from '../engine/fx.js';
import { parseClock } from '../engine/time.js';
import { normalizeName } from '../engine/normalize.js';
import type {
  AgentStatus,
  GlobalPolicy,
  Mandate,
  Project,
  ReferencePrice,
} from '../engine/types.js';

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
  monthly_budget: money.optional(),
  require_project: z.boolean().default(false),
});

const projectId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'Project ids use letters, digits, ".", "-" and "_"');

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
  reference_prices: z
    .array(
      z.strictObject({
        /** Stable id; default: a slug of the item name (and the supplier, when set). */
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'Use a-z, 0-9 and "-" for a price-list id')
          .optional(),
        item: z.string().trim().min(1).max(200),
        match: z.array(z.string().trim().min(2).max(100)).max(20).default([]),
        price: money,
        /** The price's currency; default the base currency. Converted through `fx`. */
        currency: currencyCode.optional(),
        /** Only for this supplier; without it, for every supplier. */
        supplier: z.string().trim().min(1).max(200).optional(),
        unit: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .max(1000)
    .default([]),
  invoice_check: z
    .strictObject({
      tolerance_percent: z.number().min(0).max(50).default(2),
      tolerance_min: money.default(5),
    })
    .default({ tolerance_percent: 2, tolerance_min: 5 }),
  price_check: z
    .strictObject({
      above_percent: z.number().int().min(0).max(1000).default(20),
      below_percent: z.number().int().min(1).max(99).nullable().default(50),
      above: z.enum(['review', 'decline']).default('review'),
    })
    .default({ above_percent: 20, below_percent: 50, above: 'review' }),
  projects: z
    .record(
      projectId,
      z.strictObject({
        name: z.string().trim().min(1).max(100),
        budget: money,
        period: z.enum(['month', 'total']).default('month'),
        agents: z.array(z.string()).default([]),
        /** Last day purchases may be booked to it, YYYY-MM-DD in the organisation's time zone. */
        ends: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-06-30')
          .optional(),
      }),
    )
    .default({}),
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
  return parseConfigObject(raw);
}

/** Validate an already-parsed mandate (e.g. JSON from a database) with the same rules. */
export function parseConfigObject(raw: unknown): MandateConfig {
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
      monthlyBudget:
        a.monthly_budget === undefined ? null : toMinor(`${path}.monthly_budget`, a.monthly_budget),
      requireProject: a.require_project,
    };
    agents[id] = { id, owner: a.owner, status: a.status, mandate };
  }

  const projects: Project[] = [];
  const projectNames = new Set<string>();
  for (const [id, p] of Object.entries(raw.projects)) {
    const path = `projects.${id}`;
    for (const agentId of p.agents) {
      if (!Object.hasOwn(raw.agents, agentId))
        problems.push(`${path}.agents: no agent "${agentId}"`);
    }
    const key = normalizeName(p.name);
    if (projectNames.has(key)) problems.push(`${path}.name: "${p.name}" is used twice`);
    projectNames.add(key);
    if (p.ends !== undefined && Number.isNaN(Date.parse(`${p.ends}T00:00:00Z`))) {
      problems.push(`${path}.ends: "${p.ends}" is not a date`);
    }
    projects.push({
      id,
      name: p.name,
      budgetBase: toMinor(`${path}.budget`, p.budget),
      period: p.period,
      agents: p.agents,
      ...(p.ends === undefined ? {} : { ends: p.ends }),
    });
  }
  for (const [id, a] of Object.entries(raw.agents)) {
    if (
      a.require_project &&
      !projects.some((p) => p.agents.length === 0 || p.agents.includes(id))
    ) {
      problems.push(`agents.${id}.require_project: no project is open to this agent`);
    }
  }

  const referencePrices: ReferencePrice[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const [i, r] of raw.reference_prices.entries()) {
    const path = `reference_prices[${String(i)}]`;
    const key = `${normalizeName(r.item)}\u0000${normalizeName(r.supplier ?? '')}`;
    if (seen.has(key)) {
      problems.push(
        `${path}: "${r.item}"${r.supplier ? ` from ${r.supplier}` : ''} is listed twice`,
      );
    }
    seen.add(key);
    const currency = r.currency ?? baseCurrency;
    if (currency !== baseCurrency && !Object.hasOwn(raw.fx, currency)) {
      problems.push(`${path}.currency: ${currency} has no rate in fx`);
    }
    let priceMinor = 0;
    try {
      priceMinor = parseAmount(r.price, currency, decimals);
    } catch (err) {
      problems.push(`${path}.price: ${(err as AmountError).message}`);
    }
    if (priceMinor === 0) problems.push(`${path}.price: must be above 0`);
    const id = r.id ?? priceListId(r.item, r.supplier);
    if (ids.has(id)) problems.push(`${path}.id: "${id}" is used twice`);
    ids.add(id);
    const ref: ReferencePrice = { id, item: r.item, match: r.match, priceMinor, currency };
    if (r.supplier !== undefined) ref.supplier = r.supplier;
    if (r.unit !== undefined) ref.unit = r.unit;
    referencePrices.push(ref);
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
    referencePrices,
    projects,
    invoiceCheck: {
      tolerancePercent: raw.invoice_check.tolerance_percent,
      toleranceMinBase: toMinor('invoice_check.tolerance_min', raw.invoice_check.tolerance_min),
    },
    priceCheck: {
      abovePercent: raw.price_check.above_percent,
      belowPercent: raw.price_check.below_percent,
      above: raw.price_check.above,
    },
  };
  if (decimals) policy.currencyDecimals = decimals;
  return raw.organisation ? { organisation: raw.organisation, policy, agents } : { policy, agents };
}

/** "Pipette tips, 20 racks" from "Example Labware AG" → "pipette-tips-20-racks--example-labware-ag". */
export function priceListId(item: string, supplier?: string): string {
  const slug = (t: string) =>
    t
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item';
  return supplier ? `${slug(item)}--${slug(supplier)}`.slice(0, 100) : slug(item);
}
