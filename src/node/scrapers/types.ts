export interface ScrapedItem {
  source: string;
  title: string;
  url: string;
  imageUrl: string;
  pricePaise: number | null;
  originalPricePaise: number | null;
  currency: string; // 'INR' unless import source
  condition: 'new' | 'preowned' | 'unknown';
  inStock: boolean;
  /**
   * Optional stable identity override. Needed when a store's item URL is not
   * product-specific (e.g. Dacby's featured list shares the search-page URL),
   * so the same product collapses to one listing across queries.
   */
  keyHint?: string;
}

/**
 * pageHadContent distinguishes "site returned a real page with zero matches"
 * (normal) from "fetch failed / parser found nothing on a populated page"
 * (breakage). Health tracking depends on this split.
 */
export interface ScrapeOutcome {
  source: string;
  ok: boolean; // fetch itself succeeded
  pageHadContent: boolean; // page had a plausible product area / non-trivial body
  items: ScrapedItem[];
  error?: string;
  durationMs: number;
}

export interface Scraper {
  source: string;
  /** Reliability tier shown in UI. */
  tier: 'reliable' | 'api' | 'best-effort';
  search(query: string): Promise<ScrapeOutcome>;
}
