import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionPolicyOf, gamesMissingTarget, loadWishlist, searchQueries } from '../state/wishlist.ts';
import { listingsPath, pricesPath } from '../state/paths.ts';

test('wishlist loads all 36 games', async () => {
  const games = await loadWishlist();
  assert.equal(games.length, 36);
});

test('wishlist splits 21 owned and 15 wanted', async () => {
  const games = await loadWishlist();
  assert.equal(games.filter((g) => g.status === 'owned').length, 21);
  assert.equal(games.filter((g) => g.status === 'wanted').length, 15);
});

/**
 * The Evil Within and Fallout 4 were listed as wanted while the collection doc
 * recorded both as bought. A wanted-but-owned game alerts on every deal for
 * something already on the shelf.
 */
test('games recorded as bought are owned, not wanted', async () => {
  const games = await loadWishlist();
  for (const slug of ['the-evil-within', 'fallout-4']) {
    const game = games.find((g) => g.slug === slug);
    assert.equal(game?.status, 'owned', slug);
    assert.ok((game?.paidPaise ?? 0) > 0, `${slug} must record what was paid`);
  }
});

test('every wanted game with a target has a positive integer paise target', async () => {
  const games = await loadWishlist();
  for (const game of games.filter((g) => g.status === 'wanted')) {
    if (game.targetPaise === undefined) continue;
    assert.ok(Number.isInteger(game.targetPaise), `${game.slug} target must be integer paise`);
    assert.ok(game.targetPaise > 0, `${game.slug} target must be positive`);
  }
});

/**
 * These are the voucher traps: the box contains a one-time code, so a cheap
 * used listing is the single most dangerous thing the bot could recommend.
 */
test('the known code-in-the-box editions are marked sealed-only', async () => {
  const games = await loadWishlist();
  for (const slug of ['cyberpunk-2077-ultimate-edition', 'resident-evil-village-gold-edition']) {
    const game = games.find((g) => g.slug === slug);
    assert.equal(conditionPolicyOf(game!), 'sealed-only', slug);
  }
});

test('games with no target are reported rather than silently muted', async () => {
  const games = await loadWishlist();
  const missing = gamesMissingTarget(games).map((g) => g.slug).sort();
  assert.deepEqual(missing, ['fallout-4-goty', 'the-last-of-us-part-2']);
});

test('owned games never carry a target, which would be meaningless', async () => {
  const games = await loadWishlist();
  for (const game of games.filter((g) => g.status === 'owned')) {
    assert.equal(game.targetPaise, undefined, `${game.slug} is owned but has a target`);
  }
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
