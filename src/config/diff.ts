import { canonicalJson } from '../crypto/canonical.js';
import type { JsonValue } from '../ledger/receipt.js';
import { configSchema } from './schema.js';

/** One changed setting of a mandate, with its value before and after (null: not set). */
export interface MandateChange {
  /** e.g. "daily_budget" under "agents.lab-procurement", or "reference_prices". */
  path: string;
  before: JsonValue;
  after: JsonValue;
}

function normalised(raw: Record<string, unknown>): Record<string, unknown> {
  const r = configSchema.safeParse(raw);
  return r.success ? (r.data) : raw;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const json = (v: unknown): JsonValue =>
  v === undefined ? null : (JSON.parse(canonicalJson(v)) as JsonValue);

/**
 * What changed between two mandates, after defaults are filled in so an unchanged form never
 * shows a change: organisation-wide keys, and each agent's settings one by one. Sorted.
 */
export function mandateDiff(
  rawBefore: Record<string, unknown>,
  rawAfter: Record<string, unknown>,
): MandateChange[] {
  const before = normalised(rawBefore);
  const after = normalised(rawAfter);
  const same = (a: unknown, b: unknown) => canonicalJson(json(a)) === canonicalJson(json(b));
  const out: MandateChange[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const k of keys) {
    if (k === 'organisation') continue;
    if (k === 'agents') {
      const a = asObject(before.agents);
      const b = asObject(after.agents);
      for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const x = asObject(a[id]);
        const y = asObject(b[id]);
        for (const f of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
          if (!same(x[f], y[f])) {
            out.push({ path: `agents.${id}.${f}`, before: json(x[f]), after: json(y[f]) });
          }
        }
      }
    } else if (!same(before[k], after[k])) {
      out.push({ path: k, before: json(before[k]), after: json(after[k]) });
    }
  }
  return out;
}
