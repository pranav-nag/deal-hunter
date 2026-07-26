import { fetchJson, normalizeUrl } from '../fetch.ts';
import { parseToPaise } from '../../lib/money.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

interface ShopifySuggestProduct {
  available?: boolean;
  title?: string;
  url?: string;
  image?: string;
  price?: string;
  price_max?: string;
  compare_at_price_min?: string;
  compare_at_price_max?: string;
}

interface ShopifySuggestResponse {
  resources?: {
    results?: {
      products?: ShopifySuggestProduct[];
    };
  };
}

interface ShopifyProductJs {
  variants?: Array<{
    title?: string;
    price?: number; // paise (Shopify money in minor units)
    compare_at_price?: number | null;
    available?: boolean;
  }>;
}

// Console Garage sells New / Pre-Owned variants and also *buys* discs via a
// "BUYBACK(SELL)" variant that is always the cheapest — the predictive-search
// `price` field is the min across variants, i.e. the buyback offer, NOT a
// sale price. So resolve real variants per product via the public .js endpoint.
const BUYBACK_RE = /buy\s*-?\s*back|\bsell\b|trade\s*-?\s*in/i;

export const consolegarage: Scraper = {
  source: 'ConsoleGarage',
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const url = `https://consolegarage.com/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=10`;
    const { data, error } = await fetchJson<ShopifySuggestResponse>(url);

    if (!data) {
      return { source: 'ConsoleGarage', ok: false, pageHadContent: false, items: [], error, durationMs: Date.now() - started };
    }

    const products = (data.resources?.results?.products ?? []).filter(
      (p) => p.title && p.url
    );

    const items: ScrapedItem[] = [];
    for (const p of products.slice(0, 6)) {
      const productUrl = normalizeUrl(
        p.url!.startsWith('http') ? p.url! : `https://consolegarage.com${p.url}`
      );
      const imageUrl = p.image?.startsWith('//') ? `https:${p.image}` : p.image ?? '';

      const handleMatch = p.url!.match(/\/products\/([^/?#]+)/);
      const { data: pjs } = handleMatch
        ? await fetchJson<ShopifyProductJs>(
            `https://consolegarage.com/products/${handleMatch[1]}.js`
          )
        : { data: null };

      const variants = (pjs?.variants ?? []).filter(
        (v) => !BUYBACK_RE.test(v.title ?? '')
      );

      if (variants.length > 0) {
        for (const v of variants) {
          const preowned = /pre\s*-?\s*owned|used/i.test(v.title ?? '');
          items.push({
            source: 'ConsoleGarage',
            title: p.title!,
            url: productUrl,
            imageUrl,
            pricePaise: typeof v.price === 'number' ? v.price : null,
            originalPricePaise:
              typeof v.compare_at_price === 'number' &&
              typeof v.price === 'number' &&
              v.compare_at_price > v.price
                ? v.compare_at_price
                : null,
            currency: 'INR',
            condition: preowned ? 'preowned' : 'new',
            inStock: v.available !== false,
            keyHint: `cg::${productUrl}::${preowned ? 'preowned' : 'new'}`,
          });
        }
        continue;
      }

      // Variant fetch failed — fall back to suggest data, using the max price
      // (min is the buyback offer).
      const pricePaise = parseToPaise(p.price_max ?? p.price ?? null);
      const comparePaise = parseToPaise(p.compare_at_price_max ?? null);
      items.push({
        source: 'ConsoleGarage',
        title: p.title!,
        url: productUrl,
        imageUrl,
        pricePaise,
        originalPricePaise:
          comparePaise && pricePaise && comparePaise > pricePaise ? comparePaise : null,
        currency: 'INR',
        condition: 'new',
        inStock: p.available !== false,
        keyHint: `cg::${productUrl}::new`,
      });
    }

    return {
      source: 'ConsoleGarage',
      ok: true,
      pageHadContent: true,
      items,
      durationMs: Date.now() - started,
    };
  },
};
