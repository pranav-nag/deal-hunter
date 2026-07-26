import { openPage } from '../browser.ts';
import { normalizeUrl } from '../fetch.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

// Play-Asia search renders client-side (skeleton placeholders in HTML).
// Browser tier: load results, read rendered product cards.
// Prices are USD — stored with currency 'USD'; deals engine converts to
// advisory landed INR, labeled "est." in the UI.
export const playasia: Scraper = {
  source: 'PlayAsia',
  tier: 'best-effort',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const session = await openPage(30000);
    if (!session) {
      return {
        source: 'PlayAsia', ok: false, pageHadContent: false, items: [],
        error: 'Browser launch failed', durationMs: Date.now() - started,
      };
    }

    try {
      const url = `https://www.play-asia.com/en/search/${encodeURIComponent(query)}`;
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
      // Intermittent Cloudflare managed challenge — wait for it to clear.
      for (let i = 0; i < 10; i++) {
        const title = await session.page.title();
        if (!/just a moment/i.test(title)) break;
        await session.page.waitForTimeout(2000);
      }
      await session.page
        .waitForSelector('.pa-modern-product-item:not(.pa-skeleton-item) a', { timeout: 15000 })
        .catch(() => {});

      const rawItems = await session.page.evaluate(() => {
        const cards = document.querySelectorAll('.pa-modern-product-item:not(.pa-skeleton-item)');
        const out: Array<{
          title: string; url: string; image: string; priceText: string; platform: string; soldOut: boolean;
        }> = [];
        cards.forEach((card) => {
          const linkEl = card.querySelector('a[href*="/paOS-"], a[href]');
          const titleEl = card.querySelector('[class*="product-title"], [class*="product-name"], a[title]');
          const imgEl = card.querySelector('img');
          const platformEl = card.querySelector('[class*="platform"]');
          if (!linkEl || !titleEl) return;
          // Play-Asia geo-localizes to INR for Indian visitors ("₹ 6,020");
          // fall back to US$ if geo-detection changes.
          const priceEl = card.querySelector('.pa-modern-current-price');
          const priceSource = priceEl?.textContent ?? card.textContent ?? '';
          const priceMatch =
            priceSource.replace(/ /g, ' ').match(/₹\s*[\d,]+(?:\.\d{2})?/) ??
            priceSource.match(/US\$\s*[\d,]+(?:\.\d{2})?/);
          out.push({
            title:
              titleEl.getAttribute('title')?.trim() || titleEl.textContent?.trim() || '',
            url: (linkEl as HTMLAnchorElement).href,
            image: imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || '',
            priceText: priceMatch?.[0] ?? '',
            platform: platformEl?.textContent?.trim() ?? '',
            soldOut: /sold\s*out/i.test(card.textContent ?? ''),
          });
        });
        return out;
      });

      const items: ScrapedItem[] = rawItems
        .filter((r) => r.title && /ps4|ps5|playstation/i.test(`${r.title} ${r.platform}`))
        .map((r) => {
          const isInr = r.priceText.includes('₹');
          const m = r.priceText.match(/([\d,]+(?:\.\d+)?)/);
          const amount = m ? Number(m[1].replace(/,/g, '')) : null;
          return {
            source: 'PlayAsia',
            title: r.title,
            url: normalizeUrl(r.url),
            imageUrl: r.image.startsWith('//') ? `https:${r.image}` : r.image,
            pricePaise:
              amount !== null && Number.isFinite(amount) ? Math.round(amount * 100) : null,
            originalPricePaise: null,
            currency: isInr ? 'INR' : 'USD',
            condition: 'new' as const,
            inStock: !r.soldOut,
          };
        });

      return {
        source: 'PlayAsia',
        ok: true,
        pageHadContent: rawItems.length > 0 || (await session.page.content()).length > 20000,
        items,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        source: 'PlayAsia', ok: false, pageHadContent: false, items: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    } finally {
      await session.close();
    }
  },
};
