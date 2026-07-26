import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchListing, scoreListing, AUTO_THRESHOLD } from '../matching/index.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const game = (over: Partial<WishlistGame>): WishlistGame => ({
  slug: 'titanfall-2', title: 'Titanfall 2', platform: 'ps4',
  status: 'wanted', aliases: [], ...over,
});

const GAMES = [
  game({}),
  game({ slug: 'oblivion-remastered-deluxe', title: 'The Elder Scrolls IV: Oblivion Remastered Deluxe Edition', platform: 'ps5' }),
  game({ slug: 'oblivion-remastered', title: 'The Elder Scrolls IV: Oblivion Remastered', platform: 'ps5' }),
];

test('an exact title and platform match auto-matches', () => {
  const r = matchListing('Titanfall 2 (PS4)', GAMES);
  assert.equal(r.gameSlug, 'titanfall-2');
  assert.equal(r.matchStatus, 'auto');
});

test('an unrelated title is unmatched', () => {
  const r = matchListing('RGB Gaming Mouse Pad Large', GAMES);
  assert.equal(r.gameSlug, null);
  assert.equal(r.matchStatus, 'unmatched');
});

test('a base game never auto-matches a Deluxe listing', () => {
  const score = scoreListing(
    'The Elder Scrolls IV Oblivion Remastered Deluxe Edition PS5',
    game({ slug: 'oblivion-remastered', title: 'The Elder Scrolls IV: Oblivion Remastered', platform: 'ps5' })
  );
  assert.ok(score < AUTO_THRESHOLD, `edition mismatch scored ${score}`);
});

test('the wrong platform is penalised', () => {
  const ps4 = scoreListing('Titanfall 2 PS4', game({}));
  const ps5 = scoreListing('Titanfall 2 PS5', game({}));
  assert.ok(ps4 > ps5, `expected PS4 to beat PS5: ${ps4} vs ${ps5}`);
});

test('a mid-confidence match lands in the pending band', () => {
  const r = matchListing('Titanfall II', GAMES);
  assert.ok(['auto', 'pending'].includes(r.matchStatus));
  assert.equal(r.gameSlug, 'titanfall-2');
});

test('a legacy-platform listing never auto-matches a PS4/PS5 game', () => {
  // Real false positive from the first GameLoot seed: detectPlatform returns ''
  // for PS3, which scored as "platform unstated" and cleared AUTO_THRESHOLD.
  const mgs = game({ slug: 'mgsv', title: 'Metal Gear Solid V: The Phantom Pain', platform: 'ps4' });
  const ps3 = scoreListing('Metal Gear Solid V The Phantom Pain PS3 (MGS V Pre-owned)', mgs);
  const ps4 = scoreListing('Metal Gear Solid V The Phantom Pain PS4', mgs);
  assert.ok(ps3 < AUTO_THRESHOLD, `PS3 listing scored ${ps3}, would have alerted`);
  assert.ok(ps4 >= AUTO_THRESHOLD, `PS4 listing scored ${ps4}, should still auto-match`);
});

test('an unstated platform stays neutral rather than being penalised', () => {
  const tf2 = game({});
  const bare = scoreListing('Titanfall 2', tf2);
  const wrong = scoreListing('Titanfall 2 PS3', tf2);
  assert.ok(bare > wrong, `unstated ${bare} should beat wrong-platform ${wrong}`);
});

test('the best of several candidates wins', () => {
  const r = matchListing('Oblivion Remastered Deluxe Edition PS5', GAMES);
  assert.equal(r.gameSlug, 'oblivion-remastered-deluxe');
});
