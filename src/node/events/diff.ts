import type { ListingsFile, StoredListing } from '../state/listings.ts';
import type { PricePoint } from '../state/prices.ts';

export type EventKind = 'new_listing' | 'price_drop' | 'restock' | 'price_rise' | 'gone';

export interface DealEvent {
  kind: EventKind;
  key: string;
  source: string;
  listing: StoredListing;
  previousPricePaise: number | null;
  /** Whether this goes to Discord live. Recorded-only events are false. */
  alert: boolean;
}

type ScrapedListing = Omit<StoredListing, 'firstSeen' | 'lastSeen' | 'missedPasses'>;

export interface DiffInput {
  source: string;
  previous: ListingsFile;
  scraped: Array<{ key: string; listing: ScrapedListing }>;
  now: number;
  /** Seed runs write state and emit nothing — first run, new source, state reset. */
  seed: boolean;
  ownedSlugs: Set<string>;
}

const GONE_AFTER_PASSES = 3;

export function diffPass(input: DiffInput): {
  next: ListingsFile;
  events: DealEvent[];
  pricePoints: PricePoint[];
} {
  const { source, previous, scraped, now, seed, ownedSlugs } = input;
  const events: DealEvent[] = [];
  const pricePoints: PricePoint[] = [];
  const nextListings: Record<string, StoredListing> = {};
  const seenKeys = new Set<string>();

  const alertable = (listing: StoredListing): boolean => {
    if (seed) return false;
    if (listing.matchStatus !== 'auto') return false;
    if (listing.gameSlug && ownedSlugs.has(listing.gameSlug)) return false;
    return true;
  };

  for (const { key, listing } of scraped) {
    seenKeys.add(key);
    const prior = previous.listings[key];
    const merged: StoredListing = {
      ...listing,
      firstSeen: prior?.firstSeen ?? now,
      lastSeen: now,
      missedPasses: 0,
    };
    nextListings[key] = merged;

    const push = (kind: EventKind, previousPricePaise: number | null, alert: boolean) =>
      events.push({ kind, key, source, listing: merged, previousPricePaise, alert });

    if (!prior) {
      push('new_listing', null, alertable(merged));
      pricePoints.push({ ts: now, key, pricePaise: merged.pricePaise, inStock: merged.inStock });
      continue;
    }

    const priceChanged = prior.pricePaise !== merged.pricePaise;
    const stockChanged = prior.inStock !== merged.inStock;
    if (priceChanged || stockChanged) {
      pricePoints.push({ ts: now, key, pricePaise: merged.pricePaise, inStock: merged.inStock });
    }

    if (priceChanged && merged.pricePaise !== null && prior.pricePaise !== null) {
      if (merged.pricePaise < prior.pricePaise) push('price_drop', prior.pricePaise, alertable(merged));
      else push('price_rise', prior.pricePaise, false);
    } else if (!prior.inStock && merged.inStock) {
      push('restock', prior.pricePaise, alertable(merged));
    }
  }

  for (const [key, prior] of Object.entries(previous.listings)) {
    if (seenKeys.has(key)) continue;
    const missedPasses = prior.missedPasses + 1;
    const carried: StoredListing = { ...prior, missedPasses };
    nextListings[key] = carried;
    if (missedPasses === GONE_AFTER_PASSES) {
      events.push({ kind: 'gone', key, source, listing: carried, previousPricePaise: prior.pricePaise, alert: false });
    }
  }

  return { next: { source, updatedAt: now, listings: nextListings }, events, pricePoints };
}
