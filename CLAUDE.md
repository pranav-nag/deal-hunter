# CLAUDE.md

Guidance for Claude Code working in this repository.

Read [`RESUME.md`](RESUME.md) first for current status and what is already
decided. This file covers how to work here without breaking things.

## What this is

A Node/TypeScript worker that scrapes 12 Indian game storefronts on a 6-hourly
GitHub Actions cron, matches results against a wishlist, and posts price events
to Discord. State is committed JSON in this repo. There is no server and no
database — git is the database.

## Commands

```bash
cd src/node && npm install
```

```bash
cd src/node && npx tsc --noEmit && npm test
```

```bash
cd src/node && npx tsx bin/stores.ts --only GameLoot --seed
```

```bash
cd src/node && npx tsx bin/digest.ts
```

The digest reads committed state and posts; it writes nothing, which is why it
can run on its own schedule without colliding with a scrape pass.

`--seed` writes state and emits nothing. `--only A,B` limits sources. Both
omitted means a full live pass across every source.

Always run **both** `tsc --noEmit` and `npm test` before claiming work is done.
The test runner does not typecheck, and tsx strips types without checking them,
so tests alone will happily pass on code that does not compile.

## Invariants — do not break these

- **Money is integer paise** (₹1 = 100 paise). Never floats, never rupees in a
  variable. Parse and format only through `src/node/lib/money.ts`.
- **Timestamps are integer unix ms, UTC.**
- **All state JSON goes through `writeJsonStable()`.** Sorted keys, 2-space
  indent, trailing newline. Never `JSON.stringify` into a state file. Every pass
  rewrites these files in full and commits them; unsorted output turns every run
  into a whole-file diff.
- **`state/prices/<source>.jsonl` is append-only.** Never rewritten in place.
- **State is partitioned per source.** One `listings/<source>.json` and one
  `prices/<source>.jsonl` per source, and no job writes another's files. This is
  what makes concurrent workflow runs safe without locking.
- **Scrapers must never throw.** Every failure path returns a `ScrapeOutcome`
  with `ok: false`. A thrown scraper takes down the whole pass.
- **No secrets in code.** `DISCORD_WEBHOOK_URL` and the optional
  `DISCORD_DIGEST_WEBHOOK_URL` come from the environment only; unset means mock
  mode (prints to stdout). The digest webhook falls back to the deals one.

## Vendored code

`src/node/lib/identity.ts` and `src/node/lib/money.ts` were vendored verbatim
from a separate `ps-collector` project. **Do not edit them.** If their behaviour
is wrong, fix it in the layer above and leave a comment saying why.

Worked example already in the tree: `detectPlatform` has no PS3 pattern and
returns `''`, which the scorer read as "platform unstated" rather than "wrong
platform" — a PS3 disc auto-matched a PS4 wishlist entry and would have alerted.
The fix is `LEGACY_PLATFORM` in `src/node/matching/index.ts`, not a change to
`identity.ts`.

If a vendored characterisation test fails, fix the *test* to match the vendored
behaviour and note the difference. Do not change the vendored logic.

## Adding a scraper

1. Write a `Scraper`: `{ source, tier, search(query) }` returning a
   `ScrapeOutcome`. WooCommerce storefronts need only a `WooConfig` passed to
   `makeWooScraper`.
2. Register in `ALL_SCRAPERS` and add a `SOURCE_LABELS` entry.
3. **Capture a real fixture** into `src/node/tests/fixtures/` and assert products
   parse out of it. A parser with no fixture fails silently when markup drifts.
4. Seed it once: `--seed --only <Source>`.

Matching, diffing, health, pruning and Discord are source-agnostic. Adding a
source should require no change to any of them.

## Alerting

Three layers stand between a scraped listing and the user's phone. Adding a
fourth kind of alert means passing it through all three, not around them.

- **The gate** (`src/node/events/gate.ts`) decides whether one listing is worth
  an interruption: wanted, in stock, priced in INR, condition allowed, at or
  under `targetPaise`, and at least 5% better than whatever we last alerted for
  that listing. Pure and total — it returns a `GateReason` even when it passes,
  because the digest explains why things stayed quiet.
- **`conditionPolicy: 'sealed-only'`** is not a preference. It marks the titles
  whose value sits in a one-time code, where a cheap used listing is a trap. It
  rejects `unknown` condition as well as `preowned`; under a price-only rule
  those listings would be the *loudest* alerts sent.
- **The circuit breaker** (`src/node/events/breaker.ts`) judges the pass, not the
  listing. Over 8 alerts, or one source re-reporting over half its catalogue as
  new, means listing keys changed — every alert individually valid, the batch
  obviously wrong. It suppresses and posts one summary. Suppressed events are
  still recorded in state and still appear in the digest.

`lastAlertedPricePaise` is written by `recordAlerts()` *after* Discord accepts
the message, never at diff time. Recording earlier would mark breaker-suppressed
deals as already-announced and mute them permanently. A failed send therefore
re-alerts next pass, which is the right failure direction.

A wanted game with no `targetPaise` can never alert. `gamesMissingTarget()`
reports these on every pass and in the digest — otherwise a missing target reads
as "no deals" rather than as a config gap.

## Two things that are load-bearing, not decoration

- **`pageHadContent`** distinguishes "site returned a real page with zero
  matches" (normal) from "parser found nothing on a populated page" (breakage).
  Health tracking depends on the split. Get it wrong and a dead scraper looks
  healthy forever.
- **The relevance guard** (`src/node/scrapers/relevance.ts`) rejects a populated
  but unrelated page. Silent wrong data is worse than a missing source, because
  it writes wrong prices into permanent append-only history while reporting
  success.

## Politeness and robots.txt

`fetch.ts` gates both `fetchHtml` and `fetchJson` on `robots.txt`, matching rules
over path **and** query with `*` and trailing-`$` wildcards, plus a 1.5s jittered
per-host delay. Do not add a network path that bypasses the gate.

Host exceptions live in `ROBOTS_OVERRIDES` in `src/node/scrapers/robots.ts`, each
with its reason inline. Never make a host work by weakening the matcher — that
hides the exception instead of recording it.

## Tests

`node:test`, run via `node --test --import tsx tests/*.test.ts`.

Tests that write real state **must clean up after themselves**. Note that
`state/health.json` is a single shared file, so prune your key rather than
deleting the file. Do not key scratch state on `process.pid` without truncating
first — pids get recycled and the append-only store then accumulates across runs.

## Security

Public repo. That has consequences:

- Workflows run on **`schedule` and `workflow_dispatch` only**. Never
  `pull_request_target`, and never `pull_request` with secrets in scope.
- `workflow_dispatch` inputs are passed **through the environment**, never
  interpolated into a shell line.
- `GITHUB_TOKEN` gets `permissions: { contents: write }` and nothing else.
- Never import git history from another repository into this one.

## Line endings

`.gitattributes` pins LF for `state/`, `src/node/` and `scripts/`. Leave it
alone. Without it a Windows checkout with `core.autocrlf=true` rewrites every
state file on every pass and rewrites the append-only price history end to end.
