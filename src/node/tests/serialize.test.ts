import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify, writeJsonStable, readJson } from '../lib/serialize.ts';

test('stableStringify sorts keys regardless of insertion order', () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
});

test('stableStringify sorts nested keys and ends with a newline', () => {
  const out = stableStringify({ z: { y: 1, x: 2 } });
  assert.equal(out, '{\n  "z": {\n    "x": 2,\n    "y": 1\n  }\n}\n');
});

test('stableStringify preserves array order', () => {
  assert.equal(stableStringify([3, 1, 2]), '[\n  3,\n  1,\n  2\n]\n');
});

test('readJson returns the fallback for a missing file', async () => {
  const got = await readJson(join(tmpdir(), 'definitely-absent-9f3a.json'), { n: 7 });
  assert.deepEqual(got, { n: 7 });
});

test('writeJsonStable round-trips and creates parent directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ser-'));
  const path = join(dir, 'nested', 'state.json');
  await writeJsonStable(path, { b: 1, a: [2, 3] });
  assert.equal(await readFile(path, 'utf8'), '{\n  "a": [\n    2,\n    3\n  ],\n  "b": 1\n}\n');
  assert.deepEqual(await readJson(path, null), { b: 1, a: [2, 3] });
});
