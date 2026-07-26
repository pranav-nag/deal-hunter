import { makeWooScraper } from '../woocommerce.ts';

export const nekavo = makeWooScraper({
  source: 'Nekavo',
  baseUrl: 'https://nekavo.com',
  searchUrl: (q) => `https://nekavo.com/?s=${q}&post_type=product`,
  cardSelector: '.wd-product-wrapper.product-wrapper',
  titleSelectors: ['.wd-entities-title a', 'h3.wd-entities-title'],
  linkSelectors: ['.wd-entities-title a', 'a.product-image-link'],
  imageSelectors: ['.wd-product-thumb img', 'img'],
  priceContainer: '.price',
  outOfStockSelector: '.wd-product-stock.out-of-stock, .out-of-stock',
});
