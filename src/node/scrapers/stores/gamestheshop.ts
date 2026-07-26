import { fetchJson, normalizeUrl } from '../fetch.ts';
import { rupeesToPaise } from '../../lib/money.ts';
import { detectCondition } from '../../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

// GamesTheShop rebuilt on green-api.gamestheshop.com (2026).
// Search via storefront autocomplete endpoint; product URLs are
// /product/{product_id}?variant={id}. Prices are whole rupees.

interface GtsVariant {
  id?: string;
  product_id?: string;
  name?: string;
  displayName?: string;
  edition?: { name?: string };
  category?: { name?: string };
  platform?: { name?: string };
  regular_price?: number | null;
  sale_price?: number | null;
  thumbnail?: string;
  stock_status?: string;
}

interface GtsAutocompleteResponse {
  status?: string;
  data?: { products?: GtsVariant[] };
}

export const gamestheshop: Scraper = {
  source: 'GamesTheShop',
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const url = `https://green-api.gamestheshop.com/storefront/search/autocomplete?q=${encodeURIComponent(query)}`;
    const { data, error } = await fetchJson<GtsAutocompleteResponse>(url);

    if (!data) {
      return { source: 'GamesTheShop', ok: false, pageHadContent: false, items: [], error, durationMs: Date.now() - started };
    }

    const products = data.data?.products ?? [];
    const items: ScrapedItem[] = products
      .filter((p) => p.name && p.product_id)
      // Software only — the API also returns controllers/accessories.
      .filter((p) => !p.category?.name || !/accessor|hardware|console|merch/i.test(p.category.name))
      .filter((p) => !p.platform?.name || /ps4|ps5|playstation/i.test(p.platform.name))
      .map((p) => {
        const sale = p.sale_price ?? null;
        const regular = p.regular_price ?? null;
        const price = sale ?? regular;
        const edition = p.edition?.name && p.edition.name !== 'Standard' ? ` ${p.edition.name}` : '';
        const platform = p.platform?.name ? ` ${p.platform.name}` : '';
        const title = `${p.name}${edition}${platform}`.trim();
        return {
          source: 'GamesTheShop',
          title,
          url: normalizeUrl(
            `https://www.gamestheshop.com/product/${p.product_id}${p.id ? `?variant=${p.id}` : ''}`
          ),
          imageUrl: p.thumbnail ?? '',
          pricePaise: price !== null ? rupeesToPaise(price) : null,
          originalPricePaise:
            regular !== null && sale !== null && regular > sale ? rupeesToPaise(regular) : null,
          currency: 'INR',
          condition: detectCondition(title) === 'preowned' ? 'preowned' : 'new',
          inStock: p.stock_status ? /in\s*stock/i.test(p.stock_status) : true,
        };
      });

    return {
      source: 'GamesTheShop',
      ok: true,
      pageHadContent: data.status === 'success',
      items,
      durationMs: Date.now() - started,
    };
  },
};
