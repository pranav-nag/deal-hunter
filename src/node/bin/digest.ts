#!/usr/bin/env -S npx tsx
import { runDigest } from '../digest/index.ts';

const summary = await runDigest();
console.log(`embeds=${summary.embeds} ok=${summary.ok}`);
if (!summary.ok) process.exitCode = 1;
