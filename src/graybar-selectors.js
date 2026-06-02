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

// The exact UPS search URL provided for the mission (Eaton / APC / Tripp Lite).
export const SEARCH_URL =
  'https://www.graybar.com/search/?q=query%3Aups%3Bsort%3Arelevance%3Bbrands%3AEaton%3Bbrands%3AAPC+%28Schneider+Electric%29%3Bbrands%3ATripp+Lite+%28Eaton%29&text=ups&enablePartNumberSearch=';

// Hybris pagination parameter (0-indexed). Page 2 => currentPage=1.
export const PAGE_PARAM = 'currentPage';

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
    email:
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[name="j_username"], input[autocomplete="username"], input[name="username"], input[placeholder*="email" i]',
    password:
      'input[type="password"], input[name="j_password"], input[name*="pass" i], input[id*="pass" i], input[autocomplete="current-password"]',
    submit:
      'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login")',
  },

  // Logged-in indicator (best effort — the real gate is "are prices visible").
  // When signed in, Graybar shows an account menu like "<First>'s Menu".
  account: 'a:has-text("Menu"), a:has-text("Sign Out"), a:has-text("Log Out"), [class*="account" i]',

  // Product result-row selectors (comma-separated candidate lists; first match
  // within each row wins). All fields optional -> null when absent.
  product: {
    card:
      '[class*="product-tile" i], [class*="productListItem" i], [class*="product-item" i], [class*="search-result" i], li[class*="product" i], article[class*="product" i], [data-product-code], [data-product-id]',
    title:
      '[class*="product-title" i] a, a[class*="product-name" i], [class*="productName" i] a, h2 a, h3 a, a[href*="/product/" i]',
    brand: '[class*="brand" i], [class*="manufacturer" i], [class*="vendor" i]',
    sku: '[class*="sku" i], [class*="product-code" i], [data-product-code], [class*="materialNumber" i]',
    mfr: '[class*="mfr" i], [class*="mpn" i], [class*="manufacturerPart" i], [class*="model" i], [class*="catalog" i]',
    category: '[class*="category" i], [class*="breadcrumb" i]',
    price: '[class*="price" i], [data-price], [itemprop="price"], [class*="Price"]',
    availability:
      '[class*="availab" i], [class*="stock" i], [class*="inventory" i], [class*="in-stock" i]',
    link: 'a[href*="/product/" i], a[href*="product" i], a[href]',
  },

  // Pager (to advance through result pages if URL paging needs a fallback).
  pager: {
    next: 'a[rel="next"], a:has-text("Next"), [class*="pagination" i] a[aria-label*="next" i], li.next a',
    countText: '[class*="results" i], [class*="product-count" i], [class*="searchResult" i]',
  },
};
