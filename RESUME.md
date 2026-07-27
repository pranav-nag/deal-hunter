# Resume Here

Context for picking this project up in a fresh session. Read this first, then
[`README.md`](README.md) for how to run it, then the spec for why it is shaped
this way.

**Last updated:** 2026-07-27

---

## What this project is

A Node/TypeScript worker that scrapes 12 Indian game storefronts on a 6-hourly
GitHub Actions cron, matches results against a 35-game wishlist, and posts price
events to Discord. All state is committed JSON in this repo — no server, no
database, no always-on machine.

It was extracted from a private repo that also hosts an unrelated Python bot.
**That project is not part of this one and should not be referenced here.** The
scrapers were vendored from a local `ps-collector` project (Next.js + SQLite)
which only ran on localhost; this repo is the always-on replacement.

## Current status: phase 1 complete, phase 3 built

Everything below is built, tested and committed.

| Area | File | State |
|---|---|---|
| Deterministic JSON serializer | `src/node/lib/serialize.ts` | done |
| Wishlist + state paths | `src/node/state/{wishlist,paths}.ts` | done |
| Listings + append-only prices | `src/node/state/{listings,prices}.ts` | done |
| Vendored identity/money helpers | `src/node/lib/{identity,money}.ts` | done, unmodified |
| robots.txt + fetch layer | `src/node/scrapers/{robots,fetch}.ts` | done |
| Relevance guard | `src/node/scrapers/relevance.ts` | done |
| 12 store scrapers + registry | `src/node/scrapers/` | done |
| Matcher | `src/node/matching/index.ts` | done |
| Event diffing + seed mode | `src/node/events/diff.ts` | done |
| Health tracking | `src/node/state/health.ts` | done |
| Discord notifier | `src/node/discord/notify.ts` | done |
| Pass orchestrator + CLI | `src/node/pass.ts`, `src/node/bin/stores.ts` | done |
| Pruning | `src/node/state/prune.ts` | done |
| State commit script | `scripts/commit-state.sh` | done |
| Workflow | `.github/workflows/stores.yml` | written and YAML-validated |
| Alert gate | `src/node/events/gate.ts` | done |
| Circuit breaker | `src/node/events/breaker.ts` | done |
| Daily digest + workflow | `src/node/digest/`, `.github/workflows/digest.yml` | done, **never run in CI** |

**Verification as of last session:** `npx tsc --noEmit` clean, `npm test` 149
passing, 0 failing.

**Live proof it works:** `npx tsx bin/stores.ts --seed --only GameLoot` returned
`sources=1 events=180 alerts=0` and wrote 180 listings (52 auto-matched,
99 pending, 25 unmatched), health `ok`. That seeded state is committed.

## The alert flood, and what fixed it (2026-07-27)

The first live pass across the 11 newly-seeded sources flooded Discord. Seed
suppression covered run 1; run 2 then emitted `new_listing` for everything the
seed pass had not happened to return.

The root cause was not seeding. The alert rule was "matched, and not a game we
own" — no price check at all, so a ₹4,999 Horizon alerted identically to a
₹1,450 one, once per store, one HTTP POST per event.

Replaying the committed 180-listing GameLoot catalogue as if every listing were
new — the exact flood shape — measures each layer:

| Stage | Messages |
|---|---|
| Old rule | 23 (from one store) |
| After the gate | 2 |
| After grouping by game | 2 embeds |
| After the circuit breaker | 0 sent, 1 summary — correctly read 180/180 new as key churn |

The two survivors were Horizon Zero Dawn Remastered at ₹1,399 against a ₹1,699
target and Clair Obscur sealed at ₹3,199 against ₹3,500. Both are real buys.

See the Alerting section of [`CLAUDE.md`](CLAUDE.md) for how the three layers
work and which rules must not be routed around.

## Immediate next steps

1. **Create the GitHub repo and push.** Nothing has been pushed yet.
2. **Add the `DISCORD_WEBHOOK_URL` secret** in repo Settings → Secrets and
   variables → Actions. Without it the workflow runs in mock mode and posts
   nothing. Add **`DISCORD_DIGEST_WEBHOOK_URL`** too, pointed at a second,
   notifications-off channel — that is what keeps the deals channel to buy
   alerts only. Unset, digest and system messages fall back to the deals
   webhook and the separation is lost.
3. **Seed the remaining 11 sources before any live pass.** Run the workflow with
   `seed=true`, once per source or all at once:
   ```
   gh workflow run stores.yml -f seed=true
   ```
   Then confirm `state/listings/` has a file per source. `runSource` seeds
   automatically for a source with no prior state, so this is belt-and-braces,
   but check rather than assume.
4. **Watch the first non-seed run.** Expect a small number of alerts. If it
   floods, something did not seed.
5. Only then consider making the repo public (see Security below).

## Known issues and open items

- **Only GameLoot has ever run.** The other 11 scrapers are vendored and
  typecheck, but have never executed against their live sites in this repo.
  Expect some to need selector fixes. `state/health.json` will show `degraded` /
  `broken` and Discord gets a broken-source alert after 3 consecutive failures.
- **Match quality is mediocre by design.** In the GameLoot seed, 99 of 180 were
  `pending` — recorded but never alerted. Wrong-platform and wrong-edition
  listings land here on purpose. The daily digest surfaces them for confirmation.

- **Two wanted games still have no `targetPaise`** and therefore cannot alert:
  `the-last-of-us-part-2` and `fallout-4-goty`. Neither appears in §7 of the
  collection doc. They are reported on every pass and in the digest rather than
  going quietly silent. Set a target or drop them.

- **The wishlist disagreed with the collection doc and now follows it.** The doc
  records The Evil Within (₹1,100) and Fallout 4 (₹1,400) as bought; the wishlist
  had The Evil Within as `wanted` and no Fallout 4 base entry at all. Both are
  now `owned`, so the counts are 21 owned / 15 wanted, not 19 / 16. A
  wanted-but-owned game alerts on deals for something already on the shelf.
- **Console bundles can auto-match.** A PS4 console bundle *including* MGSV
  matched at 0.854 and would alert at hardware pricing. Not fixed. Consider a
  price-sanity check or a bundle-token penalty in the matcher.
- **No fixture tests for the 11 unrun scrapers.** Only GameLoot has one
  (`src/node/tests/fixtures/gameloot-search.html`). Add one per source as you
  bring each online — a parser with no fixture fails silently later.
- **`playwright install --with-deps chromium` runs every workflow pass.** Adds
  ~1-2 min. Worth caching or dropping if no enabled source actually needs a
  browser.

## Decisions already taken — do not re-litigate

- **NXTGamerCode dropped (2026-07-25).** Domain expired: HTTPS fails the TLS
  handshake, HTTP returns a registrar parking page titled "Your domain is
  expired". Verified, recorded in the spec. 12 stores, not 13.
- **GameLoot robots.txt override.** Its `Disallow: /?s=` covers the only search
  endpoint the storefront exposes. Operator chose to scrape it anyway; the
  exception is explicit in `ROBOTS_OVERRIDES` with the reasoning inline, rather
  than hidden behind a permissive matcher. Everything else is enforced for real.
- **Forum/social sources are out of scope.** Storefronts only.
- **Vendored `lib/identity.ts` and `lib/money.ts` are not to be edited.** Fixes
  go in the layer above — see the platform fix below for the pattern.

## Traps that already bit once

Each of these was a real bug found during phase 1. They are fixed; this is so
they are not reintroduced.

- **Relevance guard failing open.** `ps5` is itself a stopword, so a bare `ps5`
  query tokenised to nothing and `isRelevant` returned `true` for anything —
  disabling the guard for exactly the generic query it existed to catch. It now
  falls back to unfiltered tokens.
- **robots.txt matcher ignoring the query string.** It compared `pathname` only
  and had no wildcard support, so every query-string rule was invisible. Rules
  are prefix-matched over path+query with `*` and trailing `$`.
- **Wrong-platform auto-match.** `detectPlatform` has no PS3/PS2/Wii patterns and
  returns `''`, which the scorer read as "platform not stated" (neutral 0.5)
  instead of "wrong platform" (0). A PS3 disc auto-matched a PS4 wishlist entry
  at 0.90 and would have alerted. Fixed via `LEGACY_PLATFORM` in the matcher.
- **CRLF destroying the stable serializer.** With `core.autocrlf=true`, committed
  LF state checked out as CRLF and every pass rewrote every file — including the
  append-only price history, end to end. `.gitattributes` pins LF. Keep it.
- **Flaky price test.** It keyed scratch state on `process.pid` and never cleared
  it; recycled pids doubled the append-only file and broke the order assertion.
  Tests that write real state must clean up after themselves — note that
  `health.json` is one shared file, so prune the key rather than deleting it.
- **Workflow YAML that would not parse.** `chore(state): ` inside an inline
  scalar. Commit messages with `: ` need a block scalar.

## Security

- **No credential belongs in this repo.** `DISCORD_WEBHOOK_URL` comes from the
  environment only; unset means mock mode.
- **This repo starts from a fresh git history** with no prior credential
  exposure. That is deliberate and is what makes it safe to publish. Do not
  import history from the repo it was extracted from — that history contains a
  real leaked credential and importing it would republish the leak.
- **Workflows must stay on `schedule` and `workflow_dispatch` only.** Never
  `pull_request_target`, never `pull_request` with secrets in scope — a public
  repo means fork PRs, and that combination hands secrets to arbitrary code.
- **`workflow_dispatch` inputs go through the environment**, never interpolated
  into a shell line, or the input box becomes command injection.
- **Before making the repo public**, re-run the history scan from the plan's
  Task 18 and confirm it is clean.
- **`state/wishlist.json` records what was paid for owned games.** Publishing the
  repo publishes that purchase history. Fine, but a deliberate choice.

## Where things are

```
src/node/            the worker
  bin/stores.ts      CLI entry: --seed, --only <A,B>
  pass.ts            orchestrator: runSource / runPass
  scrapers/          fetch, robots, relevance, registry, stores/
  matching/          wishlist matcher
  events/diff.ts     event diffing + seed suppression
  state/             paths, wishlist, listings, prices, health, prune
  discord/notify.ts  embeds + webhook
  tests/             87 tests, node:test
state/               committed JSON state
scripts/             commit-state.sh
.github/workflows/   stores.yml
docs/superpowers/    spec and phase 1 plan
```

## Phases 2-4

Not started. Each needs its own plan written before code.

- **Phase 2 — more sources.** Broader e-commerce, and quick-commerce if it can be
  made to work from CI. The original design closed quick-commerce on evidence
  (geo-blocking from cloud runners, bot protection); reopening it means solving
  those, not assuming they lapsed. See "Adding a source" in the spec — the
  contracts are already source-agnostic.
- **Phase 3 — digest workflow. Built 2026-07-27, never run in CI.**
  `.github/workflows/digest.yml` at 03:30 UTC. Reads all state, writes nothing,
  posts one message: a per-tier board of the best current price for every wanted
  game, near misses within 10% of target, unconfirmed `pending` matches, wanted
  games with no target, and unhealthy sources.
- **Phase 4 — `ps-collector` sync.** Import script reading committed state from
  `raw.githubusercontent.com` into the existing SQLite schema; its local worker
  gets disabled.
