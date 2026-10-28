import { z } from 'zod';
import { normalizeName } from '@flow-e/mcp/core';
import { text, texts } from './form';
import { isBlankRow, type PriceRow } from './price-list';

/**
 * The stored mandate (mandate.yaml as JSON) shaped into form values, and a submitted form shaped
 * back into a mandate. The result is validated by the core's config schema in the store; nothing
 * here is trusted. Values the form does not show are kept as stored, and a value shown and sent
 * back unchanged keeps its stored form (e.g. a number stays a number), so saving an untouched
 * page records no change.
 */

export interface AgentFields {
  id: string;
  owner: string;
  status: string;
  daily_budget: string;
  monthly_budget: string;
  per_payment_limit: string;
  approval_above: string;
  currencies: string;
  categories: string;
  supplier_mode: string;
  allow: string;
  block: string;
  blocked_countries: string;
  velocity_per_minute: string;
  business_hours_only: boolean;
  require_project: boolean;
}

export interface ProjectFields {
  id: string;
  name: string;
  budget: string;
  /** "month" or "total". */
  period: string;
  /** YYYY-MM-DD or empty. */
  ends: string;
  /** Agents that may book to it; none ticked means every agent. */
  agents: string[];
}

export interface MandateFields {
  baseCurrency: string;
  /** The mandate's own decimal places per currency, if it sets any. */
  currencyDecimals?: Record<string, number>;
  timezone: string;
  fx: [string, string][];
  blocked_countries: string;
  blocked_suppliers: string;
  days: number[];
  start: string;
  end: string;
  prices: PriceRow[];
  above_percent: string;
  below_percent: string;
  price_action: string;
  tolerance_percent: string;
  tolerance_min: string;
  projects: ProjectFields[];
  agents: AgentFields[];
}

type Raw = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const arr = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);
const obj = (v: unknown): Raw =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};

export function mandateFields(raw: Raw, baseCurrency: string): MandateFields {
  const hours = obj(raw.business_hours);
  const check = obj(raw.price_check);
  const invoice = obj(raw.invoice_check);
  const agents = obj(raw.agents) as Record<string, Raw>;
  const decimals = obj(raw.currency_decimals) as Record<string, number>;
  return {
    baseCurrency,
    ...(Object.keys(decimals).length > 0 ? { currencyDecimals: decimals } : {}),
    timezone: str(raw.timezone ?? 'UTC'),
    fx: Object.entries(obj(raw.fx)).map(([k, v]) => [k, str(v)]),
    blocked_countries: arr(raw.blocked_countries).join(', '),
    blocked_suppliers: arr(raw.blocked_suppliers).join('\n'),
    days: Array.isArray(hours.days) ? hours.days.map(Number) : [1, 2, 3, 4, 5],
    start: str(hours.start ?? '08:00'),
    end: str(hours.end ?? '18:00'),
    prices: (Array.isArray(raw.reference_prices) ? raw.reference_prices : []).map((v) => {
      const r = obj(v);
      return {
        item: str(r.item),
        supplier: str(r.supplier),
        price: str(r.price),
        currency: str(r.currency),
        unit: str(r.unit),
        keywords: arr(r.match).join(', '),
      };
    }),
    above_percent: str(check.above_percent ?? 20),
    below_percent: check.below_percent === null ? '' : str(check.below_percent ?? 50),
    price_action: str(check.above ?? 'review'),
    tolerance_percent: str(invoice.tolerance_percent ?? 2),
    tolerance_min: str(invoice.tolerance_min ?? 5),
    projects: Object.entries(obj(raw.projects)).map(([id, v]) => {
      const p = obj(v);
      return {
        id,
        name: str(p.name),
        budget: str(p.budget),
        period: str(p.period ?? 'month'),
        ends: str(p.ends),
        agents: arr(p.agents),
      };
    }),
    agents: Object.entries(agents).map(([id, a]) => {
      const suppliers = obj(a.suppliers);
      return {
        id,
        owner: str(a.owner),
        status: str(a.status ?? 'active'),
        daily_budget: str(a.daily_budget),
        monthly_budget: str(a.monthly_budget),
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
        require_project: a.require_project === true,
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
/** Row keys the form generates for table rows. */
const rowKeys = z.array(z.string().regex(/^r\d{1,6}$/)).max(1000);

/** A value shown and sent back unchanged keeps its stored form (e.g. a number stays a number). */
const keep = (stored: unknown, posted: string): unknown =>
  stored !== undefined && str(stored) === posted ? stored : posted;

export class FormProblem extends Error {
  override name = 'FormProblem';
}

/** Problems found while reading the form, reported together like the core's own. */
class Problems {
  readonly list: string[] = [];
  add(path: string, message: string) {
    this.list.push(`✖ ${path}: ${message}`);
  }
  /** A whole number (or any number) typed in a field, or a problem. */
  number(path: string, value: string, whole = false): number {
    const n = Number(value);
    if (value === '' || !Number.isFinite(n)) {
      this.add(path, whole ? 'Use a whole number, e.g. 10.' : 'Use a number, e.g. 20.');
      return 0;
    }
    if (whole && !Number.isInteger(n)) this.add(path, 'Use a whole number, e.g. 10.');
    return n;
  }
  throwIfAny() {
    if (this.list.length > 0) throw new FormProblem(this.list.join('\n'));
  }
}

/** "EUR 0.94" per line → { EUR: "0.94" }, keeping a stored rate's form when unchanged. */
function fxFromLines(value: string, current: Raw, problems: Problems): Raw {
  const fx: Raw = {};
  for (const line of lines(value)) {
    const [code, rate, ...rest] = line.split(/\s+/);
    if (!code || !rate || rest.length > 0) {
      problems.add('fx', `"${line.slice(0, 40)}": write each rate as "EUR 0.94".`);
      continue;
    }
    const c = code.toUpperCase();
    fx[c] = keep(current[c], rate);
  }
  return fx;
}

/** The usual-price table, or what is stored when the form does not show it. */
function pricesFromForm(form: FormData, current: Raw, problems: Problems): Raw {
  if (!form.has('prices_shown')) {
    return {
      ...(current.reference_prices === undefined
        ? {}
        : { reference_prices: current.reference_prices }),
      ...(current.price_check === undefined ? {} : { price_check: current.price_check }),
    };
  }
  const stored = new Map<string, Raw>();
  for (const v of Array.isArray(current.reference_prices) ? current.reference_prices : []) {
    const r = obj(v);
    stored.set(`${normalizeName(str(r.item))}\u0000${normalizeName(str(r.supplier))}`, r);
  }
  const prices: Raw[] = [];
  for (const key of rowKeys.parse(texts(form, 'price.row'))) {
    const f = (name: keyof PriceRow) => text(form, `price.${key}.${name}`).trim();
    const row: PriceRow = {
      item: f('item'),
      supplier: f('supplier'),
      price: f('price'),
      currency: f('currency').toUpperCase(),
      unit: f('unit'),
      keywords: f('keywords'),
    };
    if (isBlankRow(row)) continue;
    const before = stored.get(`${normalizeName(row.item)}\u0000${normalizeName(row.supplier)}`);
    const path = `reference_prices[${String(prices.length)}]`;
    if (row.item === '') problems.add(`${path}.item`, 'Name the item.');
    if (row.price === '') problems.add(`${path}.price`, 'Enter the usual price.');
    const match = list(row.keywords, /\s*,\s*/);
    prices.push({
      // An id set outside the form (YAML, an import) stays with its row.
      ...(typeof before?.id === 'string' ? { id: before.id } : {}),
      item: row.item,
      ...(match.length === 0 ? {} : { match }),
      price: keep(before?.price, row.price),
      ...(row.currency === '' ? {} : { currency: row.currency }),
      ...(row.supplier === '' ? {} : { supplier: row.supplier }),
      ...(row.unit === '' ? {} : { unit: row.unit }),
    });
  }
  const below = text(form, 'below_percent').trim();
  const check = {
    above_percent: problems.number(
      'price_check.above_percent',
      text(form, 'above_percent').trim(),
      true,
    ),
    below_percent: below === '' ? null : problems.number('price_check.below_percent', below, true),
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

/** The projects table, or what is stored when the form does not show it. */
function projectsFromForm(form: FormData, current: Raw, problems: Problems): Raw {
  if (!form.has('projects_shown')) {
    return current.projects === undefined ? {} : { projects: current.projects };
  }
  const stored = obj(current.projects);
  const projects: Raw = {};
  for (const key of rowKeys.parse(texts(form, 'project.row'))) {
    const f = (name: string) => text(form, `project.${key}.${name}`).trim();
    const id = f('id');
    const name = f('name');
    const budget = f('budget');
    const ends = f('ends');
    const ticked = texts(form, `project.${key}.agents`).map((a) => a.trim());
    if (id === '' && name === '' && budget === '' && ends === '') continue;
    const path = `projects.${id || '(new)'}`;
    if (id === '') {
      problems.add(`${path}.id`, 'Give the project a short id, e.g. lab-2027.');
      continue;
    }
    if (Object.hasOwn(projects, id)) {
      problems.add(`${path}.id`, `The id "${id}" is used twice.`);
      continue;
    }
    if (name === '') problems.add(`${path}.name`, 'Give the project a name.');
    if (budget === '') problems.add(`${path}.budget`, 'Enter a budget.');
    const before = obj(stored[id]);
    projects[id] = {
      name,
      budget: keep(before.budget, budget),
      // "Per month" is the default; it is written only when stored so before.
      ...(f('period') === 'total' || before.period !== undefined
        ? { period: f('period') === 'total' ? 'total' : 'month' }
        : {}),
      // The same agents as stored keep their stored order.
      agents:
        Array.isArray(before.agents) &&
        [...arr(before.agents)].sort().join(',') === [...ticked].sort().join(',')
          ? before.agents
          : ticked,
      ...(ends === '' ? {} : { ends }),
    };
  }
  return Object.keys(projects).length === 0 && current.projects === undefined ? {} : { projects };
}

/** The invoice tolerance, or what is stored when the form does not show it. */
function invoiceFromForm(form: FormData, current: Raw, problems: Problems): Raw {
  if (!form.has('tolerance_percent')) {
    return current.invoice_check === undefined ? {} : { invoice_check: current.invoice_check };
  }
  const stored = obj(current.invoice_check);
  const percent = text(form, 'tolerance_percent').trim();
  const min = text(form, 'tolerance_min').trim();
  if (min === '') problems.add('invoice_check.tolerance_min', 'Enter an amount, e.g. 5.');
  const check = {
    tolerance_percent:
      str(stored.tolerance_percent) === percent
        ? stored.tolerance_percent
        : problems.number('invoice_check.tolerance_percent', percent),
    tolerance_min: keep(stored.tolerance_min ?? 5, min),
  };
  const untouched =
    current.invoice_check === undefined &&
    check.tolerance_percent === 2 &&
    str(check.tolerance_min) === '5';
  return untouched ? {} : { invoice_check: check };
}

/** The submitted mandate form as a raw mandate, keeping what the form does not edit. */
export function rawFromForm(form: FormData, current: Raw): Raw {
  const problems = new Problems();
  const currentFx = obj(current.fx);
  let fx: Raw = {};
  if (form.has('fx_lines')) {
    fx = fxFromLines(text(form, 'fx_lines'), currentFx, problems);
  } else {
    for (const [k, v] of form.entries()) {
      const m = /^fx\.([A-Z]{3,5})$/.exec(k);
      if (m?.[1] && typeof v === 'string') fx[m[1]] = keep(currentFx[m[1]], v.trim());
    }
  }
  const storedAgents = obj(current.agents);
  const agents: Raw = {};
  for (const id of agentIds.parse(texts(form, 'agent'))) {
    const f = (name: string, fallback = '') => text(form, `${id}.${name}`, fallback).trim();
    const before = obj(storedAgents[id]);
    const approval = f('approval_above');
    // Fields an older form does not send keep their stored values.
    const monthly = form.has(`${id}.monthly_budget`)
      ? f('monthly_budget')
      : str(before.monthly_budget);
    const requireProject =
      f('require_project') === 'on' ||
      (!form.has(`${id}.require_project.shown`) && before.require_project === true);
    const velocity = f('velocity_per_minute');
    agents[id] = {
      owner: f('owner'),
      status: f('status', 'active'),
      daily_budget: keep(before.daily_budget, f('daily_budget')),
      per_payment_limit: keep(before.per_payment_limit, f('per_payment_limit')),
      ...(approval === '' ? {} : { approval_above: keep(before.approval_above, approval) }),
      ...(monthly === '' ? {} : { monthly_budget: keep(before.monthly_budget, monthly) }),
      currencies: codes(f('currencies')),
      categories: list(f('categories'), /[\s,]+/),
      suppliers: {
        mode: f('supplier_mode', 'any'),
        allow: lines(f('allow')),
        block: lines(f('block')),
      },
      blocked_countries: codes(f('blocked_countries')),
      velocity_per_minute: problems.number(`agents.${id}.velocity_per_minute`, velocity, true),
      business_hours_only: f('business_hours_only') === 'on',
      ...(requireProject || before.require_project !== undefined
        ? { require_project: requireProject }
        : {}),
    };
  }
  const result = {
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
    ...pricesFromForm(form, current, problems),
    ...invoiceFromForm(form, current, problems),
    ...projectsFromForm(form, current, problems),
    agents,
  };
  problems.throwIfAny();
  return result;
}

// Explaining problems -----------------------------------------------------------------------

export interface ExplainedProblem {
  /** The setting in plain words, e.g. "Agent buyer: daily budget". Empty for the whole form. */
  label: string;
  message: string;
  /** The mandate path the core named, e.g. "agents.buyer.daily_budget". */
  path: string;
}

const FIELD_WORDS: Record<string, string> = {
  owner: 'responsible owner',
  status: 'status',
  daily_budget: 'daily budget',
  monthly_budget: 'monthly budget',
  per_payment_limit: 'per payment',
  approval_above: 'human approval above',
  currencies: 'currencies',
  categories: 'categories',
  suppliers: 'suppliers',
  blocked_countries: 'blocked countries',
  velocity_per_minute: 'requests per minute',
  business_hours_only: 'business hours',
  require_project: 'every purchase must name a project',
  id: 'id',
  name: 'name',
  budget: 'budget',
  period: 'period',
  agents: 'agents that may book to it',
  ends: 'end date',
  item: 'item',
  price: 'price',
  currency: 'currency',
  supplier: 'supplier',
  unit: 'unit',
  match: 'keywords',
};
const words = (f: string | undefined) => (f ? (FIELD_WORDS[f] ?? f.replace(/_/g, ' ')) : '');

/** A mandate path in plain words. */
export function pathLabel(path: string): string {
  const parts = path.split('.');
  const [top, second, third] = parts;
  const price = /^reference_prices\[(\d+)\](?:\.(\w+))?/.exec(path);
  if (price) {
    return `Usual prices, row ${String(Number(price[1]) + 1)}${price[2] ? `: ${words(price[2])}` : ''}`;
  }
  switch (top) {
    case 'agents':
      if (second === undefined) return 'Agents';
      return `Agent ${second}${third ? `: ${words(third)}` : ''}`;
    case 'projects':
      if (second === undefined) return 'Projects';
      return `Project ${second}${third ? `: ${words(third)}` : ''}`;
    case 'timezone':
      return 'Time zone';
    case 'fx':
      return second ? `Exchange rate ${second}` : 'Exchange rates';
    case 'blocked_countries':
      return 'Always-blocked countries';
    case 'blocked_suppliers':
      return 'Blocked suppliers';
    case 'business_hours':
      return 'Business hours';
    case 'price_check':
      if (second === undefined) return 'Fair price check';
      return second === 'below_percent'
        ? 'Flag below the usual price'
        : second === 'above'
          ? 'Fair price: then'
          : 'Flag above the usual price';
    case 'invoice_check':
      return second === 'tolerance_min'
        ? 'Invoice tolerance: minimum amount'
        : second === 'tolerance_percent'
          ? 'Invoice tolerance (%)'
          : 'Invoice tolerance';
    case 'reference_prices':
      return 'Usual prices';
    default:
      return path.replace(/_/g, ' ');
  }
}

/** The schema's technical wording in plain words. */
function plainMessage(message: string): string {
  const m = message.trim();
  let r: RegExpExecArray | null;
  if ((r = /^Invalid input: expected (\w+), received (\w+)/.exec(m))) {
    if (r[2] === 'undefined') return 'This is required.';
    if (r[1] === 'number') return 'Use a number.';
    return 'This value is not valid.';
  }
  if ((r = /^Too small: expected (\w+) to (?:have|be) >=?(\d+)/.exec(m))) {
    if (r[1] === 'array') return r[2] === '1' ? 'Choose at least one.' : `Choose at least ${r[2]}.`;
    if (r[1] === 'string')
      return r[2] === '1' ? 'This cannot be empty.' : `Use at least ${r[2]} characters.`;
    return `Use ${r[2]} or more.`;
  }
  if ((r = /^Too big: expected (\w+) to (?:have|be) <=?(\d+)/.exec(m))) {
    if (r[1] === 'array') return `At most ${r[2]} entries.`;
    if (r[1] === 'string') return `Use at most ${r[2]} characters.`;
    return `Use ${r[2]} or less.`;
  }
  if (/^Invalid option/.test(m)) return 'Choose one of the options.';
  if (/^Unrecognized key/.test(m)) return 'This setting is not known.';
  if (/^Invalid (?:string|input)/.test(m)) return 'This value is not valid.';
  const s = m.replace(
    / has no rate in fx$/,
    ' has no exchange rate. Add one under Exchange rates.',
  );
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A "Not saved" message from the store (the core's "✖ path: problem" lines, or the schema's
 * "✖ problem → at path" pairs) as one plain problem per setting. Other text comes back as one
 * problem for the whole form.
 */
export function explainProblems(message: string): ExplainedProblem[] {
  const out: ExplainedProblem[] = [];
  const rows = message.split(/\r?\n/).map((l) => l.trimEnd());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? '';
    if (!row.startsWith('✖')) continue;
    const body = row.slice(1).trim();
    const at = /^→ at (.+)$/.exec((rows[i + 1] ?? '').trim());
    if (at?.[1]) {
      const path = at[1].replace(/\["([^"]+)"\]/g, '.$1');
      out.push({ path, label: pathLabel(path), message: plainMessage(body) });
      i++;
      continue;
    }
    const own = /^([a-z_]+(?:\[\d+\])?(?:\.[^\s:]+)*): (.+)$/.exec(body);
    if (own?.[1] && own[2]) {
      out.push({ path: own[1], label: pathLabel(own[1]), message: plainMessage(own[2]) });
    } else {
      out.push({ path: '', label: '', message: plainMessage(body) });
    }
  }
  if (out.length === 0) {
    const text = message.replace(/^(Not saved|Cannot preview):\s*/, '').trim();
    if (text !== '') out.push({ path: '', label: '', message: text });
  }
  return out;
}

/**
 * Where a problem shows in the form: the name of the field, with table rows as
 * "price#<index>.<field>" and "project@<id>.<field>". Null when no single field fits.
 */
export function fieldKey(path: string): string | null {
  const price = /^reference_prices\[(\d+)\](?:\.(\w+))?$/.exec(path);
  if (price) {
    const f = price[2] === 'match' ? 'keywords' : (price[2] ?? 'item');
    return `price#${price[1] ?? ''}.${f}`;
  }
  const [top, second, third, fourth] = path.split('.');
  switch (top) {
    case 'agents': {
      if (!second || !third) return null;
      if (third === 'suppliers') {
        return `${second}.${fourth === 'mode' ? 'supplier_mode' : fourth === 'block' ? 'block' : 'allow'}`;
      }
      return `${second}.${third}`;
    }
    case 'projects': {
      if (!second) return null;
      // A project id may contain dots; the field is the last part.
      const parts = path.slice('projects.'.length).split('.');
      const field = parts.length > 1 ? parts.pop() : undefined;
      const known = field !== undefined && Object.hasOwn(FIELD_WORDS, field);
      const id = known ? parts.join('.') : [...parts, ...(field ? [field] : [])].join('.');
      return `project@${id}.${known ? field : 'id'}`;
    }
    case 'price_check':
      return second === 'above' ? 'price_action' : (second ?? null);
    case 'invoice_check':
      return second ?? null;
    case 'business_hours':
      return 'start';
    case 'fx':
      return 'fx';
    case 'timezone':
    case 'blocked_countries':
    case 'blocked_suppliers':
      return top;
    default:
      return null;
  }
}
