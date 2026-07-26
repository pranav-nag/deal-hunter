import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { appendPrices, readPrices } from '../state/prices.ts';
import { pricesPath } from '../state/paths.ts';
import { listingKey, loadListings } from '../state/listings.ts';

test('listingKey is stable for the same source and url', () => {
  assert.equal(listingKey('GameLoot', 'https://x.test/p/1'), listingKey('GameLoot', 'https://x.test/p/1'));
});

test('listingKey differs across sources for the same url', () => {
  assert.notEqual(listingKey('GameLoot', 'https://x.test/p/1'), listingKey('Nekavo', 'https://x.test/p/1'));
});

test('listingKey is a short hex digest', () => {
  assert.match(listingKey('GameLoot', 'https://x.test/p/1'), /^[0-9a-f]{16}$/);
});

test('loadListings returns an empty file for an unknown source', async () => {
  const file = await loadListings('NoSuchSource');
  assert.equal(file.source, 'NoSuchSource');
  assert.deepEqual(file.listings, {});
  assert.equal(file.updatedAt, 0);
});

test('appendPrices then readPrices round-trips and preserves order', async (t) => {
  const source = `TestSource${process.pid}`;
  // The store is append-only and pids get recycled, so a leftover file from an
  // earlier run would silently double the expected sequence. Start from empty.
  await rm(pricesPath(source), { force: true });
  t.after(() => rm(pricesPath(source), { force: true }));
  await appendPrices(source, [
    { ts: 1, key: 'a', pricePaise: 100, inStock: true },
    { ts: 2, key: 'a', pricePaise: 90, inStock: true },
  ]);
  await appendPrices(source, [{ ts: 3, key: 'a', pricePaise: 90, inStock: false }]);
  const points = await readPrices(source);
  assert.deepEqual(points.map((p) => p.ts), [1, 2, 3]);
  assert.equal(points[1].pricePaise, 90);
});

test('appendPrices with no points writes nothing', async () => {
  const before = await readPrices('EmptyWriteSource');
  await appendPrices('EmptyWriteSource', []);
  assert.deepEqual(await readPrices('EmptyWriteSource'), before);
});
