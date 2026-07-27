import { readJson } from '../lib/serialize.ts';
import { WISHLIST_PATH } from './paths.ts';

/**
 * What a used copy costs you beyond the disc.
 *
 * `sealed-only` is not a preference — it means the box contains a one-time-use
 * code whose value is gone on a pre-owned copy, so a cheap used listing is a
 * trap rather than a deal. Under a price-only gate those listings would be the
 * loudest alerts we send, which is exactly backwards.
 */
export type ConditionPolicy = 'sealed-only' | 'either' | 'prefer-used';

/** Buy priority. 1 = buy now, 2 = buy but sealed only, 3 = waiting for a price. */
export type BuyTier = 1 | 2 | 3;

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
  /**
   * Highest price worth an alert, integer paise. Wanted games only.
   * A wanted game with no target can never alert — see `gamesMissingTarget`.
   */
  targetPaise?: number;
  conditionPolicy?: ConditionPolicy;
  tier?: BuyTier;
  /** One line explaining the buy, shown on the alert. */
  verdict?: string;
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

export function conditionPolicyOf(game: WishlistGame): ConditionPolicy {
  return game.conditionPolicy ?? 'either';
}

/**
 * Wanted games that can never alert because no target price is set.
 *
 * Without this the gate mutes a game silently: it looks configured, it gets
 * scraped every pass, and no alert can ever fire. Surfaced on every pass and in
 * the digest so a missing target reads as a config gap, not as "no deals".
 */
export function gamesMissingTarget(games: WishlistGame[]): WishlistGame[] {
  return games.filter((g) => g.status === 'wanted' && g.targetPaise === undefined);
}
