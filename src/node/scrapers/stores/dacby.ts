import { fetchAndParse, normalizeUrl } from '../fetch.ts';
import { parseToPaise } from '../../lib/money.ts';
import { normTitleKey } from '../../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

// Dacby is a Flutter web app; SSR emits plain <li> product rows for SEO crawlers.
export const dacby: Scraper = {
  source: 'Dacby',
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const url = `https://dacby.com/buy/search?query=${encodeURIComponent(query)}`;
    const { doc, html, error } = await fetchAndParse(url);

    if (!doc || !html) {
      return { source: 'Dacby', ok: false, pageHadContent: false, items: [], error, durationMs: Date.now() - started };
    }

    const items: ScrapedItem[] = [];
    doc.querySelectorAll('li').forEach((li) => {
      const strongEl = li.querySelector('strong');
      if (!strongEl) return;
      const title = strongEl.textContent?.trim() || '';
      if (!title) return;

      const text = li.textContent || '';
      const priceMatch = text.match(/₹([\d,]+)/);
      if (!priceMatch) return;

      const imgEl = li.querySelector('img');
      const altText = imgEl?.getAttribute('alt') || '';
      const isPreOwned = /pre-?owned/i.test(title) || /pre-?owned/i.test(altText) || /pre-?owned/i.test(text);

      const cleanedTitle = title.replace(/\(Pre-owned\)/gi, '').trim();
      const condition = isPreOwned ? ('preowned' as const) : ('new' as const);
      items.push({
        source: 'Dacby',
        title: cleanedTitle,
        url: normalizeUrl(url),
        imageUrl: imgEl?.getAttribute('src') || '',
        pricePaise: parseToPaise(priceMatch[1]),
        originalPricePaise: null,
        currency: 'INR',
        condition,
        inStock: true,
        // Same featured products appear under every search URL, and PS4/PS5
        // variants share a bare title — the product image is the only stable
        // per-variant identity Dacby's SSR exposes.
        keyHint: `dacby::${normTitleKey(cleanedTitle)}::${condition}::${imgEl?.getAttribute('src') ?? 'noimg'}`,
      });
    });

    return {
      source: 'Dacby',
      ok: true,
      pageHadContent: html.length > 2000,
      items,
      durationMs: Date.now() - started,
    };
  },
};
