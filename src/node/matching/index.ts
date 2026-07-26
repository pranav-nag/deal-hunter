import { detectPlatform, detectEditions, baseTitle } from '../lib/identity.ts';
import type { WishlistGame } from '../state/wishlist.ts';

export const AUTO_THRESHOLD = 0.85;
export const PENDING_THRESHOLD = 0.55;

/**
 * Dice coefficient over word bigrams — robust to word order and small edits.
 * Vendored unchanged from ps-collector/src/server/matching/index.ts.
 */
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
 * Platforms the vendored detectPlatform does not recognise.
 *
 * It returns '' for these, which the scorer reads as "listing didn't say",
 * scoring a neutral 0.5 rather than a mismatch. A PS3 disc with an otherwise
 * perfect title then clears AUTO_THRESHOLD and alerts as the PS4 game — seen
 * for real on "Metal Gear Solid V The Phantom Pain PS3" in the first GameLoot
 * seed. Fixed here rather than in the vendored lib, which stays untouched.
 */
const LEGACY_PLATFORM =
  /\b(ps\s*[123]|playstation\s*[123]|psp|ps\s*vita|wii\s*u?|game\s*cube|nintendo\s*ds|3\s*ds)\b/i;

/**
 * Weights: base-title similarity 0.65, platform agreement 0.2, edition overlap 0.15.
 * An edition mismatch is hard-capped below AUTO_THRESHOLD — a base game and its
 * Deluxe/GOTY release are different SKUs at very different prices.
 */
export function scoreListing(listingTitle: string, game: WishlistGame): number {
  const titleScore = titleSimilarity(baseTitle(listingTitle), baseTitle(game.title));
  // A weak title match can't be rescued by platform/edition agreement.
  if (titleScore < 0.35) return titleScore * 0.65;

  const listingPlatform = detectPlatform(listingTitle);
  let platformScore = 0.5; // listing doesn't state platform → neutral
  const expected = game.platform !== 'any' ? game.platform : null;
  if (listingPlatform) {
    platformScore = expected ? (listingPlatform === expected ? 1 : 0) : 1;
  } else if (expected && LEGACY_PLATFORM.test(listingTitle)) {
    // Stated a platform, just not one detectPlatform knows. Still a mismatch.
    platformScore = 0;
  }

  const listingEditions = new Set(detectEditions(listingTitle));
  const gameEditions = new Set(detectEditions(game.title));
  let editionScore: number;
  if (gameEditions.size === 0 && listingEditions.size === 0) {
    editionScore = 1; // both base game
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
