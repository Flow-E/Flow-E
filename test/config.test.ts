import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/schema.js';
import { buildProgram } from '../src/cli/program.js';

const example = readFileSync(new URL('../mandate.example.yaml', import.meta.url), 'utf8');

describe('parseConfig', () => {
  it('turns the example mandate.yaml into engine types in minor units', () => {
    const { policy, agents } = parseConfig(example);
    expect(policy).toMatchObject({
      baseCurrency: 'CHF',
      timezone: 'Europe/Zurich',
      blockedCountries: ['RU', 'BY', 'IR', 'KP'],
      businessHours: { days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1080 },
    });
    expect(agents['lab-procurement']).toEqual({
      id: 'lab-procurement',
      owner: 'M. Keller, Head of Lab',
      status: 'active',
      mandate: {
        dailyBudget: 2_000_000,
        perPaymentLimit: 800_000,
        approvalAbove: 500_000,
        currencies: ['CHF', 'EUR'],
        categories: ['5169', '5047'],
        suppliers: {
          mode: 'allowlist',
          allow: ['Alpine Reagents AG', 'Basel Labware AG'],
          block: [],
        },
        blockedCountries: [],
        velocityPerMinute: 6,
        businessHoursOnly: false,
      },
    });
  });

  it('fills defaults for a minimal file', () => {
    const { policy, agents } = parseConfig(`
base_currency: EUR
agents:
  bot:
    owner: Someone
    daily_budget: "100.50"
    per_payment_limit: 50
    currencies: [EUR]
    categories: ["5111"]
`);
    expect(policy.timezone).toBe('UTC');
    expect(policy.currencyDecimals).toBeUndefined();
    expect(agents.bot?.mandate).toMatchObject({
      dailyBudget: 10_050,
      approvalAbove: null,
      suppliers: { mode: 'any' },
      velocityPerMinute: 10,
    });
  });

  it('reads reference prices in minor units, with price-check defaults', () => {
    const { policy } = parseConfig(`
base_currency: CHF
reference_prices:
  - { item: 'Phosphate buffer solution, 10 L', match: ['phosphate buffer'], price: 480 }
  - { item: 'Nitrile gloves', price: '24.50', unit: box }
agents: {}
`);
    expect(policy.referencePrices).toEqual([
      { item: 'Phosphate buffer solution, 10 L', match: ['phosphate buffer'], priceBase: 48_000 },
      { item: 'Nitrile gloves', match: [], priceBase: 2_450, unit: 'box' },
    ]);
    expect(policy.priceCheck).toEqual({ abovePercent: 20, belowPercent: 50, above: 'review' });
  });

  it.each([
    ['a zero price', '[{ item: Gloves, price: 0 }]', /must be above 0/],
    [
      'an item listed twice',
      '[{ item: Gloves, price: 1 }, { item: " gloves", price: 2 }]',
      /twice/,
    ],
  ])('rejects reference prices with %s', (_name, list, message) => {
    expect(() =>
      parseConfig(`base_currency: CHF
reference_prices: ${list}
agents: {}
`),
    ).toThrow(message);
  });

  const invalid: [string, string, RegExp][] = [
    ['not YAML', 'agents: [', /not valid YAML/],
    ['an unknown key (typo)', example.replace('daily_budget', 'daily_budgte'), /daily_budgte/],
    [
      'a currency with no fx rate',
      example.replace('[CHF, EUR]', '[CHF, GBP]'),
      /GBP has no rate in fx/,
    ],
    [
      'an empty allowlist',
      example.replace(/allow: \[[^\]]*\]/, 'allow: []'),
      /allowlist mode needs/,
    ],
    [
      'a bad time zone',
      example.replace('Europe/Zurich', 'Europe/Atlantis'),
      /not an IANA time zone/,
    ],
    [
      'end before start',
      example.replace("end: '18:00'", "end: '07:00'"),
      /end must be after start/,
    ],
    [
      'too many decimals',
      example.replace('daily_budget: 20000', 'daily_budget: 20000.001'),
      /decimal places/,
    ],
    ['a bad fx rate', example.replace('EUR: 0.93', "EUR: 'abc'"), /fx\.EUR/],
    ['a lower-case country', example.replace('[RU, BY', '[ru, BY'), /ISO 3166-1/],
    ['a bad category', example.replace("'5169'", "'51'"), /four-digit/],
  ];
  it.each(invalid)('rejects %s', (_name, text, message) => {
    expect(() => parseConfig(text)).toThrow(ConfigError);
    expect(() => parseConfig(text)).toThrow(message);
  });
});

describe('CLI', () => {
  it('lists every planned command in --help', () => {
    const help = buildProgram().helpInformation();
    for (const cmd of [
      'init',
      'agent',
      'check',
      'serve',
      'approve',
      'decline',
      'freeze',
      'unfreeze',
      'cooloff-cancel',
      'panel',
      'export',
      'verify',
      'audit',
      'demo',
    ]) {
      expect(help).toContain(cmd);
    }
  });
});
