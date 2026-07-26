import { JSDOM } from 'jsdom';
import { fetchAndParse } from '../fetch.ts';
import { fetchHtmlViaBrowser } from '../browser.ts';
import { parseWooDocument, WooConfig } from '../woocommerce.ts';
import { ScrapeOutcome, Scraper } from '../types.ts';

const config: WooConfig = {
  source: 'E2ZStore',
  baseUrl: 'https://e2zstore.com',
  searchUrl: (q) => `https://e2zstore.com/?s=${q}&post_type=product`,
  cardSelector: '.product-small.col',
  titleSelectors: ['.product-title a'],
  linkSelectors: ['.product-title a'],
  imageSelectors: ['.box-image img', 'img'],
  priceContainer: '.price',
  outOfStockSelector: '.out-of-stock',
};

// E2ZStore's Cloudflare blocks Node's TLS fingerprint (curl passes, undici 403s).
// Plain fetch first; fall back to real browser on challenge.
export const e2zstore: Scraper = {
  source: 'E2ZStore',
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const url = config.searchUrl(encodeURIComponent(query));

    const plain = await fetchAndParse(url, 12000);
    if (plain.doc && plain.html && !/just a moment|cf-challenge/i.test(plain.html)) {
      const { items, pageHadContent } = parseWooDocument(config, plain.doc, plain.html);
      return { source: 'E2ZStore', ok: true, pageHadContent, items, durationMs: Date.now() - started };
    }

    const html = await fetchHtmlViaBrowser(url, 25000, '.product-small.col');
    if (!html) {
      return {
        source: 'E2ZStore', ok: false, pageHadContent: false, items: [],
        error: plain.error ?? 'Cloudflare challenge (browser fallback failed)',
        durationMs: Date.now() - started,
      };
    }
    const doc = new JSDOM(html).window.document as unknown as Document;
    const { items, pageHadContent } = parseWooDocument(config, doc, html);
    return { source: 'E2ZStore', ok: true, pageHadContent, items, durationMs: Date.now() - started };
  },
};
