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
