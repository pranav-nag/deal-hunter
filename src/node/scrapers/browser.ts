// Shared Playwright helper for best-effort sources (JS-rendered / bot-protected).
// Playwright is a hard dependency but browser launch can still fail — every
// caller must handle a null page result and report "degraded".

import type { Browser, BrowserContext, Page } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
    })();
  }
  return browserPromise;
}

export interface BrowserSession {
  page: Page;
  close: () => Promise<void>;
}

/** Open a page with realistic fingerprint. Caller MUST call close() (kills context). */
export async function openPage(timeoutMs: number): Promise<BrowserSession | null> {
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-IN',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const ctx = context;
    return {
      page,
      close: async () => {
        // Kill the whole context so a hung page can't stall the pass.
        await ctx.close().catch(() => {});
      },
    };
  } catch {
    await context?.close().catch(() => {});
    return null;
  }
}

/** Fetch a URL's HTML through the real browser (for TLS-fingerprint blocks). */
export async function fetchHtmlViaBrowser(
  url: string,
  timeoutMs = 25000,
  waitSelector?: string
): Promise<string | null> {
  const session = await openPage(timeoutMs);
  if (!session) return null;
  try {
    await session.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (waitSelector) {
      await session.page.waitForSelector(waitSelector, { timeout: 8000 }).catch(() => {});
    }
    return await session.page.content();
  } catch {
    return null;
  } finally {
    await session.close();
  }
}

/** Fetch JSON through the browser context (same-origin fetch inside the page). */
export async function fetchJsonViaBrowser<T>(
  originUrl: string,
  apiUrl: string,
  timeoutMs = 25000
): Promise<T | null> {
  const session = await openPage(timeoutMs);
  if (!session) return null;
  try {
    await session.page.goto(originUrl, { waitUntil: 'domcontentloaded' });
    return (await session.page.evaluate(async (url: string) => {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return res.json();
    }, apiUrl)) as T | null;
  } catch {
    return null;
  } finally {
    await session.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
    browserPromise = null;
  }
}
