import { fetchAndParse, getImageSrc, normalizeUrl } from '../fetch.ts';
import { parseToPaise } from '../../lib/money.ts';
import { detectCondition } from '../../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';
import { makeWooScraper } from '../woocommerce.ts';

const listScraper = makeWooScraper({
  source: 'HGWorld',
  baseUrl: 'https://hgworld.in',
  searchUrl: (q) => `https://hgworld.in/?s=${q}&post_type=product`,
  cardSelector: 'li.product',
  titleSelectors: ['.woocommerce-loop-product__title a', 'h2 a', 'h3 a', '.woocommerce-loop-product__title'],
  linkSelectors: ['.woocommerce-LoopProduct-link', 'a'],
  imageSelectors: ['img'],
  priceContainer: '.price',
  outOfStockSelector: '.out-of-stock, .outofstock',
  timeoutMs: 20000,
});

// HGWorld redirects single-result searches straight to the product page.
export const hgworld: Scraper = {
  source: 'HGWorld',
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
    const listOutcome = await listScraper.search(query);
    if (listOutcome.items.length > 0 || !listOutcome.ok) return listOutcome;

    const started = Date.now();
    const url = `https://hgworld.in/?s=${encodeURIComponent(query)}&post_type=product`;
    const { doc, html } = await fetchAndParse(url, 20000);
    if (!doc || !html) return listOutcome;

    const titleEl =
      doc.querySelector('h1.product_title') ||
      doc.querySelector('h1.entry-title') ||
      doc.querySelector('h1');
    const priceEl =
      doc.querySelector('p.price ins .amount') ||
      doc.querySelector('p.price .amount') ||
      doc.querySelector('.price .amount');

    const items: ScrapedItem[] = [];
    if (titleEl && priceEl) {
      let title = titleEl.textContent?.trim() || '';
      const pricePaise = parseToPaise(priceEl.textContent);
      const delEl = doc.querySelector('p.price del .amount');
      const originalPricePaise = parseToPaise(delEl?.textContent ?? null);
      const metaImage = doc
        .querySelector('meta[property="og:image"]')
        ?.getAttribute('content');
      const image =
        metaImage ||
        getImageSrc(
          doc.querySelector('.woocommerce-product-gallery__image img') ||
            doc.querySelector('.wp-post-image')
        );
      const condition =
        detectCondition(title) === 'unknown' ? 'new' : detectCondition(title);
      title = title.replace(/\((?:pre-?owned|used)\)/gi, '').trim();

      items.push({
        source: 'HGWorld',
        title,
        url: normalizeUrl(url),
        imageUrl: image,
        pricePaise,
        originalPricePaise:
          originalPricePaise && originalPricePaise !== pricePaise
            ? originalPricePaise
            : null,
        currency: 'INR',
        condition,
        inStock: true,
      });
    }

    return {
      source: 'HGWorld',
      ok: true,
      pageHadContent: html.length > 5000,
      items,
      durationMs: Date.now() - started + listOutcome.durationMs,
    };
  },
};
