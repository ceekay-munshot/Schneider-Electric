/**
 * Site configuration + best-effort selectors for the Rexel USA capture.
 *
 * IMPORTANT: rexelusa.com is a JavaScript single-page app (Salesforce
 * Experience Cloud style `/s/` routes). The exact DOM class names are not
 * publicly known and may sit inside web-component shadow roots. The selectors
 * below are deliberately broad, ordered candidate lists. They are a starting
 * point and will very likely need one round of tuning against a real
 * authenticated run.
 *
 * How to tune (no guessing required):
 *   1. Run the workflow once with debug on (or `npm run capture:rexel:debug`
 *      locally with credentials in env).
 *   2. Download the run artifact and open `raw-responses-*.json` — these are
 *      the JSON API payloads the page itself fetched. They usually contain the
 *      clean product fields and the exact endpoint paths.
 *   3. Adjust `API_HINTS` and/or the `SELECTORS.product.*` lists here.
 *
 * Playwright CSS locators pierce *open* shadow DOM automatically, so the
 * locator-based login + price gate are resilient even when querySelector is
 * not.
 */

export const BASE_URL = 'https://www.rexelusa.com';

// Best guess for the dedicated login route; if the email field is not found
// here the scraper falls back to opening the login UI from the homepage.
export const LOGIN_URL = `${BASE_URL}/s/login`;

// Exact search URL requested for the mission (UPS, large page size).
export const SEARCH_URL = 'https://www.rexelusa.com/s/search?q=UPS&show=10000';

// Substrings used to recognise the JSON XHR/fetch responses that carry product
// data. Matched case-insensitively against the response URL. Capturing these
// raw is the most robust acquisition path and is site-agnostic.
export const API_HINTS = [
  '/aura',
  '/webruntime',
  '/api/',
  '/services/',
  'search',
  'product',
  'commerce',
  'catalog',
  'pricing',
  'price',
  'inventory',
  'availability',
  'graphql',
];

export const SELECTORS = {
  login: {
    // Triggers to open a login modal/page from the homepage if needed.
    triggers: [
      'a:has-text("Sign In")',
      'a:has-text("Log In")',
      'a:has-text("Login")',
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
      'a[href*="login" i]',
      '[data-testid*="login" i]',
    ],
    email:
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"], input[name="username"], input[placeholder*="email" i]',
    password:
      'input[type="password"], input[name*="pass" i], input[id*="pass" i], input[autocomplete="current-password"]',
    submit:
      'button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In"), button:has-text("Sign in")',
  },

  // Optional hints that we reached a logged-in state (best effort, not
  // authoritative — the real success gate is "are prices visible").
  account: 'a:has-text("Sign Out"), a:has-text("Log Out"), [class*="account" i], [data-testid*="account" i]',

  // Product search-tile selectors. Comma-separated candidate lists; the first
  // match within each tile wins. All fields are optional and resolve to null
  // when absent on the tile (many fields, e.g. UPC, usually live on the
  // product detail page, not the search tile).
  product: {
    card:
      '[data-product-id], [data-productid], [data-sku], .product-tile, .product-card, .productCard, li.product, article.product, [class*="ProductTile"], [class*="product-tile"], [class*="productItem"], [class*="product-item"], [class*="search-result"]',
    title:
      '[class*="ProductName"], [class*="product-name"], [class*="product-title"], .product-title, h2 a, h3 a, a[class*="name" i], [class*="title" i] a',
    brand:
      '[class*="brand" i], [class*="manufacturer" i], .product-brand, [data-brand]',
    itemNumber:
      '[class*="item" i][class*="number" i], [class*="itemNumber" i], [class*="sku" i], [data-sku], .product-sku, [class*="catalogNumber" i]',
    catMpn:
      '[class*="mpn" i], [class*="catalog" i], [class*="model" i], [class*="manufacturerPart" i], [class*="mfr" i]',
    upc: '[class*="upc" i], [class*="gtin" i], [class*="ean" i]',
    category: '[class*="category" i], [class*="productLine" i], [class*="breadcrumb" i]',
    price:
      '[class*="price" i], [data-price], .product-price, [class*="Price"], [itemprop="price"]',
    uom: '[class*="uom" i], [class*="unitOfMeasure" i], [class*="unit-of-measure" i], [class*="per-unit" i]',
    availability:
      '[class*="availab" i], [class*="stock" i], [class*="inventory" i], [class*="in-stock" i]',
    link: 'a[href*="/p/" i], a[href*="product" i], a[href]',
  },
};
