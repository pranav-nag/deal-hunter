import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pricesPath } from './paths.ts';

export interface PricePoint {
  ts: number;
  key: string;
  pricePaise: number | null;
  inStock: boolean;
}

/**
 * Append-only. One line per observed change — never rewritten, so each commit
 * adds lines rather than restating the file.
 */
export async function appendPrices(source: string, points: PricePoint[]): Promise<void> {
  if (points.length === 0) return;
  const path = pricesPath(source);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, points.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
}

export async function readPrices(source: string): Promise<PricePoint[]> {
  try {
    const text = await readFile(pricesPath(source), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PricePoint);
  } catch {
    return [];
  }
}
