# Deal Hunter Phase 1 — Store Scrapers on Cloud Cron: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run 13 Indian game-store scrapers on a 6-hourly GitHub Actions cron, matching results against a 35-game wishlist and alerting price events to Discord, with all state committed back to the repo as deterministic JSON.

**Architecture:** A standalone Node/TypeScript worker vendored from `ps-collector`, run by GitHub Actions. State lives as committed JSON and JSONL files partitioned per source, so concurrent workflows never touch the same file. The pipeline is scrape → normalize → match → diff against previous state → emit events → Discord → commit.

**Tech Stack:** Node 22, TypeScript, tsx, jsdom, Playwright (bot-walled sources only), GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-07-25-multi-store-deal-hunter-design.md`](../specs/2026-07-25-multi-store-deal-hunter-design.md)

## Global Constraints

- **Money is always integer paise** (₹1 = 100 paise), never floats. Parse and format only through `src/node/lib/money.ts`.
- **Timestamps are integer unix ms, UTC.**
- **All state JSON is written through `writeJsonStable()`** — sorted keys, two-space indent, trailing newline. Never `JSON.stringify` directly into a state file.
- **`prices/<source>.jsonl` is append-only.** Never rewritten in place.
- **Source names are the exact strings in `SOURCE_LABELS`** (`GameLoot`, `GameNation`, `GamesTheShop`, `E2ZStore`, `HGWorld`, `Dacby`, `Nekavo`, `ConsoleGarage`, `CexIndia`, `PlayAsia`, `AmazonIn`, `Flipkart`, `NXTGamerCode`). State filenames use the lowercased source name.
- **No secrets in code.** `DISCORD_WEBHOOK_URL` comes from the environment only; unset means mock mode (print to stdout).
- **Forum and social sources are out of scope.** This worker scrapes storefronts only; vendor only the store scrapers from `ps-collector`.
- **Scrapers must never throw.** Every failure path returns a `ScrapeOutcome` with `ok: false`.

## Scope

This plan covers **phase 1 only**. Phases 2 (quick-commerce and e-commerce expansion), 3 (digest workflow) and 4 (ps-collector sync) get their own plans, written once the state contracts here exist as real code.

**Deliberately deferred from this phase:** the spec's *fallback ladder* — intercept JSON API responses first, hydration data second, DOM last — for the browser-driven scrapers. The vendored scrapers already extract successfully by their existing means, so rewriting their extraction strategy before the pipeline runs end-to-end would be changing two things at once. The half of that idea that guards against silent failure, the **relevance guard**, *is* in this phase (Task 6), because that is the part that prevents wrong data reaching permanent history. The interception rewrite becomes worthwhile when a specific scraper starts breaking on markup changes, and should be its own plan with that scraper's real API traffic in hand.

---

### Task 1: Node workspace and deterministic serializer

Everything downstream writes state through this. It comes first because a non-deterministic serializer silently reintroduces the repo-bloat problem the whole storage design exists to avoid.

**Files:**
- Create: `src/node/package.json`
- Create: `src/node/tsconfig.json`
- Create: `src/node/lib/serialize.ts`
- Test: `src/node/tests/serialize.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `stableStringify(value: unknown): string` — sorted keys, 2-space indent, trailing newline
  - `writeJsonStable(path: string, value: unknown): Promise<void>`
  - `readJson<T>(path: string, fallback: T): Promise<T>` — returns `fallback` when the file is absent

- [ ] **Step 1: Create the workspace files**

`src/node/package.json`:

```json
{
  "name": "deal-hunter-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "stores": "tsx bin/stores.ts",
    "test": "node --test --import tsx tests/*.test.ts"
  },
  "dependencies": {
    "jsdom": "^29.1.1",
    "playwright": "^1.61.1"
  },
  "devDependencies": {
    "@types/jsdom": "^28.0.3",
    "@types/node": "^20",
    "tsx": "^4.23.1",
    "typescript": "^5"
  }
}
```

`src/node/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test**

`src/node/tests/serialize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify, writeJsonStable, readJson } from '../lib/serialize.ts';

test('stableStringify sorts keys regardless of insertion order', () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
});

test('stableStringify sorts nested keys and ends with a newline', () => {
  const out = stableStringify({ z: { y: 1, x: 2 } });
  assert.equal(out, '{\n  "z": {\n    "x": 2,\n    "y": 1\n  }\n}\n');
});

test('stableStringify preserves array order', () => {
  assert.equal(stableStringify([3, 1, 2]), '[\n  3,\n  1,\n  2\n]\n');
});

test('readJson returns the fallback for a missing file', async () => {
  const got = await readJson(join(tmpdir(), 'definitely-absent-9f3a.json'), { n: 7 });
  assert.deepEqual(got, { n: 7 });
});

test('writeJsonStable round-trips and creates parent directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ser-'));
  const path = join(dir, 'nested', 'state.json');
  await writeJsonStable(path, { b: 1, a: [2, 3] });
  assert.equal(await readFile(path, 'utf8'), '{\n  "a": [\n    2,\n    3\n  ],\n  "b": 1\n}\n');
  assert.deepEqual(await readJson(path, null), { b: 1, a: [2, 3] });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd src/node && npm install && npm test
```

Expected: FAIL — `Cannot find module '../lib/serialize.ts'`

- [ ] **Step 4: Implement the serializer**

`src/node/lib/serialize.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * JSON with keys sorted at every level, two-space indent, trailing newline.
 *
 * State files are rewritten in full on every pass and committed to git, so
 * output has to be byte-identical when the data is. Unsorted keys would make
 * every commit a whole-file diff.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2) + '\n';
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

export async function writeJsonStable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableStringify(value), 'utf8');
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd src/node && npm test
```

Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/node/package.json src/node/tsconfig.json src/node/lib/serialize.ts src/node/tests/serialize.test.ts src/node/package-lock.json
git commit -m "feat(worker): node workspace and deterministic JSON serializer"
```

---

### Task 2: State paths and the wishlist

**Files:**
- Create: `src/node/state/paths.ts`
- Create: `src/node/state/wishlist.ts`
- Create: `state/wishlist.json`
- Test: `src/node/tests/wishlist.test.ts`

**Interfaces:**
- Consumes: `readJson` from Task 1
- Produces:
  - `type WishlistGame = { slug: string; title: string; platform: 'ps4' | 'ps5' | 'any'; status: 'owned' | 'wanted'; paidPaise?: number; condition?: 'new' | 'preowned'; notes?: string; aliases: string[] }`
  - `loadWishlist(): Promise<WishlistGame[]>`
  - `searchQueries(game: WishlistGame): string[]` — canonical title plus aliases
  - `STATE_DIR`, `listingsPath(source: string)`, `pricesPath(source: string)`, `HEALTH_PATH`, `WISHLIST_PATH`

- [ ] **Step 1: Write the failing test**

`src/node/tests/wishlist.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWishlist, searchQueries } from '../state/wishlist.ts';
import { listingsPath, pricesPath } from '../state/paths.ts';

test('wishlist loads all 35 games', async () => {
  const games = await loadWishlist();
  assert.equal(games.length, 35);
});

test('wishlist splits 19 owned and 16 wanted', async () => {
  const games = await loadWishlist();
  assert.equal(games.filter((g) => g.status === 'owned').length, 19);
  assert.equal(games.filter((g) => g.status === 'wanted').length, 16);
});

test('every game has a unique slug and at least one query', async () => {
  const games = await loadWishlist();
  const slugs = new Set(games.map((g) => g.slug));
  assert.equal(slugs.size, games.length);
  for (const g of games) assert.ok(searchQueries(g).length >= 1, `${g.slug} has no queries`);
});

test('owned games carry what was paid', async () => {
  const games = await loadWishlist();
  const gow = games.find((g) => g.slug === 'god-of-war-2018');
  assert.equal(gow?.status, 'owned');
  assert.equal(gow?.paidPaise, 85000);
});

test('searchQueries returns the title first, then aliases, deduped', () => {
  const queries = searchQueries({
    slug: 'gta-v-ps5',
    title: 'Grand Theft Auto V',
    platform: 'ps5',
    status: 'owned',
    aliases: ['GTA V', 'Grand Theft Auto V'],
  });
  assert.deepEqual(queries, ['Grand Theft Auto V', 'GTA V']);
});

test('state paths are partitioned per source and lowercased', () => {
  assert.ok(listingsPath('GameLoot').endsWith('state/listings/gameloot.json'));
  assert.ok(pricesPath('CexIndia').endsWith('state/prices/cexindia.jsonl'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../state/wishlist.ts`

- [ ] **Step 3: Implement paths**

`src/node/state/paths.ts`:

```ts
import { join, resolve } from 'node:path';

/** Repo root, two levels up from src/node. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const STATE_DIR = join(REPO_ROOT, 'state');

export const WISHLIST_PATH = join(STATE_DIR, 'wishlist.json');
export const HEALTH_PATH = join(STATE_DIR, 'health.json');

const fileKey = (source: string) => source.toLowerCase();

export const listingsPath = (source: string) =>
  join(STATE_DIR, 'listings', `${fileKey(source)}.json`);

export const pricesPath = (source: string) =>
  join(STATE_DIR, 'prices', `${fileKey(source)}.jsonl`);
```

- [ ] **Step 4: Implement the wishlist loader**

`src/node/state/wishlist.ts`:

```ts
import { readJson } from '../lib/serialize.ts';
import { WISHLIST_PATH } from './paths.ts';

export interface WishlistGame {
  slug: string;
  title: string;
  platform: 'ps4' | 'ps5' | 'any';
  status: 'owned' | 'wanted';
  /** What the user paid, integer paise. Owned games only. */
  paidPaise?: number;
  condition?: 'new' | 'preowned';
  notes?: string;
  aliases: string[];
}

export async function loadWishlist(): Promise<WishlistGame[]> {
  const data = await readJson<{ games: WishlistGame[] }>(WISHLIST_PATH, { games: [] });
  return data.games;
}

/** Canonical title first, then aliases, deduplicated case-insensitively. */
export function searchQueries(game: WishlistGame): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of [game.title, ...game.aliases]) {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q.trim());
  }
  return out;
}
```

- [ ] **Step 5: Create the wishlist data**

`state/wishlist.json` — 19 owned, 16 wanted. Prices are the listed purchase price in paise, excluding shipping.

```json
{
  "games": [
    { "slug": "the-witcher-3-complete-edition", "title": "The Witcher 3: Wild Hunt Complete Edition", "platform": "ps5", "status": "owned", "paidPaise": 169900, "condition": "new", "aliases": ["Witcher 3 Complete Edition", "The Witcher 3 Wild Hunt"] },
    { "slug": "dark-souls-trilogy", "title": "Dark Souls Trilogy", "platform": "ps4", "status": "owned", "paidPaise": 330000, "condition": "new", "aliases": ["Dark Souls Trilogy PS4"] },
    { "slug": "elden-ring-shadow-of-the-erdtree", "title": "Elden Ring Shadow of the Erdtree Edition", "platform": "ps5", "status": "owned", "paidPaise": 390000, "condition": "new", "aliases": ["Elden Ring Erdtree Edition", "Elden Ring Shadow of the Erdtree"] },
    { "slug": "black-myth-wukong", "title": "Black Myth: Wukong", "platform": "ps5", "status": "owned", "paidPaise": 450000, "condition": "preowned", "notes": "plus 153 shipping", "aliases": ["Black Myth Wukong"] },
    { "slug": "gta-v-ps5", "title": "Grand Theft Auto V", "platform": "ps5", "status": "owned", "paidPaise": 140000, "condition": "preowned", "notes": "Saudi Arabia region; plus 80 shipping", "aliases": ["GTA V", "GTA 5"] },
    { "slug": "gta-v-premium-edition-ps4", "title": "Grand Theft Auto V Premium Edition", "platform": "ps4", "status": "owned", "paidPaise": 90000, "condition": "preowned", "notes": "with map and Criminal Enterprise Starter Pack code", "aliases": ["GTA V Premium Edition", "GTA 5 Premium"] },
    { "slug": "metal-gear-solid-v-the-phantom-pain", "title": "Metal Gear Solid V: The Phantom Pain", "platform": "ps4", "status": "owned", "paidPaise": 57500, "condition": "preowned", "aliases": ["MGS V", "Metal Gear Solid 5 Phantom Pain"] },
    { "slug": "titanfall-2", "title": "Titanfall 2", "platform": "ps4", "status": "owned", "paidPaise": 50000, "condition": "preowned", "aliases": ["Titanfall 2 PS4"] },
    { "slug": "resident-evil-7-gold-edition", "title": "Resident Evil 7 Gold Edition", "platform": "ps4", "status": "owned", "paidPaise": 100000, "condition": "preowned", "notes": "US region; free PS5 upgrade on USA account only; plus 100 shipping", "aliases": ["Resident Evil VII Gold", "RE7 Gold Edition"] },
    { "slug": "resident-evil-requiem", "title": "Resident Evil Requiem", "platform": "ps5", "status": "owned", "paidPaise": 345000, "condition": "preowned", "notes": "plus 116 shipping", "aliases": ["RE Requiem"] },
    { "slug": "resident-evil-4-remake", "title": "Resident Evil 4", "platform": "ps5", "status": "owned", "paidPaise": 160000, "condition": "preowned", "notes": "2023 remake", "aliases": ["Resident Evil 4 Remake", "RE4 Remake"] },
    { "slug": "astro-bot", "title": "Astro Bot", "platform": "ps5", "status": "owned", "paidPaise": 265900, "aliases": ["Astrobot"] },
    { "slug": "death-stranding-2-on-the-beach", "title": "Death Stranding 2: On the Beach", "platform": "ps5", "status": "owned", "paidPaise": 340000, "condition": "preowned", "aliases": ["Death Stranding 2", "DS2"] },
    { "slug": "god-of-war-2018", "title": "God of War", "platform": "ps4", "status": "owned", "paidPaise": 85000, "condition": "preowned", "notes": "2018 entry", "aliases": ["God of War 2018", "GOW 2018"] },
    { "slug": "god-of-war-3-remastered", "title": "God of War III Remastered", "platform": "ps4", "status": "owned", "paidPaise": 85000, "condition": "preowned", "aliases": ["God of War 3 Remastered", "GOW 3"] },
    { "slug": "fifa-18-ronaldo-edition", "title": "FIFA 18 Ronaldo Edition", "platform": "ps4", "status": "owned", "paidPaise": 35000, "condition": "preowned", "aliases": ["FIFA 18"] },
    { "slug": "call-of-duty-wwii", "title": "Call of Duty: WWII", "platform": "ps4", "status": "owned", "paidPaise": 100000, "condition": "preowned", "aliases": ["COD WWII", "Call of Duty WW2"] },
    { "slug": "ghost-of-yotei", "title": "Ghost of Yotei", "platform": "ps5", "status": "owned", "paidPaise": 250000, "condition": "preowned", "aliases": ["Ghost of Yotei PS5"] },
    { "slug": "oblivion-remastered-deluxe", "title": "The Elder Scrolls IV: Oblivion Remastered Deluxe Edition", "platform": "ps5", "status": "owned", "paidPaise": 340000, "condition": "new", "aliases": ["Oblivion Remastered", "Elder Scrolls IV Oblivion Remastered"] },

    { "slug": "clair-obscur-expedition-33", "title": "Clair Obscur: Expedition 33", "platform": "ps5", "status": "wanted", "aliases": ["Clair Obscur Expedition 33", "Expedition 33"] },
    { "slug": "the-evil-within", "title": "The Evil Within", "platform": "ps4", "status": "wanted", "aliases": ["Evil Within"] },
    { "slug": "the-evil-within-2", "title": "The Evil Within 2", "platform": "ps4", "status": "wanted", "aliases": ["Evil Within 2"] },
    { "slug": "horizon-forbidden-west-complete-edition", "title": "Horizon Forbidden West Complete Edition", "platform": "ps5", "status": "wanted", "aliases": ["Horizon Forbidden West"] },
    { "slug": "horizon-zero-dawn-remastered", "title": "Horizon Zero Dawn Remastered", "platform": "ps5", "status": "wanted", "aliases": ["Horizon Zero Dawn"] },
    { "slug": "the-first-berserker-khazan", "title": "The First Berserker: Khazan", "platform": "ps5", "status": "wanted", "aliases": ["First Berserker Khazan", "Khazan"] },
    { "slug": "cyberpunk-2077-ultimate-edition", "title": "Cyberpunk 2077: Ultimate Edition", "platform": "ps5", "status": "wanted", "aliases": ["Cyberpunk 2077 Ultimate"] },
    { "slug": "resident-evil-village-gold-edition", "title": "Resident Evil Village Gold Edition", "platform": "ps5", "status": "wanted", "aliases": ["RE Village Gold", "Resident Evil 8 Gold"] },
    { "slug": "death-stranding-directors-cut", "title": "Death Stranding Director's Cut", "platform": "ps5", "status": "wanted", "aliases": ["Death Stranding Directors Cut"] },
    { "slug": "crimson-desert", "title": "Crimson Desert", "platform": "ps5", "status": "wanted", "aliases": [] },
    { "slug": "the-last-of-us-part-1", "title": "The Last of Us Part I", "platform": "ps5", "status": "wanted", "aliases": ["The Last of Us Part 1", "TLOU Part 1"] },
    { "slug": "the-last-of-us-part-2", "title": "The Last of Us Part II", "platform": "ps5", "status": "wanted", "aliases": ["The Last of Us Part 2", "TLOU Part 2"] },
    { "slug": "god-of-war-ragnarok", "title": "God of War Ragnarok", "platform": "ps5", "status": "wanted", "aliases": ["GOW Ragnarok"] },
    { "slug": "fallout-4-goty", "title": "Fallout 4 Game of the Year Edition", "platform": "ps4", "status": "wanted", "aliases": ["Fallout 4 GOTY"] },
    { "slug": "skyrim-special-edition", "title": "The Elder Scrolls V: Skyrim Special Edition", "platform": "ps4", "status": "wanted", "notes": "Anniversary Edition also acceptable", "aliases": ["Skyrim Special Edition", "Skyrim Anniversary Edition"] },
    { "slug": "assassins-creed-ezio-collection", "title": "Assassin's Creed The Ezio Collection", "platform": "ps4", "status": "wanted", "aliases": ["AC Ezio Collection"] }
  ]
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd src/node && npm test
```

Expected: PASS, 11 tests total

- [ ] **Step 7: Commit**

```bash
git add src/node/state/paths.ts src/node/state/wishlist.ts state/wishlist.json src/node/tests/wishlist.test.ts
git commit -m "feat(worker): wishlist model and partitioned state paths"
```

---

### Task 3: Listings and price-history stores

**Files:**
- Create: `src/node/state/listings.ts`
- Create: `src/node/state/prices.ts`
- Test: `src/node/tests/state-stores.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonStable`, `listingsPath`, `pricesPath`
- Produces:
  - `type StoredListing = { title: string; url: string; imageUrl: string; pricePaise: number | null; originalPricePaise: number | null; currency: string; condition: 'new' | 'preowned' | 'unknown'; inStock: boolean; gameSlug: string | null; matchScore: number; matchStatus: 'auto' | 'pending' | 'unmatched'; firstSeen: number; lastSeen: number; missedPasses: number }`
  - `type ListingsFile = { source: string; updatedAt: number; listings: Record<string, StoredListing> }`
  - `listingKey(source: string, urlOrHint: string): string`
  - `loadListings(source: string): Promise<ListingsFile>`
  - `saveListings(file: ListingsFile): Promise<void>`
  - `type PricePoint = { ts: number; key: string; pricePaise: number | null; inStock: boolean }`
  - `appendPrices(source: string, points: PricePoint[]): Promise<void>`
  - `readPrices(source: string): Promise<PricePoint[]>`

- [ ] **Step 1: Write the failing test**

`src/node/tests/state-stores.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingKey } from '../state/listings.ts';

test('listingKey is stable for the same source and url', () => {
  assert.equal(listingKey('GameLoot', 'https://x.test/p/1'), listingKey('GameLoot', 'https://x.test/p/1'));
});

test('listingKey differs across sources for the same url', () => {
  assert.notEqual(listingKey('GameLoot', 'https://x.test/p/1'), listingKey('Nekavo', 'https://x.test/p/1'));
});

test('listingKey is a short hex digest', () => {
  assert.match(listingKey('GameLoot', 'https://x.test/p/1'), /^[0-9a-f]{16}$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../state/listings.ts`

- [ ] **Step 3: Implement the listings store**

`src/node/state/listings.ts`:

```ts
import { createHash } from 'node:crypto';
import { readJson, writeJsonStable } from '../lib/serialize.ts';
import { listingsPath } from './paths.ts';

export interface StoredListing {
  title: string;
  url: string;
  imageUrl: string;
  pricePaise: number | null;
  originalPricePaise: number | null;
  currency: string;
  condition: 'new' | 'preowned' | 'unknown';
  inStock: boolean;
  gameSlug: string | null;
  matchScore: number;
  matchStatus: 'auto' | 'pending' | 'unmatched';
  firstSeen: number;
  lastSeen: number;
  /** Consecutive passes this listing was absent. At 3 it is reported gone. */
  missedPasses: number;
}

export interface ListingsFile {
  source: string;
  updatedAt: number;
  listings: Record<string, StoredListing>;
}

/**
 * Stable identity for a listing. The caller passes the normalized URL, or the
 * scraper's keyHint when a store's item URLs are not product-specific.
 */
export function listingKey(source: string, urlOrHint: string): string {
  return createHash('sha256').update(`${source} ${urlOrHint}`).digest('hex').slice(0, 16);
}

export async function loadListings(source: string): Promise<ListingsFile> {
  return readJson<ListingsFile>(listingsPath(source), {
    source,
    updatedAt: 0,
    listings: {},
  });
}

export async function saveListings(file: ListingsFile): Promise<void> {
  await writeJsonStable(listingsPath(file.source), file);
}
```

- [ ] **Step 4: Implement the price store**

`src/node/state/prices.ts`:

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pricesPath } from './paths.ts';

export interface PricePoint {
  ts: number;
  key: string;
  pricePaise: number | null;
  inStock: boolean;
}

/**
 * Append-only. One line per observed change — never rewritten, so each commit
 * adds lines rather than restating the file.
 */
export async function appendPrices(source: string, points: PricePoint[]): Promise<void> {
  if (points.length === 0) return;
  const path = pricesPath(source);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, points.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
}

export async function readPrices(source: string): Promise<PricePoint[]> {
  try {
    const text = await readFile(pricesPath(source), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PricePoint);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Add round-trip tests**

Append to `src/node/tests/state-stores.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPrices, readPrices } from '../state/prices.ts';
import { loadListings, saveListings } from '../state/listings.ts';

test('loadListings returns an empty file for an unknown source', async () => {
  const file = await loadListings('NoSuchSource');
  assert.equal(file.source, 'NoSuchSource');
  assert.deepEqual(file.listings, {});
  assert.equal(file.updatedAt, 0);
});

test('appendPrices then readPrices round-trips and preserves order', async () => {
  const source = `TestSource${process.pid}`;
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
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd src/node && npm test
```

Expected: PASS. Then clean the scratch files this created:

```bash
rm -f state/prices/testsource*.jsonl
```

- [ ] **Step 7: Add a gitignore rule so test scratch never lands in state**

Append to `.gitignore`:

```
state/prices/testsource*.jsonl
src/node/node_modules/
```

- [ ] **Step 8: Commit**

```bash
git add src/node/state/listings.ts src/node/state/prices.ts src/node/tests/state-stores.test.ts .gitignore
git commit -m "feat(worker): listings snapshot and append-only price history stores"
```

---

### Task 4: Vendor the identity and money libraries

These are pure functions with no database coupling, so they port unchanged.

**Files:**
- Create: `src/node/lib/identity.ts` (copy of `ps-collector/src/server/lib/identity.ts`)
- Create: `src/node/lib/money.ts` (copy of `ps-collector/src/server/lib/money.ts`)
- Test: `src/node/tests/identity.test.ts`

**Interfaces:**
- Produces: `detectPlatform`, `detectCondition`, `detectEditions`, `cleanTitle`, `normTitleKey`, `baseTitle`, `type Platform`, `parseToPaise`, `formatPaise`, `rupeesToPaise`, `discountPercent`

- [ ] **Step 1: Copy the two files verbatim**

```bash
cp "../ps-collector/src/server/lib/identity.ts" src/node/lib/identity.ts
cp "../ps-collector/src/server/lib/money.ts" src/node/lib/money.ts
```

Adjust any relative imports to stay within `src/node/lib/`. Neither file should import from `../db` — if it does, stop and report, because that means the vendoring assumption in the spec is wrong.

- [ ] **Step 2: Write characterisation tests**

`src/node/tests/identity.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, detectCondition, detectEditions, baseTitle, normTitleKey } from '../lib/identity.ts';
import { parseToPaise, formatPaise } from '../lib/money.ts';

test('detectPlatform reads ps5 and ps4 from titles', () => {
  assert.equal(detectPlatform('Death Stranding 2 PS5'), 'ps5');
  assert.equal(detectPlatform('Titanfall 2 (PS4)'), 'ps4');
});

test('detectCondition distinguishes pre-owned from new', () => {
  assert.equal(detectCondition('God of War PS4 (Pre-Owned)'), 'preowned');
  assert.equal(detectCondition('God of War PS4 Brand New Sealed'), 'new');
});

test('baseTitle strips edition tokens but normTitleKey keeps them', () => {
  const deluxe = 'Oblivion Remastered Deluxe Edition';
  assert.ok(!baseTitle(deluxe).includes('deluxe'));
  assert.ok(normTitleKey(deluxe).includes('deluxe'));
});

test('detectEditions finds edition tokens', () => {
  assert.ok(detectEditions('Cyberpunk 2077 Ultimate Edition').length > 0);
  assert.equal(detectEditions('Titanfall 2').length, 0);
});

test('parseToPaise converts rupees to integer paise', () => {
  assert.equal(parseToPaise('₹1,699'), 169900);
  assert.equal(parseToPaise('3400.00'), 340000);
});

test('formatPaise renders rupees', () => {
  assert.match(formatPaise(169900), /1,699/);
});
```

- [ ] **Step 3: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS. If any assertion fails, the vendored behaviour differs from what this plan assumes — fix the *test* to match the vendored source, and note the difference in the commit message. Do not change the vendored logic.

- [ ] **Step 4: Commit**

```bash
git add src/node/lib/identity.ts src/node/lib/money.ts src/node/tests/identity.test.ts
git commit -m "feat(worker): vendor identity and money helpers from ps-collector"
```

---

### Task 5: Fetch layer with robots.txt enforcement

The spec's previous draft claimed robots.txt compliance with no mechanism. This task supplies the mechanism.

**Files:**
- Create: `src/node/scrapers/robots.ts`
- Create: `src/node/scrapers/fetch.ts` (vendored, plus a robots gate)
- Test: `src/node/tests/robots.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseRobots(text: string, userAgent?: string): { isAllowed(path: string): boolean }`
  - `isPathAllowed(url: string): Promise<boolean>` — fetches and caches robots.txt per host for the process lifetime
  - `fetchHtml(url: string, timeoutMs?: number): Promise<{ html: string | null; error?: string }>`
  - `fetchAndParse(url: string, timeoutMs?: number): Promise<{ doc: Document | null; html: string | null; error?: string }>`
  - `fetchJson<T>(url, headers?, timeoutMs?): Promise<{ data: T | null; error?: string }>`
  - `getImageSrc(element: Element | null): string`
  - `normalizeUrl(url: string): string`

- [ ] **Step 1: Write the failing test**

`src/node/tests/robots.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots } from '../scrapers/robots.ts';

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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../scrapers/robots.ts`

- [ ] **Step 3: Implement robots parsing**

`src/node/scrapers/robots.ts`:

```ts
interface Rule {
  path: string;
  allow: boolean;
}

export interface RobotsRules {
  isAllowed(path: string): boolean;
}

/**
 * Minimal robots.txt matcher: only the `*` group, longest-match wins, Allow
 * beats Disallow on equal length. Enough for the small shops this hits, and it
 * fails open — an unparseable or absent file allows everything.
 */
export function parseRobots(text: string, userAgent = '*'): RobotsRules {
  const rules: Rule[] = [];
  let inGroup = false;

  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      inGroup = value === '*' || value.toLowerCase() === userAgent.toLowerCase();
      continue;
    }
    if (!inGroup) continue;
    if (field === 'disallow' && value) rules.push({ path: value, allow: false });
    if (field === 'allow' && value) rules.push({ path: value, allow: true });
  }

  return {
    isAllowed(path: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!path.startsWith(rule.path)) continue;
        if (!best || rule.path.length > best.path.length) best = rule;
        else if (rule.path.length === best.path.length && rule.allow) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

const cache = new Map<string, RobotsRules>();

/** Fetches and caches robots.txt per host for the process lifetime. */
export async function isPathAllowed(url: string): Promise<boolean> {
  const parsed = new URL(url);
  let rules = cache.get(parsed.host);
  if (!rules) {
    let text = '';
    try {
      const res = await fetch(`${parsed.origin}/robots.txt`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) text = await res.text();
    } catch {
      text = '';
    }
    rules = parseRobots(text);
    cache.set(parsed.host, rules);
  }
  return rules.isAllowed(parsed.pathname);
}
```

- [ ] **Step 4: Vendor fetch.ts and add the robots gate**

```bash
cp "../ps-collector/src/server/scrapers/fetch.ts" src/node/scrapers/fetch.ts
```

Then in `src/node/scrapers/fetch.ts`, add the import and the gate at the top of `fetchHtml`:

```ts
import { isPathAllowed } from './robots.ts';
```

```ts
export async function fetchHtml(
  url: string,
  timeoutMs = 10000
): Promise<{ html: string | null; error?: string }> {
  try {
    if (!(await isPathAllowed(url))) {
      return { html: null, error: 'blocked by robots.txt' };
    }
    await politeDelay(url);
    // ...rest unchanged
```

Keep the existing `politeDelay`, `MIN_GAP_MS = 1500` and jitter exactly as vendored.

- [ ] **Step 5: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, 6 new tests

- [ ] **Step 6: Commit**

```bash
git add src/node/scrapers/robots.ts src/node/scrapers/fetch.ts src/node/tests/robots.test.ts
git commit -m "feat(worker): robots.txt enforcement in the fetch layer"
```

---

### Task 6: Scraper types with the relevance guard

The guard is the lesson from the failed Zepto scraper: a populated page is not a relevant page, and silent wrong data is worse than a missing source.

**Files:**
- Create: `src/node/scrapers/types.ts`
- Create: `src/node/scrapers/relevance.ts`
- Test: `src/node/tests/relevance.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ScrapedItem`, `ScrapeOutcome`, `Scraper` (as in `ps-collector/src/server/scrapers/types.ts`)
  - `isRelevant(query: string, titles: string[]): boolean`
  - `guardOutcome(outcome: ScrapeOutcome, query: string): ScrapeOutcome` — flips `pageHadContent` to `false` when a populated page yielded only irrelevant items

- [ ] **Step 1: Write the failing test**

`src/node/tests/relevance.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../scrapers/relevance.ts`

- [ ] **Step 3: Vendor types.ts**

```bash
cp "../ps-collector/src/server/scrapers/types.ts" src/node/scrapers/types.ts
```

- [ ] **Step 4: Implement the relevance guard**

`src/node/scrapers/relevance.ts`:

```ts
import type { ScrapeOutcome } from './types.ts';

const STOPWORDS = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'edition', 'ps4', 'ps5']);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * True when at least one title shares a meaningful token with the query.
 *
 * This is the guard against silent degradation: a scraper that falls through
 * its extraction tiers can land on a populated but unrelated page and report
 * success. Writing those prices into an append-only history is permanent and
 * looks healthy, which makes it worse than an outright failure.
 */
export function isRelevant(query: string, titles: string[]): boolean {
  const wanted = new Set(tokens(query));
  if (wanted.size === 0) return true; // nothing to check against
  return titles.some((title) => tokens(title).some((t) => wanted.has(t)));
}

export function guardOutcome(outcome: ScrapeOutcome, query: string): ScrapeOutcome {
  if (!outcome.ok || outcome.items.length === 0) return outcome;
  if (isRelevant(query, outcome.items.map((i) => i.title))) return outcome;
  return {
    ...outcome,
    pageHadContent: false,
    items: [],
    error: `parse produced ${outcome.items.length} irrelevant items for query "${query}"`,
  };
}
```

- [ ] **Step 5: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, 7 new tests

- [ ] **Step 6: Commit**

```bash
git add src/node/scrapers/types.ts src/node/scrapers/relevance.ts src/node/tests/relevance.test.ts
git commit -m "feat(worker): relevance guard so scrapers fail loudly on irrelevant results"
```

---

### Task 7: Vendor the WooCommerce factory and its four stores

**Files:**
- Create: `src/node/scrapers/woocommerce.ts`
- Create: `src/node/scrapers/stores/gameloot.ts`, `e2zstore.ts`, `hgworld.ts`, `nekavo.ts`
- Test: `src/node/tests/woocommerce.test.ts`
- Create: `src/node/tests/fixtures/gameloot-search.html`

**Interfaces:**
- Consumes: `fetchAndParse`, `getImageSrc`, `normalizeUrl`, `ScrapedItem`, `ScrapeOutcome`, `Scraper`
- Produces: `WooConfig`, `parseWooDocument(doc: Document, config: WooConfig): ScrapedItem[]`, `makeWooScraper(config: WooConfig): Scraper`, and the four `Scraper` constants `gameloot`, `e2zstore`, `hgworld`, `nekavo`

- [ ] **Step 1: Copy the factory and the four stores**

```bash
cp "../ps-collector/src/server/scrapers/woocommerce.ts" src/node/scrapers/woocommerce.ts
mkdir -p src/node/scrapers/stores
for s in gameloot e2zstore hgworld nekavo; do
  cp "../ps-collector/src/server/scrapers/stores/$s.ts" "src/node/scrapers/stores/$s.ts"
done
```

Fix import paths so they resolve within `src/node` (`../fetch.ts`, `../types.ts`, `../../lib/money.ts`). Add `.ts` extensions to relative imports — this workspace runs under tsx with ESM resolution.

- [ ] **Step 2: Capture a real fixture**

```bash
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" \
  "https://gameloot.in/?s=titanfall+2&post_type=product" \
  -o src/node/tests/fixtures/gameloot-search.html
```

Confirm the file is non-trivial and contains product markup before continuing:

```bash
wc -c src/node/tests/fixtures/gameloot-search.html
grep -c -i "titanfall" src/node/tests/fixtures/gameloot-search.html
```

Expected: several tens of KB and at least one match. If GameLoot's URL shape has changed, find the working search URL in the browser first and update `src/node/scrapers/stores/gameloot.ts` to match.

- [ ] **Step 3: Write the fixture test**

`src/node/tests/woocommerce.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { parseWooDocument } from '../scrapers/woocommerce.ts';
import { GAMELOOT_CONFIG } from '../scrapers/stores/gameloot.ts';

async function fixtureDoc(name: string): Promise<Document> {
  const html = await readFile(join(import.meta.dirname, 'fixtures', name), 'utf8');
  return new JSDOM(html).window.document as unknown as Document;
}

test('parses products out of a real GameLoot search page', async () => {
  const doc = await fixtureDoc('gameloot-search.html');
  const items = parseWooDocument(doc, GAMELOOT_CONFIG);
  assert.ok(items.length > 0, 'expected at least one product');
  const first = items[0];
  assert.ok(first.title.length > 0);
  assert.ok(first.url.startsWith('http'));
  assert.equal(first.source, 'GameLoot');
});

test('every parsed price is integer paise or null', async () => {
  const doc = await fixtureDoc('gameloot-search.html');
  const items = parseWooDocument(doc, GAMELOOT_CONFIG);
  for (const item of items) {
    if (item.pricePaise !== null) {
      assert.equal(Number.isInteger(item.pricePaise), true, `${item.title} price not integer`);
      assert.ok(item.pricePaise > 0);
    }
  }
});
```

Export the config from `src/node/scrapers/stores/gameloot.ts` so the test can import it directly:

```ts
export const GAMELOOT_CONFIG: WooConfig = { /* the existing config object */ };
export const gameloot = makeWooScraper(GAMELOOT_CONFIG);
```

Then import it in the test: `import { gameloot, GAMELOOT_CONFIG } from '../scrapers/stores/gameloot.ts';` and delete the placeholder cast in the first test.

- [ ] **Step 4: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS. If zero products parse, the selectors have drifted since `ps-collector` last ran — inspect the fixture and update `GAMELOOT_CONFIG.cardSelector` to match, then re-run.

- [ ] **Step 5: Commit**

```bash
git add src/node/scrapers/woocommerce.ts src/node/scrapers/stores/ src/node/tests/woocommerce.test.ts src/node/tests/fixtures/
git commit -m "feat(worker): vendor WooCommerce factory and four stores with a fixture test"
```

---

### Task 8: Vendor the remaining eight stores and the browser helper

**Files:**
- Create: `src/node/scrapers/browser.ts`
- Create: `src/node/scrapers/stores/gamenation.ts`, `gamestheshop.ts`, `dacby.ts`, `consolegarage.ts`, `cex.ts`, `playasia.ts`, `amazon.ts`, `flipkart.ts`
- Create: `src/node/scrapers/index.ts`
- Test: `src/node/tests/registry.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–7
- Produces: `ALL_SCRAPERS: Scraper[]`, `SOURCE_LABELS: Record<string, string>`, `getScraper(source: string): Scraper | undefined`

- [ ] **Step 1: Copy the eight stores and the browser helper**

```bash
cp "../ps-collector/src/server/scrapers/browser.ts" src/node/scrapers/browser.ts
for s in gamenation gamestheshop dacby consolegarage cex playasia amazon flipkart; do
  cp "../ps-collector/src/server/scrapers/stores/$s.ts" "src/node/scrapers/stores/$s.ts"
done
```

Fix relative imports and add `.ts` extensions as in Task 7. Copy only the eight store scrapers listed above — forum sources are out of scope.

- [ ] **Step 2: Write the registry**

`src/node/scrapers/index.ts` — same shape as `ps-collector/src/server/scrapers/index.ts`, minus the forum source, plus NXTGamerCode in Task 9. For now:

```ts
import type { Scraper } from './types.ts';
import { gameloot } from './stores/gameloot.ts';
import { gamenation } from './stores/gamenation.ts';
import { gamestheshop } from './stores/gamestheshop.ts';
import { e2zstore } from './stores/e2zstore.ts';
import { hgworld } from './stores/hgworld.ts';
import { dacby } from './stores/dacby.ts';
import { nekavo } from './stores/nekavo.ts';
import { consolegarage } from './stores/consolegarage.ts';
import { cex } from './stores/cex.ts';
import { playasia } from './stores/playasia.ts';
import { amazon } from './stores/amazon.ts';
import { flipkart } from './stores/flipkart.ts';

export const ALL_SCRAPERS: Scraper[] = [
  gameloot, gamenation, gamestheshop, e2zstore, hgworld, dacby,
  nekavo, consolegarage, cex, playasia, amazon, flipkart,
];

export const SOURCE_LABELS: Record<string, string> = {
  GameLoot: 'GameLoot',
  GameNation: 'GameNation',
  GamesTheShop: 'Games The Shop',
  E2ZStore: 'E2Z Store',
  HGWorld: 'HGWorld',
  Dacby: 'Dacby',
  Nekavo: 'Nekavo',
  ConsoleGarage: 'Console Garage',
  CexIndia: 'CeX India',
  PlayAsia: 'Play-Asia',
  AmazonIn: 'Amazon.in',
  Flipkart: 'Flipkart',
};

export function getScraper(source: string): Scraper | undefined {
  return ALL_SCRAPERS.find((s) => s.source === source);
}
```

- [ ] **Step 3: Write the registry test**

`src/node/tests/registry.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd src/node && npx tsc --noEmit && npm test
```

Expected: both clean. Typecheck failures here are almost always unfixed import paths from the copy.

- [ ] **Step 5: Commit**

```bash
git add src/node/scrapers/ src/node/tests/registry.test.ts
git commit -m "feat(worker): vendor remaining eight store scrapers and the registry"
```

---

### Task 9: NXTGamerCode scraper

The spec flags that `nxtgamercode.com` did not resolve during design. Verify before building.

**Files:**
- Create: `src/node/scrapers/stores/nxtgamercode.ts`
- Modify: `src/node/scrapers/index.ts`
- Modify: `docs/superpowers/specs/2026-07-25-multi-store-deal-hunter-design.md` (if the site is dead)

- [ ] **Step 1: Check whether the site is alive**

```bash
curl -s -o /dev/null -w "http=%{http_code} size=%{size_download}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" "https://nxtgamercode.com/?s=titanfall&post_type=product"
```

**If this returns a connection failure or a non-2xx status:** the site is dead. Skip to Step 4.

**If it returns 200:** continue to Step 2.

- [ ] **Step 2: Port the scraper as a WooCommerce config**

`gameScout` targets `nxtgamercode.com/?s=<query>&post_type=product`, which is the standard WooCommerce search shape, so it fits `makeWooScraper`. Read `../gameScout/functions/src/scrapers/nxtgamercode.ts` for its selectors and translate them into a `WooConfig`:

```ts
import { makeWooScraper, type WooConfig } from '../woocommerce.ts';

export const NXTGAMERCODE_CONFIG: WooConfig = {
  source: 'NXTGamerCode',
  baseUrl: 'https://nxtgamercode.com',
  searchUrl: (q: string) => `https://nxtgamercode.com/?s=${q}&post_type=product`,
  cardSelector: 'li.product, div.product',
  titleSelectors: ['h2.woocommerce-loop-product__title', '.product-title'],
  linkSelectors: ['a.woocommerce-LoopProduct-link', 'a'],
  imageSelectors: ['img'],
  priceContainer: '.price',
  outOfStockSelector: '.outofstock',
};

export const nxtgamercode = makeWooScraper(NXTGAMERCODE_CONFIG);
```

Adjust the selectors to match the live markup — capture a fixture as in Task 7 and confirm products parse.

- [ ] **Step 3: Register it and add a fixture test**

Add `nxtgamercode` to `ALL_SCRAPERS` and `NXTGamerCode: 'NXT Gamer Code'` to `SOURCE_LABELS`. Mirror the Task 7 fixture test for this store.

- [ ] **Step 4: If the site is dead, record it**

Do not register a broken scraper. Update the spec's "Open questions" to state the finding, and edit the Scrapers section to say NXTGamerCode was dropped, with the date and the observed status code.

- [ ] **Step 5: Run the tests**

```bash
cd src/node && npx tsc --noEmit && npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A src/node docs/superpowers/specs
git commit -m "feat(worker): add NXTGamerCode scraper"   # or "docs: drop NXTGamerCode, site is dead"
```

---

### Task 10: Database-free matching

`ps-collector`'s `matchListing()` calls `getDb()`. `scoreListing()` is pure and ports unchanged; the matcher around it is reimplemented over the JSON wishlist.

**Files:**
- Create: `src/node/matching/index.ts`
- Test: `src/node/tests/matching.test.ts`

**Interfaces:**
- Consumes: `WishlistGame`, `scoreListing` helpers from `lib/identity.ts`
- Produces:
  - `AUTO_THRESHOLD = 0.85`, `PENDING_THRESHOLD = 0.55`
  - `titleSimilarity(a: string, b: string): number`
  - `scoreListing(listingTitle: string, game: WishlistGame): number`
  - `matchListing(listingTitle: string, games: WishlistGame[]): { gameSlug: string | null; matchScore: number; matchStatus: 'auto' | 'pending' | 'unmatched' }`

- [ ] **Step 1: Write the failing test**

`src/node/tests/matching.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchListing, scoreListing, AUTO_THRESHOLD } from '../matching/index.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const game = (over: Partial<WishlistGame>): WishlistGame => ({
  slug: 'titanfall-2', title: 'Titanfall 2', platform: 'ps4',
  status: 'wanted', aliases: [], ...over,
});

const GAMES = [
  game({}),
  game({ slug: 'oblivion-remastered-deluxe', title: 'The Elder Scrolls IV: Oblivion Remastered Deluxe Edition', platform: 'ps5' }),
  game({ slug: 'oblivion-remastered', title: 'The Elder Scrolls IV: Oblivion Remastered', platform: 'ps5' }),
];

test('an exact title and platform match auto-matches', () => {
  const r = matchListing('Titanfall 2 (PS4)', GAMES);
  assert.equal(r.gameSlug, 'titanfall-2');
  assert.equal(r.matchStatus, 'auto');
});

test('an unrelated title is unmatched', () => {
  const r = matchListing('RGB Gaming Mouse Pad Large', GAMES);
  assert.equal(r.gameSlug, null);
  assert.equal(r.matchStatus, 'unmatched');
});

test('a base game never auto-matches a Deluxe listing', () => {
  const score = scoreListing(
    'The Elder Scrolls IV Oblivion Remastered Deluxe Edition PS5',
    game({ slug: 'oblivion-remastered', title: 'The Elder Scrolls IV: Oblivion Remastered', platform: 'ps5' })
  );
  assert.ok(score < AUTO_THRESHOLD, `edition mismatch scored ${score}`);
});

test('the wrong platform is penalised', () => {
  const ps4 = scoreListing('Titanfall 2 PS4', game({}));
  const ps5 = scoreListing('Titanfall 2 PS5', game({}));
  assert.ok(ps4 > ps5, `expected PS4 to beat PS5: ${ps4} vs ${ps5}`);
});

test('a mid-confidence match lands in the pending band', () => {
  const r = matchListing('Titanfall II', GAMES);
  assert.ok(['auto', 'pending'].includes(r.matchStatus));
  assert.equal(r.gameSlug, 'titanfall-2');
});

test('the best of several candidates wins', () => {
  const r = matchListing('Oblivion Remastered Deluxe Edition PS5', GAMES);
  assert.equal(r.gameSlug, 'oblivion-remastered-deluxe');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../matching/index.ts`

- [ ] **Step 3: Implement matching**

`src/node/matching/index.ts` — copy `titleSimilarity` and the body of `scoreListing` from `ps-collector/src/server/matching/index.ts` verbatim, changing only the game type and dropping the database:

```ts
import { detectPlatform, detectEditions, baseTitle } from '../lib/identity.ts';
import type { WishlistGame } from '../state/wishlist.ts';

export const AUTO_THRESHOLD = 0.85;
export const PENDING_THRESHOLD = 0.55;

/** Vendored unchanged from ps-collector/src/server/matching/index.ts:23. */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = a.split(' ').filter(Boolean);
  const tokensB = b.split(' ').filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap++;
  const tokenScore = (2 * overlap) / (setA.size + setB.size);

  // Character bigram score catches "witcher3" vs "witcher 3" style variants.
  const bigrams = (s: string) => {
    const flat = s.replace(/\s+/g, '');
    const out = new Map<string, number>();
    for (let i = 0; i < flat.length - 1; i++) {
      const bg = flat.slice(i, i + 2);
      out.set(bg, (out.get(bg) ?? 0) + 1);
    }
    return out;
  };
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  let bgOverlap = 0;
  let bgTotal = 0;
  for (const [bg, count] of bgA) {
    bgTotal += count;
    bgOverlap += Math.min(count, bgB.get(bg) ?? 0);
  }
  for (const count of bgB.values()) bgTotal += count;
  const bigramScore = bgTotal > 0 ? (2 * bgOverlap) / bgTotal : 0;

  return 0.5 * tokenScore + 0.5 * bigramScore;
}

/**
 * Weights: base-title similarity 0.65, platform agreement 0.2, edition overlap 0.15.
 * An edition mismatch is hard-capped below AUTO_THRESHOLD — a base game and its
 * Deluxe/GOTY release are different SKUs at very different prices.
 */
export function scoreListing(listingTitle: string, game: WishlistGame): number {
  const titleScore = titleSimilarity(baseTitle(listingTitle), baseTitle(game.title));
  if (titleScore < 0.35) return titleScore * 0.65;

  const listingPlatform = detectPlatform(listingTitle);
  let platformScore = 0.5;
  const expected = game.platform !== 'any' ? game.platform : null;
  if (listingPlatform) {
    platformScore = expected ? (listingPlatform === expected ? 1 : 0) : 1;
  }

  const listingEditions = new Set(detectEditions(listingTitle));
  const gameEditions = new Set(detectEditions(game.title));
  let editionScore: number;
  if (gameEditions.size === 0 && listingEditions.size === 0) {
    editionScore = 1;
  } else {
    let overlap = 0;
    for (const e of gameEditions) if (listingEditions.has(e)) overlap++;
    const union = new Set([...gameEditions, ...listingEditions]).size;
    editionScore = union > 0 ? overlap / union : 1;
  }

  const score = titleScore * 0.65 + platformScore * 0.2 + editionScore * 0.15;
  if (editionScore < 0.999) return Math.min(score, AUTO_THRESHOLD - 0.05);
  return score;
}

export interface MatchOutcome {
  gameSlug: string | null;
  matchScore: number;
  matchStatus: 'auto' | 'pending' | 'unmatched';
}

export function matchListing(listingTitle: string, games: WishlistGame[]): MatchOutcome {
  let best: { slug: string; score: number } | null = null;
  for (const game of games) {
    const score = scoreListing(listingTitle, game);
    if (!best || score > best.score) best = { slug: game.slug, score };
  }
  if (!best || best.score < PENDING_THRESHOLD) {
    return { gameSlug: null, matchScore: best?.score ?? 0, matchStatus: 'unmatched' };
  }
  return {
    gameSlug: best.slug,
    matchScore: best.score,
    matchStatus: best.score >= AUTO_THRESHOLD ? 'auto' : 'pending',
  };
}
```

Replace the `titleSimilarity` placeholder with the real vendored implementation before running tests.

- [ ] **Step 4: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, 6 new tests

- [ ] **Step 5: Commit**

```bash
git add src/node/matching/index.ts src/node/tests/matching.test.ts
git commit -m "feat(worker): database-free listing matcher over the JSON wishlist"
```

---

### Task 11: Event diffing and seed mode

**Files:**
- Create: `src/node/events/diff.ts`
- Test: `src/node/tests/diff.test.ts`

**Interfaces:**
- Consumes: `StoredListing`, `ListingsFile`, `PricePoint`, `WishlistGame`
- Produces:
  - `type DealEvent = { kind: 'new_listing' | 'price_drop' | 'restock' | 'price_rise' | 'gone'; key: string; source: string; listing: StoredListing; previousPricePaise: number | null; alert: boolean }`
  - `diffPass(input: { source: string; previous: ListingsFile; scraped: Array<{ key: string; listing: Omit<StoredListing, 'firstSeen' | 'lastSeen' | 'missedPasses'> }>; now: number; seed: boolean; ownedSlugs: Set<string> }): { next: ListingsFile; events: DealEvent[]; pricePoints: PricePoint[] }`

- [ ] **Step 1: Write the failing test**

`src/node/tests/diff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPass } from '../events/diff.ts';
import type { ListingsFile, StoredListing } from '../state/listings.ts';

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

const run = (opts: Partial<Parameters<typeof diffPass>[0]>) => diffPass({
  source: 'TestStore', previous: prevFile({}), scraped: [], now: NOW,
  seed: false, ownedSlugs: new Set<string>(), ...opts,
});

test('an unseen listing is a new_listing and alerts', () => {
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
    previous: prevFile({ k1: stored({ pricePaise: 60000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
  });
  assert.equal(events[0].kind, 'price_drop');
  assert.equal(events[0].previousPricePaise, 60000);
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
    previous: prevFile({ k1: stored({ pricePaise: 60000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
    ownedSlugs: new Set(['titanfall-2']),
  });
  assert.equal(events[0].kind, 'price_drop');
  assert.equal(events[0].alert, false);
});

test('pending matches are recorded but not live-alerted', () => {
  const { events } = run({
    scraped: [{ key: 'k1', listing: base({ matchStatus: 'pending', matchScore: 0.7 }) }],
  });
  assert.equal(events[0].alert, false);
});

test('an absent listing increments missedPasses and reports gone at three', () => {
  let previous = prevFile({ k1: stored({ missedPasses: 2 }) });
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
    previous: prevFile({ k1: stored({ pricePaise: 60000 }) }),
    scraped: [{ key: 'k1', listing: base({ pricePaise: 50000 }) }],
  });
  assert.deepEqual(pricePoints, [{ ts: NOW, key: 'k1', pricePaise: 50000, inStock: true }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../events/diff.ts`

- [ ] **Step 3: Implement the differ**

`src/node/events/diff.ts`:

```ts
import type { ListingsFile, StoredListing } from '../state/listings.ts';
import type { PricePoint } from '../state/prices.ts';

export type EventKind = 'new_listing' | 'price_drop' | 'restock' | 'price_rise' | 'gone';

export interface DealEvent {
  kind: EventKind;
  key: string;
  source: string;
  listing: StoredListing;
  previousPricePaise: number | null;
  /** Whether this goes to Discord live. Recorded-only events are false. */
  alert: boolean;
}

type ScrapedListing = Omit<StoredListing, 'firstSeen' | 'lastSeen' | 'missedPasses'>;

export interface DiffInput {
  source: string;
  previous: ListingsFile;
  scraped: Array<{ key: string; listing: ScrapedListing }>;
  now: number;
  /** Seed runs write state and emit nothing — first run, new source, state reset. */
  seed: boolean;
  ownedSlugs: Set<string>;
}

const GONE_AFTER_PASSES = 3;

export function diffPass(input: DiffInput): {
  next: ListingsFile;
  events: DealEvent[];
  pricePoints: PricePoint[];
} {
  const { source, previous, scraped, now, seed, ownedSlugs } = input;
  const events: DealEvent[] = [];
  const pricePoints: PricePoint[] = [];
  const nextListings: Record<string, StoredListing> = {};
  const seenKeys = new Set<string>();

  const alertable = (listing: StoredListing): boolean => {
    if (seed) return false;
    if (listing.matchStatus !== 'auto') return false;
    if (listing.gameSlug && ownedSlugs.has(listing.gameSlug)) return false;
    return true;
  };

  for (const { key, listing } of scraped) {
    seenKeys.add(key);
    const prior = previous.listings[key];
    const merged: StoredListing = {
      ...listing,
      firstSeen: prior?.firstSeen ?? now,
      lastSeen: now,
      missedPasses: 0,
    };
    nextListings[key] = merged;

    const push = (kind: EventKind, previousPricePaise: number | null, alert: boolean) =>
      events.push({ kind, key, source, listing: merged, previousPricePaise, alert });

    if (!prior) {
      push('new_listing', null, alertable(merged));
      pricePoints.push({ ts: now, key, pricePaise: merged.pricePaise, inStock: merged.inStock });
      continue;
    }

    const priceChanged = prior.pricePaise !== merged.pricePaise;
    const stockChanged = prior.inStock !== merged.inStock;
    if (priceChanged || stockChanged) {
      pricePoints.push({ ts: now, key, pricePaise: merged.pricePaise, inStock: merged.inStock });
    }

    if (priceChanged && merged.pricePaise !== null && prior.pricePaise !== null) {
      if (merged.pricePaise < prior.pricePaise) push('price_drop', prior.pricePaise, alertable(merged));
      else push('price_rise', prior.pricePaise, false);
    } else if (!prior.inStock && merged.inStock) {
      push('restock', prior.pricePaise, alertable(merged));
    }
  }

  for (const [key, prior] of Object.entries(previous.listings)) {
    if (seenKeys.has(key)) continue;
    const missedPasses = prior.missedPasses + 1;
    const carried: StoredListing = { ...prior, missedPasses };
    nextListings[key] = carried;
    if (missedPasses === GONE_AFTER_PASSES) {
      events.push({ kind: 'gone', key, source, listing: carried, previousPricePaise: prior.pricePaise, alert: false });
    }
  }

  return { next: { source, updatedAt: now, listings: nextListings }, events, pricePoints };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, 12 new tests

- [ ] **Step 5: Commit**

```bash
git add src/node/events/diff.ts src/node/tests/diff.test.ts
git commit -m "feat(worker): event diffing with seed mode and owned-game suppression"
```

---

### Task 12: Health tracking

**Files:**
- Create: `src/node/state/health.ts`
- Test: `src/node/tests/health.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonStable`, `HEALTH_PATH`, `ScrapeOutcome`
- Produces:
  - `type SourceHealth = { status: 'ok' | 'degraded' | 'broken'; consecutiveFailures: number; lastOkAt: number; lastError?: string }`
  - `type HealthFile = Record<string, SourceHealth>`
  - `updateHealth(current: HealthFile, source: string, outcomes: ScrapeOutcome[], now: number): { health: HealthFile; justBroke: boolean }`
  - `loadHealth(): Promise<HealthFile>`, `saveHealth(health: HealthFile): Promise<void>`

- [ ] **Step 1: Write the failing test**

`src/node/tests/health.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateHealth, type HealthFile } from '../state/health.ts';
import type { ScrapeOutcome } from '../scrapers/types.ts';

const NOW = 1_774_454_400_000;
const out = (over: Partial<ScrapeOutcome>): ScrapeOutcome => ({
  source: 'S', ok: true, pageHadContent: true, items: [], durationMs: 5, ...over,
});

test('a good pass resets the failure count', () => {
  const { health } = updateHealth({ S: { status: 'degraded', consecutiveFailures: 2, lastOkAt: 0 } }, 'S', [out({})], NOW);
  assert.equal(health.S.status, 'ok');
  assert.equal(health.S.consecutiveFailures, 0);
  assert.equal(health.S.lastOkAt, NOW);
});

test('a real page with zero matches counts as healthy', () => {
  const { health } = updateHealth({}, 'S', [out({ items: [], pageHadContent: true })], NOW);
  assert.equal(health.S.status, 'ok');
});

test('a populated page that parsed nothing counts as a failure', () => {
  const { health } = updateHealth({}, 'S', [out({ ok: true, pageHadContent: false, error: 'parse empty' })], NOW);
  assert.equal(health.S.consecutiveFailures, 1);
  assert.equal(health.S.status, 'degraded');
});

test('three consecutive failures mark the source broken', () => {
  let health: HealthFile = {};
  let justBroke = false;
  for (let i = 0; i < 3; i++) {
    ({ health, justBroke } = updateHealth(health, 'S', [out({ ok: false, pageHadContent: false, error: 'HTTP 500' })], NOW));
  }
  assert.equal(health.S.status, 'broken');
  assert.equal(justBroke, true, 'the third failure must report justBroke');
});

test('justBroke fires only on the transition, not on every later failure', () => {
  let health: HealthFile = {};
  for (let i = 0; i < 3; i++) {
    ({ health } = updateHealth(health, 'S', [out({ ok: false, pageHadContent: false })], NOW));
  }
  const { justBroke } = updateHealth(health, 'S', [out({ ok: false, pageHadContent: false })], NOW);
  assert.equal(justBroke, false);
});

test('one good outcome among several rescues the pass', () => {
  const { health } = updateHealth({}, 'S', [
    out({ ok: false, pageHadContent: false }),
    out({ ok: true, pageHadContent: true }),
  ], NOW);
  assert.equal(health.S.status, 'ok');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../state/health.ts`

- [ ] **Step 3: Implement health tracking**

`src/node/state/health.ts`:

```ts
import { readJson, writeJsonStable } from '../lib/serialize.ts';
import { HEALTH_PATH } from './paths.ts';
import type { ScrapeOutcome } from '../scrapers/types.ts';

export interface SourceHealth {
  status: 'ok' | 'degraded' | 'broken';
  consecutiveFailures: number;
  lastOkAt: number;
  lastError?: string;
}

export type HealthFile = Record<string, SourceHealth>;

const BROKEN_AFTER = 3;

/**
 * A source is healthy if any query in the pass returned a real page.
 *
 * pageHadContent is the load-bearing distinction: a site returning a real page
 * with zero matches is normal, while a parser finding nothing on a populated
 * page is breakage. A silently dead scraper is worse than no scraper.
 */
export function updateHealth(
  current: HealthFile,
  source: string,
  outcomes: ScrapeOutcome[],
  now: number
): { health: HealthFile; justBroke: boolean } {
  const prior = current[source] ?? { status: 'ok' as const, consecutiveFailures: 0, lastOkAt: 0 };
  const anyGood = outcomes.some((o) => o.ok && o.pageHadContent);

  if (anyGood) {
    return {
      health: { ...current, [source]: { status: 'ok', consecutiveFailures: 0, lastOkAt: now } },
      justBroke: false,
    };
  }

  const consecutiveFailures = prior.consecutiveFailures + 1;
  const status = consecutiveFailures >= BROKEN_AFTER ? 'broken' : 'degraded';
  const justBroke = status === 'broken' && prior.status !== 'broken';

  return {
    health: {
      ...current,
      [source]: {
        status,
        consecutiveFailures,
        lastOkAt: prior.lastOkAt,
        lastError: outcomes.find((o) => o.error)?.error ?? 'no successful fetch',
      },
    },
    justBroke,
  };
}

export const loadHealth = () => readJson<HealthFile>(HEALTH_PATH, {});
export const saveHealth = (health: HealthFile) => writeJsonStable(HEALTH_PATH, health);
```

- [ ] **Step 4: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, 6 new tests

- [ ] **Step 5: Commit**

```bash
git add src/node/state/health.ts src/node/tests/health.test.ts
git commit -m "feat(worker): per-source health tracking with broken-source detection"
```

---

### Task 13: Discord notifier

**Files:**
- Create: `src/node/discord/notify.ts`
- Test: `src/node/tests/notify.test.ts`

**Interfaces:**
- Consumes: `DealEvent`, `WishlistGame`, `PricePoint`, `formatPaise`, `SOURCE_LABELS`
- Produces:
  - `type PriceStats = { seenCount: number; lowPaise: number | null; highPaise: number | null; firstSeen: number | null }`
  - `computeStats(points: PricePoint[], key: string): PriceStats`
  - `buildEmbed(event: DealEvent, game: WishlistGame | undefined, stats: PriceStats): object`
  - `sendEvents(events: DealEvent[], lookup: (event: DealEvent) => { game?: WishlistGame; stats: PriceStats }): Promise<number>` — returns the number sent; mock mode when `DISCORD_WEBHOOK_URL` is unset
  - `sendBrokenSourceAlert(source: string, error: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

`src/node/tests/notify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, buildEmbed } from '../discord/notify.ts';
import type { DealEvent } from '../events/diff.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const NOW = 1_774_454_400_000;

const event: DealEvent = {
  kind: 'price_drop', key: 'k1', source: 'GameLoot', previousPricePaise: 369000, alert: true,
  listing: {
    title: 'Death Stranding 2 On The Beach PS5', url: 'https://gameloot.in/p/ds2', imageUrl: '',
    pricePaise: 343800, originalPricePaise: 519900, currency: 'INR', condition: 'new',
    inStock: true, gameSlug: 'death-stranding-2-on-the-beach', matchScore: 0.94,
    matchStatus: 'auto', firstSeen: NOW - 86400000, lastSeen: NOW, missedPasses: 0,
  },
};

const game: WishlistGame = {
  slug: 'death-stranding-2-on-the-beach', title: 'Death Stranding 2: On the Beach',
  platform: 'ps5', status: 'owned', paidPaise: 340000, condition: 'preowned', aliases: [],
};

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

test('the embed shows the current price and the previous price', () => {
  const embed = buildEmbed(event, game, computeStats([], 'k1')) as { title: string; description: string };
  assert.match(embed.description, /3,438/);
  assert.match(embed.description, /3,690/);
});

test('the embed states what was paid for an owned game', () => {
  const embed = buildEmbed(event, game, computeStats([], 'k1')) as { description: string };
  assert.match(embed.description, /paid/i);
  assert.match(embed.description, /3,400/);
});

test('the embed labels condition and source', () => {
  const embed = buildEmbed(event, game, computeStats([], 'k1')) as { description: string };
  assert.match(embed.description, /New/);
  assert.match(embed.description, /GameLoot/);
});

test('an unmatched listing still builds an embed', () => {
  const orphan = { ...event, listing: { ...event.listing, gameSlug: null } };
  const embed = buildEmbed(orphan, undefined, computeStats([], 'k1')) as { title: string };
  assert.ok(embed.title.length > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../discord/notify.ts`

- [ ] **Step 3: Implement the notifier**

`src/node/discord/notify.ts`:

```ts
import type { DealEvent } from '../events/diff.ts';
import type { PricePoint } from '../state/prices.ts';
import type { WishlistGame } from '../state/wishlist.ts';
import { formatPaise } from '../lib/money.ts';
import { SOURCE_LABELS } from '../scrapers/index.ts';

const COLOURS: Record<DealEvent['kind'], number> = {
  new_listing: 0x3498db,
  price_drop: 0x2ecc71,
  restock: 0xe67e22,
  price_rise: 0x95a5a6,
  gone: 0x7f8c8d,
};

/** Discord allows bursts, but 1s between posts keeps us clear of 429s. */
const THROTTLE_MS = 1000;

export interface PriceStats {
  seenCount: number;
  lowPaise: number | null;
  highPaise: number | null;
  firstSeen: number | null;
}

export function computeStats(points: PricePoint[], key: string): PriceStats {
  const mine = points.filter((p) => p.key === key && p.pricePaise !== null);
  if (mine.length === 0) return { seenCount: 0, lowPaise: null, highPaise: null, firstSeen: null };
  const prices = mine.map((p) => p.pricePaise as number);
  return {
    seenCount: mine.length,
    lowPaise: Math.min(...prices),
    highPaise: Math.max(...prices),
    firstSeen: Math.min(...mine.map((p) => p.ts)),
  };
}

export function buildEmbed(event: DealEvent, game: WishlistGame | undefined, stats: PriceStats): object {
  const l = event.listing;
  const lines: string[] = [];

  const price = formatPaise(l.pricePaise);
  const was = event.previousPricePaise !== null ? `  was ${formatPaise(event.previousPricePaise)}` : '';
  const mrp = l.originalPricePaise !== null ? `  MRP ${formatPaise(l.originalPricePaise)}` : '';
  lines.push(`**${price}**${was}${mrp}`);

  if (stats.seenCount > 0) {
    lines.push(`seen ${stats.seenCount}× · low ${formatPaise(stats.lowPaise)} · high ${formatPaise(stats.highPaise)}`);
  }
  if (game?.status === 'owned' && game.paidPaise) {
    lines.push(`you paid ${formatPaise(game.paidPaise)} ${game.condition ?? ''}`.trim());
  }
  if (game?.notes) lines.push(`_${game.notes}_`);

  const conditionLabel = l.condition === 'preowned' ? 'Pre-owned' : l.condition === 'new' ? 'New' : 'Condition unknown';
  const stock = l.inStock ? 'in stock' : 'out of stock';
  lines.push(`${conditionLabel} · ${SOURCE_LABELS[event.source] ?? event.source} · ${stock}`);
  if (l.currency !== 'INR') lines.push(`⚠️ listed in ${l.currency} — import, price is indicative`);
  if (l.matchStatus === 'pending') lines.push(`_match unconfirmed (${l.matchScore.toFixed(2)})_`);

  return {
    title: l.title.slice(0, 250),
    url: l.url,
    color: COLOURS[event.kind],
    description: lines.join('\n'),
    footer: { text: event.kind.replace('_', ' ') },
  };
}

async function post(payload: object): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log('[mock discord]', JSON.stringify(payload));
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) console.error(`discord POST failed: HTTP ${res.status}`);
}

export async function sendEvents(
  events: DealEvent[],
  lookup: (event: DealEvent) => { game?: WishlistGame; stats: PriceStats }
): Promise<number> {
  let sent = 0;
  for (const event of events.filter((e) => e.alert)) {
    const { game, stats } = lookup(event);
    await post({ embeds: [buildEmbed(event, game, stats)] });
    sent++;
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }
  return sent;
}

export async function sendBrokenSourceAlert(source: string, error: string): Promise<void> {
  await post({
    embeds: [{
      title: `⚠️ Scraper broken: ${SOURCE_LABELS[source] ?? source}`,
      color: 0xe74c3c,
      description: `Three consecutive failed passes.\n\`\`\`${error.slice(0, 500)}\`\`\``,
    }],
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, 7 new tests

- [ ] **Step 5: Commit**

```bash
git add src/node/discord/notify.ts src/node/tests/notify.test.ts
git commit -m "feat(worker): Discord embeds with inline price history"
```

---

### Task 14: Pass orchestrator and CLI entry point

**Files:**
- Create: `src/node/pass.ts`
- Create: `src/node/bin/stores.ts`
- Test: `src/node/tests/pass.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `runSource(scraper: Scraper, games: WishlistGame[], opts: { seed?: boolean; now?: number }): Promise<{ events: DealEvent[]; outcomes: ScrapeOutcome[] }>`, `runPass(opts: { only?: string[]; seed?: boolean }): Promise<{ sources: number; events: number; alerts: number }>`

- [ ] **Step 1: Write the failing test**

`src/node/tests/pass.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSource } from '../pass.ts';
import type { Scraper, ScrapeOutcome } from '../scrapers/types.ts';
import type { WishlistGame } from '../state/wishlist.ts';

const GAMES: WishlistGame[] = [
  { slug: 'titanfall-2', title: 'Titanfall 2', platform: 'ps4', status: 'wanted', aliases: [] },
];

const fakeScraper = (items: string[], source = `Fake${process.pid}`): Scraper => ({
  source,
  tier: 'reliable',
  async search(query: string): Promise<ScrapeOutcome> {
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

test('a seed run produces no alertable events', async () => {
  const { events } = await runSource(fakeScraper(['Titanfall 2 PS4'], `Seed${process.pid}`), GAMES, { seed: true });
  assert.equal(events.filter((e) => e.alert).length, 0);
});

test('irrelevant scraper output is discarded by the relevance guard', async () => {
  const { events, outcomes } = await runSource(
    fakeScraper(["Let's Try Desi Spicy Wafers"], `Junk${process.pid}`),
    GAMES,
    { seed: true }
  );
  assert.equal(events.length, 0);
  assert.equal(outcomes.every((o) => !o.pageHadContent), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../pass.ts`

- [ ] **Step 3: Implement the orchestrator**

`src/node/pass.ts`:

```ts
import { ALL_SCRAPERS } from './scrapers/index.ts';
import type { Scraper, ScrapeOutcome } from './scrapers/types.ts';
import { guardOutcome } from './scrapers/relevance.ts';
import { normalizeUrl } from './scrapers/fetch.ts';
import { loadWishlist, searchQueries, type WishlistGame } from './state/wishlist.ts';
import { listingKey, loadListings, saveListings, type StoredListing } from './state/listings.ts';
import { appendPrices, readPrices } from './state/prices.ts';
import { loadHealth, saveHealth, updateHealth } from './state/health.ts';
import { matchListing } from './matching/index.ts';
import { diffPass, type DealEvent } from './events/diff.ts';
import { computeStats, sendEvents, sendBrokenSourceAlert } from './discord/notify.ts';

export async function runSource(
  scraper: Scraper,
  games: WishlistGame[],
  opts: { seed?: boolean; now?: number } = {}
): Promise<{ events: DealEvent[]; outcomes: ScrapeOutcome[] }> {
  const now = opts.now ?? Date.now();
  const previous = await loadListings(scraper.source);
  // A source with no prior state is always seeded, so a first run can never flood.
  const seed = opts.seed ?? Object.keys(previous.listings).length === 0;

  const outcomes: ScrapeOutcome[] = [];
  const byKey = new Map<string, { key: string; listing: Omit<StoredListing, 'firstSeen' | 'lastSeen' | 'missedPasses'> }>();

  for (const game of games) {
    for (const query of searchQueries(game)) {
      const outcome = guardOutcome(await scraper.search(query), query);
      outcomes.push(outcome);
      for (const item of outcome.items) {
        const identity = item.keyHint ?? normalizeUrl(item.url);
        const key = listingKey(scraper.source, identity);
        if (byKey.has(key)) continue;
        const match = matchListing(item.title, games);
        byKey.set(key, {
          key,
          listing: {
            title: item.title, url: item.url, imageUrl: item.imageUrl,
            pricePaise: item.pricePaise, originalPricePaise: item.originalPricePaise,
            currency: item.currency, condition: item.condition, inStock: item.inStock,
            gameSlug: match.gameSlug, matchScore: match.matchScore, matchStatus: match.matchStatus,
          },
        });
      }
    }
  }

  const ownedSlugs = new Set(games.filter((g) => g.status === 'owned').map((g) => g.slug));
  const { next, events, pricePoints } = diffPass({
    source: scraper.source, previous, scraped: [...byKey.values()], now, seed, ownedSlugs,
  });

  await saveListings(next);
  await appendPrices(scraper.source, pricePoints);

  const health = await loadHealth();
  const { health: nextHealth, justBroke } = updateHealth(health, scraper.source, outcomes, now);
  await saveHealth(nextHealth);
  if (justBroke) {
    await sendBrokenSourceAlert(scraper.source, nextHealth[scraper.source].lastError ?? 'unknown');
  }

  return { events, outcomes };
}

export async function runPass(
  opts: { only?: string[]; seed?: boolean } = {}
): Promise<{ sources: number; events: number; alerts: number }> {
  const games = await loadWishlist();
  const scrapers = opts.only?.length
    ? ALL_SCRAPERS.filter((s) => opts.only!.includes(s.source))
    : ALL_SCRAPERS;

  // Sources run in parallel; queries within a source stay sequential so the
  // per-host politeness delay in fetch.ts actually applies.
  const results = await Promise.all(
    scrapers.map(async (scraper) => {
      try {
        return await runSource(scraper, games, { seed: opts.seed });
      } catch (error) {
        console.error(`[${scraper.source}] pass failed:`, error);
        return { events: [] as DealEvent[], outcomes: [] as ScrapeOutcome[] };
      }
    })
  );

  const events = results.flatMap((r) => r.events);
  const bySource = new Map<string, Awaited<ReturnType<typeof readPrices>>>();
  for (const source of new Set(events.map((e) => e.source))) {
    bySource.set(source, await readPrices(source));
  }
  const gameBySlug = new Map(games.map((g) => [g.slug, g]));

  const alerts = await sendEvents(events, (event) => ({
    game: event.listing.gameSlug ? gameBySlug.get(event.listing.gameSlug) : undefined,
    stats: computeStats(bySource.get(event.source) ?? [], event.key),
  }));

  return { sources: scrapers.length, events: events.length, alerts };
}
```

- [ ] **Step 4: Write the CLI entry point**

`src/node/bin/stores.ts`:

```ts
#!/usr/bin/env -S npx tsx
import { runPass } from '../pass.ts';

const args = process.argv.slice(2);
const seed = args.includes('--seed');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1]?.split(',') : undefined;

const summary = await runPass({ seed, only });
console.log(`sources=${summary.sources} events=${summary.events} alerts=${summary.alerts}`);
```

- [ ] **Step 5: Run the tests, then a real seed pass against one source**

```bash
cd src/node && npm test
npx tsx bin/stores.ts --seed --only GameLoot
```

Expected: tests PASS. The seed run prints a summary with `alerts=0` and creates `state/listings/gameloot.json`. Confirm the file exists and contains listings:

```bash
head -30 ../../state/listings/gameloot.json
```

If it has zero listings, the scraper is returning nothing — check `state/health.json` for the recorded error before assuming the orchestrator is wrong.

- [ ] **Step 6: Commit**

```bash
git add src/node/pass.ts src/node/bin/stores.ts src/node/tests/pass.test.ts
git commit -m "feat(worker): pass orchestrator with automatic seeding on first run"
```

---

### Task 15: State commit script

**Files:**
- Create: `scripts/commit-state.sh`

- [ ] **Step 1: Write the script**

`scripts/commit-state.sh`:

```bash
#!/usr/bin/env bash
# Commit state back to the repo. Safe to run concurrently with other workflows:
# each writes a disjoint set of files, so resetting onto the remote tip can
# never drop another job's work.
set -euo pipefail

BRANCH="${1:-main}"
MESSAGE="${2:-chore(state): update scraped state}"

git config user.name "deal-hunter-bot"
git config user.email "actions@users.noreply.github.com"

if git diff --quiet -- state/; then
  echo "no state changes"
  exit 0
fi

for attempt in 1 2 3; do
  git add state/
  git commit -q -m "$MESSAGE" || true

  # Shallow clones cannot rebase, so re-point at the remote tip and re-apply.
  git fetch --depth=1 origin "$BRANCH"
  git reset --soft FETCH_HEAD
  git add state/
  git commit -q -m "$MESSAGE" || { echo "nothing to commit"; exit 0; }

  if git push origin "HEAD:$BRANCH"; then
    echo "state pushed on attempt $attempt"
    exit 0
  fi
  echo "push rejected, retrying ($attempt/3)"
  sleep $((attempt * 5))
done

echo "failed to push state after 3 attempts" >&2
exit 1
```

- [ ] **Step 2: Make it executable and verify it no-ops on a clean tree**

```bash
chmod +x scripts/commit-state.sh
bash scripts/commit-state.sh main "test"
```

Expected: prints `no state changes` and exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/commit-state.sh
git commit -m "feat(ci): state commit script with shallow-clone-safe retries"
```

---

### Task 16: The stores workflow

**Files:**
- Create: `.github/workflows/stores.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/stores.yml`:

```yaml
name: Store Scrapers

# schedule and workflow_dispatch only. Never pull_request or
# pull_request_target — this repo is public, and a fork PR must never be able
# to run with repository secrets in scope.
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
    inputs:
      seed:
        description: 'Seed state without sending alerts'
        type: boolean
        default: false
      only:
        description: 'Comma-separated source names, blank for all'
        type: string
        default: ''

permissions:
  contents: write

concurrency:
  group: stores
  cancel-in-progress: false

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: src/node/package-lock.json

      - name: Install dependencies
        working-directory: src/node
        run: npm ci

      - name: Install Playwright chromium
        working-directory: src/node
        run: npx playwright install --with-deps chromium

      - name: Run store pass
        working-directory: src/node
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
        run: |
          ARGS=""
          if [ "${{ inputs.seed }}" = "true" ]; then ARGS="$ARGS --seed"; fi
          if [ -n "${{ inputs.only }}" ]; then ARGS="$ARGS --only ${{ inputs.only }}"; fi
          npx tsx bin/stores.ts $ARGS

      - name: Commit state
        run: bash scripts/commit-state.sh main "chore(state): store pass $(date -u +%Y-%m-%dT%H:%MZ)"
```

- [ ] **Step 2: Validate the YAML parses**

```bash
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/stores.yml')); print('yaml ok')"
```

Expected: `yaml ok`

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/stores.yml
git commit -m "feat(ci): 6-hourly store scraper workflow"
git push
```

- [ ] **Step 4: Trigger a seed run and confirm it is silent**

```bash
gh workflow run stores.yml -f seed=true -f only=GameLoot
sleep 20 && gh run list --workflow stores.yml --limit 1
```

Then watch it and inspect the result:

```bash
gh run watch --exit-status
git pull && cat state/health.json
```

Expected: the run succeeds, `state/listings/gameloot.json` is committed, and no Discord messages arrive because `--seed` suppresses alerts.

**Do not run a non-seed pass across all sources until every source has been seeded once.** The automatic seeding in `runSource` protects against this, but confirm `state/listings/` has a file per source before relying on it.

---

### Task 17: Pruning

**Files:**
- Create: `src/node/state/prune.ts`
- Modify: `src/node/pass.ts`
- Test: `src/node/tests/prune.test.ts`

**Interfaces:**
- Consumes: `ListingsFile`
- Produces: `pruneListings(file: ListingsFile, now: number, maxAgeDays?: number): ListingsFile`

- [ ] **Step 1: Write the failing test**

`src/node/tests/prune.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneListings } from '../state/prune.ts';
import type { ListingsFile, StoredListing } from '../state/listings.ts';

const NOW = 1_774_454_400_000;
const DAY = 86_400_000;

const listing = (over: Partial<StoredListing>): StoredListing => ({
  title: 't', url: 'https://x.test/1', imageUrl: '', pricePaise: 100,
  originalPricePaise: null, currency: 'INR', condition: 'unknown', inStock: true,
  gameSlug: null, matchScore: 0, matchStatus: 'unmatched',
  firstSeen: NOW - 90 * DAY, lastSeen: NOW, missedPasses: 0, ...over,
});

const file = (listings: Record<string, StoredListing>): ListingsFile => ({
  source: 'S', updatedAt: NOW, listings,
});

test('a listing gone longer than 30 days is dropped', () => {
  const out = pruneListings(file({ old: listing({ missedPasses: 5, lastSeen: NOW - 31 * DAY }) }), NOW);
  assert.equal(Object.keys(out.listings).length, 0);
});

test('a currently-present listing is kept regardless of age', () => {
  const out = pruneListings(file({ live: listing({ missedPasses: 0, lastSeen: NOW }) }), NOW);
  assert.equal(Object.keys(out.listings).length, 1);
});

test('a recently-gone listing is kept', () => {
  const out = pruneListings(file({ recent: listing({ missedPasses: 4, lastSeen: NOW - 5 * DAY }) }), NOW);
  assert.equal(Object.keys(out.listings).length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/node && npm test
```

Expected: FAIL — cannot find `../state/prune.ts`

- [ ] **Step 3: Implement pruning**

`src/node/state/prune.ts`:

```ts
import type { ListingsFile } from './listings.ts';

const DAY_MS = 86_400_000;

/**
 * Drop listings that have been gone for longer than maxAgeDays. Their price
 * history survives in the JSONL, which is never pruned in place — only the
 * current snapshot is bounded.
 */
export function pruneListings(file: ListingsFile, now: number, maxAgeDays = 30): ListingsFile {
  const cutoff = now - maxAgeDays * DAY_MS;
  const listings = Object.fromEntries(
    Object.entries(file.listings).filter(
      ([, listing]) => listing.missedPasses < 3 || listing.lastSeen >= cutoff
    )
  );
  return { ...file, listings };
}
```

- [ ] **Step 4: Wire it into the pass**

In `src/node/pass.ts`, add the import and prune before saving:

```ts
import { pruneListings } from './state/prune.ts';
```

```ts
  await saveListings(pruneListings(next, now));
```

- [ ] **Step 5: Run the tests**

```bash
cd src/node && npm test
```

Expected: PASS, all suites

- [ ] **Step 6: Commit**

```bash
git add src/node/state/prune.ts src/node/pass.ts src/node/tests/prune.test.ts
git commit -m "feat(worker): prune long-gone listings from the current snapshot"
```

---

### Task 18: Secret audit and repository visibility

The final gate before the repo goes public. History persists after the flip, so this cannot be deferred.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Scan the full history for secrets**

```bash
git log -p --all | grep -a -n -i -E "discord\.com/api/webhooks|client_secret|[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}" | head -40
```

Expected: no matches. **If anything is found, stop.** Do not delete the file and continue — the blob stays reachable. Either rewrite history with `git filter-repo` before the repo is ever public, or start a fresh repo. Rotate the exposed credential either way and treat it as burned.

- [ ] **Step 2: Confirm no inlined credentials in the working tree**

```bash
grep -rn -E "https://discord(app)?\.com/api/webhooks/[0-9]" --include="*.py" --include="*.ts" --include="*.yml" . | grep -v node_modules
```

Expected: no matches. Every reference should be `process.env.DISCORD_WEBHOOK_URL` or `${{ secrets.DISCORD_WEBHOOK_URL }}`.

- [ ] **Step 3: Verify no workflow uses a fork-reachable trigger**

```bash
grep -n -E "pull_request|pull_request_target" .github/workflows/*.yml
```

Expected: no matches.

- [ ] **Step 4: Rotate credentials**

Regenerate the Discord webhook and update the GitHub Secret. This repository starts from a fresh history with no prior credential exposure, so this is precautionary.

- [ ] **Step 5: Document the setup in the README**

Add a section covering: the three state directories and what writes them, the `--seed` flag and when it is required, how to run one source locally (`npx tsx bin/stores.ts --only GameLoot --seed`), and the required secrets.

- [ ] **Step 6: Make the repository public**

This is the user's decision to execute, not the implementer's. Confirm explicitly before running:

```bash
gh repo edit --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: worker setup, seeding and required secrets"
```

---

## Verification

After all tasks, confirm the whole phase:

```bash
cd src/node && npx tsc --noEmit && npm test
```

Expected: typecheck clean, all suites pass.

```bash
gh workflow run stores.yml
gh run watch --exit-status
git pull
ls state/listings/ && cat state/health.json
```

Expected: a file per registered source in `state/listings/`, every source `ok` in `state/health.json`, and Discord alerts only for genuine events on already-seeded sources.

## Phases 2–4

Written as separate plans once these interfaces exist:

- **Phase 2 — quick-commerce and e-commerce expansion.** Additional storefronts beyond the current 12, using the contracts from Tasks 3 and 11 unchanged. Each new source is a `Scraper` in the registry and a new pair of partitioned state files.
- **Phase 3 — Digest workflow.** Daily 03:30 UTC job reading all sources, reporting `pending` matches and recorded-but-unalerted events.
- **Phase 4 — ps-collector sync.** Import script reading committed state from `raw.githubusercontent.com` into the existing SQLite schema; local worker disabled.
