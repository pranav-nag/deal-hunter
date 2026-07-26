import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_SCRAPERS, SOURCE_LABELS, getScraper } from '../scrapers/index.ts';

test('the registry is not empty', () => {
  assert.ok(ALL_SCRAPERS.length > 0);
});

test('every scraper has a label and a unique source', () => {
  const sources = ALL_SCRAPERS.map((s) => s.source);
  assert.equal(new Set(sources).size, sources.length, 'duplicate source names');
  for (const s of sources) assert.ok(SOURCE_LABELS[s], `missing label for ${s}`);
});

test('every scraper exposes search and a tier', () => {
  for (const s of ALL_SCRAPERS) {
    assert.equal(typeof s.search, 'function', `${s.source} has no search()`);
    assert.ok(['reliable', 'api', 'best-effort'].includes(s.tier), `${s.source} bad tier`);
  }
});

test('getScraper finds by exact source name', () => {
  assert.equal(getScraper('GameLoot')?.source, 'GameLoot');
  assert.equal(getScraper('NoSuchStore'), undefined);
});
