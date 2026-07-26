import type { ScrapeOutcome } from './types.ts';

const STOPWORDS = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'edition', 'ps4', 'ps5']);

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function tokens(text: string): string[] {
  return rawTokens(text).filter((t) => !STOPWORDS.has(t));
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
  if (wanted.size > 0) {
    return titles.some((title) => tokens(title).some((t) => wanted.has(t)));
  }

  // The query was nothing but stopwords — "ps5", "edition". Failing open here
  // would disable the guard for precisely the generic query that motivated it:
  // the dead Zepto scraper searched "ps5" and cheerfully returned groceries.
  // Drop the stopword filter on both sides instead, so "ps5" still has to
  // appear somewhere in the results.
  const loose = new Set(rawTokens(query));
  if (loose.size === 0) return true; // genuinely nothing to check against
  return titles.some((title) => rawTokens(title).some((t) => loose.has(t)));
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
