import type { DealEvent } from './diff.ts';

/** More alerting events than this in one pass means something is wrong, not lucky. */
export const MAX_ALERTS_PER_PASS = 8;

/**
 * A source re-reporting more than this share of its catalogue as new is not
 * finding deals — its listing keys have changed. Below this many stored
 * listings the ratio is too noisy to act on.
 */
export const CHURN_RATIO = 0.5;
export const CHURN_MIN_LISTINGS = 20;

export interface BreakerInput {
  events: DealEvent[];
  /** Stored listing count per source, after this pass. */
  listingCounts: Map<string, number>;
}

export interface BreakerResult {
  /** Events that should actually be sent as individual alerts. */
  send: DealEvent[];
  /** Events held back. Still recorded in state, still in the digest. */
  suppressed: DealEvent[];
  /** Populated when the breaker fired, for the summary message. */
  tripped: { kind: 'volume' | 'churn'; detail: string } | null;
}

/**
 * Last line of defence between a broken pass and the user's phone.
 *
 * The gate decides whether a listing is a good deal; this decides whether the
 * pass as a whole is trustworthy. A URL-shape change at one store re-keys every
 * listing, and each one then looks like a brand new deal — every alert
 * individually valid, the batch obviously wrong. Volume is the only signal
 * available at this layer, so volume is what it acts on.
 *
 * Suppressed events are never dropped: state still records them and the digest
 * still reports them. The only thing lost is the interruption.
 */
export function applyCircuitBreaker(input: BreakerInput): BreakerResult {
  const { events, listingCounts } = input;
  const alerting = events.filter((e) => e.alert);

  const churned = churnedSources(events, listingCounts);
  if (churned.length > 0) {
    const detail = churned
      .map(({ source, newListings, total }) => `${source} ${newListings}/${total} listings new`)
      .join(', ');
    const churnedNames = new Set(churned.map((c) => c.source));
    const send = alerting.filter((e) => !churnedNames.has(e.source));
    const suppressed = alerting.filter((e) => churnedNames.has(e.source));
    // Churn suppression can still leave a large volume behind, so fall through
    // to the volume check rather than returning early.
    if (send.length > MAX_ALERTS_PER_PASS) {
      return {
        send: [],
        suppressed: alerting,
        tripped: { kind: 'volume', detail: `${send.length} alerts, plus key churn: ${detail}` },
      };
    }
    return { send, suppressed, tripped: { kind: 'churn', detail } };
  }

  if (alerting.length > MAX_ALERTS_PER_PASS) {
    return {
      send: [],
      suppressed: alerting,
      tripped: { kind: 'volume', detail: `${alerting.length} alerts in one pass` },
    };
  }

  return { send: alerting, suppressed: [], tripped: null };
}

function churnedSources(
  events: DealEvent[],
  listingCounts: Map<string, number>
): Array<{ source: string; newListings: number; total: number }> {
  const newBySource = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'new_listing') continue;
    newBySource.set(event.source, (newBySource.get(event.source) ?? 0) + 1);
  }

  const out: Array<{ source: string; newListings: number; total: number }> = [];
  for (const [source, newListings] of newBySource) {
    const total = listingCounts.get(source) ?? 0;
    if (total < CHURN_MIN_LISTINGS) continue;
    if (newListings > total * CHURN_RATIO) out.push({ source, newListings, total });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}
