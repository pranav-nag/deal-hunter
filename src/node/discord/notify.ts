import type { DealEvent } from '../events/diff.ts';
import type { PricePoint } from '../state/prices.ts';
import type { WishlistGame } from '../state/wishlist.ts';
import { formatPaise } from '../lib/money.ts';
import { SOURCE_LABELS } from '../scrapers/index.ts';

const COLOURS: Record<DealEvent['kind'], number> = {
  new_listing: 0x3498db,
  price_drop: 0x2ecc71,
  restock: 0xe67e22,
  price_rise: 0x95a5a6,
  gone: 0x7f8c8d,
};

/** Discord allows bursts, but 1s between posts keeps us clear of 429s. */
const THROTTLE_MS = 1000;

export interface PriceStats {
  seenCount: number;
  lowPaise: number | null;
  highPaise: number | null;
  firstSeen: number | null;
}

export function computeStats(points: PricePoint[], key: string): PriceStats {
  const mine = points.filter((p) => p.key === key && p.pricePaise !== null);
  if (mine.length === 0) return { seenCount: 0, lowPaise: null, highPaise: null, firstSeen: null };
  const prices = mine.map((p) => p.pricePaise as number);
  return {
    seenCount: mine.length,
    lowPaise: Math.min(...prices),
    highPaise: Math.max(...prices),
    firstSeen: Math.min(...mine.map((p) => p.ts)),
  };
}

export function buildEmbed(event: DealEvent, game: WishlistGame | undefined, stats: PriceStats): object {
  const l = event.listing;
  const lines: string[] = [];

  const price = formatPaise(l.pricePaise);
  const was = event.previousPricePaise !== null ? `  was ${formatPaise(event.previousPricePaise)}` : '';
  const mrp = l.originalPricePaise !== null ? `  MRP ${formatPaise(l.originalPricePaise)}` : '';
  lines.push(`**${price}**${was}${mrp}`);

  if (stats.seenCount > 0) {
    lines.push(`seen ${stats.seenCount}× · low ${formatPaise(stats.lowPaise)} · high ${formatPaise(stats.highPaise)}`);
  }
  if (game?.status === 'owned' && game.paidPaise) {
    lines.push(`you paid ${formatPaise(game.paidPaise)} ${game.condition ?? ''}`.trim());
  }
  if (game?.notes) lines.push(`_${game.notes}_`);

  const conditionLabel = l.condition === 'preowned' ? 'Pre-owned' : l.condition === 'new' ? 'New' : 'Condition unknown';
  const stock = l.inStock ? 'in stock' : 'out of stock';
  lines.push(`${conditionLabel} · ${SOURCE_LABELS[event.source] ?? event.source} · ${stock}`);
  if (l.currency !== 'INR') lines.push(`⚠️ listed in ${l.currency} — import, price is indicative`);
  if (l.matchStatus === 'pending') lines.push(`_match unconfirmed (${l.matchScore.toFixed(2)})_`);

  return {
    title: l.title.slice(0, 250),
    url: l.url,
    color: COLOURS[event.kind],
    description: lines.join('\n'),
    footer: { text: event.kind.replace('_', ' ') },
  };
}

async function post(payload: object): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log('[mock discord]', JSON.stringify(payload));
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) console.error(`discord POST failed: HTTP ${res.status}`);
}

export async function sendEvents(
  events: DealEvent[],
  lookup: (event: DealEvent) => { game?: WishlistGame; stats: PriceStats }
): Promise<number> {
  let sent = 0;
  for (const event of events.filter((e) => e.alert)) {
    const { game, stats } = lookup(event);
    await post({ embeds: [buildEmbed(event, game, stats)] });
    sent++;
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }
  return sent;
}

export async function sendBrokenSourceAlert(source: string, error: string): Promise<void> {
  await post({
    embeds: [{
      title: `⚠️ Scraper broken: ${SOURCE_LABELS[source] ?? source}`,
      color: 0xe74c3c,
      description: `Three consecutive failed passes.\n\`\`\`${error.slice(0, 500)}\`\`\``,
    }],
  });
}
