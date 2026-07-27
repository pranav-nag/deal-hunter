import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPass } from '../events/diff.ts';
import type { ListingsFile, StoredListing } from '../state/listings.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const NOW = 1_774_454_400_000;

const base = (over: Partial<StoredListing> = {}): Omit<StoredListing, 'firstSeen' | 'lastSeen' | 'missedPasses'> => ({
  title: 'Titanfall 2 PS4', url: 'https://x.test/tf2', imageUrl: '',
  pricePaise: 50000, originalPricePaise: null, currency: 'INR',
  condition: 'preowned', inStock: true, gameSlug: 'titanfall-2',
  matchScore: 0.95, matchStatus: 'auto', ...over,
});

const prevFile = (listings: Record<string, StoredListing>): ListingsFile => ({
  source: 'TestStore', updatedAt: NOW - 1000, listings,
});

const stored = (over: Partial<StoredListing> = {}): StoredListing => ({
  ...base(), firstSeen: NOW - 5000, lastSeen: NOW - 1000, missedPasses: 0, ...over,
});

const game = (over: Partial<WishlistGame> = {}): WishlistGame => ({
  slug: 'titanfall-2', title: 'Titanfall 2', platform: 'ps4', status: 'wanted',
  targetPaise: 60000, aliases: [], ...over,
});

const games = (...list: WishlistGame[]) =>
  new Map((list.length > 0 ? list : [game()]).map((g) => [g.slug, g]));

const run = (opts: Partial<Parameters<typeof diffPass>[0]>) => diffPass({
  source: 'TestStore', previous: prevFile({}), scraped: [], now: NOW,
  seed: false, gamesBySlug: games(), ...opts,
});

test('an unseen listing under target is a new_listing and alerts', () => {
  const { events } = run({ scraped: [{ key: 'k1', listing: base() }] });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'new_listing');
  assert.equal(events[0].alert, true);
});

test('seed mode emits no alerts but still writes state', () => {
  const { events, next } = run({ scraped: [{ key: 'k1', listing: base() }], seed: true });
  assert.equal(events.filter((e) => e.alert).length, 0);
  assert.ok(next.listings.k1, 'state must still be written during seeding');
});

test('a lower price is a price_drop carrying the previous price', () => {
  const { events } = run({
    previous: prevFile({ k1: stored({ pricePaise: 58000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
  });
  assert.equal(events[0].kind, 'price_drop');
  assert.equal(events[0].previousPricePaise, 58000);
  assert.equal(events[0].alert, true);
});

test('a higher price is recorded but never alerted', () => {
  const { events } = run({
    previous: prevFile({ k1: stored({ pricePaise: 40000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
  });
  assert.equal(events[0].kind, 'price_rise');
  assert.equal(events[0].alert, false);
});

test('coming back into stock is a restock and alerts', () => {
  const { events } = run({
    previous: prevFile({ k1: stored({ inStock: false }) }),
    scraped: [{ key: 'k1', listing: base({ inStock: true }) }],
  });
  assert.equal(events[0].kind, 'restock');
  assert.equal(events[0].alert, true);
});

test('an unchanged listing produces no event and no price point', () => {
  const { events, pricePoints } = run({
    previous: prevFile({ k1: stored() }),
    scraped: [{ key: 'k1', listing: base() }],
  });
  assert.equal(events.length, 0);
  assert.equal(pricePoints.length, 0);
});

test('owned games are recorded but never alerted', () => {
  const { events } = run({
    previous: prevFile({ k1: stored({ pricePaise: 58000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
    gamesBySlug: games(game({ status: 'owned', targetPaise: undefined })),
  });
  assert.equal(events[0].kind, 'price_drop');
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'not_wanted');
});

test('pending matches are recorded but not live-alerted', () => {
  const { events } = run({
    scraped: [{ key: 'k1', listing: base({ matchStatus: 'pending', matchScore: 0.7 }) }],
  });
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'match_not_auto');
});

test('a listing over target is recorded but does not alert', () => {
  const { events } = run({ scraped: [{ key: 'k1', listing: base({ pricePaise: 90000 }) }] });
  assert.equal(events[0].kind, 'new_listing');
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'over_target');
});

test('a wanted game with no target can never alert', () => {
  const { events } = run({
    scraped: [{ key: 'k1', listing: base() }],
    gamesBySlug: games(game({ targetPaise: undefined })),
  });
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'no_target');
});

test('a pre-owned listing for a sealed-only game does not alert at any price', () => {
  const { events } = run({
    scraped: [{ key: 'k1', listing: base({ pricePaise: 1000, condition: 'preowned' }) }],
    gamesBySlug: games(game({ conditionPolicy: 'sealed-only' })),
  });
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'condition_blocked');
});

test('a listing already alerted does not re-alert on a trivial dip', () => {
  const { events } = run({
    previous: prevFile({ k1: stored({ pricePaise: 50000, lastAlertedPricePaise: 50000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 49000 }) }],
  });
  assert.equal(events[0].kind, 'price_drop');
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'not_better_than_last_alert');
});

test('a listing already alerted re-alerts once it beats the last alert by 5%', () => {
  const { events } = run({
    previous: prevFile({ k1: stored({ pricePaise: 50000, lastAlertedPricePaise: 50000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 47000 }) }],
  });
  assert.equal(events[0].alert, true);
});

test('lastAlerted is carried into the next state, not reset by a rescrape', () => {
  const { next } = run({
    previous: prevFile({ k1: stored({ lastAlertedPricePaise: 50000, lastAlertedAt: 42 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 48000 }) }],
  });
  assert.equal(next.listings.k1.lastAlertedPricePaise, 50000);
  assert.equal(next.listings.k1.lastAlertedAt, 42);
});

test('an out-of-stock listing under target does not alert', () => {
  const { events } = run({ scraped: [{ key: 'k1', listing: base({ inStock: false }) }] });
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'out_of_stock');
});

test('an import priced in another currency does not alert', () => {
  const { events } = run({ scraped: [{ key: 'k1', listing: base({ currency: 'USD' }) }] });
  assert.equal(events[0].alert, false);
  assert.equal(events[0].gateReason, 'foreign_currency');
});

test('an absent listing increments missedPasses and reports gone at three', () => {
  const previous = prevFile({ k1: stored({ missedPasses: 2 }) });
  const { events, next } = run({ previous, scraped: [] });
  assert.equal(next.listings.k1.missedPasses, 3);
  assert.equal(events[0].kind, 'gone');
  assert.equal(events[0].alert, false);
});

test('a returning listing resets missedPasses', () => {
  const { next } = run({
    previous: prevFile({ k1: stored({ missedPasses: 2 }) }),
    scraped: [{ key: 'k1', listing: base() }],
  });
  assert.equal(next.listings.k1.missedPasses, 0);
});

test('firstSeen is preserved and lastSeen advances', () => {
  const { next } = run({
    previous: prevFile({ k1: stored({ firstSeen: 111 }) }),
    scraped: [{ key: 'k1', listing: base() }],
  });
  assert.equal(next.listings.k1.firstSeen, 111);
  assert.equal(next.listings.k1.lastSeen, NOW);
});

test('a price change writes exactly one price point', () => {
  const { pricePoints } = run({
    previous: prevFile({ k1: stored({ pricePaise: 58000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
  });
  assert.deepEqual(pricePoints, [{ ts: NOW, key: 'k1', pricePaise: 50000, inStock: true }]);
});
