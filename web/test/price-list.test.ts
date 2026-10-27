import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyRow, mergeRows, parsePriceCsv, suggestPrices, type PriceRow } from '@/lib/price-list';

const CTX = { baseCurrency: 'CHF', rates: ['EUR', 'JPY'] };

describe('price list import', () => {
  it('reads supplier, item, unit, price, currency and keywords, with quoted cells', () => {
    const csv = [
      'Supplier,Item,Unit,Price,Currency,Keywords',
      'Example Lab Supplies,"Phosphate buffer solution, 10 L",bottle,1150,,phosphate buffer',
      "Example Lab Supplies,Pipette tips 20 racks,box,CHF 1'310.50,,pipette tips; tips",
      'Example Office Goods,Printer paper,box,24.5,EUR,',
    ].join('\n');
    const r = parsePriceCsv(csv, CTX);
    expect(r.problems).toEqual([]);
    expect(r.rows).toEqual([
      {
        supplier: 'Example Lab Supplies',
        item: 'Phosphate buffer solution, 10 L',
        unit: 'bottle',
        price: '1150.00',
        currency: '',
        keywords: 'phosphate buffer',
        priceMinor: 115_000,
        line: 2,
      },
      {
        supplier: 'Example Lab Supplies',
        item: 'Pipette tips 20 racks',
        unit: 'box',
        price: '1310.50',
        currency: '',
        keywords: 'pipette tips, tips',
        priceMinor: 131_050,
        line: 3,
      },
      {
        supplier: 'Example Office Goods',
        item: 'Printer paper',
        unit: 'box',
        price: '24.50',
        currency: 'EUR',
        keywords: '',
        priceMinor: 2_450,
        line: 4,
      },
    ]);
  });

  it('reads German headers, semicolons and decimal commas', () => {
    const csv = [
      'Lieferant;Artikel;Einheit;Preis;Währung;Stichworte',
      'Example Chemie;Ethanol 20 L;Kanister;1.420,50;EUR;Ethanol',
      'Example Chemie;Aceton 5 L;Kanister;42,5;;',
    ].join('\n');
    const r = parsePriceCsv(csv, CTX);
    expect(r.problems).toEqual([]);
    expect(r.rows).toMatchObject([
      {
        supplier: 'Example Chemie',
        item: 'Ethanol 20 L',
        unit: 'Kanister',
        price: '1420.50',
        currency: 'EUR',
        keywords: 'Ethanol',
        priceMinor: 142_050,
      },
      { item: 'Aceton 5 L', price: '42.50', currency: '', priceMinor: 4_250 },
    ]);
  });

  it('turns prices into minor units of their currency, defaulting to the base currency', () => {
    const r = parsePriceCsv(
      ['Item,Price,Currency', 'Gloves,22,', 'Tips,1200,JPY', 'Paper,9.5,eur'].join('\n'),
      CTX,
    );
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => [x.item, x.currency, x.priceMinor, x.price])).toEqual([
      ['Gloves', '', 2_200, '22.00'],
      ['Tips', 'JPY', 1_200, '1200'],
      ['Paper', 'EUR', 950, '9.50'],
    ]);
    // A currency named in the price header applies to every row.
    expect(parsePriceCsv('Item,Price (EUR)\nGloves,3', CTX).rows[0]).toMatchObject({
      currency: 'EUR',
      priceMinor: 300,
    });
  });

  it('reports every bad line with its number and reason, and imports the rest', () => {
    const csv = [
      'Item,Price,Currency',
      'Gloves,,',
      ',12,',
      'Yen tips,1200.5,JPY',
      'Dollar paper,10,USD',
      'Good,5,',
      '',
      'Broken,abc,',
      'Free,0,',
      'Good,6,',
      'Odd,5,EURO1',
    ].join('\n');
    const r = parsePriceCsv(csv, CTX);
    expect(r.rows.map((x) => x.item)).toEqual(['Good']);
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5, 8, 9, 10, 11]);
    const reason = (line: number) => r.problems.find((p) => p.line === line)?.reason ?? '';
    expect(reason(2)).toMatch(/price is missing/);
    expect(reason(3)).toMatch(/item is missing/);
    expect(reason(4)).toMatch(/JPY prices have 0 decimal places/);
    expect(reason(5)).toMatch(/no exchange rate for USD/);
    expect(reason(8)).toMatch(/"abc" is not a price/);
    expect(reason(9)).toMatch(/above 0/);
    expect(reason(10)).toMatch(/already on line 6/);
    expect(reason(11)).toMatch(/not a currency code/);
  });

  it('reports lines beyond the limit instead of dropping them', () => {
    const body = Array.from({ length: 1002 }, (_, i) => `Item ${String(i)},1`);
    const r = parsePriceCsv(['Item,Price', ...body].join('\n'), CTX);
    expect(r.rows).toHaveLength(1000);
    expect(r.problems.map((p) => p.line)).toEqual([1002, 1003]);
  });

  it('explains a file without the needed columns, or an empty one', () => {
    const r = parsePriceCsv('a,b\n1,2', CTX);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ line: 1 });
    expect(r.problems[0]?.reason).toMatch(/name the columns/);
    expect(parsePriceCsv('', CTX).problems[0]?.reason).toMatch(/empty/);
  });

  it('reads the downloadable template without a problem', () => {
    const template = readFileSync(
      path.resolve(__dirname, '../public/price-list-template.csv'),
      'utf8',
    );
    const r = parsePriceCsv(template, CTX);
    expect(r.problems).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(2);
    expect(r.rows.every((x) => x.supplier.startsWith('Example '))).toBe(true);
  });

  it('replaces rows for the same item and supplier and adds new ones', () => {
    const row = (item: string, supplier: string, price: string): PriceRow => ({
      ...emptyRow(),
      item,
      supplier,
      price,
    });
    const merged = mergeRows(
      [row('Gloves', '', '20'), row('Gloves', 'Example A', '19'), row('', '', '')],
      [row('gloves', '', '22'), row('Paper', '', '5')],
    );
    expect(merged.map((r) => [r.item, r.supplier, r.price])).toEqual([
      ['gloves', '', '22'],
      ['Gloves', 'Example A', '19'],
      ['Paper', '', '5'],
    ]);
  });
});

describe('suggested usual prices', () => {
  const NOW = Date.parse('2026-10-27T10:00:00Z');
  const paid = (item: string, amountBase: number, daysAgo = 5, quantity?: number) => ({
    status: 'approved',
    amountBase,
    createdAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    request: { memo: item, ...(quantity ? { quantity } : {}) },
  });

  it('suggests the median unit price of items bought at least three times', () => {
    const s = suggestPrices(
      [
        paid('Pipette tips', 30_000),
        paid('pipette  TIPS', 31_000),
        paid('Pipette tips', 64_000, 3, 2),
        paid('Pipette tips', 99_000, 200), // too old
        paid('Paper', 500),
        paid('Paper', 600),
      ],
      [],
      NOW,
    );
    expect(s).toEqual([{ item: 'Pipette tips', supplier: '', priceBase: 31_000, purchases: 3 }]);
  });

  it('groups by supplier and carries the supplier paid', () => {
    const from = (supplier: string, amount: number) => {
      const p = paid('Gloves', amount);
      return { ...p, request: { ...p.request, merchant: supplier } };
    };
    const s = suggestPrices(
      [
        from('Example A', 100),
        from('Example A', 120),
        from('Example A', 110),
        from('Example B', 90),
      ],
      [],
      NOW,
    );
    expect(s).toEqual([{ item: 'Gloves', supplier: 'Example A', priceBase: 110, purchases: 3 }]);
  });

  it('skips items that already have a usual price, and anything not approved', () => {
    const refs = [{ item: 'Pipette tips', match: [], priceMinor: 30_000, currency: 'CHF' }];
    const declined = { ...paid('Gloves', 2_000), status: 'declined' };
    expect(
      suggestPrices(
        [
          paid('Pipette tips', 1),
          paid('Pipette tips', 1),
          paid('Pipette tips', 1),
          declined,
          declined,
          declined,
        ],
        refs,
        NOW,
      ),
    ).toEqual([]);
  });
});
