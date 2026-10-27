import { DEMO_REFERENCE_PRICES, localTime } from '@flow-e/mcp/core';

/**
 * Thirty days of fictional lab purchasing for a SANDBOX, so the dashboard has something to show
 * in a demo. This file only plans the steps; the sandbox store runs each one through the real
 * engine and ledger at its (backdated) time. Organisations never get sample data: only
 * SandboxStore can run a plan, and only on an empty ledger.
 */

export const SAMPLE_APPROVER = 'M. Muster, Finance (fictional approver)';
export const SAMPLE_DAYS = 30;
export const SAMPLE_HISTORY = 'sandbox.sample_history';

export interface SampleRequest {
  merchant: string;
  /** Minor units. */
  amount: number;
  currency: string;
  category: string;
  country: string;
  memo: string;
  /** The item, for the fair-price check. */
  item?: string;
}

export type SampleStep =
  | {
      at: number;
      kind: 'request';
      key: string;
      agentId: string;
      request: SampleRequest;
      /** Use a lapsed credential for this one request. */
      expiredCredential?: boolean;
    }
  | { at: number; kind: 'resolve'; key: string; status: 'approved' | 'declined'; note: string }
  | { at: number; kind: 'cancel'; key: string; note: string }
  | { at: number; kind: 'kill_switch'; on: boolean; note: string };

const MINUTE = 60_000;
const LAB = 'lab-procurement';
const OFFICE = 'office-supplies';

/** Small deterministic generator (mulberry32), so a seed gives the same history every time. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The instant of a local wall-clock time ("2026-10-26", 9:30) in a time zone. */
export function zonedInstant(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, minutes);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const local = localTime(guess, timeZone);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    const seen = Date.UTC(ly ?? 1970, (lm ?? 1) - 1, ld ?? 1, 0, local.minutes);
    if (seen === target) break;
    guess += target - seen;
  }
  return guess;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)).toISOString().slice(0, 10);
}

/** CHF amount in minor units, rounded to 5 francs. */
function chf(rand: () => number, min: number, max: number): number {
  return Math.round((min + rand() * (max - min)) / 5) * 5 * 100;
}

const REAGENTS = [
  'Phosphate buffer solution, 10 L',
  'Ethanol absolute, 20 L',
  'Agarose, 500 g',
  'PCR master mix, 10 kits',
  'Cell culture medium, 24 bottles',
];
const LABWARE = [
  'Nitrile gloves, 10 boxes',
  'Pipette tips, 20 racks',
  'Centrifuge tubes, 2,000',
  'Petri dishes, 500',
  'Cryo boxes, 50',
];
const EQUIPMENT = [
  'Benchtop centrifuge',
  'Incubator shaker',
  'Gel imaging system',
  'Ultrasonic bath',
];
const OFFICE_ITEMS = [
  'Printer paper, 10 reams',
  'Toner cartridges',
  'Notebooks and pens',
  'Labels',
];

/** The usual price of a demo item in CHF minor units. */
export function usualPrice(item: string): number {
  const ref = DEMO_REFERENCE_PRICES.find((r) => r.item === item);
  if (!ref) throw new Error(`no usual price for ${item}`);
  return ref.price * 100;
}

/** A price near the usual one: between `low` and `high` times it, rounded to 5 francs. */
function near(rand: () => number, item: string, low: number, high: number): number {
  const usual = usualPrice(item) / 100;
  return chf(rand, usual * low, usual * high);
}

const lab = (
  merchant: string,
  category: string,
  item: string,
  amount: number,
  memo = item,
): SampleRequest => ({ merchant, amount, currency: 'CHF', category, country: 'CH', memo, item });

const reagents = (rand: () => number): SampleRequest => {
  const item = pick(rand, REAGENTS);
  return lab('Example Reagents AG', '5169', item, near(rand, item, 0.92, 1.12));
};
const labware = (rand: () => number): SampleRequest => {
  const item = pick(rand, LABWARE);
  return lab('Example Labware AG', '5047', item, near(rand, item, 0.92, 1.12));
};
const office = (rand: () => number, amount?: number): SampleRequest => ({
  merchant: 'Example Office Supplies AG',
  amount: amount ?? chf(rand, 25, 180),
  currency: 'CHF',
  category: '5943',
  country: 'CH',
  memo: pick(rand, OFFICE_ITEMS),
});

function pick<T>(rand: () => number, list: readonly T[]): T {
  const item = list[Math.floor(rand() * list.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

/**
 * The steps, oldest first, all before `now`. Weekdays carry the routine purchases; a few days
 * carry one scripted episode each, so every kind of decision shows up in 30 days.
 */
export function samplePlan(now: number, timeZone: string, seed = 7): SampleStep[] {
  const rand = random(seed);
  const today = localTime(now, timeZone).date;
  const steps: SampleStep[] = [];
  let n = 0;
  const at = (date: string, hh: number, mm: number) => zonedInstant(date, hh * 60 + mm, timeZone);
  const request = (
    t: number,
    agentId: string,
    r: SampleRequest,
    extra: { expiredCredential?: boolean } = {},
  ): string => {
    n += 1;
    const key = `s${String(n)}`;
    steps.push({ at: t, kind: 'request', key, agentId, request: r, ...extra });
    return key;
  };

  const weekdays: string[] = [];
  for (let back = SAMPLE_DAYS - 1; back >= 1; back--) {
    const date = addDays(today, -back);
    if (localTime(at(date, 12, 0), timeZone).weekday <= 5) weekdays.push(date);
  }

  weekdays.forEach((date, i) => {
    // Routine: the lab buys consumables, the office buys supplies.
    request(at(date, 8, 40 + Math.floor(rand() * 20)), LAB, reagents(rand));
    if (rand() < 0.6) request(at(date, 11, Math.floor(rand() * 50)), LAB, labware(rand));
    if (rand() < 0.7) request(at(date, 9, 30 + Math.floor(rand() * 25)), OFFICE, office(rand));
    if (rand() < 0.3) request(at(date, 15, Math.floor(rand() * 50)), OFFICE, office(rand));

    // Every third day an equipment purchase above the approval threshold: a human decides.
    if (i % 3 === 1) {
      const t = at(date, 13, 10 + Math.floor(rand() * 30));
      const item = pick(rand, EQUIPMENT);
      const key = request(
        t,
        LAB,
        lab('Example Labware AG', '5047', item, near(rand, item, 0.95, 1.1)),
      );
      const declined = i % 9 === 7;
      steps.push({
        at: t + (20 + Math.floor(rand() * 200)) * MINUTE,
        kind: 'resolve',
        key,
        status: declined ? 'declined' : 'approved',
        note: declined ? 'Not in this quarter’s plan.' : 'Budgeted in the lab plan.',
      });
    }

    // Scripted episodes, one per day, spread over the month.
    const episode = weekdays.length - 1 - i;
    if (episode === 18) {
      // The cheapest offer comes from a supplier on the blocklist.
      request(at(date, 10, 5), LAB, {
        merchant: 'Example Chem Trading LLC',
        amount: 64_000,
        currency: 'CHF',
        category: '5169',
        country: 'AE',
        memo: 'Phosphate buffer solution, 10 L (cheapest offer)',
      });
    } else if (episode === 16) {
      // Above the per-payment limit, then an attempt to split it into two halves.
      const hplc = (amount: number, memo: string): SampleRequest => ({
        merchant: 'Example Labware AG',
        amount,
        currency: 'CHF',
        category: '5047',
        country: 'CH',
        memo,
      });
      request(at(date, 14, 20), LAB, hplc(900_000, 'HPLC column set (10 columns)'));
      request(at(date, 14, 26), LAB, hplc(450_000, 'HPLC column set, columns 1-5'));
      request(at(date, 14, 29), LAB, hplc(450_000, 'HPLC column set, columns 6-10'));
    } else if (episode === 15) {
      // Overpriced pipette tips: the fair-price check asks a person, who declines.
      const key = request(
        at(date, 9, 20),
        LAB,
        lab('Example Labware AG', '5047', 'Pipette tips, 20 racks', 52_000),
      );
      steps.push({
        at: at(date, 10, 5),
        kind: 'resolve',
        key,
        status: 'declined',
        note: 'Ordered at the usual price through the framework contract instead.',
      });
    } else if (episode === 14) {
      // Above the usual price, but a real price rise: a person approves it.
      const key = request(
        at(date, 9, 35),
        LAB,
        lab('Example Reagents AG', '5169', 'Cell culture medium, 24 bottles', 110_000),
      );
      steps.push({
        at: at(date, 11, 0),
        kind: 'resolve',
        key,
        status: 'approved',
        note: 'Supplier price rise confirmed; usual price to be updated.',
      });
    } else if (episode === 12) {
      // Suspiciously cheap: the quote was for the wrong pack size.
      const key = request(
        at(date, 13, 40),
        LAB,
        lab('Example Reagents AG', '5169', 'PCR master mix, 10 kits', 69_000),
      );
      steps.push({
        at: at(date, 14, 25),
        kind: 'resolve',
        key,
        status: 'declined',
        note: 'The quote was for 1 kit, not 10.',
      });
    } else if (episode === 13) {
      // The office agent tries to buy lab gloves: wrong category for its mandate.
      request(at(date, 10, 45), OFFICE, {
        merchant: 'Example Labware AG',
        amount: 9_000,
        currency: 'CHF',
        category: '5047',
        country: 'CH',
        memo: 'Nitrile gloves for the kitchen',
      });
    } else if (episode === 11) {
      // A first payment to a new supplier, cancelled inside the cooling-off window.
      const key = request(at(date, 11, 15), OFFICE, {
        merchant: 'Example Print Shop AG',
        amount: 16_000,
        currency: 'CHF',
        category: '5111',
        country: 'CH',
        memo: 'Business cards',
      });
      steps.push({
        at: at(date, 11, 19),
        kind: 'cancel',
        key,
        note: 'Ordered twice; the first order already covers it.',
      });
    } else if (episode === 9) {
      // The kill switch: someone stops all agents, one request is refused, then release.
      steps.push({
        at: at(date, 14, 0),
        kind: 'kill_switch',
        on: true,
        note: 'Unexpected order burst; checking before anything else goes out.',
      });
      request(at(date, 14, 7), LAB, reagents(rand));
      steps.push({
        at: at(date, 14, 35),
        kind: 'kill_switch',
        on: false,
        note: 'Checked: a duplicated reorder rule, fixed.',
      });
    } else if (episode === 7) {
      // The office agent orders past its daily budget.
      for (const [hh, mm] of [
        [9, 5],
        [10, 10],
        [11, 20],
        [15, 40],
      ] as const) {
        request(at(date, hh, mm), OFFICE, office(rand, 15_000));
      }
    } else if (episode === 5) {
      // A supplier in a blocked country.
      request(at(date, 9, 50), OFFICE, {
        merchant: 'Example Stationery LLC',
        amount: 12_000,
        currency: 'CHF',
        category: '5943',
        country: 'BY',
        memo: 'Archive boxes',
      });
    } else if (episode === 3) {
      // A request with a lapsed agent credential.
      request(at(date, 16, 10), LAB, reagents(rand), { expiredCredential: true });
    }
  });

  // Today, relative to now: two routine purchases and one equipment purchase still waiting.
  request(now - 150 * MINUTE, LAB, reagents(rand));
  request(now - 95 * MINUTE, OFFICE, office(rand));
  request(
    now - 40 * MINUTE,
    LAB,
    lab('Example Labware AG', '5047', 'Benchtop centrifuge', 650_000),
  );

  return steps.filter((s) => s.at < now - MINUTE).sort((a, b) => a.at - b.at);
}
