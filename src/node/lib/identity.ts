// Title normalization + platform/edition/condition extraction.
// Evolved from gameScout shared/gameIdentity.ts.

export type Platform = 'ps4' | 'ps5' | 'xbox' | 'switch' | 'pc' | '';

const CONDITION_TOKENS =
  /\b(pre[\s-]*owned|preowned|used|second[\s-]*hand|refurbished|sealed|brand\s*new|new)\b/gi;
const STOCK_NOISE = /\b(in\s*stock|out\s*of\s*stock|pre[\s-]*order|preorder|sold\s*out)\b/gi;
const SEO_NOISE = /\b(buy|online|for|sale|disc|cd|dvd|physical|standard)\b/gi;

const EDITION_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: 'goty', re: /\b(game\s*of\s*the\s*year|goty)\b/i },
  { key: 'complete', re: /\bcomplete(\s*edition)?\b/i },
  { key: 'ultimate', re: /\bultimate(\s*edition)?\b/i },
  { key: 'deluxe', re: /\bdeluxe(\s*edition)?\b/i },
  { key: 'gold', re: /\bgold(\s*edition)?\b/i },
  { key: 'definitive', re: /\bdefinitive(\s*edition)?\b/i },
  { key: 'directors-cut', re: /\bdirector'?s\s*cut\b/i },
  { key: 'remastered', re: /\bremaster(ed)?\b/i },
  { key: 'anniversary', re: /\banniversary(\s*edition)?\b/i },
  { key: 'collectors', re: /\bcollector'?s(\s*edition)?\b/i },
  { key: 'legacy', re: /\blegacy(\s*edition)?\b/i },
  { key: 'launch', re: /\blaunch(\s*edition)?\b/i },
  { key: 'shadow-of-the-erdtree', re: /\bshadow\s*of\s*the\s*erdtree\b/i },
];

export function detectPlatform(title: string): Platform {
  const t = title.toLowerCase();
  if (/\bps\s*5\b|\bps5\b|playstation\s*5/.test(t)) return 'ps5';
  if (/\bps\s*4\b|\bps4\b|playstation\s*4/.test(t)) return 'ps4';
  if (/\bxbox\b|series\s*[xs]\b/.test(t)) return 'xbox';
  if (/\bswitch\b|\bnintendo\b/.test(t)) return 'switch';
  if (/\bpc\b|\bsteam\b/.test(t)) return 'pc';
  return '';
}

export function detectCondition(title: string): 'new' | 'preowned' | 'unknown' {
  const t = title.toLowerCase();
  if (/pre[\s-]*owned|preowned|\bused\b|second[\s-]*hand|refurbished/.test(t)) return 'preowned';
  if (/brand\s*new|\bsealed\b/.test(t)) return 'new';
  return 'unknown';
}

/** Ordered list of edition keys found in a title (empty = base game). */
export function detectEditions(title: string): string[] {
  const found: string[] = [];
  for (const { key, re } of EDITION_PATTERNS) {
    if (re.test(title)) found.push(key);
  }
  return found;
}

/** Core title with platform/condition/stock/SEO noise stripped, editions KEPT. */
export function cleanTitle(title: string): string {
  if (!title) return '';
  return title
    .split('|')[0]
    .split(' – ')[0]
    .toLowerCase()
    .replace(/\((?:[^)]*)\)/g, ' ') // parenthetical qualifiers
    .replace(/\b(ps\s*[45]|playstation\s*[45]|xbox(\s*series\s*[xs])?|one|switch|nintendo|pc)\b/gi, ' ')
    .replace(CONDITION_TOKENS, ' ')
    .replace(STOCK_NOISE, ' ')
    .replace(SEO_NOISE, ' ')
    .replace(/\bgames?\b/gi, ' ')
    .replace(/[']/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable normalized key for match-memory: cleaned title (editions kept, since
 * editions are different SKUs) + platform. Cosmetic title changes map to same key.
 */
export function normTitleKey(title: string): string {
  const platform = detectPlatform(title);
  const core = cleanTitle(title).replace(/[^a-z0-9]/g, '');
  return platform ? `${core}_${platform}` : core;
}

/** Title with editions ALSO stripped — used to match against canonical base game names. */
export function baseTitle(title: string): string {
  let t = cleanTitle(title);
  for (const { re } of EDITION_PATTERNS) t = t.replace(re, ' ');
  return t
    .replace(/\bedition\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
