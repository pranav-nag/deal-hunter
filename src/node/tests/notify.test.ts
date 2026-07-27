import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestPerGame,
  buildDealEmbed,
  chunkEmbeds,
  computeStats,
  embedLength,
  MAX_CHARS_PER_MESSAGE,
  MAX_EMBEDS_PER_MESSAGE,
  type DealContext,
  type Embed,
} from '../discord/notify.ts';
import type { DealEvent } from '../events/diff.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const NOW = 1_774_454_400_000;

const event = (over: Partial<DealEvent> = {}): DealEvent => ({
  kind: 'price_drop', key: 'k1', source: 'GameLoot', previousPricePaise: 189900,
  alert: true, gateReason: 'ok',
  listing: {
    title: 'Horizon Forbidden West Complete Edition PS5 Preowned Disc CIB',
    url: 'https://gameloot.in/p/hfw', imageUrl: 'https://gameloot.in/img/hfw.jpg',
    pricePaise: 145000, originalPricePaise: 299900, currency: 'INR', condition: 'preowned',
    inStock: true, gameSlug: 'horizon-forbidden-west-complete-edition', matchScore: 0.94,
    matchStatus: 'auto', firstSeen: NOW - 86400000, lastSeen: NOW, missedPasses: 0,
  },
  ...over,
});

const game: WishlistGame = {
  slug: 'horizon-forbidden-west-complete-edition',
  title: 'Horizon Forbidden West Complete Edition',
  platform: 'ps5', status: 'wanted', targetPaise: 199900,
  conditionPolicy: 'prefer-used', tier: 1,
  verdict: 'Two-disc release — the expansion is on the plastic.',
  aliases: [],
};

const ctx = (over: Partial<DealContext> = {}): DealContext => ({
  game,
  stats: computeStats([], 'k1'),
  alternatives: [],
  ...over,
});

const fieldValue = (embed: Embed, name: string) =>
  embed.fields?.find((f) => f.name === name)?.value;

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

test('the embed is titled with the wishlist name, not the store string', () => {
  const embed = buildDealEmbed(event(), ctx());
  assert.equal(embed.title, 'Horizon Forbidden West Complete Edition');
});

test('the embed falls back to the store title when nothing matched', () => {
  const orphan = event({ listing: { ...event().listing, gameSlug: null } });
  const embed = buildDealEmbed(orphan, ctx({ game: undefined }));
  assert.match(embed.title ?? '', /Horizon Forbidden West Complete Edition PS5 Preowned/);
});

test('the embed states the gap to target', () => {
  const embed = buildDealEmbed(event(), ctx());
  assert.match(fieldValue(embed, 'Price') ?? '', /27% under your ₹1,999 target/);
});

test('the embed shows the current price and the previous price', () => {
  const price = fieldValue(buildDealEmbed(event(), ctx()), 'Price') ?? '';
  assert.match(price, /1,450/);
  assert.match(price, /1,899/);
});

test('a price exactly at target reads as at target, not 0% under', () => {
  const at = event({ listing: { ...event().listing, pricePaise: 199900 } });
  assert.match(fieldValue(buildDealEmbed(at, ctx()), 'Price') ?? '', /at your ₹1,999 target/);
});

test('the embed carries the verdict from the wishlist', () => {
  assert.match(fieldValue(buildDealEmbed(event(), ctx()), 'Why') ?? '', /two-disc release/i);
});

test('the embed lists other stores instead of sending separate messages', () => {
  const embed = buildDealEmbed(event(), ctx({
    alternatives: [
      { source: 'GameNation', pricePaise: 289900, condition: 'new' },
      { source: 'GamesTheShop', pricePaise: 499900, condition: 'preowned' },
    ],
  }));
  const value = fieldValue(embed, 'Also available') ?? '';
  assert.match(value, /GameNation ₹2,899 sealed/);
  assert.match(value, /Games The Shop ₹4,999 pre-owned/);
});

test('the embed uses the scraped image as a thumbnail', () => {
  assert.equal(buildDealEmbed(event(), ctx()).thumbnail?.url, 'https://gameloot.in/img/hfw.jpg');
});

test('a listing with no image omits the thumbnail rather than sending an empty url', () => {
  const noImage = event({ listing: { ...event().listing, imageUrl: '' } });
  assert.equal(buildDealEmbed(noImage, ctx()).thumbnail, undefined);
});

test('the colour reflects saving depth, not event kind', () => {
  const deep = buildDealEmbed(event({ listing: { ...event().listing, pricePaise: 100000 } }), ctx());
  const shallow = buildDealEmbed(event({ listing: { ...event().listing, pricePaise: 199000 } }), ctx());
  assert.notEqual(deep.color, shallow.color);

  const sameDepthDifferentKind = buildDealEmbed(
    event({ kind: 'new_listing', listing: { ...event().listing, pricePaise: 100000 } }),
    ctx()
  );
  assert.equal(deep.color, sameDepthDifferentKind.color);
});

test('an import warns that the price is indicative', () => {
  const usd = event({ listing: { ...event().listing, currency: 'USD' } });
  assert.match(fieldValue(buildDealEmbed(usd, ctx()), 'Note') ?? '', /USD/);
});

test('bestPerGame keeps only the cheapest listing for a game', () => {
  const cheap = event({ key: 'cheap', source: 'GameLoot', listing: { ...event().listing, pricePaise: 120000 } });
  const dear = event({ key: 'dear', source: 'GameNation', listing: { ...event().listing, pricePaise: 180000 } });
  const chosen = bestPerGame([dear, cheap]);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].key, 'cheap');
});

test('bestPerGame keeps unmatched listings separate rather than merging them', () => {
  const a = event({ key: 'a', listing: { ...event().listing, gameSlug: null } });
  const b = event({ key: 'b', listing: { ...event().listing, gameSlug: null } });
  assert.equal(bestPerGame([a, b]).length, 2);
});

test('bestPerGame prefers a real price over a null one', () => {
  const priced = event({ key: 'priced' });
  const unpriced = event({ key: 'unpriced', listing: { ...event().listing, pricePaise: null } });
  assert.equal(bestPerGame([unpriced, priced])[0].key, 'priced');
});

test('embeds are chunked to Discord embed-count limit', () => {
  const embeds: Embed[] = Array.from({ length: 23 }, (_, i) => ({ title: `t${i}` }));
  const chunks = chunkEmbeds(embeds);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= MAX_EMBEDS_PER_MESSAGE));
});

test('embeds are chunked to the character limit even when few in number', () => {
  const big: Embed = { title: 'x', description: 'y'.repeat(4000) };
  const chunks = chunkEmbeds([big, big, big]);
  assert.ok(chunks.length > 1, 'three 4000-char embeds cannot share one message');
  for (const chunk of chunks) {
    const total = chunk.reduce((sum, e) => sum + embedLength(e), 0);
    assert.ok(total <= MAX_CHARS_PER_MESSAGE, `chunk of ${total} chars exceeds the limit`);
  }
});

test('a single oversized embed is still emitted rather than silently dropped', () => {
  const huge: Embed = { title: 'x', description: 'y'.repeat(MAX_CHARS_PER_MESSAGE + 100) };
  assert.equal(chunkEmbeds([huge]).length, 1);
});

test('embedLength counts every field Discord counts', () => {
  const embed: Embed = {
    title: 'ab', description: 'cde', author: { name: 'fg' },
    footer: { text: 'h' }, fields: [{ name: 'ij', value: 'klm' }],
  };
  assert.equal(embedLength(embed), 2 + 3 + 2 + 1 + 2 + 3);
});

test('a real deal embed stays well inside the per-embed budget', () => {
  const embed = buildDealEmbed(event(), ctx({
    alternatives: [
      { source: 'GameNation', pricePaise: 289900, condition: 'new' },
      { source: 'GamesTheShop', pricePaise: 499900, condition: 'preowned' },
      { source: 'E2ZStore', pricePaise: 320000, condition: 'unknown' },
    ],
    stats: { seenCount: 14, lowPaise: 139900, highPaise: 249900, firstSeen: NOW - 999 },
  }));
  assert.ok(embedLength(embed) < 1200, `embed was ${embedLength(embed)} chars`);
  assert.ok(chunkEmbeds(Array(MAX_EMBEDS_PER_MESSAGE).fill(embed)).length >= 1);
});
