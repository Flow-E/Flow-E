import { describe, expect, it } from 'vitest';
import { mergeLines, parsePriceCsv, suggestPrices } from '@/lib/price-list';

describe('price list import', () => {
  it('reads a comma CSV with a header row, quoted cells and Swiss number formats', () => {
    const csv = [
      'Item,Price,Unit,Keywords',
      '"Phosphate buffer solution, 10 L",1150,bottle,phosphate buffer',
      "Pipette tips 20 racks,CHF 1'310.50,box,",
      'Nitrile gloves,,box,',
    ].join('\n');
    const r = parsePriceCsv(csv);
    expect(r.lines).toEqual([
      {
        item: 'Phosphate buffer solution, 10 L',
        price: '1150',
        match: 'phosphate buffer',
        unit: 'bottle',
      },
      { item: 'Pipette tips 20 racks', price: '1310.50', match: '', unit: 'box' },
    ]);
    expect(r.skipped).toEqual(['Row 4: needs an item and a price above 0.']);
  });

  it('reads semicolons and decimal commas, and German headers', () => {
    const r = parsePriceCsv('Artikel;Preis\nEthanol 20 L;420,50\n');
    expect(r.lines).toEqual([{ item: 'Ethanol 20 L', price: '420.50', match: '', unit: '' }]);
  });

  it('explains a file without the needed columns', () => {
    expect(parsePriceCsv('a,b\n1,2').skipped[0]).toMatch(/name the columns/);
  });

  it('replaces lines for the same item and adds new ones', () => {
    const merged = mergeLines('Gloves | 20 | | box\nTips | 300', [
      { item: 'gloves', price: '22', match: '', unit: 'box' },
      { item: 'Paper', price: '5', match: '', unit: '' },
    ]);
    expect(merged).toBe('gloves | 22 |  | box\nTips | 300\nPaper | 5');
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
    expect(s).toEqual([{ item: 'Pipette tips', priceBase: 31_000, purchases: 3 }]);
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
