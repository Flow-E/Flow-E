import { pathLabel } from './mandate-form-data';

/**
 * The latest saved changes to a mandate, from the ledger's `config.updated` entries: who, when,
 * and each setting's old and new value. Entries written before values were recorded name only
 * the settings that changed.
 */

export interface ChangeLine {
  label: string;
  /** Null for older entries, which recorded only which settings changed. */
  before: string | null;
  after: string | null;
}

export interface MandateChangeView {
  at: string;
  by: string;
  note: string | null;
  lines: ChangeLine[];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A plain value as text; anything else as nothing. */
const t = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function cut(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A recorded value for people: "not set", "yes", "CHF, EUR", "3 usual prices", … */
export function showValue(path: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'not set';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' || typeof v === 'number') return cut(String(v));
  if (path === 'reference_prices' && Array.isArray(v)) {
    if (v.length === 0) return 'none';
    return v.length === 1 ? '1 usual price' : `${String(v.length)} usual prices`;
  }
  if (path === 'projects' && isObject(v)) {
    const names = Object.values(v).map((p) => (isObject(p) ? t(p.name) : ''));
    return names.length === 0 ? 'none' : cut(names.join(', '));
  }
  if (path === 'invoice_check' && isObject(v)) {
    return `${t(v.tolerance_percent)}%, at least ${t(v.tolerance_min)}`;
  }
  if (path === 'price_check' && isObject(v)) {
    const below = v.below_percent === null ? 'never' : `${t(v.below_percent)}%`;
    const then = v.above === 'decline' ? 'decline' : 'a person decides';
    return `above ${t(v.above_percent)}% (${then}), below ${below}`;
  }
  if (path === 'business_hours' && isObject(v)) {
    const days = Array.isArray(v.days)
      ? v.days.map((d) => DAYS[Number(d) - 1] ?? String(d)).join(', ')
      : '';
    return `${days} ${t(v.start)}–${t(v.end)}`.trim();
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return 'none';
    return cut(v.map((x) => (isObject(x) ? JSON.stringify(x) : String(x))).join(', '));
  }
  if (isObject(v)) {
    const parts = Object.entries(v).map(([k, x]) => {
      const shown = x === null ? 'none' : Array.isArray(x) ? x.join(', ') || 'none' : t(x);
      return `${k.replace(/_/g, ' ')} ${shown}`;
    });
    return parts.length === 0 ? 'none' : cut(parts.join('; '));
  }
  return '';
}

/** The newest `limit` changes, newest first. */
export function recentChanges(
  entries: readonly { type: string; created_at: string; data: string }[],
  limit = 8,
): MandateChangeView[] {
  const out: MandateChangeView[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (e?.type !== 'config.updated') continue;
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(e.data);
      if (isObject(parsed)) data = parsed;
    } catch {
      // An unreadable entry still shows who and when.
    }
    let lines: ChangeLine[] = [];
    if (Array.isArray(data.diff)) {
      lines = data.diff.filter(isObject).map((d) => {
        const path = t(d.path);
        const top = path.split('.')[0] ?? path;
        const kind = top === 'agents' ? (path.split('.')[2] ?? '') : top;
        return {
          label: pathLabel(path),
          before: showValue(kind, d.before),
          after: showValue(kind, d.after),
        };
      });
    } else if (Array.isArray(data.changes)) {
      lines = data.changes.map((c) => ({ label: pathLabel(t(c)), before: null, after: null }));
    }
    out.push({
      at: e.created_at,
      by: typeof data.by === 'string' ? data.by : 'someone',
      note: typeof data.note === 'string' && data.note !== '' ? data.note : null,
      lines,
    });
  }
  return out;
}
