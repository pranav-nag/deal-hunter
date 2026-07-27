import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestAllowed,
  buildBoardEmbeds,
  buildConfigGapEmbed,
  buildNearMissEmbed,
  buildPendingEmbed,
  type Candidate,
} from '../digest/index.ts';
import type { StoredListing } from '../state/listings.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const NOW = 1_774_454_400_000;

const listing = (over: Partial<StoredListing> = {}): StoredListing => ({
  title: 'Horizon Forbidden West Complete Edition PS5', url: 'https://x.test/hfw', imageUrl: '',
  pricePaise: 145000, originalPricePaise: null, currency: 'INR', condition: 'preowned',
  inStock: true, gameSlug: 'hfw', matchScore: 0.93, matchStatus: 'auto',
  firstSeen: NOW, lastSeen: NOW, missedPasses: 0, ...over,
});

const candidate = (source: string, over: Partial<StoredListing> = {}): Candidate => ({
  source, key: `${source}-k`, listing: listing(over),
});

const game = (over: Partial<WishlistGame> = {}): WishlistGame => ({
  slug: 'hfw', title: 'Horizon Forbidden West Complete Edition', platform: 'ps5',
  status: 'wanted', targetPaise: 199900, tier: 1, aliases: [], ...over,
});

test('bestAllowed skips a used copy when the game is sealed-only', () => {
  const candidates = [
    candidate('GameLoot', { pricePaise: 100000, condition: 'preowned' }),
    candidate('GameNation', { pricePaise: 240000, condition: 'new' }),
  ];
  const chosen = bestAllowed(candidates, game({ conditionPolicy: 'sealed-only' }));
  assert.equal(chosen?.source, 'GameNation');
});

test('bestAllowed takes the cheapest when any condition is allowed', () => {
  const candidates = [
    candidate('GameLoot', { pricePaise: 100000, condition: 'preowned' }),
    candidate('GameNation', { pricePaise: 240000, condition: 'new' }),
  ];
  assert.equal(bestAllowed(candidates, game())?.source, 'GameLoot');
});

test('the board marks a game under target and names the store', () => {
  const embeds = buildBoardEmbeds([game()], new Map([['hfw', [candidate('GameLoot')]]]));
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].description ?? '', /✅ \*\*Horizon Forbidden West Complete Edition\*\*/);
  assert.match(embeds[0].description ?? '', /₹1,450 used at GameLoot/);
  assert.match(embeds[0].description ?? '', /27% under ₹1,999/);
});

test('the board reports a game with nothing in stock rather than omitting it', () => {
  const embeds = buildBoardEmbeds([game()], new Map());
  assert.match(embeds[0].description ?? '', /not in stock anywhere/);
});

test('the board says so when only a disallowed condition is available', () => {
  const candidates = [candidate('GameLoot', { condition: 'preowned' })];
  const embeds = buildBoardEmbeds([game({ conditionPolicy: 'sealed-only' })], new Map([['hfw', candidates]]));
  assert.match(embeds[0].description ?? '', /nothing in an allowed condition/);
});

test('the board groups by tier and skips empty tiers', () => {
  const embeds = buildBoardEmbeds(
    [game({ slug: 'a', tier: 1 }), game({ slug: 'b', tier: 3 })],
    new Map()
  );
  assert.equal(embeds.length, 2);
  assert.match(embeds[0].title ?? '', /Tier 1/);
  assert.match(embeds[1].title ?? '', /Tier 3/);
});

test('the board ignores owned games', () => {
  assert.equal(buildBoardEmbeds([game({ status: 'owned' })], new Map()).length, 0);
});

test('near misses list a game just over target', () => {
  const embed = buildNearMissEmbed([game()], new Map([['hfw', [candidate('GameLoot', { pricePaise: 210000 })]]]));
  assert.match(embed?.description ?? '', /₹2,100 at GameLoot/);
  assert.match(embed?.description ?? '', /₹101 over target/);
});

test('a game already under target is not also reported as a near miss', () => {
  assert.equal(buildNearMissEmbed([game()], new Map([['hfw', [candidate('GameLoot')]]])), null);
});

test('pending matches are listed highest score first', () => {
  const embed = buildPendingEmbed(
    [game()],
    ['GameLoot'],
    [
      { source: 'GameLoot', listing: listing({ matchStatus: 'pending', matchScore: 0.61, title: 'Low scorer' }) },
      { source: 'GameLoot', listing: listing({ matchStatus: 'pending', matchScore: 0.82, title: 'High scorer' }) },
    ]
  );
  const lines = (embed?.description ?? '').split('\n');
  assert.match(lines[0], /High scorer/);
  assert.match(lines[1], /Low scorer/);
});

test('pending matches for owned games are not surfaced', () => {
  const embed = buildPendingEmbed(
    [game({ status: 'owned' })],
    ['GameLoot'],
    [{ source: 'GameLoot', listing: listing({ matchStatus: 'pending', matchScore: 0.7 }) }]
  );
  assert.equal(embed, null);
});

test('a wanted game with no target is reported as a config gap', () => {
  const embed = buildConfigGapEmbed([game({ targetPaise: undefined })]);
  assert.match(embed?.description ?? '', /no `targetPaise` set/);
});

test('no config gap embed when every wanted game has a target', () => {
  assert.equal(buildConfigGapEmbed([game()]), null);
});
