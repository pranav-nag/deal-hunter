import type { DealEvent } from '../events/diff.ts';
import type { PricePoint } from '../state/prices.ts';
import type { StoredListing } from '../state/listings.ts';
import { conditionPolicyOf, type WishlistGame } from '../state/wishlist.ts';
import { percentUnderTarget } from '../events/gate.ts';
import { formatPaise } from '../lib/money.ts';
import { SOURCE_LABELS } from '../scrapers/index.ts';

/** Discord allows bursts, but 1s between messages keeps us clear of 429s. */
const THROTTLE_MS = 1000;

/**
 * Discord's documented payload limits. Exceeding any of these is a silent
 * failure — the request 400s and the alert is simply never delivered — so the
 * batcher enforces them rather than hoping embeds stay small.
 */
export const MAX_EMBEDS_PER_MESSAGE = 10;
export const MAX_CHARS_PER_MESSAGE = 6000;
const MAX_TITLE = 256;
const MAX_FIELD_VALUE = 1024;

/** Green through amber by how far under target. Quality, not event kind. */
const COLOUR_DEEP_SAVING = 0x1f8b4c;
const COLOUR_GOOD_SAVING = 0x7fb800;
const COLOUR_AT_TARGET = 0xe0a800;
const COLOUR_BREAKER = 0xe67e22;
const COLOUR_BROKEN = 0xe74c3c;

export interface PriceStats {
  seenCount: number;
  lowPaise: number | null;
  highPaise: number | null;
  firstSeen: number | null;
}

export interface AlternativeListing {
  source: string;
  pricePaise: number | null;
  condition: StoredListing['condition'];
}

export interface DealContext {
  game: WishlistGame | undefined;
  stats: PriceStats;
  /** Same game at other stores, cheapest first, excluding the alerting listing. */
  alternatives: AlternativeListing[];
}

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  url?: string;
  color?: number;
  description?: string;
  author?: { name: string };
  thumbnail?: { url: string };
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
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

const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

const conditionLabel = (condition: StoredListing['condition']) =>
  condition === 'preowned' ? 'Pre-owned' : condition === 'new' ? 'Sealed' : 'Condition unknown';

function tierLabel(game: WishlistGame | undefined): string {
  const policy = game ? conditionPolicyOf(game) : 'either';
  const policyText =
    policy === 'sealed-only' ? 'sealed only' : policy === 'prefer-used' ? 'used is safe' : 'either condition';
  switch (game?.tier) {
    case 1:
      return `Tier 1 · buy immediately · ${policyText}`;
    case 2:
      return `Tier 2 · buy sealed · ${policyText}`;
    case 3:
      return `Tier 3 · waiting on price · ${policyText}`;
    default:
      return policyText;
  }
}

function qualityColour(pricePaise: number | null, targetPaise: number | undefined): number {
  if (pricePaise === null || targetPaise === undefined) return COLOUR_AT_TARGET;
  const pct = percentUnderTarget(pricePaise, targetPaise);
  if (pct >= 30) return COLOUR_DEEP_SAVING;
  if (pct >= 15) return COLOUR_GOOD_SAVING;
  return COLOUR_AT_TARGET;
}

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + '…');

/**
 * One embed per game, not per listing.
 *
 * The title is the wishlist title rather than the store's string, because the
 * store string is what made the old channel unscannable — you read four lines
 * of SKU noise before learning which game it was. The store's own title stays
 * available behind the link.
 */
export function buildDealEmbed(event: DealEvent, ctx: DealContext): Embed {
  const l = event.listing;
  const { game, stats, alternatives } = ctx;
  const fields: EmbedField[] = [];

  const priceLines = [`**${formatPaise(l.pricePaise)}**`];
  if (game?.targetPaise !== undefined && l.pricePaise !== null) {
    const pct = percentUnderTarget(l.pricePaise, game.targetPaise);
    priceLines.push(
      pct > 0
        ? `${pct}% under your ${formatPaise(game.targetPaise)} target`
        : `at your ${formatPaise(game.targetPaise)} target`
    );
  }
  if (event.previousPricePaise !== null) {
    priceLines.push(`was ${formatPaise(event.previousPricePaise)}`);
  }
  if (l.originalPricePaise !== null) priceLines.push(`MRP ${formatPaise(l.originalPricePaise)}`);

  fields.push({ name: 'Price', value: clip(priceLines.join('\n'), MAX_FIELD_VALUE), inline: true });
  fields.push({ name: 'Condition', value: conditionLabel(l.condition), inline: true });
  fields.push({ name: 'Store', value: sourceLabel(event.source), inline: true });

  if (stats.seenCount > 0) {
    fields.push({
      name: 'History',
      value: `low ${formatPaise(stats.lowPaise)} · high ${formatPaise(stats.highPaise)} · seen ${stats.seenCount}×`,
      inline: false,
    });
  }

  if (alternatives.length > 0) {
    const value = alternatives
      .slice(0, 3)
      .map((a) => `${sourceLabel(a.source)} ${formatPaise(a.pricePaise)} ${conditionLabel(a.condition).toLowerCase()}`)
      .join(' · ');
    fields.push({ name: 'Also available', value: clip(value, MAX_FIELD_VALUE), inline: false });
  }

  if (game?.verdict) {
    fields.push({ name: 'Why', value: clip(game.verdict, MAX_FIELD_VALUE), inline: false });
  }

  const warnings: string[] = [];
  if (l.currency !== 'INR') warnings.push(`⚠️ listed in ${l.currency} — import, price is indicative`);
  if (l.matchStatus === 'pending') warnings.push(`match unconfirmed (${l.matchScore.toFixed(2)})`);
  if (warnings.length > 0) {
    fields.push({ name: 'Note', value: clip(warnings.join('\n'), MAX_FIELD_VALUE), inline: false });
  }

  const embed: Embed = {
    author: { name: clip(tierLabel(game), MAX_TITLE) },
    title: clip(game?.title ?? l.title, MAX_TITLE),
    url: l.url,
    color: qualityColour(l.pricePaise, game?.targetPaise),
    fields,
    footer: { text: `${event.kind.replace('_', ' ')} · ${sourceLabel(event.source)}` },
    timestamp: new Date(l.lastSeen).toISOString(),
  };
  if (l.imageUrl) embed.thumbnail = { url: l.imageUrl };
  return embed;
}

/**
 * Discord counts an embed's length as the sum of its text fields, and rejects a
 * message whose embeds total over 6000 characters.
 */
export function embedLength(embed: Embed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  total += embed.footer?.text.length ?? 0;
  total += embed.author?.name.length ?? 0;
  for (const field of embed.fields ?? []) total += field.name.length + field.value.length;
  return total;
}

/** Split embeds into messages that satisfy both the count and character limits. */
export function chunkEmbeds(embeds: Embed[]): Embed[][] {
  const chunks: Embed[][] = [];
  let current: Embed[] = [];
  let chars = 0;
  for (const embed of embeds) {
    const length = embedLength(embed);
    if (current.length > 0 && (current.length >= MAX_EMBEDS_PER_MESSAGE || chars + length > MAX_CHARS_PER_MESSAGE)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(embed);
    chars += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type Channel = 'deals' | 'log';

/**
 * The log channel falls back to the deals webhook when unconfigured, so a
 * single-webhook setup still works — it just loses the separation.
 */
function webhookFor(channel: Channel): string | undefined {
  const deals = process.env.DISCORD_WEBHOOK_URL;
  if (channel === 'deals') return deals;
  return process.env.DISCORD_DIGEST_WEBHOOK_URL || deals;
}

async function post(channel: Channel, payload: object): Promise<boolean> {
  const url = webhookFor(channel);
  if (!url) {
    console.log(`[mock discord:${channel}]`, JSON.stringify(payload));
    return true;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`discord POST failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('discord POST failed:', error);
    return false;
  }
}

async function postEmbeds(channel: Channel, embeds: Embed[]): Promise<boolean> {
  let allOk = true;
  const chunks = chunkEmbeds(embeds);
  for (const [index, chunk] of chunks.entries()) {
    if (!(await post(channel, { embeds: chunk }))) allOk = false;
    if (index < chunks.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }
  return allOk;
}

/**
 * Collapse events to one per game, keeping the cheapest.
 *
 * Twelve stores carrying the same game used to mean twelve notifications. The
 * others are not discarded — they become the "also available" comparison inside
 * the surviving embed.
 */
export function bestPerGame(events: DealEvent[]): DealEvent[] {
  const best = new Map<string, DealEvent>();
  for (const event of events) {
    const groupKey = event.listing.gameSlug ?? `key:${event.key}`;
    const held = best.get(groupKey);
    if (!held) {
      best.set(groupKey, event);
      continue;
    }
    const a = event.listing.pricePaise;
    const b = held.listing.pricePaise;
    if (a !== null && (b === null || a < b)) best.set(groupKey, event);
  }
  return [...best.values()].sort((a, b) => (a.listing.pricePaise ?? 0) - (b.listing.pricePaise ?? 0));
}

/**
 * Sends the pass's buy alerts and reports which listings were actually
 * delivered, so only those get stamped as announced.
 */
export async function sendDealAlerts(
  events: DealEvent[],
  lookup: (event: DealEvent) => DealContext
): Promise<Array<{ source: string; key: string; pricePaise: number }>> {
  const chosen = bestPerGame(events);
  if (chosen.length === 0) return [];

  const embeds = chosen.map((event) => buildDealEmbed(event, lookup(event)));
  if (!(await postEmbeds('deals', embeds))) return [];

  return chosen
    .filter((e) => e.listing.pricePaise !== null)
    .map((e) => ({ source: e.source, key: e.key, pricePaise: e.listing.pricePaise as number }));
}

export async function sendBreakerSummary(
  detail: string,
  suppressed: DealEvent[]
): Promise<void> {
  const byGame = new Map<string, number>();
  for (const event of suppressed) {
    const name = event.listing.gameSlug ?? 'unmatched';
    byGame.set(name, (byGame.get(name) ?? 0) + 1);
  }
  const breakdown = [...byGame.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, count]) => `${slug} ×${count}`)
    .join('\n');

  await post('log', {
    embeds: [
      {
        title: '⚠️ Alerts held back',
        color: COLOUR_BREAKER,
        description:
          `${detail}. Nothing was sent to the deals channel — a batch this size usually means ` +
          `listing keys changed, not that ${suppressed.length} real deals appeared at once.\n\n` +
          `Everything is still recorded in state and will appear in the digest.`,
        fields: breakdown ? [{ name: 'Held back', value: clip(breakdown, MAX_FIELD_VALUE) }] : [],
      },
    ],
  });
}

export async function sendBrokenSourceAlert(source: string, error: string): Promise<void> {
  await post('log', {
    embeds: [
      {
        title: `⚠️ Scraper broken: ${sourceLabel(source)}`,
        color: COLOUR_BROKEN,
        description: `Three consecutive failed passes.\n\`\`\`${error.slice(0, 500)}\`\`\``,
      },
    ],
  });
}

/** Used by the digest job, which builds its own embeds and posts one message. */
export async function sendLogEmbeds(embeds: Embed[]): Promise<boolean> {
  if (embeds.length === 0) return true;
  return postEmbeds('log', embeds);
}
