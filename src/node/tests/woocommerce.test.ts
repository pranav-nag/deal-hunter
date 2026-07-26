import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { parseWooDocument } from '../scrapers/woocommerce.ts';
import { gameloot, GAMELOOT_CONFIG } from '../scrapers/stores/gameloot.ts';

/**
 * The vendored parseWooDocument is (config, doc, html) => { items, pageHadContent },
 * not the (doc, config) => items[] the plan assumed. Vendored logic wins.
 */
async function fixture(name: string): Promise<{ doc: Document; html: string }> {
  const html = await readFile(join(import.meta.dirname, 'fixtures', name), 'utf8');
  return { doc: new JSDOM(html).window.document as unknown as Document, html };
}

test('parses products out of a real GameLoot search page', async () => {
  const { doc, html } = await fixture('gameloot-search.html');
  const { items, pageHadContent } = parseWooDocument(GAMELOOT_CONFIG, doc, html);
  assert.equal(pageHadContent, true);
  assert.ok(items.length > 0, 'expected at least one product');
  const first = items[0];
  assert.ok(first.title.length > 0);
  assert.ok(first.url.startsWith('http'));
  assert.equal(first.source, 'GameLoot');
});

test('every parsed price is integer paise or null', async () => {
  const { doc, html } = await fixture('gameloot-search.html');
  const { items } = parseWooDocument(GAMELOOT_CONFIG, doc, html);
  for (const item of items) {
    if (item.pricePaise !== null) {
      assert.equal(Number.isInteger(item.pricePaise), true, `${item.title} price not integer`);
      assert.ok(item.pricePaise > 0);
    }
  }
});

test('the fixture actually contains the product searched for', async () => {
  const { doc, html } = await fixture('gameloot-search.html');
  const { items } = parseWooDocument(GAMELOOT_CONFIG, doc, html);
  assert.ok(
    items.some((i) => /titanfall/i.test(i.title)),
    `no Titanfall listing among: ${items.map((i) => i.title).join(' | ')}`
  );
});

test('the exported scraper carries the config it was built from', () => {
  assert.equal(gameloot.source, GAMELOOT_CONFIG.source);
  assert.equal(gameloot.tier, 'reliable');
});
