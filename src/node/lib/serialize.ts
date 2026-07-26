import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * JSON with keys sorted at every level, two-space indent, trailing newline.
 *
 * State files are rewritten in full on every pass and committed to git, so
 * output has to be byte-identical when the data is. Unsorted keys would make
 * every commit a whole-file diff.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2) + '\n';
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

export async function writeJsonStable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableStringify(value), 'utf8');
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
