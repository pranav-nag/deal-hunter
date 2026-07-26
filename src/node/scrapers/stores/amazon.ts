import { openPage } from '../browser.ts';
import { parseToPaise } from '../../lib/money.ts';
import { normalizeUrl } from '../fetch.ts';
import { detectCondition } from '../../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

// Amazon.in — heavy bot protection; expect this to sit "degraded" often.
// Best-effort browser scrape of search results, PS4/PS5 video-games category.
export const amazon: Scraper = {
  source: 'AmazonIn',
  tier: 'best-effort',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const session = await openPage(25000);
    if (!session) {
      return {
        source: 'AmazonIn', ok: false, pageHadContent: false, items: [],
        error: 'Browser launch failed', durationMs: Date.now() - started,
      };
    }

    try {
      const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}&i=videogames`;
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
      await session.page
        .waitForSelector('div[data-component-type="s-search-result"]', { timeout: 12000 })
        .catch(() => {});

      const html = await session.page.content();
      const blocked = /captcha|api-services-support@amazon|Robot Check/i.test(html);
      if (blocked) {
        return {
          source: 'AmazonIn', ok: false, pageHadContent: false, items: [],
          error: 'Bot challenge page', durationMs: Date.now() - started,
        };
      }

      const rawItems = await session.page.evaluate(() => {
        const out: Array<{ title: string; url: string; image: string; priceText: string }> = [];
        document
          .querySelectorAll('div[data-component-type="s-search-result"]')
          .forEach((card) => {
            const titleEl = card.querySelector('h2 span');
            const linkEl = card.querySelector('a.a-link-normal[href*="/dp/"], h2 a');
            const priceEl = card.querySelector('.a-price .a-offscreen');
            const imgEl = card.querySelector('img.s-image');
            if (!titleEl || !linkEl) return;
            out.push({
              title: titleEl.textContent?.trim() ?? '',
              url: (linkEl as HTMLAnchorElement).href,
              image: imgEl?.getAttribute('src') ?? '',
              priceText: priceEl?.textContent ?? '',
            });
          });
        return out;
      });

      const items: ScrapedItem[] = rawItems
        .filter((r) => r.title && /ps4|ps5|playstation/i.test(r.title))
        .map((r) => ({
          source: 'AmazonIn',
          title: r.title,
          url: normalizeUrl(r.url.split('/ref=')[0]),
          imageUrl: r.image,
          pricePaise: parseToPaise(r.priceText),
          originalPricePaise: null,
          currency: 'INR',
          condition: detectCondition(r.title) === 'preowned' ? 'preowned' : 'new',
          inStock: true,
        }));

      return {
        source: 'AmazonIn',
        ok: true,
        pageHadContent: rawItems.length > 0 || html.length > 50000,
        items,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        source: 'AmazonIn', ok: false, pageHadContent: false, items: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    } finally {
      await session.close();
    }
  },
};
