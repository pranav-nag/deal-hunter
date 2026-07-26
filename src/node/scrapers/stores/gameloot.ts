import { makeWooScraper, type WooConfig } from '../woocommerce.ts';

export const GAMELOOT_CONFIG: WooConfig = {
  source: 'GameLoot',
  baseUrl: 'https://gameloot.in',
  searchUrl: (q) => `https://gameloot.in/?s=${q}&post_type=product`,
  cardSelector: '.product_item',
  titleSelectors: ['.product_details h5'],
  linkSelectors: ['.product_item_link'],
  imageSelectors: ['.kad-woo-image-size img', 'img'],
  priceContainer: '.product_price',
  outOfStockSelector: '.out-of-stock, .outofstock',
};

export const gameloot = makeWooScraper(GAMELOOT_CONFIG);
