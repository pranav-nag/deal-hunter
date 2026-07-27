import { ALL_SCRAPERS, SOURCE_LABELS } from '../scrapers/index.ts';
import { loadListings, type StoredListing } from '../state/listings.ts';
import { loadHealth } from '../state/health.ts';
import {
  gamesMissingTarget,
  loadWishlist,
  type BuyTier,
  type WishlistGame,
} from '../state/wishlist.ts';
import { conditionAllowed, isNearMiss, percentUnderTarget } from '../events/gate.ts';
import { formatPaise } from '../lib/money.ts';
import { sendLogEmbeds, type Embed } from '../discord/notify.ts';

const MAX_DESCRIPTION = 4096;
const MAX_PENDING_ROWS = 15;

const COLOUR_BOARD = 0x5865f2;
const COLOUR_NEAR_MISS = 0xe0a800;
const COLOUR_PENDING = 0x95a5a6;
const COLOUR_GAP = 0xe67e22;

export interface Candidate {
  source: string;
  key: string;
  listing: StoredListing;
}

const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + '…');

/**
 * Every in-stock, priced, matched listing, indexed by game.
 *
 * Read-only over committed state. The digest runs as its own job and must never
 * write — that is what lets it run on a schedule that overlaps a scrape pass
 * without any locking.
 */
export async function loadCandidates(sources: string[]): Promise<Map<string, Candidate[]>> {
  const index = new Map<string, Candidate[]>();
  for (const source of sources) {
    const file = await loadListings(source);
    for (const [key, listing] of Object.entries(file.listings)) {
      if (!listing.gameSlug || listing.matchStatus === 'unmatched') continue;
      if (!listing.inStock || listing.pricePaise === null) continue;
      const list = index.get(listing.gameSlug) ?? [];
      list.push({ source, key, listing });
      index.set(listing.gameSlug, list);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => (a.listing.pricePaise ?? Infinity) - (b.listing.pricePaise ?? Infinity));
  }
  return index;
}

/** Cheapest listing whose condition the game's policy actually permits. */
export function bestAllowed(candidates: Candidate[], game: WishlistGame): Candidate | undefined {
  return candidates.find((c) => conditionAllowed(c.listing, game));
}

const TIER_TITLES: Record<BuyTier, string> = {
  1: 'Tier 1 — buy immediately',
  2: 'Tier 2 — buy sealed only',
  3: 'Tier 3 — waiting on price',
};

function boardLine(game: WishlistGame, candidates: Candidate[]): string {
  const target = game.targetPaise;
  const best = bestAllowed(candidates, game);

  const targetText = target === undefined ? 'no target set' : `target ${formatPaise(target)}`;

  if (!best) {
    const blocked = candidates.length > 0 ? ' (nothing in an allowed condition)' : '';
    return `**${game.title}** — not in stock anywhere${blocked} · ${targetText}`;
  }

  const price = best.listing.pricePaise as number;
  const where = sourceLabel(best.source);
  const cond = best.listing.condition === 'preowned' ? 'used' : best.listing.condition === 'new' ? 'sealed' : 'condition unknown';

  if (target === undefined) {
    return `**${game.title}** — ${formatPaise(price)} ${cond} at ${where} · no target set`;
  }
  if (price <= target) {
    const pct = percentUnderTarget(price, target);
    return `✅ **${game.title}** — ${formatPaise(price)} ${cond} at ${where} · ${pct}% under ${formatPaise(target)}`;
  }
  const over = Math.round(((price - target) / target) * 100);
  return `**${game.title}** — ${formatPaise(price)} ${cond} at ${where} · ${over}% over ${formatPaise(target)}`;
}

export function buildBoardEmbeds(
  games: WishlistGame[],
  candidates: Map<string, Candidate[]>
): Embed[] {
  const wanted = games.filter((g) => g.status === 'wanted');
  const embeds: Embed[] = [];

  for (const tier of [1, 2, 3] as BuyTier[]) {
    const inTier = wanted.filter((g) => (g.tier ?? 3) === tier);
    if (inTier.length === 0) continue;
    const lines = inTier.map((g) => boardLine(g, candidates.get(g.slug) ?? []));
    embeds.push({
      title: TIER_TITLES[tier],
      color: COLOUR_BOARD,
      description: clip(lines.join('\n'), MAX_DESCRIPTION),
    });
  }
  return embeds;
}

export function buildNearMissEmbed(
  games: WishlistGame[],
  candidates: Map<string, Candidate[]>
): Embed | null {
  const lines: string[] = [];
  for (const game of games) {
    if (game.status !== 'wanted') continue;
    for (const candidate of candidates.get(game.slug) ?? []) {
      if (!isNearMiss(candidate.listing, game)) continue;
      const price = candidate.listing.pricePaise as number;
      const over = price - (game.targetPaise as number);
      lines.push(
        `**${game.title}** — ${formatPaise(price)} at ${sourceLabel(candidate.source)} · ${formatPaise(over)} over target`
      );
      break; // cheapest only; the list is already sorted
    }
  }
  if (lines.length === 0) return null;
  return {
    title: 'Close, but over target',
    color: COLOUR_NEAR_MISS,
    description: clip(lines.join('\n'), MAX_DESCRIPTION),
    footer: { text: 'Within 10% of your target. No alert was sent for these.' },
  };
}

/**
 * Listings that scored between the pending and auto thresholds.
 *
 * These are the wrong-platform and wrong-edition near-matches the matcher
 * deliberately refuses to auto-accept. They are recorded on every pass and were
 * previously never surfaced anywhere — this is the only place they become
 * actionable.
 */
export function buildPendingEmbed(
  games: WishlistGame[],
  sources: string[],
  pending: Array<{ source: string; listing: StoredListing }>
): Embed | null {
  if (pending.length === 0) return null;
  const wanted = new Set(games.filter((g) => g.status === 'wanted').map((g) => g.slug));
  const relevant = pending
    .filter((p) => p.listing.gameSlug && wanted.has(p.listing.gameSlug))
    .sort((a, b) => b.listing.matchScore - a.listing.matchScore);
  if (relevant.length === 0) return null;

  const lines = relevant
    .slice(0, MAX_PENDING_ROWS)
    .map(
      (p) =>
        `\`${p.listing.matchScore.toFixed(2)}\` ${clip(p.listing.title, 70)} — ` +
        `${formatPaise(p.listing.pricePaise)} at ${sourceLabel(p.source)}`
    );
  const more = relevant.length > MAX_PENDING_ROWS ? `\n…and ${relevant.length - MAX_PENDING_ROWS} more` : '';

  return {
    title: `Unconfirmed matches (${relevant.length})`,
    color: COLOUR_PENDING,
    description: clip(lines.join('\n') + more, MAX_DESCRIPTION),
    footer: {
      text: 'Scored too low to auto-match. Add an alias to state/wishlist.json to accept one.',
    },
  };
}

export function buildConfigGapEmbed(games: WishlistGame[]): Embed | null {
  const untargeted = gamesMissingTarget(games);
  if (untargeted.length === 0) return null;
  return {
    title: 'Wanted games that cannot alert',
    color: COLOUR_GAP,
    description: clip(
      untargeted.map((g) => `**${g.title}** — no \`targetPaise\` set`).join('\n'),
      MAX_DESCRIPTION
    ),
    footer: { text: 'These are scraped every pass but the gate can never pass them.' },
  };
}

export async function buildHealthEmbed(): Promise<Embed | null> {
  const health = await loadHealth();
  const entries = Object.entries(health).filter(([, h]) => h.status !== 'ok');
  if (entries.length === 0) return null;
  return {
    title: 'Source health',
    color: COLOUR_GAP,
    description: clip(
      entries
        .map(([source, h]) => `**${sourceLabel(source)}** — ${h.status}, ${h.consecutiveFailures} consecutive failures`)
        .join('\n'),
      MAX_DESCRIPTION
    ),
  };
}

export async function buildDigest(): Promise<Embed[]> {
  const games = await loadWishlist();
  const sources = ALL_SCRAPERS.map((s) => s.source);
  const candidates = await loadCandidates(sources);

  const pending: Array<{ source: string; listing: StoredListing }> = [];
  for (const source of sources) {
    const file = await loadListings(source);
    for (const listing of Object.values(file.listings)) {
      if (listing.matchStatus === 'pending' && listing.inStock) pending.push({ source, listing });
    }
  }

  const embeds: Embed[] = [
    ...buildBoardEmbeds(games, candidates),
    buildNearMissEmbed(games, candidates),
    buildPendingEmbed(games, sources, pending),
    buildConfigGapEmbed(games),
    await buildHealthEmbed(),
  ].filter((e): e is Embed => e !== null);

  return embeds;
}

export async function runDigest(): Promise<{ embeds: number; ok: boolean }> {
  const embeds = await buildDigest();
  const ok = await sendLogEmbeds(embeds);
  return { embeds: embeds.length, ok };
}
