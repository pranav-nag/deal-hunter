import { JSDOM } from 'jsdom';
import { isPathAllowed } from './robots.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  Referer: 'https://www.google.com/',
  'Upgrade-Insecure-Requests': '1',
};

// Per-domain politeness: minimum gap between requests to the same host, with jitter.
const lastRequestAt = new Map<string, number>();
const MIN_GAP_MS = 1500;

async function politeDelay(url: string): Promise<void> {
  const host = new URL(url).host;
  const last = lastRequestAt.get(host) ?? 0;
  const gap = MIN_GAP_MS + Math.random() * 700;
  const wait = last + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

export async function fetchHtml(
  url: string,
  timeoutMs = 10000
): Promise<{ html: string | null; error?: string }> {
  try {
    if (!(await isPathAllowed(url))) {
      return { html: null, error: 'blocked by robots.txt' };
    }
    await politeDelay(url);
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) return { html: null, error: `HTTP ${response.status}` };
    return { html: await response.text() };
  } catch (error) {
    return { html: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchAndParse(
  url: string,
  timeoutMs = 10000
): Promise<{ doc: Document | null; html: string | null; error?: string }> {
  const { html, error } = await fetchHtml(url, timeoutMs);
  if (!html) return { doc: null, html: null, error };
  const dom = new JSDOM(html);
  return { doc: dom.window.document as unknown as Document, html };
}

export async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 10000
): Promise<{ data: T | null; error?: string }> {
  try {
    // Gated too, not just fetchHtml: an API-tier scraper is still a crawler,
    // and a gate on only the HTML path leaves the compliance claim half true.
    if (!(await isPathAllowed(url))) {
      return { data: null, error: 'blocked by robots.txt' };
    }
    await politeDelay(url);
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { data: null, error: `HTTP ${response.status}` };
    return { data: (await response.json()) as T };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function getImageSrc(element: Element | null): string {
  if (!element) return '';
  return (
    element.getAttribute('data-src') ||
    element.getAttribute('data-lazy-src') ||
    element.getAttribute('srcset')?.split(' ')[0] ||
    element.getAttribute('src') ||
    ''
  );
}

/** Strip tracking/session params so listing identity stays stable across runs. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const junk = [...u.searchParams.keys()].filter(
      (k) =>
        /^utm_|^fbclid|^gclid|^ref$|^srsltid|^_ga|^mc_|^igshid/i.test(k)
    );
    junk.forEach((k) => u.searchParams.delete(k));
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}
