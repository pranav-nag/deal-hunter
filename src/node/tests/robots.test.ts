import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isPathAllowed, ROBOTS_OVERRIDES } from '../scrapers/robots.ts';

const SAMPLE = `
User-agent: *
Disallow: /cart
Disallow: /checkout/
Allow: /checkout/policy

User-agent: BadBot
Disallow: /
`;

test('paths outside a Disallow rule are allowed', () => {
  assert.equal(parseRobots(SAMPLE).isAllowed('/product/witcher-3'), true);
});

test('disallowed prefixes are blocked', () => {
  const r = parseRobots(SAMPLE);
  assert.equal(r.isAllowed('/cart'), false);
  assert.equal(r.isAllowed('/checkout/step-1'), false);
});

test('a longer Allow rule beats a shorter Disallow', () => {
  assert.equal(parseRobots(SAMPLE).isAllowed('/checkout/policy'), true);
});

test('rules for other user agents are ignored', () => {
  assert.equal(parseRobots(SAMPLE).isAllowed('/anything'), true);
});

test('an empty or unfetchable robots.txt allows everything', () => {
  assert.equal(parseRobots('').isAllowed('/cart'), true);
});

test('Disallow with an empty value allows everything', () => {
  assert.equal(parseRobots('User-agent: *\nDisallow:').isAllowed('/cart'), true);
});

// GameLoot's real rules. Matching pathname alone would miss every one of
// these, which is how a query-string Disallow gets silently crawled anyway.
const QUERY_RULES = `
User-agent: *
Disallow: /?s=
Disallow: /*?*swoof=
Disallow: /*?*add-to-cart=
Disallow: /private/*.pdf$
`;

test('a query-string Disallow blocks the search endpoint', () => {
  const r = parseRobots(QUERY_RULES);
  assert.equal(r.isAllowed('/?s=titanfall&post_type=product'), false);
  assert.equal(r.isAllowed('/product/titanfall-2'), true);
});

test('wildcards match anywhere in the path and query', () => {
  const r = parseRobots(QUERY_RULES);
  assert.equal(r.isAllowed('/shop?page=2&swoof=1'), false);
  assert.equal(r.isAllowed('/shop?page=2'), true);
});

test('a trailing $ anchors the end of the pattern', () => {
  const r = parseRobots(QUERY_RULES);
  assert.equal(r.isAllowed('/private/terms.pdf'), false);
  assert.equal(r.isAllowed('/private/terms.pdf?download=1'), true);
});

test('regex metacharacters in a rule are matched literally', () => {
  const r = parseRobots('User-agent: *\nDisallow: /a.b');
  assert.equal(r.isAllowed('/a.b'), false);
  assert.equal(r.isAllowed('/axb'), true);
});

test('GameLoot is an explicit, recorded override rather than a matcher gap', async () => {
  assert.ok(ROBOTS_OVERRIDES.has('gameloot.in'));
  // Returns true without fetching robots.txt at all.
  assert.equal(await isPathAllowed('https://gameloot.in/?s=titanfall&post_type=product'), true);
});
