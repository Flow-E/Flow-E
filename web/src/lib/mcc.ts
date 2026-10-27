/**
 * Merchant category codes (MCC) offered in pickers, with plain names. Any other four-digit code
 * still works: the pickers have an "other codes" field and the engine accepts every code.
 */
export interface Category {
  code: string;
  name: string;
}

export const CATEGORY_GROUPS: { title: string; items: Category[] }[] = [
  {
    title: 'Lab and science',
    items: [
      { code: '5169', name: 'Chemicals and reagents' },
      { code: '5047', name: 'Lab, medical and dental equipment' },
      { code: '5122', name: 'Drugs and pharmaceuticals' },
      { code: '8071', name: 'Medical and testing laboratories' },
    ],
  },
  {
    title: 'Technical',
    items: [
      { code: '5045', name: 'Computers and peripherals' },
      { code: '5734', name: 'Software' },
      { code: '5065', name: 'Electrical and electronic parts' },
      { code: '5085', name: 'Industrial supplies' },
    ],
  },
  {
    title: 'Office and services',
    items: [
      { code: '5111', name: 'Stationery and office supplies (wholesale)' },
      { code: '5943', name: 'Stationery and office supplies (shops)' },
      { code: '5021', name: 'Office furniture' },
      { code: '4214', name: 'Freight and delivery' },
      { code: '7399', name: 'Business services' },
    ],
  },
];

const NAMES = new Map(CATEGORY_GROUPS.flatMap((g) => g.items).map((c) => [c.code, c.name]));

export const KNOWN_CODES: ReadonlySet<string> = new Set(NAMES.keys());

/** "Chemicals and reagents (5169)", or just the code when it has no name here. */
export function categoryLabel(code: string): string {
  const name = NAMES.get(code);
  return name ? `${name} (${code})` : code;
}

/** Split "5169, 5047 8071" into codes, keeping order and dropping repeats. */
export function splitCodes(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}
