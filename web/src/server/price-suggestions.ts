import type { MandateConfig, PaymentRecord } from '@flow-e/mcp/core';
import { money } from '@/lib/format';
import { suggestPrices } from '@/lib/price-list';
import type { PriceSuggestion } from '@/app/sandbox/mandate/prices-field';

/**
 * Usual prices to suggest on the Mandate page, from approved purchases of the last 90 days, each
 * with the supplier it was paid to.
 */
export function priceSuggestions(view: {
  now: number;
  config: MandateConfig;
  payments: readonly PaymentRecord[];
  baseCurrency: string;
  currencyDecimals: Readonly<Record<string, number>> | undefined;
}): PriceSuggestion[] {
  const decimals = view.currencyDecimals?.[view.baseCurrency] ?? 2;
  return suggestPrices(view.payments, view.config.policy.referencePrices ?? [], view.now).map(
    (s) => ({
      item: s.item,
      supplier: s.supplier,
      price: (s.priceBase / 10 ** decimals).toFixed(decimals).replace(/\.0+$/, ''),
      why: `${money(s.priceBase, view.baseCurrency, view.currencyDecimals)}, median of ${String(s.purchases)} purchases`,
    }),
  );
}
