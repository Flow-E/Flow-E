/** The pilot request form's fields and caps. Client-safe: shared by the form and the server. */

export const PILOT_SIZES = [
  { value: '1-9', label: '1–9 people' },
  { value: '10-49', label: '10–49 people' },
  { value: '50-249', label: '50–249 people' },
  { value: '250-999', label: '250–999 people' },
  { value: '1000+', label: '1,000 or more' },
] as const;

export type PilotSize = (typeof PILOT_SIZES)[number]['value'];
export const PILOT_STATUSES = ['new', 'contacted', 'declined'] as const;
export type PilotStatus = (typeof PILOT_STATUSES)[number];

/** Field caps, shared by the form (maxLength), the schema and the table's checks. */
export const PILOT_LIMITS = {
  name: 120,
  email: 254,
  company: 160,
  role: 120,
  buying: 2000,
  country: 80,
  message: 4000,
} as const;

/** The hidden field a person never fills in. */
export const HONEYPOT_FIELD = 'website';
