import { z } from 'zod';
import type { MandateFields } from '@/app/sandbox/mandate/mandate-form';
import { text, texts } from './form';

/**
 * The stored mandate (mandate.yaml as JSON) shaped into form values, and a submitted form shaped
 * back into a mandate. The result is validated by the core's config schema in the store; nothing
 * here is trusted.
 */

type Raw = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const arr = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);

export function mandateFields(raw: Raw, baseCurrency: string): MandateFields {
  const hours = (raw.business_hours ?? {}) as Raw;
  const check = (raw.price_check ?? {}) as Raw;
  const agents = (raw.agents ?? {}) as Record<string, Raw>;
  return {
    baseCurrency,
    timezone: str(raw.timezone ?? 'UTC'),
    fx: Object.entries((raw.fx ?? {}) as Raw).map(([k, v]) => [k, str(v)]),
    blocked_countries: arr(raw.blocked_countries).join(', '),
    blocked_suppliers: arr(raw.blocked_suppliers).join('\n'),
    days: Array.isArray(hours.days) ? hours.days.map(Number) : [1, 2, 3, 4, 5],
    start: str(hours.start ?? '08:00'),
    end: str(hours.end ?? '18:00'),
    prices: (Array.isArray(raw.reference_prices) ? (raw.reference_prices as Raw[]) : [])
      .map((r) =>
        [str(r.item), str(r.price), arr(r.match).join(', '), str(r.unit)]
          .join(' | ')
          .replace(/( \| )+$/, ''),
      )
      .join('\n'),
    above_percent: str(check.above_percent ?? 20),
    below_percent: check.below_percent === null ? '' : str(check.below_percent ?? 50),
    price_action: str(check.above ?? 'review'),
    agents: Object.entries(agents).map(([id, a]) => {
      const suppliers = (a.suppliers ?? {}) as Raw;
      return {
        id,
        owner: str(a.owner),
        status: str(a.status ?? 'active'),
        daily_budget: str(a.daily_budget),
        per_payment_limit: str(a.per_payment_limit),
        approval_above: str(a.approval_above),
        currencies: arr(a.currencies).join(', '),
        categories: arr(a.categories).join(', '),
        supplier_mode: str(suppliers.mode ?? 'any'),
        allow: arr(suppliers.allow).join('\n'),
        block: arr(suppliers.block).join('\n'),
        blocked_countries: arr(a.blocked_countries).join(', '),
        velocity_per_minute: str(a.velocity_per_minute ?? 10),
        business_hours_only: a.business_hours_only === true,
      };
    }),
  };
}

const list = (value: string, separator: RegExp) =>
  value
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s !== '');
export const codes = (value: string) => list(value, /[\s,]+/).map((s) => s.toUpperCase());
const lines = (value: string) => list(value, /\r?\n/);

const agentIds = z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)).max(100);

/** "EUR 0.94" per line → { EUR: "0.94" }. */
function fxFromLines(value: string): Record<string, string> {
  const fx: Record<string, string> = {};
  for (const line of lines(value)) {
    const [code, rate, ...rest] = line.split(/\s+/);
    if (!code || !rate || rest.length > 0) {
      throw new FormProblem(`Exchange rate "${line.slice(0, 40)}": write it as "EUR 0.94".`);
    }
    fx[code.toUpperCase()] = rate;
  }
  return fx;
}

/** "Item | usual price | other words, comma-separated | unit" per line. */
function pricesFromLines(value: string): Raw[] {
  return lines(value).map((line) => {
    const [item = '', price = '', match = '', unit = '', ...rest] = line
      .split('|')
      .map((p) => p.trim());
    if (item === '' || price === '' || rest.length > 0) {
      throw new FormProblem(
        `Usual price "${line.slice(0, 60)}": write it as "Item | price | other words | unit".`,
      );
    }
    return {
      item,
      price,
      ...(match === '' ? {} : { match: list(match, /\s*,\s*/) }),
      ...(unit === '' ? {} : { unit }),
    };
  });
}

/** The price-check fields, or what is stored when the form does not show them. */
function pricesFromForm(form: FormData, current: Raw): Raw {
  if (!form.has('prices')) {
    return {
      ...(current.reference_prices === undefined
        ? {}
        : { reference_prices: current.reference_prices }),
      ...(current.price_check === undefined ? {} : { price_check: current.price_check }),
    };
  }
  const below = text(form, 'below_percent').trim();
  const prices = pricesFromLines(text(form, 'prices'));
  const check = {
    above_percent: Number(text(form, 'above_percent').trim()),
    below_percent: below === '' ? null : Number(below),
    above: text(form, 'price_action', 'review'),
  };
  // Never set and still the defaults: keep it unset, so saving an untouched page changes nothing.
  const untouched =
    prices.length === 0 &&
    current.reference_prices === undefined &&
    current.price_check === undefined &&
    check.above_percent === 20 &&
    check.below_percent === 50 &&
    check.above === 'review';
  return untouched ? {} : { reference_prices: prices, price_check: check };
}

export class FormProblem extends Error {
  override name = 'FormProblem';
}

/** The submitted mandate form as a raw mandate, keeping what the form does not edit. */
export function rawFromForm(form: FormData, current: Raw): Raw {
  let fx: Record<string, string> = {};
  if (form.has('fx_lines')) {
    fx = fxFromLines(text(form, 'fx_lines'));
  } else {
    for (const [k, v] of form.entries()) {
      const m = /^fx\.([A-Z]{3,5})$/.exec(k);
      if (m?.[1] && typeof v === 'string') fx[m[1]] = v.trim();
    }
  }
  const agents: Raw = {};
  for (const id of agentIds.parse(texts(form, 'agent'))) {
    const f = (name: string, fallback = '') => text(form, `${id}.${name}`, fallback).trim();
    const approval = f('approval_above');
    agents[id] = {
      owner: f('owner'),
      status: f('status', 'active'),
      daily_budget: f('daily_budget'),
      per_payment_limit: f('per_payment_limit'),
      ...(approval === '' ? {} : { approval_above: approval }),
      currencies: codes(f('currencies')),
      categories: list(f('categories'), /[\s,]+/),
      suppliers: {
        mode: f('supplier_mode', 'any'),
        allow: lines(f('allow')),
        block: lines(f('block')),
      },
      blocked_countries: codes(f('blocked_countries')),
      velocity_per_minute: Number(f('velocity_per_minute')),
      business_hours_only: f('business_hours_only') === 'on',
    };
  }
  return {
    ...(current.organisation === undefined ? {} : { organisation: current.organisation }),
    base_currency: current.base_currency,
    timezone: text(form, 'timezone').trim(),
    fx,
    ...(current.currency_decimals === undefined
      ? {}
      : { currency_decimals: current.currency_decimals }),
    blocked_countries: codes(text(form, 'blocked_countries')),
    blocked_suppliers: lines(text(form, 'blocked_suppliers')),
    business_hours: {
      days: texts(form, 'days').map(Number),
      start: text(form, 'start'),
      end: text(form, 'end'),
    },
    ...pricesFromForm(form, current),
    agents,
  };
}
