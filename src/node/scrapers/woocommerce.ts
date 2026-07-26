import { fetchAndParse, getImageSrc, normalizeUrl } from './fetch.ts';
import { parseToPaise } from '../lib/money.ts';
import { detectCondition } from '../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from './types.ts';

export interface WooConfig {
  source: string;
  baseUrl: string;
  searchUrl: (encodedQuery: string) => string;
  cardSelector: string;
  titleSelectors: string[];
  linkSelectors: string[];
  imageSelectors: string[];
  priceContainer?: string; // defaults to card itself
  outOfStockSelector?: string;
  timeoutMs?: number;
}

function firstMatch(root: Element, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Shared scraper for WooCommerce storefronts (GameLoot, e2zStore, HGWorld, Nekavo).
 * Price pattern: `.price ins .amount` = sale price, `.price del .amount` = MRP.
 */
export function parseWooDocument(
  config: WooConfig,
  doc: Document,
  html: string
): { items: ScrapedItem[]; pageHadContent: boolean } {

      const items: ScrapedItem[] = [];
      const cards = doc.querySelectorAll(config.cardSelector);

      cards.forEach((card) => {
        const titleEl = firstMatch(card, config.titleSelectors);
        const linkEl = firstMatch(card, config.linkSelectors);
        const priceRoot = config.priceContainer
          ? card.querySelector(config.priceContainer) ?? card
          : card;
        const priceEl =
          priceRoot.querySelector('ins .amount, ins .woocommerce-Price-amount') ||
          priceRoot.querySelector('.amount, .woocommerce-Price-amount');
        const outOfStock = config.outOfStockSelector
          ? Boolean(card.querySelector(config.outOfStockSelector))
          : false;
        // Sold-out WooCommerce cards often omit the price entirely — keep them
        // (price null, inStock false) instead of dropping the listing.
        if (!titleEl || !linkEl || (!priceEl && !outOfStock)) return;

        let title =
          linkEl.getAttribute('title')?.trim() || titleEl.textContent?.trim() || '';
        if (!title) return;

        let link = linkEl.getAttribute('href') || '';
        if (link && !link.startsWith('http')) {
          link = config.baseUrl + (link.startsWith('/') ? '' : '/') + link;
        }
        if (!link) return;

        const pricePaise = parseToPaise(priceEl?.textContent?.replace(/ /g, ' '));
        const delEl = priceRoot.querySelector('del .amount, del .woocommerce-Price-amount');
        const originalPricePaise = parseToPaise(delEl?.textContent?.replace(/ /g, ' ') ?? null);

        const condition =
          detectCondition(title) === 'unknown' ? 'new' : detectCondition(title);
        title = title.replace(/\((?:pre-?owned|used)\)/gi, '').trim();

        items.push({
          source: config.source,
          title,
          url: normalizeUrl(link),
          imageUrl: getImageSrc(firstMatch(card, config.imageSelectors)),
          pricePaise,
          originalPricePaise:
            originalPricePaise && originalPricePaise !== pricePaise
              ? originalPricePaise
              : null,
          currency: 'INR',
          condition,
          inStock: !outOfStock,
        });
      });

  // Heuristic: a real WooCommerce page always has a body with products area
  // or a "no results" notice. Trivially small HTML = challenge/error page.
  const pageHadContent =
    html.length > 5000 &&
    (cards.length > 0 || /no products were found|no results|woocommerce/i.test(html));

  return { items, pageHadContent };
}

export function makeWooScraper(config: WooConfig): Scraper {
  return {
    source: config.source,
    tier: 'reliable',
    async search(query: string): Promise<ScrapeOutcome> {
      const started = Date.now();
      const url = config.searchUrl(encodeURIComponent(query));
      const { doc, html, error } = await fetchAndParse(url, config.timeoutMs ?? 12000);

      if (!doc || !html) {
        return {
          source: config.source,
          ok: false,
          pageHadContent: false,
          items: [],
          error,
          durationMs: Date.now() - started,
        };
      }

      const { items, pageHadContent } = parseWooDocument(config, doc, html);
      return {
        source: config.source,
        ok: true,
        pageHadContent,
        items,
        durationMs: Date.now() - started,
      };
    },
  };
}
