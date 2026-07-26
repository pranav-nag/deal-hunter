# Multi-Store PS4/PS5 Disc Deal Hunter — Design

**Date:** 2026-07-25
**Status:** Approved (phases 1, 2, 4). Phase 3 (quick-commerce) deferred to its own spec.

## Problem

Nothing watches the Indian storefronts that actually sell PS4/PS5 discs. Prices
move, stock returns, and a deal is gone before anyone notices.

Two codebases already scrape overlapping sets of those stores:

| Repo | Runtime | Covers | Runs |
|---|---|---|---|
| `ps-collector` | Next.js + SQLite | 13 sources, matching, deal detection, Discord | every 6h, **localhost only** |
| `gameScout` | Firebase Functions | 13 sources (commercial product) | on demand |

`ps-collector` already implements almost exactly the wanted system — but it only
runs when a laptop is on, which is the one condition that cannot be met. `gameScout`
is a commercial product with paying users and must not become a personal tool.

So this is not a "build scrapers" problem. It is a **hosting and consolidation**
problem: take the scrapers that already work, run them somewhere always-on and
free, and stop maintaining three copies.

## Goals

1. Watch every supported storefront from the cloud, with no machine of the
   user's powered on.
2. Record every price ever observed, so any alert can carry history.
3. Alert on events, not thresholds — the user reviews and decides.
4. Keep `ps-collector`'s UI usable, fed by cloud data.
5. Cost ₹0, permanently.
6. One canonical copy of each scraper.

## Non-goals

- **Quick-commerce (Zepto, Blinkit, Instamart, BigBasket).** Deferred; see
  "Phase 0 findings" and the separate spec to follow.
- **Per-game target prices.** Explicitly rejected by the user. No thresholds to
  maintain.
- **Automated purchasing.** The bot alerts. The user buys.
- **Bot-detection circumvention.** Sources that actively block automated clients
  (Zepto's AWS WAF challenge, Instamart's 403) are out of scope permanently, not
  merely deferred.

## Phase 0 findings (completed 2026-07-25)

A throwaway workflow on branch `probe/qcommerce-geo` tested whether a GitHub
Actions runner can reach Indian quick-commerce.

| Source | From Indian residential IP | From GitHub runner (`20.55.86.52`, US) |
|---|---|---|
| Blinkit | HTTP 200, products and prices render | **HTTP 403** (561KB block page) |
| BigBasket | HTTP 200, 155 products render | **HTTP 403** to headless Chromium |
| Zepto | HTTP 202 + AWS WAF JS challenge | not retested — out of scope |
| Instamart | HTTP 403 | not retested — out of scope |

Same code, same browser, different network path. The block is on the network, not
the scraper. **Quick-commerce cannot run on GitHub Actions.** Whether the cause is
geographic or datacenter-ASN was never resolved — see "Where the value actually
sits" for why the question was closed rather than answered.

BigBasket additionally served curl a 200 while serving headless Chromium a 403,
so it fingerprints the client beyond geography.

### Where the value actually sits

The user reports that **Zepto is the source of genuinely cheap PS4/PS5 discs**;
Blinkit and BigBasket are not price-competitive. This inverts the priority of any
quick-commerce work:

- The two sources that are *technically reachable* (Blinkit, BigBasket) are the
  two that are *commercially uninteresting*.
- The one source worth watching (Zepto) is permanently out of scope for automated
  scraping.

The consequence is that a 24/7 cloud solution for quick-commerce is **not worth
pursuing**, and the Mumbai-region probe was dropped rather than run — it would
have bought always-on access to the expensive stores. Blinkit and BigBasket drop
to low priority, worth adding only opportunistically.

Zepto coverage is therefore an alerting problem, not a scraping problem from the
cloud's point of view. Two routes remain, both legitimate: deal-feed watching on
the cloud cron (24/7, second-hand) and Zepto's own app notifications. A third —
scraping Zepto directly — was attempted and closed; see below.

### `zepto_scraper` (user-built, 2026-07-25)

The user independently built `D:\Coding\GitHub Projects\zepto_scraper` — Playwright
Chromium, a delivery-address step, JSON response interception, with `__NEXT_DATA__`
and DOM fallbacks.

**It does not work, and it is not integrated.** An instrumented run on 2026-07-25
established that the scraper has never retrieved Zepto product data:

- The only XHR/fetch calls the page issued were to `token.awswaf.com` —
  `/inputs?client=browser` and `/mp_verify`, AWS WAF managed bot protection.
- `zepto.com/` returned 202 (challenge); `zepto.com/search?query=…` and `?q=…`
  both returned **429**. Rendered text length was zero in every case.
- A search for `ps5` had been returning three packets of potato chips, scraped
  off a fallback page, reported as `[SUCCESS]`.

Separately, the code targets `zeptonow.com`, which now redirects to `zepto.com`,
uses `?q=` where the site uses `?query=`, and depends on `__NEXT_DATA__`, which no
longer exists — Zepto moved to the Next.js App Router with RSC streaming. None of
those matter while the WAF challenge sits in front of them.

Making this scraper function would require defeating AWS WAF bot detection, which
is a permanent non-goal (see "Non-goals"). The three break points above are recorded
so this is not re-attempted as a "bug fix" later. **Zepto is closed as a scraping
target.**

The scraper's design still contributes one thing of value, carried into the store
scrapers instead — see "The fallback ladder" below.

## Architecture

```
deal-hunter  (public repo — unlimited free Actions minutes)
│
├── .github/workflows/
│     stores.yml   0 */6     store scrapers                        [Node]
│     digest.yml   30 3 * *  daily pending-match digest            [Node]
│
├── src/node/       scrapers + matching, vendored from ps-collector
│
└── state/          committed back to the repo by each run
      wishlist.json
      listings/<source>.json
      prices/<source>.jsonl
      health.json
```

Pipeline:

**scrape → normalize → match to wishlist → diff against previous state → emit
events → Discord → commit state**

`digest.yml` runs at 03:30 UTC (09:00 IST) and only reads state — it emits the
daily summary of `pending` matches and recorded-but-unalerted events. It is a
separate workflow because the scrape workflows must not be coupled to a
once-a-day concern, and because it is the only job that reads across all sources.

Source count, stated once to avoid ambiguity elsewhere: **12 store scrapers**
after NXTGamerCode was dropped. See "Scrapers".

### Why git is the database

State is committed back to the repo as JSON and JSONL. This is free, needs no
service, no signup, and no credentials beyond the token Actions already has.
Git history becomes the price-history store at zero cost, and `git log -p` on a
price file is a readable audit of every change.

Constraints that follow from this choice, all of them load-bearing:

- **Text, never binary.** A committed SQLite file would re-write wholesale on
  every run; at 96 runs/day the repo reaches gigabytes.
- **Deterministic serialization.** Text alone is not enough. `listings/<source>.json`
  is fully rewritten each pass, so it only diffs cheaply if the output is stable:
  keys sorted, two-space indent, one field per line, trailing newline. Unstable key
  order would make every commit a whole-file diff and reproduce exactly the bloat
  this section claims to avoid.
- **Append-only for history.** `prices/<source>.jsonl` is only ever appended, so
  each commit adds lines rather than rewriting a document.
- **Bounded state.** Every file needs a size ceiling or it grows forever. See
  "Pruning" below.

### Growth and checkout cost

At these intervals the repo takes roughly 50 commits/day, about 19,000/year.
History is never garbage-collected, so it becomes checkout cost on every run.

- All workflows check out with **`fetch-depth: 1`**. Full history is never needed
  to append to state.
- Shallow checkout is incompatible with `git pull --rebase`. The commit step
  therefore uses `git fetch --depth=1 origin <branch> && git reset --soft
  FETCH_HEAD` before committing, retried up to three times. Because the workflows
  write disjoint files (see "Avoiding write races"), a concurrent run's changes
  are never lost by this reset.
- Automatic commits keep the repository active, preventing GitHub from disabling
  scheduled workflows after 60 days of inactivity.

One claim to retire: with 19,000 automated commits a year, `git log -p` is not a
human-readable audit trail. History is a machine-queryable price archive. If a
human-readable view is wanted, that is `ps-collector`'s job.

### Pruning

| File | Rule |
|---|---|
| `listings/<source>.json` | Drop entries `gone` for more than 30 days. Their price history survives in the JSONL. |
| `prices/<source>.jsonl` | Never pruned in place. If a file passes 20MB, roll it to `prices/archive/<source>-<year>.jsonl`. |

### Avoiding write races

Workflows run on independent schedules and will sometimes overlap. Rather than
locking, state is **partitioned so that no two writers touch the same file**:
each source owns exactly one `listings/<source>.json` and one
`prices/<source>.jsonl`, and no job writes another's files.

Pushes can still collide at the git level. Each job ends with
`git pull --rebase && git push`, retried up to three times. Because the changed
files are disjoint, the rebase cannot conflict.

Each workflow additionally declares `concurrency: { group: <name>,
cancel-in-progress: false }` so a slow run is never overlapped by its own
successor.

## Data model

### `state/wishlist.json`

The canonical list of the user's 35 games. Owned games are retained rather than
deleted — they are the only real price anchors available, and they let an alert
say "₹3,438 versus the ₹3,400 you paid".

```jsonc
{
  "games": [
    {
      "slug": "death-stranding-2-on-the-beach",
      "title": "Death Stranding 2: On the Beach",
      "platform": "ps5",              // ps4 | ps5 | any
      "status": "owned",              // owned | wanted
      "paidPaise": 340000,            // owned only
      "condition": "preowned",        // owned only: what was bought
      "notes": "",
      "aliases": ["death stranding 2", "ds2"]
    }
  ]
}
```

`status: "owned"` suppresses alerts but keeps the game matched and price-tracked,
so history keeps accumulating and the collection view stays populated.

`aliases` exists because store titles vary wildly ("GTA V", "Grand Theft Auto V",
"Grand Theft Auto 5"). Aliases feed the matcher as additional candidate titles.

### `state/listings/<source>.json`

Current snapshot for one source, keyed by a stable listing key.

```jsonc
{
  "source": "GameLoot",
  "updatedAt": 1774454400000,
  "listings": {
    "<listingKey>": {
      "title": "Death Stranding 2 On The Beach PS5",
      "url": "https://…",
      "imageUrl": "https://…",
      "pricePaise": 343800,
      "originalPricePaise": 519900,
      "currency": "INR",
      "condition": "new",
      "inStock": true,
      "gameSlug": "death-stranding-2-on-the-beach",
      "matchScore": 0.94,
      "matchStatus": "auto",          // auto | pending | unmatched
      "firstSeen": 1774368000000,
      "lastSeen": 1774454400000,
      "missedPasses": 0
    }
  }
}
```

`listingKey` is a hash of `(source, normalizeUrl(url) || keyHint)`. `normalizeUrl`
strips tracking parameters so a listing keeps one identity across passes; `keyHint`
covers stores whose item URLs are not product-specific. Both are carried over
from `ps-collector` unchanged.

### `state/prices/<source>.jsonl`

Append-only. One line per observed price, written only when something changed.

```jsonl
{"ts":1774454400000,"key":"a3f9…","pricePaise":343800,"inStock":true}
```

Writing only on change keeps the file proportional to real price movement rather
than to poll frequency.

### `state/health.json`

Per-source consecutive-failure counts, carrying over `ps-collector`'s crucial
`pageHadContent` distinction: a site returning a real page with zero matches is
normal, while a parser finding nothing on a populated page is breakage. Three
consecutive failures across all queries marks a source `broken` and fires a
Discord alert — a silently dead scraper is worse than no scraper.

## Matching

Vendored from `ps-collector` without behavioural change:

- Score = title similarity 0.65 + platform 0.2 + edition 0.15
- ≥ 0.85 → `auto`, 0.55–0.85 → `pending`, below → `unmatched`
- An edition mismatch is hard-capped below the auto threshold, so a base game can
  never auto-match a Deluxe/GOTY listing — these are distinct SKUs at very
  different prices.

Two title normalizations exist and must not be conflated: `normTitleKey` **keeps**
edition tokens and is the match-memory key; `baseTitle` **strips** them and is used
to compare against canonical names.

`auto` matches alert immediately. `pending` matches go to a once-daily digest
rather than a live ping — this preserves "show me everything, I'll decide" without
turning the channel into noise.

## Events and alerts

Each pass diffs the new snapshot against the previous one, per listing key:

| Event | Condition | Alert |
|---|---|---|
| `new_listing` | key not previously seen | live |
| `price_drop` | price below last recorded | live |
| `restock` | `inStock` false → true | live |
| `price_rise` | price above last recorded | recorded only |
| `gone` | absent for 3 consecutive passes | recorded only |

Owned games are recorded but never alerted.

### Bootstrap mode

On a first run every listing is unseen, so every listing is a `new_listing`.
Across 13 stores and 35 games that is plausibly several hundred live alerts at a
1-second throttle — twenty minutes of uninterrupted pinging, and a muted channel
by the end of day one. The same happens whenever state is reset or a new source
is added.

Both runtimes therefore support `--seed`: run the full pipeline, write state,
**emit nothing**. Required on first run, on adding a source, and after any state
reset. A run is treated as a seed run automatically when the source has no
existing `listings/<source>.json`, so this cannot be forgotten — the flag exists
for deliberate re-seeding.

The digest reports what a seed run ingested, so a silent run is still visible.

### Discord format

One webhook, one embed per event, colour-coded by event type. Every embed carries
history inline, because history is what makes an unfamiliar price legible:

```
Death Stranding 2: On the Beach — PS5              [price drop]
₹3,438   was ₹3,690   MRP ₹5,199

seen 7× since 12 Jun · low ₹3,438 (today) · high ₹5,199
you paid ₹3,400 pre-owned

New · GameLoot · in stock
```

Region is flagged when detectable (the user's collection already includes Saudi
and US region discs, which affect resale and account compatibility). Condition is
always labelled and **never filtered on** — filtering by condition would have
suppressed the new-disc quick-commerce deal that motivated this project.

Alerts are throttled 1s apart, as the current bot already does, to stay under
Discord's rate limit.

## Scrapers

Twelve sources move to `src/node/scrapers/`, vendored from `ps-collector`:

GameLoot, GameNation, GamesTheShop, e2zStore, HGWorld, Dacby, Nekavo,
Console Garage, CeX India, Play-Asia, Amazon.in, Flipkart.

`ps-collector`'s forum scraper is deliberately **not** vendored. This worker
covers storefronts only; a source whose listings are free-text posts needs a
different filtering model and does not share these contracts.

**NXTGamerCode was dropped on 2026-07-25.** It was the only store on the user's
list not already covered, and `gameScout` targets
`nxtgamercode.com/?s=<query>&post_type=product`, a standard WooCommerce search.
Verified before porting, as this spec required:

- `https://` — TLS handshake fails outright, no HTTP status (`curl` exit 35).
- `http://` — **200**, but the body is a 10,881-byte registrar holding page
  titled *"Your domain is expired"*. No WooCommerce markup, no product cards.
- DNS still resolves, to `2.57.91.92` — a parking host, not the storefront.

The domain lapsed, so there is nothing to scrape. No scraper was written and
none is registered; phase 1 ships **12 stores, not 13**. Revisit only if the
domain is renewed and the storefront returns.

The four WooCommerce stores (GameLoot, e2zStore, HGWorld, Nekavo) continue to
share one `makeWooScraper(config)` factory. `fetch.ts` keeps its per-host 1.5s
jittered politeness delay — the schedule is 6-hourly precisely because these are
small shops that restock rarely and do not deserve to be hammered.

### The fallback ladder

Salvaged from the failed `zepto_scraper`, and applied to the browser-driven store
scrapers: extract in tiers — **intercept the JSON API response first, page
hydration data second, DOM parsing last.** A store's JSON API changes far less
often than its markup, and it yields structured `mrp`, `savings` and `availability`
fields rather than values scraped out of rendered text.

The ladder carries a failure mode that must be designed against, because
`zepto_scraper` demonstrated it precisely: each tier degrades silently into the
next until DOM parsing returns something irrelevant and the scraper reports
success. Searching `ps5` returned three packets of potato chips and exited zero.

Every scraper therefore applies a **relevance guard** on top of `pageHadContent`:
if no result contains any token from the query, the outcome is a parse failure,
not a result. Silently writing wrong prices into an append-only history is the
worst available outcome — worse than a missing source, because it is permanent and
looks healthy.

### Query strategy and runtime budget

Scrapers take `search(query)`, so the pass must decide what to search for.

- **Queries come from `wishlist.json`, all 35 games — `owned` included.** Owned
  games are searched so their price history keeps accumulating; they are simply
  never alerted on. Query text is the canonical title plus each alias.
- **Sources run in parallel, queries within a source run sequentially**, which is
  what the per-host politeness delay requires. This mirrors `ps-collector`'s
  existing pass structure.
- **Budget:** 35 queries × 1.5s ≈ 53s per source, all 13 in parallel, so roughly
  1–3 minutes per pass allowing for latency and retries. Well inside both the
  6-hour job limit and the 6-hourly schedule.

If the wishlist grows past roughly 100 games this becomes a ~3 minute serial
tail per source and should be revisited — most likely by searching `wanted`
games every pass and `owned` games once a day.

### robots.txt

`fetch.ts` gains a per-host `robots.txt` check, cached for the lifetime of a
pass, and skips disallowed paths. Politeness here is not decoration: these are
small independent shops, and the whole project depends on continued access to
them. A stated intention to honour robots.txt with no mechanism behind it is
worse than not claiming it, which is what the previous draft did.

### Vendoring and source of truth

**The bot repo becomes the canonical home for scraper code.** This is the decision
that ends the three-way duplication tax: today a broken CSS selector must be fixed
in `ps-collector` and `gameScout` separately, and in practice one of them silently
rots.

Vendoring strips the Drizzle and Next.js dependencies; the scrapers themselves are
already free of both, depending only on `jsdom` and, for bot-walled sources,
Playwright. `ps-collector` and `gameScout` migrating to consume this copy is
follow-up work, out of scope here, but no new divergence should be introduced in
the meantime.

## Adding a source

Phase 2 widens coverage beyond the twelve stores. The contracts are already in
place, so a new storefront is additive rather than structural:

1. Write a `Scraper` — `{ source, tier, search(query) }` returning a
   `ScrapeOutcome`. WooCommerce storefronts need only a `WooConfig` passed to
   `makeWooScraper`; anything else parses its own DOM or JSON.
2. Register it in `ALL_SCRAPERS` and give it a `SOURCE_LABELS` entry.
3. Capture a fixture of a real search page and assert products parse out of it.
   A parser with no fixture is a silent failure waiting to happen.
4. Run `--seed --only <Source>` once. It writes `listings/<source>.json` and
   `prices/<source>.jsonl` and alerts nothing.

Nothing else changes: matching, diffing, health, pruning and Discord are all
source-agnostic and need no edit to accept a new store.

Two rules that are not negotiable for a new source. It must respect
`robots.txt` through the shared fetch layer, and it must never report success on
a populated but irrelevant page — the relevance guard exists because that
failure writes wrong prices into permanent history while looking healthy.

## ps-collector integration

The worker commits state to a public repo, so `ps-collector` reads it directly from
`raw.githubusercontent.com`. No service, no API, no auth.

Sync is **one-way, cloud to local**, for prices and listings. The reverse direction
— marking a game owned — is the user editing `wishlist.json`, which the next run
picks up. Two-way sync would need conflict resolution to protect against a laptop
that has been off for a week overwriting fresher cloud state; one-way sidesteps
this entirely.

An import script reads the JSON into `ps-collector`'s existing SQLite schema, so
its UI, matching review queue and collection views work unchanged. Its local
worker is disabled — the cloud is now authoritative.

## Making the repository public

Unlimited Actions minutes require a public repo. The 6-hourly store pass fits
inside the private tier's 2,000 minutes/month, but tighter polling and more
sources do not.

Before flipping visibility:

1. Scan the full git history for committed secrets, not just the working tree —
   `git log -p` over the whole history, checking for webhook URLs, client secrets
   and tokens. History persists after a repo goes public.
2. Confirm every credential is referenced via `secrets.*` and none is inlined.
3. Rotate the Discord webhook as a precaution.
4. **If step 1 finds anything**, do not proceed by deleting the file — the blob
   stays reachable. Either rewrite history with `git filter-repo` and force-push
   before the repo is ever public, or create a fresh repo with no history. Rotate
   the exposed credential regardless; assume it is burned.

### Workflow triggers and permissions

A public repo means anyone can fork it and open a pull request, so trigger
configuration becomes a security control rather than a convenience:

- Workflows run on **`schedule` and `workflow_dispatch` only**. Never
  `pull_request_target`, and never `pull_request` with secrets in scope — that
  combination hands repository secrets to arbitrary fork code.
- The `GITHUB_TOKEN` needs `permissions: { contents: write }` for the state
  commits, and nothing else. Declare it per workflow rather than repo-wide.

### Where personal data lives

The distinction matters because the two runtimes have different access:

| Data | Home | Why |
|---|---|---|
| Discord webhook | GitHub Secrets | consumed by workflows running in Actions |

**No personal address is stored anywhere.** With quick-commerce closed, the
system has no use for a delivery address or pincode, so none is collected. This
is the strongest available outcome and it came from dropping a feature, not from
protecting the data better.

Quick-commerce prototypes tend to hardcode a delivery address, because their
search results depend on one. Any such code is **out of scope here and must not
be vendored into this repository in that state** — an address inlined in a source
file becomes a permanent blob in public history the moment it is pushed. If phase
2 reopens quick-commerce, the address has to arrive from the environment, or the
source stays out.

Two principles that applied while this was live, kept because they will recur:

- **Encryption would not have helped.** Committed ciphertext needs a local key
  file — the same exposure as a gitignored plaintext file, plus ceremony, plus a
  permanent blob in public history carrying retroactive leak risk. Encryption is
  for secrets that must be *distributed*.
- **Minimise before protecting.** The best version of this was never "encrypt the
  address" or even "hide the address", but "need no address". Data that is never
  collected cannot leak.

GitHub Secrets are also unavailable to locally-run code, so any future local
component must read a gitignored `.env` rather than expecting Actions secrets.

### Publishing scraped data

Making the repo public is treated above as a billing decision, but it has a
second consequence: the repo continuously republishes 13 stores' price catalogs
at a public URL, with history. That is a materially different posture from
scraping privately for personal use, and invites takedown requests that private
scraping does not.

This is judged acceptable — small independent shops, low visibility, prices are
not creative works, and the data is a thin derived subset rather than a mirror.
It is recorded as a deliberate trade for unlimited Actions minutes, not an
accident of wanting free compute. If any store objects, the response is to drop
that source rather than to argue.

## Testing

- **Scraper fixtures.** Each scraper gets a saved HTML fixture and a golden-file
  test, so a parser regression is caught in CI without network access. Note what
  this does *not* catch: a fixture stays green forever while the live site changes
  underneath it. Fixtures protect against regressions in our code; `pageHadContent`
  health monitoring is what detects changes in theirs. The two are not
  substitutes, and health monitoring is the more important of the pair.
- **Event diffing.** Unit tests over synthetic before/after snapshots covering
  each event type, including the owned-game suppression path.
- **Matching.** Port `ps-collector`'s existing matching tests, particularly the
  edition-mismatch cap.
- **Price parsing.** The existing `test_price_parser.py` and `test_bot_filter.py`
  stay, extended to cover the `retail` profile.
- **State round-trip.** Write, re-read and diff state files to prove no drift
  across runs.

## Risks

| Risk | Mitigation |
|---|---|
| A scraper breaks silently | `pageHadContent` health tracking, broken-source Discord alert; fixture tests for parser regressions |
| Scheduled runs drift | GitHub cron is best-effort and delays 3–15 min under load; `*/30` is effectively 30–45 min. Accepted. |
| Repo grows without bound | Deterministic serialization, change-only price writes, pruning rules, `fetch-depth: 1` checkouts |
| First run floods Discord | Automatic seed mode when a source has no existing state; `--seed` for deliberate re-seeding |
| Fork PR exfiltrates secrets | Workflows restricted to `schedule` and `workflow_dispatch`; scoped `contents: write` |
| Home address published | No address is collected at all; `zepto_scraper`, which hardcodes one, is not vendored and must not be pushed public as-is |
| A blocked source is re-attempted as a "bug fix" | Zepto's WAF findings recorded in full so the closure is not mistaken for rot |
| Small stores object to polling | 6-hourly, politeness delays retained, `robots.txt` enforced in `fetch.ts`; drop any source that objects |
| Public repo republishes catalogs | Accepted trade for unlimited minutes; drop a source on request |
| NXTGamerCode is dead | Closed 2026-07-25: domain expired, dropped, never registered |
| Public repo exposes history | Full history secret scan, `filter-repo` or fresh repo on a hit, credential rotation before flipping |

## Phases

| # | Scope | Depends on |
|---|---|---|
| 1 | 12 stores on 6h cloud cron, seed mode, state commits, matching, events, Discord, health | — |
| 2 | Additional storefronts: broader e-commerce, and quick-commerce if it can be made to work from CI | 1 |
| 3 | Daily digest workflow for `pending` matches and unalerted events | 1 |
| 4 | `ps-collector` reads cloud state; local worker disabled | 1 |

Phase 2 reopens quick-commerce, which the original design closed. That closure
was evidence-based and the findings below still stand as written. Reopening it
means solving geo-blocking from CI runners and bot protection on their merits,
not assuming they went away.

## Open questions

1. ~~Is `nxtgamercode.com` still live?~~ **Closed 2026-07-25: no.** The domain
   expired and now serves a registrar parking page. Dropped from phase 1, which
   ships 12 stores. See the Scrapers section for the evidence.
2. Which additional e-commerce storefronts are worth adding, and do any expose a
   JSON search endpoint rather than requiring DOM parsing?
3. Can quick-commerce be reached from GitHub-hosted runners at all, given the
   geo-blocking recorded below?

The Mumbai-region geo-versus-ASN question was closed without being answered: it
only mattered for Blinkit and BigBasket, which are not price-competitive. See
"Where the value actually sits".
