/**
 * Canonical JSON: object keys sorted, no whitespace, so the same value always serialises to the
 * same bytes. Used for everything that gets signed or hashed (credentials, receipts, ledger rows).
 * Throws on values JSON cannot represent exactly, instead of silently dropping them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalise a non-finite number.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('Only plain objects can be canonicalised.');
      }
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalise a value of type ${typeof value}.`);
  }
}
