/**
 * Site configuration + best-effort selectors for the Graybar capture.
 *
 * graybar.com is an SAP Hybris/Commerce storefront (note the `q=query:ups:sort:
 * relevance:brands:...` query syntax). Results are paginated server-side. The
 * selectors below are broad starting points and will likely need one round of
 * tuning against a real authenticated run — the scraper writes login/search
 * diagnostics to the artifact to make that precise.
 */

export const BASE_URL = 'https://www.graybar.com';

// Best-guess login route; if the email field is not found here the scraper
// falls back to opening the login UI from the homepage.
export const LOGIN_URL = `${BASE_URL}/login`;

// Category + search URL are set per-category in the workflow matrix via env.
// A bare `npm run capture:graybar` defaults to the UPS capture.
export const CATEGORY = process.env.GRAYBAR_CATEGORY || 'ups';
export const SEARCH_URL =
  process.env.GRAYBAR_SEARCH_URL ||
  'https://www.graybar.com/search/?q=query%3Aups%3Bsort%3Arelevance%3Bbrands%3AEaton%3Bbrands%3AAPC+%28Schneider+Electric%29%3Bbrands%3ATripp+Lite+%28Eaton%29&text=ups&enablePartNumberSearch=';

// Pagination query parameter, 0-indexed (confirmed: &page=2 renders page "3").
export const PAGE_PARAM = 'page';

// Substrings used to recognise JSON XHR/fetch responses that may carry product
// data (Hybris OCC etc.). Matched case-insensitively against the response URL.
export const API_HINTS = [
  '/occ/',
  '/rest/',
  '/api/',
  '/search',
  'product',
  'pricing',
  'price',
  'availability',
  'inventory',
  'catalog',
  'p/details',
  '/details/',
  'storestock',
  'productlisting',
  'getprice',
];

export const SELECTORS = {
  login: {
    triggers: [
      'a:has-text("Sign In")',
      'a:has-text("Log In")',
      'a:has-text("Login")',
      'button:has-text("Sign In")',
      'a[href*="login" i]',
      '[data-testid*="login" i]',
    ],
    // Target the Hybris login field (j_username) specifically. NOTE: the page
    // also has a Pardot marketing newsletter field input[type=email]
    // (name=pardot_email) — we must NOT match that, so the generic email
    // selectors are intentionally excluded here.
    email:
      'input#j_username, input[name="j_username"], input[autocomplete="username"], input[type="text"][name="username"]',
    password:
      'input#j_password, input[name="j_password"], input[type="password"]:not([name="pardot_password"])',
    submit:
      'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login")',
  },

  // Logged-in indicator (best effort — the real gate is "are prices visible").
  // When signed in, Graybar shows an account menu like "<First>'s Menu".
  account: 'a:has-text("Menu"), a:has-text("Sign Out"), a:has-text("Log Out"), [class*="account" i]',

  // Product result-row selectors — confirmed against the authenticated search
  // page (SAP Hybris "product-listing_*" markup). SKU + MFR # come from
  // label/value pairs and are resolved in the extractor (capture-graybar.js).
  product: {
    card: '.js-product-list-item, .product-listing_product-wrapper, .product__list--item',
    title: '.product-listing_product-name .title a, .product-listing_product-name a, h3.title a',
    brand: '.product-listing_product-manufacturer .name, .product-listing_product-manufacturer',
    // SKU/MFR are label/value pairs; the extractor maps them by label text.
    labelPair: '.product-listing_product-detail, .product-listing_product-exp__group',
    label: '.product-listing_product-label',
    value: '.product-listing_product-value',
    category: '',
    // Prices populate asynchronously into these containers after page load.
    price: '.js-productListing-price, .product-listing_product-exp__price',
    availability:
      '.js-productListing-availability, .product-listing_product-exp__availability, .js-productList-storeStock, .product-listing_product-exp__stock',
    link: '.product-listing_product-name a, .product-listing_product-image a, a[href*="/p/"]',
  },

  // Pager (to advance through result pages if URL paging needs a fallback).
  pager: {
    next: 'a[rel="next"], a:has-text("Next"), [class*="pagination" i] a[aria-label*="next" i], li.next a',
    countText: '[class*="results" i], [class*="product-count" i], [class*="searchResult" i]',
  },
};
