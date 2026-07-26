import { fetchAndParse, getImageSrc, normalizeUrl } from '../fetch.ts';
import { parseToPaise } from '../../lib/money.ts';
import { detectCondition } from '../../lib/identity.ts';
import { ScrapedItem, ScrapeOutcome, Scraper } from '../types.ts';

export const gamenation: Scraper = {
  source: 'GameNation',
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
    const started = Date.now();
    const url = `https://gamenation.in/Search?term=${encodeURIComponent(query)}`;
    const { doc, html, error } = await fetchAndParse(url);

    if (!doc || !html) {
      return { source: 'GameNation', ok: false, pageHadContent: false, items: [], error, durationMs: Date.now() - started };
    }

    const items: ScrapedItem[] = [];
    const cards = doc.querySelectorAll('.product-card-1');

    cards.forEach((card) => {
      const titleEl = card.querySelector('.product-card-1--middle p');
      const priceEl = card.querySelector('.product-price--display p');
      let link = card.getAttribute('href') || card.querySelector('a')?.getAttribute('href') || '';
      if (link && !link.startsWith('http')) {
        link = `https://gamenation.in${link.startsWith('/') ? '' : '/'}${link}`;
      }
      if (!titleEl || !priceEl || !link) return;

      let title = titleEl.textContent?.trim() || '';
      const pricePaise = parseToPaise(priceEl.textContent);
      const originalEl = card.querySelector('.product-price--original p');
      const originalPricePaise = parseToPaise(originalEl?.textContent ?? null);

      const isPreOwned =
        detectCondition(title) === 'preowned' ||
        Boolean(card.querySelector('.product-type.pre-owned'));
      title = title.replace(/\(PRE-OWNED\)/gi, '').trim();

      const stockTag = card.querySelector('.playable-tag')?.textContent?.trim() ?? '';
      const outOfStock = stockTag.toLowerCase().includes('out of stock');

      items.push({
        source: 'GameNation',
        title,
        url: normalizeUrl(link),
        imageUrl: getImageSrc(card.querySelector('.product-card-1--top img') || card.querySelector('img')),
        pricePaise,
        originalPricePaise:
          originalPricePaise && originalPricePaise !== pricePaise ? originalPricePaise : null,
        currency: 'INR',
        condition: isPreOwned ? 'preowned' : 'new',
        inStock: !outOfStock,
      });
    });

    return {
      source: 'GameNation',
      ok: true,
      pageHadContent: html.length > 5000,
      items,
      durationMs: Date.now() - started,
    };
  },
};
