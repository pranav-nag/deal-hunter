import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRelevant, guardOutcome } from '../scrapers/relevance.ts';
import type { ScrapeOutcome } from '../scrapers/types.ts';

const outcome = (items: string[]): ScrapeOutcome => ({
  source: 'TestStore',
  ok: true,
  pageHadContent: true,
  items: items.map((title) => ({
    source: 'TestStore',
    title,
    url: `https://x.test/${encodeURIComponent(title)}`,
    imageUrl: '',
    pricePaise: 100000,
    originalPricePaise: null,
    currency: 'INR',
    condition: 'unknown' as const,
    inStock: true,
  })),
  durationMs: 10,
});

test('a matching title is relevant', () => {
  assert.equal(isRelevant('Death Stranding 2', ['Death Stranding 2 On The Beach PS5']), true);
});

test('unrelated results are not relevant', () => {
  assert.equal(isRelevant('ps5', ["Let's Try Desi Spicy Wafers", 'Masala Puffs']), false);
});

test('one relevant result among many is enough', () => {
  assert.equal(isRelevant('Titanfall 2', ['Random Mouse Pad', 'Titanfall 2 PS4']), true);
});

test('short tokens do not create false relevance', () => {
  assert.equal(isRelevant('The Last of Us', ['A Game of The Year Edition']), false);
});

test('guardOutcome marks an irrelevant populated page as parse-empty', () => {
  const guarded = guardOutcome(outcome(["Let's Try Desi Spicy Wafers"]), 'ps5');
  assert.equal(guarded.pageHadContent, false);
  assert.equal(guarded.items.length, 0);
  assert.match(guarded.error ?? '', /irrelevant/i);
});

test('guardOutcome leaves a relevant page untouched', () => {
  const original = outcome(['Titanfall 2 PS4']);
  const guarded = guardOutcome(original, 'Titanfall 2');
  assert.equal(guarded.pageHadContent, true);
  assert.equal(guarded.items.length, 1);
});

test('guardOutcome leaves a genuinely empty result alone', () => {
  const empty: ScrapeOutcome = { ...outcome([]), items: [] };
  const guarded = guardOutcome(empty, 'Crimson Desert');
  assert.equal(guarded.pageHadContent, true);
  assert.equal(guarded.error, undefined);
});
