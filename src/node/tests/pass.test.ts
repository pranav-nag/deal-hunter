import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { runSource } from '../pass.ts';
import { listingsPath, pricesPath } from '../state/paths.ts';
import { loadHealth, saveHealth } from '../state/health.ts';
import type { Scraper, ScrapeOutcome } from '../scrapers/types.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const GAMES: WishlistGame[] = [
  { slug: 'titanfall-2', title: 'Titanfall 2', platform: 'ps4', status: 'wanted', aliases: [] },
];

const fakeScraper = (items: string[], source = `Fake${process.pid}`): Scraper => ({
  source,
  tier: 'reliable',
  async search(): Promise<ScrapeOutcome> {
    return {
      source, ok: true, pageHadContent: true, durationMs: 1,
      items: items.map((title) => ({
        source, title, url: `https://fake.test/${encodeURIComponent(title)}`,
        imageUrl: '', pricePaise: 50000, originalPricePaise: null,
        currency: 'INR', condition: 'preowned' as const, inStock: true,
      })),
    };
  },
});

/**
 * runSource writes real state; keep the repo's state/ clean. health.json is one
 * shared file rather than a per-source one, so it needs the key pruned, not the
 * file removed — deleting it would discard every real source's history.
 */
async function cleanup(source: string) {
  await rm(listingsPath(source), { force: true });
  await rm(pricesPath(source), { force: true });
  const health = await loadHealth();
  if (source in health) {
    delete health[source];
    await saveHealth(health);
  }
}

test('a seed run produces no alertable events', async (t) => {
  const source = `Seed${process.pid}`;
  await cleanup(source);
  t.after(() => cleanup(source));
  const { events } = await runSource(fakeScraper(['Titanfall 2 PS4'], source), GAMES, { seed: true });
  assert.equal(events.filter((e) => e.alert).length, 0);
});

test('irrelevant scraper output is discarded by the relevance guard', async (t) => {
  const source = `Junk${process.pid}`;
  await cleanup(source);
  t.after(() => cleanup(source));
  const { events, outcomes } = await runSource(
    fakeScraper(["Let's Try Desi Spicy Wafers"], source),
    GAMES,
    { seed: true }
  );
  assert.equal(events.length, 0);
  assert.equal(outcomes.every((o) => !o.pageHadContent), true);
});
