/** Calendar helpers. Pure: every function takes the instant and the time zone as input. */

export interface LocalTime {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Minutes after local midnight. */
  minutes: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localTime(epochMs: number, timeZone: string): LocalTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  const weekday = WEEKDAYS[parts.weekday ?? ''];
  if (weekday === undefined) throw new Error('Could not read the local weekday.');
  return {
    date: `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`,
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** "08:30" → 510. Throws on anything else. */
export function parseClock(text: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) throw new Error(`"${text}" is not a time of day (HH:MM).`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
