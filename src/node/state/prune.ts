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
