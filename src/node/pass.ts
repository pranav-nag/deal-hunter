import { ALL_SCRAPERS } from './scrapers/index.ts';
import type { Scraper, ScrapeOutcome } from './scrapers/types.ts';
import { guardOutcome } from './scrapers/relevance.ts';
import { normalizeUrl } from './scrapers/fetch.ts';
import { loadWishlist, searchQueries, type WishlistGame } from './state/wishlist.ts';
import { listingKey, loadListings, saveListings, type StoredListing } from './state/listings.ts';
import { appendPrices, readPrices } from './state/prices.ts';
import { loadHealth, saveHealth, updateHealth } from './state/health.ts';
import { pruneListings } from './state/prune.ts';
import { matchListing } from './matching/index.ts';
import { diffPass, type DealEvent } from './events/diff.ts';
import { computeStats, sendEvents, sendBrokenSourceAlert } from './discord/notify.ts';

export async function runSource(
  scraper: Scraper,
  games: WishlistGame[],
  opts: { seed?: boolean; now?: number } = {}
): Promise<{ events: DealEvent[]; outcomes: ScrapeOutcome[] }> {
  const now = opts.now ?? Date.now();
  const previous = await loadListings(scraper.source);
  // A source with no prior state is always seeded, so a first run can never flood.
  const seed = opts.seed ?? Object.keys(previous.listings).length === 0;

  const outcomes: ScrapeOutcome[] = [];
  const byKey = new Map<string, { key: string; listing: Omit<StoredListing, 'firstSeen' | 'lastSeen' | 'missedPasses'> }>();

  for (const game of games) {
    for (const query of searchQueries(game)) {
      const outcome = guardOutcome(await scraper.search(query), query);
      outcomes.push(outcome);
      for (const item of outcome.items) {
        const identity = item.keyHint ?? normalizeUrl(item.url);
        const key = listingKey(scraper.source, identity);
        if (byKey.has(key)) continue;
        const match = matchListing(item.title, games);
        byKey.set(key, {
          key,
          listing: {
            title: item.title, url: item.url, imageUrl: item.imageUrl,
            pricePaise: item.pricePaise, originalPricePaise: item.originalPricePaise,
            currency: item.currency, condition: item.condition, inStock: item.inStock,
            gameSlug: match.gameSlug, matchScore: match.matchScore, matchStatus: match.matchStatus,
          },
        });
      }
    }
  }

  const ownedSlugs = new Set(games.filter((g) => g.status === 'owned').map((g) => g.slug));
  const { next, events, pricePoints } = diffPass({
    source: scraper.source, previous, scraped: [...byKey.values()], now, seed, ownedSlugs,
  });

  await saveListings(pruneListings(next, now));
  await appendPrices(scraper.source, pricePoints);

  const health = await loadHealth();
  const { health: nextHealth, justBroke } = updateHealth(health, scraper.source, outcomes, now);
  await saveHealth(nextHealth);
  if (justBroke) {
    await sendBrokenSourceAlert(scraper.source, nextHealth[scraper.source].lastError ?? 'unknown');
  }

  return { events, outcomes };
}

export async function runPass(
  opts: { only?: string[]; seed?: boolean } = {}
): Promise<{ sources: number; events: number; alerts: number }> {
  const games = await loadWishlist();
  const scrapers = opts.only?.length
    ? ALL_SCRAPERS.filter((s) => opts.only!.includes(s.source))
    : ALL_SCRAPERS;

  // Sources run in parallel; queries within a source stay sequential so the
  // per-host politeness delay in fetch.ts actually applies.
  const results = await Promise.all(
    scrapers.map(async (scraper) => {
      try {
        return await runSource(scraper, games, { seed: opts.seed });
      } catch (error) {
        console.error(`[${scraper.source}] pass failed:`, error);
        return { events: [] as DealEvent[], outcomes: [] as ScrapeOutcome[] };
      }
    })
  );

  const events = results.flatMap((r) => r.events);
  const bySource = new Map<string, Awaited<ReturnType<typeof readPrices>>>();
  for (const source of new Set(events.map((e) => e.source))) {
    bySource.set(source, await readPrices(source));
  }
  const gameBySlug = new Map(games.map((g) => [g.slug, g]));

  const alerts = await sendEvents(events, (event) => ({
    game: event.listing.gameSlug ? gameBySlug.get(event.listing.gameSlug) : undefined,
    stats: computeStats(bySource.get(event.source) ?? [], event.key),
  }));

  return { sources: scrapers.length, events: events.length, alerts };
}
