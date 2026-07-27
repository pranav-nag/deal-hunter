import { ALL_SCRAPERS } from './scrapers/index.ts';
import type { Scraper, ScrapeOutcome } from './scrapers/types.ts';
import { guardOutcome } from './scrapers/relevance.ts';
import { normalizeUrl } from './scrapers/fetch.ts';
import { gamesMissingTarget, loadWishlist, searchQueries, type WishlistGame } from './state/wishlist.ts';
import {
  listingKey,
  loadListings,
  recordAlerts,
  saveListings,
  type StoredListing,
} from './state/listings.ts';
import { appendPrices, readPrices } from './state/prices.ts';
import { loadHealth, saveHealth, updateHealth } from './state/health.ts';
import { pruneListings } from './state/prune.ts';
import { matchListing } from './matching/index.ts';
import { diffPass, type DealEvent } from './events/diff.ts';
import { applyCircuitBreaker } from './events/breaker.ts';
import {
  computeStats,
  sendBreakerSummary,
  sendBrokenSourceAlert,
  sendDealAlerts,
  type AlternativeListing,
} from './discord/notify.ts';

export async function runSource(
  scraper: Scraper,
  games: WishlistGame[],
  opts: { seed?: boolean; now?: number } = {}
): Promise<{ events: DealEvent[]; outcomes: ScrapeOutcome[]; listingCount: number }> {
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

  const gamesBySlug = new Map(games.map((g) => [g.slug, g]));
  const { next, events, pricePoints } = diffPass({
    source: scraper.source, previous, scraped: [...byKey.values()], now, seed, gamesBySlug,
  });

  const pruned = pruneListings(next, now);
  await saveListings(pruned);
  await appendPrices(scraper.source, pricePoints);

  const health = await loadHealth();
  const { health: nextHealth, justBroke } = updateHealth(health, scraper.source, outcomes, now);
  await saveHealth(nextHealth);
  if (justBroke) {
    await sendBrokenSourceAlert(scraper.source, nextHealth[scraper.source].lastError ?? 'unknown');
  }

  return { events, outcomes, listingCount: Object.keys(pruned.listings).length };
}

export async function runPass(
  opts: { only?: string[]; seed?: boolean } = {}
): Promise<{ sources: number; events: number; alerts: number; suppressed: number }> {
  const games = await loadWishlist();
  const scrapers = opts.only?.length
    ? ALL_SCRAPERS.filter((s) => opts.only!.includes(s.source))
    : ALL_SCRAPERS;

  // A wanted game with no target can never alert. Say so loudly — otherwise it
  // looks configured, gets scraped every pass, and stays permanently silent.
  const untargeted = gamesMissingTarget(games);
  if (untargeted.length > 0) {
    console.warn(
      `[wishlist] ${untargeted.length} wanted game(s) have no targetPaise and cannot alert: ` +
        untargeted.map((g) => g.slug).join(', ')
    );
  }

  // Sources run in parallel; queries within a source stay sequential so the
  // per-host politeness delay in fetch.ts actually applies.
  const results = await Promise.all(
    scrapers.map(async (scraper) => {
      try {
        return await runSource(scraper, games, { seed: opts.seed });
      } catch (error) {
        console.error(`[${scraper.source}] pass failed:`, error);
        return { events: [] as DealEvent[], outcomes: [] as ScrapeOutcome[], listingCount: 0 };
      }
    })
  );

  const events = results.flatMap((r) => r.events);
  const listingCounts = new Map(scrapers.map((s, i) => [s.source, results[i].listingCount]));

  const { send, suppressed, tripped } = applyCircuitBreaker({ events, listingCounts });
  if (tripped) {
    console.warn(`[breaker] ${tripped.kind}: ${tripped.detail}`);
    await sendBreakerSummary(tripped.detail, suppressed);
  }

  let alerts = 0;
  if (send.length > 0) {
    const gameBySlug = new Map(games.map((g) => [g.slug, g]));
    const alternatives = await buildAlternatives(scrapers.map((s) => s.source));
    const pricesBySource = new Map<string, Awaited<ReturnType<typeof readPrices>>>();
    for (const source of new Set(send.map((e) => e.source))) {
      pricesBySource.set(source, await readPrices(source));
    }

    const delivered = await sendDealAlerts(send, (event) => ({
      game: event.listing.gameSlug ? gameBySlug.get(event.listing.gameSlug) : undefined,
      stats: computeStats(pricesBySource.get(event.source) ?? [], event.key),
      alternatives: alternativesFor(alternatives, event.listing.gameSlug, event.source),
    }));

    const now = Date.now();
    const bySource = new Map<string, Array<{ key: string; pricePaise: number }>>();
    for (const { source, key, pricePaise } of delivered) {
      const list = bySource.get(source) ?? [];
      list.push({ key, pricePaise });
      bySource.set(source, list);
    }
    for (const [source, entries] of bySource) await recordAlerts(source, entries, now);
    alerts = delivered.length;
  }

  return { sources: scrapers.length, events: events.length, alerts, suppressed: suppressed.length };
}

type AlternativeIndex = Map<string, Array<AlternativeListing & { key: string }>>;

/**
 * Cheapest in-stock listing per game per store, read back from committed state.
 *
 * Built from stored listings rather than from this pass's events, because a
 * store whose price did not move emits no event — and "unchanged at ₹2,899
 * elsewhere" is exactly the comparison worth showing.
 */
async function buildAlternatives(sources: string[]): Promise<AlternativeIndex> {
  const index: AlternativeIndex = new Map();
  for (const source of sources) {
    const file = await loadListings(source);
    const cheapestPerGame = new Map<string, { key: string; listing: StoredListing }>();
    for (const [key, listing] of Object.entries(file.listings)) {
      if (!listing.gameSlug || !listing.inStock || listing.pricePaise === null) continue;
      if (listing.matchStatus === 'unmatched') continue;
      const held = cheapestPerGame.get(listing.gameSlug);
      if (!held || listing.pricePaise < (held.listing.pricePaise ?? Infinity)) {
        cheapestPerGame.set(listing.gameSlug, { key, listing });
      }
    }
    for (const [slug, { key, listing }] of cheapestPerGame) {
      const list = index.get(slug) ?? [];
      list.push({ key, source, pricePaise: listing.pricePaise, condition: listing.condition });
      index.set(slug, list);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => (a.pricePaise ?? Infinity) - (b.pricePaise ?? Infinity));
  }
  return index;
}

function alternativesFor(
  index: AlternativeIndex,
  gameSlug: string | null,
  excludeSource: string
): AlternativeListing[] {
  if (!gameSlug) return [];
  return (index.get(gameSlug) ?? [])
    .filter((a) => a.source !== excludeSource)
    .map(({ source, pricePaise, condition }) => ({ source, pricePaise, condition }));
}
