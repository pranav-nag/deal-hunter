import type { Scraper } from './types.ts';
import { gameloot } from './stores/gameloot.ts';
import { gamenation } from './stores/gamenation.ts';
import { gamestheshop } from './stores/gamestheshop.ts';
import { e2zstore } from './stores/e2zstore.ts';
import { hgworld } from './stores/hgworld.ts';
import { dacby } from './stores/dacby.ts';
import { nekavo } from './stores/nekavo.ts';
import { consolegarage } from './stores/consolegarage.ts';
import { cex } from './stores/cex.ts';
import { playasia } from './stores/playasia.ts';
import { amazon } from './stores/amazon.ts';
import { flipkart } from './stores/flipkart.ts';

export const ALL_SCRAPERS: Scraper[] = [
  gameloot, gamenation, gamestheshop, e2zstore, hgworld, dacby,
  nekavo, consolegarage, cex, playasia, amazon, flipkart,
];

export const SOURCE_LABELS: Record<string, string> = {
  GameLoot: 'GameLoot',
  GameNation: 'GameNation',
  GamesTheShop: 'Games The Shop',
  E2ZStore: 'E2Z Store',
  HGWorld: 'HGWorld',
  Dacby: 'Dacby',
  Nekavo: 'Nekavo',
  ConsoleGarage: 'Console Garage',
  CexIndia: 'CeX India',
  PlayAsia: 'Play-Asia',
  AmazonIn: 'Amazon.in',
  Flipkart: 'Flipkart',
};

export function getScraper(source: string): Scraper | undefined {
  return ALL_SCRAPERS.find((s) => s.source === source);
}
