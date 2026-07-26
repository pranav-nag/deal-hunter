import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneListings } from '../state/prune.ts';
import type { ListingsFile, StoredListing } from '../state/listings.ts';

const NOW = 1_774_454_400_000;
const DAY = 86_400_000;

const listing = (over: Partial<StoredListing>): StoredListing => ({
  title: 't', url: 'https://x.test/1', imageUrl: '', pricePaise: 100,
  originalPricePaise: null, currency: 'INR', condition: 'unknown', inStock: true,
  gameSlug: null, matchScore: 0, matchStatus: 'unmatched',
  firstSeen: NOW - 90 * DAY, lastSeen: NOW, missedPasses: 0, ...over,
});

const file = (listings: Record<string, StoredListing>): ListingsFile => ({
  source: 'S', updatedAt: NOW, listings,
});

test('a listing gone longer than 30 days is dropped', () => {
  const out = pruneListings(file({ old: listing({ missedPasses: 5, lastSeen: NOW - 31 * DAY }) }), NOW);
  assert.equal(Object.keys(out.listings).length, 0);
});

test('a currently-present listing is kept regardless of age', () => {
  const out = pruneListings(file({ live: listing({ missedPasses: 0, lastSeen: NOW }) }), NOW);
  assert.equal(Object.keys(out.listings).length, 1);
});

test('a recently-gone listing is kept', () => {
  const out = pruneListings(file({ recent: listing({ missedPasses: 4, lastSeen: NOW - 5 * DAY }) }), NOW);
  assert.equal(Object.keys(out.listings).length, 1);
});
