/** Compare supplier names case- and whitespace-insensitively. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
