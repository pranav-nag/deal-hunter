import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCircuitBreaker, MAX_ALERTS_PER_PASS } from '../events/breaker.ts';
import type { DealEvent, EventKind } from '../events/diff.ts';
import type { StoredListing } from '../state/listings.ts';

const NOW = 1_774_454_400_000;

const listing = (over: Partial<StoredListing> = {}): StoredListing => ({
  title: 'Titanfall 2 PS4', url: 'https://x.test/tf2', imageUrl: '',
  pricePaise: 50000, originalPricePaise: null, currency: 'INR', condition: 'preowned',
  inStock: true, gameSlug: 'titanfall-2', matchScore: 0.95, matchStatus: 'auto',
  firstSeen: NOW, lastSeen: NOW, missedPasses: 0, ...over,
});

const event = (
  i: number,
  over: { kind?: EventKind; source?: string; alert?: boolean } = {}
): DealEvent => ({
  kind: over.kind ?? 'price_drop',
  key: `k${i}`,
  source: over.source ?? 'GameLoot',
  listing: listing(),
  previousPricePaise: 60000,
  alert: over.alert ?? true,
  gateReason: 'ok',
});

const counts = (entries: Array<[string, number]>) => new Map(entries);

test('a normal pass sends everything and never trips', () => {
  const events = [event(1), event(2), event(3)];
  const result = applyCircuitBreaker({ events, listingCounts: counts([['GameLoot', 200]]) });
  assert.equal(result.send.length, 3);
  assert.equal(result.suppressed.length, 0);
  assert.equal(result.tripped, null);
});

test('non-alerting events are never sent but do not count toward the cap', () => {
  const events = [event(1), ...Array.from({ length: 50 }, (_, i) => event(i + 2, { alert: false }))];
  const result = applyCircuitBreaker({ events, listingCounts: counts([['GameLoot', 200]]) });
  assert.equal(result.send.length, 1);
  assert.equal(result.tripped, null);
});

test('more alerts than the cap suppresses the whole batch', () => {
  const events = Array.from({ length: MAX_ALERTS_PER_PASS + 1 }, (_, i) => event(i));
  const result = applyCircuitBreaker({ events, listingCounts: counts([['GameLoot', 200]]) });
  assert.equal(result.send.length, 0);
  assert.equal(result.suppressed.length, MAX_ALERTS_PER_PASS + 1);
  assert.equal(result.tripped?.kind, 'volume');
});

test('exactly the cap still sends', () => {
  const events = Array.from({ length: MAX_ALERTS_PER_PASS }, (_, i) => event(i));
  const result = applyCircuitBreaker({ events, listingCounts: counts([['GameLoot', 200]]) });
  assert.equal(result.send.length, MAX_ALERTS_PER_PASS);
  assert.equal(result.tripped, null);
});

test('a source re-reporting most of its catalogue as new is treated as key churn', () => {
  const events = [
    ...Array.from({ length: 60 }, (_, i) => event(i, { kind: 'new_listing', alert: i < 3 })),
    event(999, { source: 'GameNation' }),
  ];
  const result = applyCircuitBreaker({
    events,
    listingCounts: counts([['GameLoot', 100], ['GameNation', 100]]),
  });
  assert.equal(result.tripped?.kind, 'churn');
  assert.equal(result.send.length, 1, 'the healthy source still gets through');
  assert.equal(result.send[0].source, 'GameNation');
  assert.equal(result.suppressed.length, 3);
});

test('churn detection ignores sources with too few listings to judge', () => {
  const events = Array.from({ length: 8 }, (_, i) => event(i, { kind: 'new_listing' }));
  const result = applyCircuitBreaker({ events, listingCounts: counts([['GameLoot', 10]]) });
  assert.equal(result.tripped, null);
  assert.equal(result.send.length, 8);
});

test('churn plus high volume elsewhere still suppresses everything', () => {
  const events = [
    ...Array.from({ length: 60 }, (_, i) => event(i, { kind: 'new_listing', alert: false })),
    ...Array.from({ length: MAX_ALERTS_PER_PASS + 1 }, (_, i) => event(1000 + i, { source: 'GameNation' })),
  ];
  const result = applyCircuitBreaker({
    events,
    listingCounts: counts([['GameLoot', 100], ['GameNation', 100]]),
  });
  assert.equal(result.tripped?.kind, 'volume');
  assert.equal(result.send.length, 0);
});
