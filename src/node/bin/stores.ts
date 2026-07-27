#!/usr/bin/env -S npx tsx
import { runPass } from '../pass.ts';
import { closeBrowser } from '../scrapers/browser.ts';

const args = process.argv.slice(2);
const seed = args.includes('--seed');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1]?.split(',') : undefined;

try {
  const summary = await runPass({ seed, only });
  console.log(
    `sources=${summary.sources} events=${summary.events} ` +
      `alerts=${summary.alerts} suppressed=${summary.suppressed}`
  );
} finally {
  // The browser is a module-level singleton shared across scrapers, so no
  // individual scraper can own closing it. Left open, its chromium process
  // keeps the event loop alive and the process never exits — the pass then
  // burns the workflow's whole timeout and the commit step never runs, which
  // means state is silently never persisted. Seen for real: three consecutive
  // passes finished their work, hung, and threw all their state away.
  await closeBrowser();
}
