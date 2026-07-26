import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateHealth, type HealthFile } from '../state/health.ts';
import type { ScrapeOutcome } from '../scrapers/types.ts';

const NOW = 1_774_454_400_000;
const out = (over: Partial<ScrapeOutcome>): ScrapeOutcome => ({
  source: 'S', ok: true, pageHadContent: true, items: [], durationMs: 5, ...over,
});

test('a good pass resets the failure count', () => {
  const { health } = updateHealth({ S: { status: 'degraded', consecutiveFailures: 2, lastOkAt: 0 } }, 'S', [out({})], NOW);
  assert.equal(health.S.status, 'ok');
  assert.equal(health.S.consecutiveFailures, 0);
  assert.equal(health.S.lastOkAt, NOW);
});

test('a real page with zero matches counts as healthy', () => {
  const { health } = updateHealth({}, 'S', [out({ items: [], pageHadContent: true })], NOW);
  assert.equal(health.S.status, 'ok');
});

test('a populated page that parsed nothing counts as a failure', () => {
  const { health } = updateHealth({}, 'S', [out({ ok: true, pageHadContent: false, error: 'parse empty' })], NOW);
  assert.equal(health.S.consecutiveFailures, 1);
  assert.equal(health.S.status, 'degraded');
});

test('three consecutive failures mark the source broken', () => {
  let health: HealthFile = {};
  let justBroke = false;
  for (let i = 0; i < 3; i++) {
    ({ health, justBroke } = updateHealth(health, 'S', [out({ ok: false, pageHadContent: false, error: 'HTTP 500' })], NOW));
  }
  assert.equal(health.S.status, 'broken');
  assert.equal(justBroke, true, 'the third failure must report justBroke');
});

test('justBroke fires only on the transition, not on every later failure', () => {
  let health: HealthFile = {};
  for (let i = 0; i < 3; i++) {
    ({ health } = updateHealth(health, 'S', [out({ ok: false, pageHadContent: false })], NOW));
  }
  const { justBroke } = updateHealth(health, 'S', [out({ ok: false, pageHadContent: false })], NOW);
  assert.equal(justBroke, false);
});

test('one good outcome among several rescues the pass', () => {
  const { health } = updateHealth({}, 'S', [
    out({ ok: false, pageHadContent: false }),
    out({ ok: true, pageHadContent: true }),
  ], NOW);
  assert.equal(health.S.status, 'ok');
});
