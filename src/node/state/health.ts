import { readJson, writeJsonStable } from '../lib/serialize.ts';
import { HEALTH_PATH } from './paths.ts';
import type { ScrapeOutcome } from '../scrapers/types.ts';

export interface SourceHealth {
  status: 'ok' | 'degraded' | 'broken';
  consecutiveFailures: number;
  lastOkAt: number;
  lastError?: string;
}

export type HealthFile = Record<string, SourceHealth>;

const BROKEN_AFTER = 3;

/**
 * A source is healthy if any query in the pass returned a real page.
 *
 * pageHadContent is the load-bearing distinction: a site returning a real page
 * with zero matches is normal, while a parser finding nothing on a populated
 * page is breakage. A silently dead scraper is worse than no scraper.
 */
export function updateHealth(
  current: HealthFile,
  source: string,
  outcomes: ScrapeOutcome[],
  now: number
): { health: HealthFile; justBroke: boolean } {
  const prior = current[source] ?? { status: 'ok' as const, consecutiveFailures: 0, lastOkAt: 0 };
  const anyGood = outcomes.some((o) => o.ok && o.pageHadContent);

  if (anyGood) {
    return {
      health: { ...current, [source]: { status: 'ok', consecutiveFailures: 0, lastOkAt: now } },
      justBroke: false,
    };
  }

  const consecutiveFailures = prior.consecutiveFailures + 1;
  const status = consecutiveFailures >= BROKEN_AFTER ? 'broken' : 'degraded';
  const justBroke = status === 'broken' && prior.status !== 'broken';

  return {
    health: {
      ...current,
      [source]: {
        status,
        consecutiveFailures,
        lastOkAt: prior.lastOkAt,
        lastError: outcomes.find((o) => o.error)?.error ?? 'no successful fetch',
      },
    },
    justBroke,
  };
}

export const loadHealth = () => readJson<HealthFile>(HEALTH_PATH, {});
export const saveHealth = (health: HealthFile) => writeJsonStable(HEALTH_PATH, health);
