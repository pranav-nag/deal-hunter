import { createHash } from 'node:crypto';
import { readJson, writeJsonStable } from '../lib/serialize.ts';
import { listingsPath } from './paths.ts';

export interface StoredListing {
  title: string;
  url: string;
  imageUrl: string;
  pricePaise: number | null;
  originalPricePaise: number | null;
  currency: string;
  condition: 'new' | 'preowned' | 'unknown';
  inStock: boolean;
  gameSlug: string | null;
  matchScore: number;
  matchStatus: 'auto' | 'pending' | 'unmatched';
  firstSeen: number;
  lastSeen: number;
  /** Consecutive passes this listing was absent. At 3 it is reported gone. */
  missedPasses: number;
  /**
   * Price at which this listing was last alerted, and when.
   *
   * Written only after Discord accepts the message, so a failed send leaves
   * these untouched and the deal alerts again next pass. Duplicating an alert
   * is a nuisance; silently swallowing one is a missed buy.
   */
  lastAlertedPricePaise?: number;
  lastAlertedAt?: number;
}

export interface ListingsFile {
  source: string;
  updatedAt: number;
  listings: Record<string, StoredListing>;
}

/**
 * Stable identity for a listing. The caller passes the normalized URL, or the
 * scraper's keyHint when a store's item URLs are not product-specific.
 */
export function listingKey(source: string, urlOrHint: string): string {
  return createHash('sha256').update(`${source} ${urlOrHint}`).digest('hex').slice(0, 16);
}

export async function loadListings(source: string): Promise<ListingsFile> {
  return readJson<ListingsFile>(listingsPath(source), {
    source,
    updatedAt: 0,
    listings: {},
  });
}

export async function saveListings(file: ListingsFile): Promise<void> {
  await writeJsonStable(listingsPath(file.source), file);
}

/**
 * Stamp `lastAlerted*` on the listings we just told the user about.
 *
 * A second write, after the send, rather than part of the main save. The alert
 * decision is made per-listing during the diff, but the circuit breaker can
 * still hold the whole batch back afterwards — recording at diff time would
 * mark suppressed deals as already-announced and mute them permanently.
 *
 * Re-reads the file rather than taking the in-memory copy so it stays a
 * single-source write, consistent with the per-source partitioning.
 */
export async function recordAlerts(
  source: string,
  alerted: Array<{ key: string; pricePaise: number }>,
  now: number
): Promise<void> {
  if (alerted.length === 0) return;
  const file = await loadListings(source);
  let changed = false;
  for (const { key, pricePaise } of alerted) {
    const listing = file.listings[key];
    if (!listing) continue;
    listing.lastAlertedPricePaise = pricePaise;
    listing.lastAlertedAt = now;
    changed = true;
  }
  if (changed) await saveListings(file);
}
