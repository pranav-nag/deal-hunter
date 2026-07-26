import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, buildEmbed } from '../discord/notify.ts';
import type { DealEvent } from '../events/diff.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const NOW = 1_774_454_400_000;

const event: DealEvent = {
  kind: 'price_drop', key: 'k1', source: 'GameLoot', previousPricePaise: 369000, alert: true,
  listing: {
    title: 'Death Stranding 2 On The Beach PS5', url: 'https://gameloot.in/p/ds2', imageUrl: '',
    pricePaise: 343800, originalPricePaise: 519900, currency: 'INR', condition: 'new',
    inStock: true, gameSlug: 'death-stranding-2-on-the-beach', matchScore: 0.94,
    matchStatus: 'auto', firstSeen: NOW - 86400000, lastSeen: NOW, missedPasses: 0,
  },
};

const game: WishlistGame = {
  slug: 'death-stranding-2-on-the-beach', title: 'Death Stranding 2: On the Beach',
  platform: 'ps5', status: 'owned', paidPaise: 340000, condition: 'preowned', aliases: [],
};

test('computeStats finds the low, high and count for one key', () => {
  const stats = computeStats([
    { ts: 1, key: 'k1', pricePaise: 519900, inStock: true },
    { ts: 2, key: 'k1', pricePaise: 343800, inStock: true },
    { ts: 3, key: 'other', pricePaise: 100, inStock: true },
  ], 'k1');
  assert.equal(stats.seenCount, 2);
  assert.equal(stats.lowPaise, 343800);
  assert.equal(stats.highPaise, 519900);
});

test('computeStats ignores null prices', () => {
  const stats = computeStats([
    { ts: 1, key: 'k1', pricePaise: null, inStock: false },
    { ts: 2, key: 'k1', pricePaise: 5000, inStock: true },
  ], 'k1');
  assert.equal(stats.lowPaise, 5000);
});

test('computeStats on no data returns nulls, not zeros', () => {
  const stats = computeStats([], 'k1');
  assert.equal(stats.lowPaise, null);
  assert.equal(stats.seenCount, 0);
});

test('the embed shows the current price and the previous price', () => {
  const embed = buildEmbed(event, game, computeStats([], 'k1')) as { title: string; description: string };
  assert.match(embed.description, /3,438/);
  assert.match(embed.description, /3,690/);
});

test('the embed states what was paid for an owned game', () => {
  const embed = buildEmbed(event, game, computeStats([], 'k1')) as { description: string };
  assert.match(embed.description, /paid/i);
  assert.match(embed.description, /3,400/);
});

test('the embed labels condition and source', () => {
  const embed = buildEmbed(event, game, computeStats([], 'k1')) as { description: string };
  assert.match(embed.description, /New/);
  assert.match(embed.description, /GameLoot/);
});

test('an unmatched listing still builds an embed', () => {
  const orphan = { ...event, listing: { ...event.listing, gameSlug: null } };
  const embed = buildEmbed(orphan, undefined, computeStats([], 'k1')) as { title: string };
  assert.ok(embed.title.length > 0);
});
