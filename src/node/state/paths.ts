import { join, resolve } from 'node:path';

/** Repo root, two levels up from src/node. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const STATE_DIR = join(REPO_ROOT, 'state');

export const WISHLIST_PATH = join(STATE_DIR, 'wishlist.json');
export const HEALTH_PATH = join(STATE_DIR, 'health.json');

const fileKey = (source: string) => source.toLowerCase();

export const listingsPath = (source: string) =>
  join(STATE_DIR, 'listings', `${fileKey(source)}.json`);

export const pricesPath = (source: string) =>
  join(STATE_DIR, 'prices', `${fileKey(source)}.jsonl`);
