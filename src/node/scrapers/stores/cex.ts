import { openPage } from '../browser.ts';
import { parseToPaise } from '../../lib/money.ts';
import { normalizeUrl } from '../fetch.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

interface CexBox {
  boxName?: string;
  boxId?: string;
  sellPrice?: number;
  categoryFriendlyName?: string;
  imageUrls?: { medium?: string };
  // Not a boolean: a list of store names where the box is *out* of stock.
  outOfStock?: string[];
  ecomQuantity?: number;
}

// Cex India (in.webuy.com) sits behind Cloudflare; plain fetch gets challenged.
// Strategy: drive a real browser to the search page and read the search JSON
// from within the page context.
//
// Search moved from Cex's own wss2.cex.in.webuy.io /boxes endpoint to Algolia
// (search.webuy.io/1/indexes/*/queries); the old endpoint is never called now.
// We still intercept rather than calling Algolia directly, because the API key
// is embedded in the SPA's query string and rotates.
export const cex: Scraper = {
  source: 'CexIndia',
  tier: 'best-effort',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const session = await openPage(25000);
    if (!session) {
      return {
        source: 'CexIndia', ok: false, pageHadContent: false, items: [],
        error: 'Browser launch failed', durationMs: Date.now() - started,
      };
    }

    try {
      // Navigate to the real search page and intercept the SPA's own Algolia
      // query response — avoids CORS and matches whatever auth the site uses.
      const boxesPromise = session.page
        .waitForResponse(
          (res) =>
            res.url().includes('search.webuy.io') &&
            res.url().includes('/queries') &&
            res.status() === 200,
          { timeout: 20000 }
        )
        .catch(() => null);
      await session.page.goto(
        `https://in.webuy.com/search?stext=${encodeURIComponent(query)}`,
        { waitUntil: 'domcontentloaded' }
      );
      const boxesResponse = await boxesPromise;
      const data = boxesResponse
        ? ((await boxesResponse.json().catch(() => null)) as {
            results?: { hits?: CexBox[] }[];
          } | null)
        : null;

      const boxes = data?.results?.[0]?.hits ?? [];
      // Cex sells consoles/accessories too — keep PlayStation game categories only.
      const items: ScrapedItem[] = boxes
        .filter((b) => b.boxName && b.boxId)
        .filter((b) => /playstation|ps4|ps5/i.test(`${b.categoryFriendlyName} ${b.boxName}`))
        .filter((b) => !/console|controller|headset|accessor/i.test(b.categoryFriendlyName ?? ''))
        .map((b) => ({
          source: 'CexIndia',
          title: b.boxName!,
          url: normalizeUrl(`https://in.webuy.com/product-detail?id=${encodeURIComponent(b.boxId!)}`),
          imageUrl: b.imageUrls?.medium ?? '',
          pricePaise: parseToPaise(b.sellPrice ?? null),
          originalPricePaise: null,
          currency: 'INR',
          condition: 'preowned' as const, // everything Cex sells is pre-owned
          // Only ecommerce stock is actually buyable from here. Cex India is
          // store-pickup driven and currently lists "IN Ecommerce" as out of
          // stock for everything, so in practice these are price references.
          inStock: (b.ecomQuantity ?? 0) > 0,
        }));

      return {
        source: 'CexIndia',
        ok: true,
        pageHadContent: data !== null,
        items,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        source: 'CexIndia', ok: false, pageHadContent: false, items: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    } finally {
      await session.close();
    }
  },
};
