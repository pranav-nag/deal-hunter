import { openPage } from '../browser.ts';
import { parseToPaise } from '../../lib/money.ts';
import { normalizeUrl } from '../fetch.ts';
import { detectCondition } from '../../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

// Flipkart — bot-protected, class names rotate. Best-effort: anchor on stable
// structural signals (product links + ₹ prices) instead of hashed class names.
export const flipkart: Scraper = {
  source: 'Flipkart',
  tier: 'best-effort',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const session = await openPage(25000);
    if (!session) {
      return {
        source: 'Flipkart', ok: false, pageHadContent: false, items: [],
        error: 'Browser launch failed', durationMs: Date.now() - started,
      };
    }

    try {
      const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query + ' game')}&marketplace=FLIPKART`;
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
      await session.page.waitForSelector('a[href*="/p/"]', { timeout: 12000 }).catch(() => {});

      const rawItems = await session.page.evaluate(() => {
        const out: Array<{ title: string; url: string; image: string; priceText: string }> = [];
        const seen = new Set<string>();
        // NB: no named helper functions in here — this body is serialised into
        // the browser, where esbuild's __name helper does not exist.
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"]').forEach((a) => {
          const href = a.href.split('?')[0];
          if (seen.has(href)) return;

          // Flipkart sometimes wraps several products in a single div[data-id].
          // Anchoring on that container makes every product inside it read the
          // same first ₹ in the container's text, so unrelated games end up
          // sharing one price and flap between passes. Instead climb only as
          // far as the widest ancestor that still holds this one product.
          let container: Element = a;
          for (
            let parent = a.parentElement;
            parent &&
            new Set(
              Array.from(parent.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"]')).map(
                (x) => x.href.split('?')[0]
              )
            ).size <= 1;
            parent = parent.parentElement
          ) {
            container = parent;
          }

          // Selling price is the first rupee amount that is an element's own
          // text and is not struck through (struck through = MRP).
          let priceText = '';
          for (const el of Array.from(container.querySelectorAll('*'))) {
            const own = Array.from(el.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent ?? '')
              .join('')
              .trim();
            if (!/^₹[\d,]+$/.test(own)) continue;
            if (getComputedStyle(el).textDecorationLine.includes('line-through')) continue;
            priceText = own;
            break;
          }
          // Older/blank layouts render the price as loose text.
          if (!priceText) priceText = (container.textContent ?? '').match(/₹[\d,]+/)?.[0] ?? '';

          const title =
            a.getAttribute('title') ||
            container.querySelector('img')?.getAttribute('alt') ||
            a.textContent?.trim() ||
            '';
          if (!title || !priceText) return;
          seen.add(href);
          out.push({
            title,
            url: href,
            image: container.querySelector('img')?.getAttribute('src') ?? '',
            priceText,
          });
        });
        return out;
      });

      const items: ScrapedItem[] = rawItems
        .filter((r) => /ps4|ps5|playstation/i.test(r.title))
        .map((r) => ({
          source: 'Flipkart',
          title: r.title,
          url: normalizeUrl(r.url),
          imageUrl: r.image,
          pricePaise: parseToPaise(r.priceText),
          originalPricePaise: null,
          currency: 'INR',
          condition: detectCondition(r.title) === 'preowned' ? 'preowned' : 'new',
          inStock: true,
        }));

      return {
        source: 'Flipkart',
        ok: true,
        pageHadContent: rawItems.length > 0,
        items,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        source: 'Flipkart', ok: false, pageHadContent: false, items: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    } finally {
      await session.close();
    }
  },
};
