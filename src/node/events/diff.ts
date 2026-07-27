import type { ListingsFile, StoredListing } from '../state/listings.ts';
import type { PricePoint } from '../state/prices.ts';
import type { WishlistGame } from '../state/wishlist.ts';
import { evaluateGate, type GateReason } from './gate.ts';

export type EventKind = 'new_listing' | 'price_drop' | 'restock' | 'price_rise' | 'gone';

export interface DealEvent {
  kind: EventKind;
  key: string;
  source: string;
  listing: StoredListing;
  previousPricePaise: number | null;
  /** Whether this goes to Discord live. Recorded-only events are false. */
  alert: boolean;
  /** Why it did or did not alert. Drives the digest's "stayed quiet" section. */
  gateReason: GateReason;
}

type ScrapedListing = Omit<
  StoredListing,
  'firstSeen' | 'lastSeen' | 'missedPasses' | 'lastAlertedPricePaise' | 'lastAlertedAt'
>;

export interface DiffInput {
  source: string;
  previous: ListingsFile;
  scraped: Array<{ key: string; listing: ScrapedListing }>;
  now: number;
  /** Seed runs write state and emit nothing — first run, new source, state reset. */
  seed: boolean;
  gamesBySlug: Map<string, WishlistGame>;
}

const GONE_AFTER_PASSES = 3;

/** Kinds that can ever interrupt the user. A rise or a removal is history, not news. */
const ALERTABLE_KINDS = new Set<EventKind>(['new_listing', 'price_drop', 'restock']);

export function diffPass(input: DiffInput): {
  next: ListingsFile;
  events: DealEvent[];
  pricePoints: PricePoint[];
} {
  const { source, previous, scraped, now, seed, gamesBySlug } = input;
  const events: DealEvent[] = [];
  const pricePoints: PricePoint[] = [];
  const nextListings: Record<string, StoredListing> = {};
  const seenKeys = new Set<string>();

  for (const { key, listing } of scraped) {
    seenKeys.add(key);
    const prior = previous.listings[key];
    const merged: StoredListing = {
      ...listing,
      firstSeen: prior?.firstSeen ?? now,
      lastSeen: now,
      missedPasses: 0,
      // Carried, not reset: this is what stops a flapping price re-alerting.
      ...(prior?.lastAlertedPricePaise !== undefined
        ? { lastAlertedPricePaise: prior.lastAlertedPricePaise }
        : {}),
      ...(prior?.lastAlertedAt !== undefined ? { lastAlertedAt: prior.lastAlertedAt } : {}),
    };
    nextListings[key] = merged;

    const push = (kind: EventKind, previousPricePaise: number | null) => {
      const gate = ALERTABLE_KINDS.has(kind)
        ? evaluateGate({
            listing: merged,
            game: merged.gameSlug ? gamesBySlug.get(merged.gameSlug) : undefined,
            seed,
            lastAlertedPricePaise: prior?.lastAlertedPricePaise ?? null,
          })
        : { alert: false, reason: 'kind_not_alertable' as GateReason };
      events.push({
        kind,
        key,
        source,
        listing: merged,
        previousPricePaise,
        alert: gate.alert,
        gateReason: gate.reason,
      });
    };

    if (!prior) {
      push('new_listing', null);
      pricePoints.push({ ts: now, key, pricePaise: merged.pricePaise, inStock: merged.inStock });
      continue;
    }

    const priceChanged = prior.pricePaise !== merged.pricePaise;
    const stockChanged = prior.inStock !== merged.inStock;
    if (priceChanged || stockChanged) {
      pricePoints.push({ ts: now, key, pricePaise: merged.pricePaise, inStock: merged.inStock });
    }

    if (priceChanged && merged.pricePaise !== null && prior.pricePaise !== null) {
      if (merged.pricePaise < prior.pricePaise) push('price_drop', prior.pricePaise);
      else push('price_rise', prior.pricePaise);
    } else if (!prior.inStock && merged.inStock) {
      push('restock', prior.pricePaise);
    }
  }

  for (const [key, prior] of Object.entries(previous.listings)) {
    if (seenKeys.has(key)) continue;
    const missedPasses = prior.missedPasses + 1;
    const carried: StoredListing = { ...prior, missedPasses };
    nextListings[key] = carried;
    if (missedPasses === GONE_AFTER_PASSES) {
      events.push({
        kind: 'gone',
        key,
        source,
        listing: carried,
        previousPricePaise: prior.pricePaise,
        alert: false,
        gateReason: 'kind_not_alertable',
      });
    }
  }

  return { next: { source, updatedAt: now, listings: nextListings }, events, pricePoints };
}
