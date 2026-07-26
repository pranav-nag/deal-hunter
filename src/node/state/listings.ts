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
