import type { StoredListing } from '../state/listings.ts';
import { conditionPolicyOf, type WishlistGame } from '../state/wishlist.ts';

/**
 * A listing already alerted at some price must beat that price by this much
 * before it alerts again. Without it a listing that oscillates 1450 → 1499 →
 * 1450 alerts every six hours forever.
 */
export const REALERT_RATIO = 0.95;

/** How far above target still earns a mention in the digest. */
export const NEAR_MISS_RATIO = 1.1;

export type GateReason =
  | 'ok'
  | 'seed'
  | 'kind_not_alertable'
  | 'match_not_auto'
  | 'not_wanted'
  | 'no_price'
  | 'out_of_stock'
  | 'foreign_currency'
  | 'no_target'
  | 'condition_blocked'
  | 'over_target'
  | 'not_better_than_last_alert';

export interface GateInput {
  listing: StoredListing;
  game: WishlistGame | undefined;
  seed: boolean;
  /** What we last told the user about this listing, from prior stored state. */
  lastAlertedPricePaise: number | null;
}

export interface GateResult {
  alert: boolean;
  reason: GateReason;
}

const block = (reason: GateReason): GateResult => ({ alert: false, reason });

/**
 * Decides whether one listing is worth interrupting the user for.
 *
 * The old rule was "matched, and not a game we own", which alerted on every
 * matched listing at any price across twelve stores. The price and condition
 * checks here are what turn an alert back into a claim — this is a buy at the
 * price you said you would pay.
 *
 * Pure and total: no I/O, no throwing, and the reason is always populated so
 * the digest can explain why something stayed quiet.
 */
export function evaluateGate(input: GateInput): GateResult {
  const { listing, game, seed, lastAlertedPricePaise } = input;

  if (seed) return block('seed');
  if (listing.matchStatus !== 'auto') return block('match_not_auto');
  if (!game || game.status !== 'wanted') return block('not_wanted');
  if (listing.pricePaise === null) return block('no_price');
  if (!listing.inStock) return block('out_of_stock');
  // An import price is indicative — duty and shipping are not in it, so it
  // cannot be compared against a rupee target. The digest still lists these.
  if (listing.currency !== 'INR') return block('foreign_currency');
  if (game.targetPaise === undefined) return block('no_target');
  if (!conditionAllowed(listing, game)) return block('condition_blocked');
  if (listing.pricePaise > game.targetPaise) return block('over_target');
  if (lastAlertedPricePaise !== null && listing.pricePaise > lastAlertedPricePaise * REALERT_RATIO) {
    return block('not_better_than_last_alert');
  }

  return { alert: true, reason: 'ok' };
}

/**
 * `sealed-only` rejects both `preowned` and `unknown`.
 *
 * Rejecting `unknown` is deliberate. These are exactly the titles where the
 * value sits in a one-time code, so a listing that does not state its condition
 * is the case we least want to guess on — and guessing generously here would
 * make the trap listings the loudest alerts we send.
 */
export function conditionAllowed(
  listing: Pick<StoredListing, 'condition'>,
  game: WishlistGame
): boolean {
  if (conditionPolicyOf(game) !== 'sealed-only') return true;
  return listing.condition === 'new';
}

/** Above target, but close enough that the digest should say so. */
export function isNearMiss(listing: StoredListing, game: WishlistGame | undefined): boolean {
  if (!game || game.status !== 'wanted' || game.targetPaise === undefined) return false;
  if (listing.pricePaise === null || !listing.inStock) return false;
  if (!conditionAllowed(listing, game)) return false;
  return (
    listing.pricePaise > game.targetPaise &&
    listing.pricePaise <= game.targetPaise * NEAR_MISS_RATIO
  );
}

/** How far under target, as a whole percent. 0 when at or above target. */
export function percentUnderTarget(pricePaise: number, targetPaise: number): number {
  if (targetPaise <= 0 || pricePaise >= targetPaise) return 0;
  return Math.round(((targetPaise - pricePaise) / targetPaise) * 100);
}
