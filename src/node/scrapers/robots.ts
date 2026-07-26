interface Rule {
  /** The raw pattern, kept because longest-pattern-wins is the tie-break. */
  pattern: string;
  match: RegExp;
  allow: boolean;
}

export interface RobotsRules {
  isAllowed(pathAndQuery: string): boolean;
}

/**
 * Hosts whose robots.txt is deliberately overridden.
 *
 * GameLoot disallows `/?s=`, which is the only search endpoint its storefront
 * exposes and the one this worker depends on. Operator decision, recorded here
 * rather than left to hide in a matcher bug: the pass runs 4x a day against a
 * single small storefront, at the same 1.5s per-host gap as everything else.
 * Everything outside this set is enforced for real.
 */
export const ROBOTS_OVERRIDES = new Set(['gameloot.in', 'www.gameloot.in']);

/**
 * robots.txt patterns are prefix matches over path *and* query, with `*` as a
 * wildcard and a trailing `$` anchoring the end. A matcher that compares
 * pathname alone silently permits every query-string rule — which is most of
 * them on a WooCommerce store.
 */
function ruleToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Minimal robots.txt matcher: only the `*` group, longest-pattern-wins, Allow
 * beats Disallow on equal length. It fails open — an unparseable or absent file
 * allows everything.
 */
export function parseRobots(text: string, userAgent = '*'): RobotsRules {
  const rules: Rule[] = [];
  let inGroup = false;

  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      inGroup = value === '*' || value.toLowerCase() === userAgent.toLowerCase();
      continue;
    }
    if (!inGroup) continue;
    if (field !== 'disallow' && field !== 'allow') continue;
    // `Disallow:` with no value is the explicit "allow everything" form.
    if (!value) continue;
    rules.push({ pattern: value, match: ruleToRegex(value), allow: field === 'allow' });
  }

  return {
    isAllowed(pathAndQuery: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.match.test(pathAndQuery)) continue;
        if (!best || rule.pattern.length > best.pattern.length) best = rule;
        else if (rule.pattern.length === best.pattern.length && rule.allow) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

const cache = new Map<string, RobotsRules>();

/** Fetches and caches robots.txt per host for the process lifetime. */
export async function isPathAllowed(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (ROBOTS_OVERRIDES.has(parsed.host)) return true;

  let rules = cache.get(parsed.host);
  if (!rules) {
    let text = '';
    try {
      const res = await fetch(`${parsed.origin}/robots.txt`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) text = await res.text();
    } catch {
      text = '';
    }
    rules = parseRobots(text);
    cache.set(parsed.host, rules);
  }
  return rules.isAllowed(parsed.pathname + parsed.search);
}
