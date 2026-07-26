# Deal Hunter

Watches Indian game storefronts for PS4/PS5 disc deals and posts price events to
Discord. Runs entirely on a GitHub Actions cron — no server, no database, no
machine of yours needs to be on.

State lives as committed JSON in this repo. Git *is* the database.

## What it does

Every 6 hours it searches 12 storefronts for each game on a 35-game wishlist,
matches results against that wishlist, diffs them against the previous pass, and
alerts only on things worth knowing:

| Event | Alerts? |
|---|---|
| `new_listing` | yes |
| `price_drop` | yes |
| `restock` | yes |
| `price_rise` | recorded only |
| `gone` (missed 3 passes) | recorded only |

Alerts are suppressed for games marked `owned`, for matches below the confidence
threshold, and entirely during a seed run.

### Sources

GameLoot, GameNation, GamesTheShop, E2Z Store, HGWorld, Dacby, Nekavo,
Console Garage, CeX India, Play-Asia, Amazon.in, Flipkart.

NXTGamerCode was dropped — its domain expired. See the spec.

## State layout

Partitioned per source so concurrent runs never write the same file:

| Path | Written by | Shape |
|---|---|---|
| `state/wishlist.json` | you, by hand | the games you want, and what you paid for the ones you own |
| `state/listings/<source>.json` | every pass | current snapshot, rewritten in full |
| `state/prices/<source>.jsonl` | every pass | **append-only** price history, one line per change |
| `state/health.json` | every pass | per-source `ok` / `degraded` / `broken` |

Three rules hold everywhere:

- **Money is integer paise** (₹1 = 100 paise). Never floats. Parse and format
  only through `src/node/lib/money.ts`.
- **Timestamps are integer unix ms, UTC.**
- **All state JSON goes through `writeJsonStable()`** — sorted keys, 2-space
  indent, trailing newline. An unchanged pass produces a byte-identical file and
  an empty diff. Never `JSON.stringify` into a state file directly.

`.gitattributes` pins LF for `state/` and `src/node/`. Without it, a Windows
checkout with `core.autocrlf=true` would rewrite every state file on every pass
and defeat the whole point of the stable serializer.

## Running it

```bash
cd src/node && npm install
```

Seed one source (writes state, alerts nothing):

```bash
npx tsx bin/stores.ts --only GameLoot --seed
```

Full pass across every source:

```bash
npx tsx bin/stores.ts
```

Tests and typecheck:

```bash
cd src/node && npx tsc --noEmit && npm test
```

### Seeding

A first pass against a new source would report every listing as new and flood
Discord. `runSource` therefore **seeds automatically whenever a source has no
prior state** — it writes state and emits nothing.

Pass `--seed` explicitly when you reset state or add a source. Don't run a
non-seed pass across all sources until each has a file in `state/listings/`.

## Configuration

One secret, set as a GitHub Actions secret named `DISCORD_WEBHOOK_URL`.

With it unset the notifier runs in **mock mode** and prints payloads to stdout
instead of posting — a local run can never message anyone by accident.

No credential is read from a file or hardcoded anywhere.

## Politeness

`fetch.ts` gates both HTML and JSON requests on `robots.txt`, matching rules over
path *and* query with `*` and trailing-`$` wildcards, and keeps a 1.5s jittered
per-host delay. The 6-hourly schedule is deliberate: these are small shops that
restock rarely and do not deserve to be hammered.

`ROBOTS_OVERRIDES` in `src/node/scrapers/robots.ts` lists hosts deliberately
exempted, with the reason recorded at the point of exception.

## Docs

- [`docs/superpowers/specs/`](docs/superpowers/specs/) — the design and why it is shaped this way
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — the phase 1 implementation plan, as executed
- [`RESUME.md`](RESUME.md) — current status and where to pick up
