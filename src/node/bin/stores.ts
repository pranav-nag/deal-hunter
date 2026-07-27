#!/usr/bin/env -S npx tsx
import { runPass } from '../pass.ts';

const args = process.argv.slice(2);
const seed = args.includes('--seed');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1]?.split(',') : undefined;

const summary = await runPass({ seed, only });
console.log(
  `sources=${summary.sources} events=${summary.events} ` +
    `alerts=${summary.alerts} suppressed=${summary.suppressed}`
);
