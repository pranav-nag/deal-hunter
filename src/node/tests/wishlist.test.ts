import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWishlist, searchQueries } from '../state/wishlist.ts';
import { listingsPath, pricesPath } from '../state/paths.ts';

test('wishlist loads all 35 games', async () => {
  const games = await loadWishlist();
  assert.equal(games.length, 35);
});

test('wishlist splits 19 owned and 16 wanted', async () => {
  const games = await loadWishlist();
  assert.equal(games.filter((g) => g.status === 'owned').length, 19);
  assert.equal(games.filter((g) => g.status === 'wanted').length, 16);
});

test('every game has a unique slug and at least one query', async () => {
  const games = await loadWishlist();
  const slugs = new Set(games.map((g) => g.slug));
  assert.equal(slugs.size, games.length);
  for (const g of games) assert.ok(searchQueries(g).length >= 1, `${g.slug} has no queries`);
});

test('owned games carry what was paid', async () => {
  const games = await loadWishlist();
  const gow = games.find((g) => g.slug === 'god-of-war-2018');
  assert.equal(gow?.status, 'owned');
  assert.equal(gow?.paidPaise, 85000);
});

test('searchQueries returns the title first, then aliases, deduped', () => {
  const queries = searchQueries({
    slug: 'gta-v-ps5',
    title: 'Grand Theft Auto V',
    platform: 'ps5',
    status: 'owned',
    aliases: ['GTA V', 'Grand Theft Auto V'],
  });
  assert.deepEqual(queries, ['Grand Theft Auto V', 'GTA V']);
});

/** join() uses backslashes on Windows; the assertion is about the tail, not the separator. */
const posix = (p: string) => p.replaceAll('\\', '/');

test('state paths are partitioned per source and lowercased', () => {
  assert.ok(posix(listingsPath('GameLoot')).endsWith('state/listings/gameloot.json'));
  assert.ok(posix(pricesPath('CexIndia')).endsWith('state/prices/cexindia.jsonl'));
});
