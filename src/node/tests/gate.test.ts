import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionAllowed,
  evaluateGate,
  isNearMiss,
  percentUnderTarget,
} from '../events/gate.ts';
import type { StoredListing } from '../state/listings.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const NOW = 1_774_454_400_000;

const listing = (over: Partial<StoredListing> = {}): StoredListing => ({
  title: 'Horizon Forbidden West Complete Edition PS5', url: 'https://x.test/hfw', imageUrl: '',
  pricePaise: 145000, originalPricePaise: null, currency: 'INR', condition: 'preowned',
  inStock: true, gameSlug: 'horizon-forbidden-west-complete-edition', matchScore: 0.93,
  matchStatus: 'auto', firstSeen: NOW, lastSeen: NOW, missedPasses: 0, ...over,
});

const game = (over: Partial<WishlistGame> = {}): WishlistGame => ({
  slug: 'horizon-forbidden-west-complete-edition',
  title: 'Horizon Forbidden West Complete Edition',
  platform: 'ps5', status: 'wanted', targetPaise: 199900, aliases: [], ...over,
});

const gate = (over: Partial<Parameters<typeof evaluateGate>[0]> = {}) =>
  evaluateGate({ listing: listing(), game: game(), seed: false, lastAlertedPricePaise: null, ...over });

test('a wanted game in stock under target passes', () => {
  assert.deepEqual(gate(), { alert: true, reason: 'ok' });
});

test('a seed run blocks everything', () => {
  assert.equal(gate({ seed: true }).reason, 'seed');
});

test('a listing with no matching wishlist game is blocked', () => {
  assert.equal(gate({ game: undefined }).reason, 'not_wanted');
});

test('exactly at target still passes', () => {
  assert.equal(gate({ listing: listing({ pricePaise: 199900 }) }).alert, true);
});

test('one paise over target is blocked', () => {
  assert.equal(gate({ listing: listing({ pricePaise: 199901 }) }).reason, 'over_target');
});

test('a sealed-only game blocks an unknown-condition listing, not just a used one', () => {
  const sealed = game({ conditionPolicy: 'sealed-only' });
  assert.equal(gate({ game: sealed, listing: listing({ condition: 'unknown' }) }).reason, 'condition_blocked');
  assert.equal(gate({ game: sealed, listing: listing({ condition: 'preowned' }) }).reason, 'condition_blocked');
  assert.equal(gate({ game: sealed, listing: listing({ condition: 'new' }) }).alert, true);
});

test('prefer-used and either accept any condition', () => {
  for (const policy of ['prefer-used', 'either'] as const) {
    const g = game({ conditionPolicy: policy });
    assert.equal(gate({ game: g, listing: listing({ condition: 'unknown' }) }).alert, true, policy);
  }
});

test('a price equal to the last alerted price is blocked', () => {
  assert.equal(gate({ lastAlertedPricePaise: 145000 }).reason, 'not_better_than_last_alert');
});

test('a 5% improvement on the last alerted price passes', () => {
  assert.equal(gate({ lastAlertedPricePaise: 152700 }).alert, true);
});

test('a rise above the last alerted price is blocked, not treated as new', () => {
  assert.equal(
    gate({ listing: listing({ pricePaise: 190000 }), lastAlertedPricePaise: 145000 }).reason,
    'not_better_than_last_alert'
  );
});

test('conditionAllowed defaults to permissive when no policy is set', () => {
  assert.equal(conditionAllowed(listing({ condition: 'preowned' }), game()), true);
});

test('percentUnderTarget rounds and never goes negative', () => {
  assert.equal(percentUnderTarget(145000, 199900), 27);
  assert.equal(percentUnderTarget(199900, 199900), 0);
  assert.equal(percentUnderTarget(250000, 199900), 0);
});

test('a near miss is above target but within 10%', () => {
  assert.equal(isNearMiss(listing({ pricePaise: 210000 }), game()), true);
  assert.equal(isNearMiss(listing({ pricePaise: 199900 }), game()), false, 'at target is not a near miss');
  assert.equal(isNearMiss(listing({ pricePaise: 250000 }), game()), false, 'too far over');
});

test('a near miss on a sealed-only game ignores used listings', () => {
  const sealed = game({ conditionPolicy: 'sealed-only' });
  assert.equal(isNearMiss(listing({ pricePaise: 210000, condition: 'preowned' }), sealed), false);
  assert.equal(isNearMiss(listing({ pricePaise: 210000, condition: 'new' }), sealed), true);
});
