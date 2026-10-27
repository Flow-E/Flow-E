/**
 * Where to go after signing in. Only our own pages, as a path: never another origin, a
 * protocol-relative URL ("//evil"), or a backslash trick ("/\evil").
 */
const ALLOWED =
  /^\/(sandbox|app|invite|approve|account)(\/[A-Za-z0-9._~\-/]*)?(\?[A-Za-z0-9._~\-=&%]*)?$/;

export function safeNext(value: unknown, fallback = '/sandbox'): string {
  if (typeof value !== 'string' || value.length > 300) return fallback;
  if (value.startsWith('//') || value.includes('\\')) return fallback;
  return ALLOWED.test(value) ? value : fallback;
}

export function loginUrl(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}
