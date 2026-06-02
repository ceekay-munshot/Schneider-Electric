#!/usr/bin/env node
/**
 * Rexel USA — authenticated UPS product capture.
 *
 * Credentials are read from environment variables ONLY:
 *   - process.env.REXELUSA_EMAIL
 *   - process.env.REXELUSA_PASSWORD
 * (These map 1:1 to the GitHub Actions secrets REXELUSA_EMAIL / REXELUSA_PASSWORD.)
 *
 * Safety & ethics (enforced in code):
 *   - Normal interactive login only. This script NEVER attempts to solve or
 *     bypass CAPTCHA, MFA/OTP, bot-protection, or any access control. If such a
 *     challenge is detected it stops and reports `auth_failed_or_price_hidden`.
 *   - Conservative, jittered delays between actions (see DELAYS), single browser,
 *     fully sequential — no parallel hammering of the site.
 *   - Credential VALUES are never printed, logged, or written to disk. Debug
 *     output is limited to counts and field-presence booleans.
 *   - Prices are treated as the success gate: if the logged-in page shows no
 *     prices, the run is marked `auth_failed_or_price_hidden` and exits non-zero
 *     instead of writing bad/empty data as if it were good.
 *
 * Exit codes:
 *   0  success (prices visible, products captured) — or a soft-failed run when
 *      REXEL_SOFT_FAIL=1
 *   1  unexpected error
 *   2  missing required credential env var(s)
 *   3  auth_failed_or_price_hidden (default; set REXEL_SOFT_FAIL=1 to exit 0)
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BASE_URL, LOGIN_URL, SEARCH_URL, SELECTORS, API_HINTS } from './selectors.js';

// ---------------------------------------------------------------------------
// Configuration (all tunable via env; safe defaults baked in)
// ---------------------------------------------------------------------------

const DEBUG =
  /^(1|true|yes|on)$/i.test(process.env.DEBUG ?? '') || process.argv.includes('--debug');
const HEADLESS = !process.argv.includes('--headed');
const SOFT_FAIL = /^(1|true|yes|on)$/i.test(process.env.REXEL_SOFT_FAIL ?? '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';

const DELAYS = {
  min: int(process.env.REXEL_MIN_DELAY_MS, 1200),
  max: int(process.env.REXEL_MAX_DELAY_MS, 2600),
  nav: int(process.env.REXEL_NAV_TIMEOUT_MS, 45000),
  settle: int(process.env.REXEL_SETTLE_MS, 3500),
  maxScroll: int(process.env.REXEL_MAX_SCROLL, 60),
};
const RAW_CAP_BYTES = int(process.env.REXEL_RAW_CAP_BYTES, 8_000_000);

const STATUS = {
  OK: 'ok',
  AUTH_FAILED_OR_PRICE_HIDDEN: 'auth_failed_or_price_hidden',
  ERROR: 'error',
};

// A normal desktop browser fingerprint. This is ordinary browser configuration
// for compatible rendering — NOT an attempt to defeat bot protection.
const CONTEXT_OPTS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1366, height: 900 },
};

// High-signal indicators of a CAPTCHA / MFA / bot challenge. We detect these so
// we can STOP — never to circumvent them.
const BLOCKER_PATTERNS = [
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /are you (a )?human/i,
  /verify you are human/i,
  /are you a robot/i,
  /unusual traffic/i,
  /automated queries/i,
  /one-?time (pass)?code/i,
  /verification code/i,
  /enter the code we sent/i,
  /two-?factor/i,
  /multi-?factor/i,
  /\bMFA\b/,
  /\bOTP\b/,
];

// Columns for the CSV export, in the exact order requested for the mission.
const COLUMNS = [
  ['title', 'product title'],
  ['brand', 'brand/manufacturer'],
  ['item_number', 'item number'],
  ['cat_mpn', 'CAT/MPN'],
  ['upc', 'UPC'],
  ['category', 'category'],
  ['price', 'price'],
  ['unit_of_measure', 'unit of measure'],
  ['availability', 'stock/availability'],
  ['product_url', 'product URL'],
  ['captured_at', 'captured_at'],
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function log(...a) {
  console.log('[rexel]', ...a);
}
function debug(...a) {
  if (DEBUG) console.log('[rexel:debug]', ...a);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
// Jittered delay for conservative, human-ish pacing / rate limiting.
function jitter() {
  const ms = Math.floor(DELAYS.min + Math.random() * Math.max(0, DELAYS.max - DELAYS.min));
  return sleep(ms);
}
function hasDigit(v) {
  return v != null && /\d/.test(String(v));
}
function fileStamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

/**
 * Load credentials from env. Prints only the NAMES of any missing variables —
 * never values. Exits 2 if either is missing.
 */
function loadCredentials() {
  const email = process.env.REXELUSA_EMAIL;
  const password = process.env.REXELUSA_PASSWORD;
  const missing = [];
  if (!email || !email.trim()) missing.push('REXELUSA_EMAIL');
  if (!password || !password.trim()) missing.push('REXELUSA_PASSWORD');
  if (missing.length) {
    console.error(`[rexel] ERROR: missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[rexel] Set them as env vars / GitHub Actions secrets. Values are never printed.');
    process.exit(2);
  }
  return { email, password };
}

// ---------------------------------------------------------------------------
// Challenge detection (detect → stop; never bypass)
// ---------------------------------------------------------------------------

async function detectBlockers(page) {
  const hits = new Set();
  try {
    const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) || '';
    for (const re of BLOCKER_PATTERNS) if (re.test(text)) hits.add(re.source);
    for (const frame of page.frames()) {
      const url = frame.url() || '';
      if (/recaptcha|hcaptcha|captcha|challenges\.cloudflare|geo\.captcha/i.test(url)) {
        hits.add('captcha-iframe');
      }
    }
  } catch {
    /* best effort only */
  }
  return [...hits];
}

// ---------------------------------------------------------------------------
// Login (normal flow only)
// ---------------------------------------------------------------------------

async function findLoginForm(page) {
  let email = page.locator(SELECTORS.login.email).first();
  if ((await email.count().catch(() => 0)) && (await email.isVisible().catch(() => false))) {
    return email;
  }
  // Try opening a login modal/page from whatever we're on.
  for (const trig of SELECTORS.login.triggers) {
    const t = page.locator(trig).first();
    if (await t.count().catch(() => 0)) {
      await t.click({ timeout: 5000 }).catch(() => {});
      await sleep(DELAYS.settle);
      email = page.locator(SELECTORS.login.email).first();
      if (
        (await email.count().catch(() => 0)) &&
        (await email.isVisible().catch(() => false))
      ) {
        return email;
      }
    }
  }
  return email; // possibly empty; caller handles
}

async function dismissOverlays(page) {
  // Best-effort: clear cookie-consent / region overlays that can block the form.
  const sels = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
    'button:has-text("Allow all")',
    'button:has-text("Got it")',
    'button[aria-label*="accept" i]',
    'button[aria-label*="close" i]',
  ];
  for (const s of sels) {
    const b = page.locator(s).first();
    if ((await b.count().catch(() => 0)) && (await b.isVisible().catch(() => false))) {
      await b.click({ timeout: 3000 }).catch(() => {});
      await sleep(500);
    }
  }
}

/**
 * Capture login-page diagnostics to the artifact: a screenshot, the page HTML,
 * and a full inventory of input/button/link controls (including those inside
 * open shadow roots). Called ONLY before any credentials are entered, so no
 * secret can appear in the screenshot or HTML. Logs attribute metadata + counts
 * only — never any entered value.
 */
async function dumpLoginDiagnostics(page, label) {
  try {
    const pngPath = path.join(OUTPUT_DIR, `${label}.png`);
    const htmlPath = path.join(OUTPUT_DIR, `${label}.html`);
    const fieldsPath = path.join(OUTPUT_DIR, `${label}-controls.json`);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) await writeFile(htmlPath, html);

    const info = await page
      .evaluate(() => {
        const out = [];
        const visit = (root) => {
          for (const el of root.querySelectorAll('input, button, a[href], select, textarea')) {
            const tag = el.tagName.toLowerCase();
            out.push({
              tag,
              type: el.getAttribute('type'),
              name: el.getAttribute('name'),
              id: el.id || null,
              placeholder: el.getAttribute('placeholder'),
              autocomplete: el.getAttribute('autocomplete'),
              ariaLabel: el.getAttribute('aria-label'),
              text: tag === 'button' || tag === 'a' ? (el.textContent || '').trim().slice(0, 40) : null,
              visible: !!(el.offsetParent || el.getClientRects().length),
            });
          }
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
        };
        visit(document);
        return { url: location.href, title: document.title, controls: out };
      })
      .catch(() => ({ url: '', title: '', controls: [] }));
    await writeFile(fieldsPath, JSON.stringify(info, null, 2));

    const inputs = info.controls.filter((c) => c.tag === 'input');
    const pwd = inputs.filter((c) => (c.type || '').toLowerCase() === 'password');
    log(`login-diagnostic: landed on ${info.url} (title="${info.title}")`);
    log(`login-diagnostic: ${info.controls.length} controls, ${inputs.length} inputs, ${pwd.length} password input(s)`);
    // Attribute metadata only (controls are unfilled) — safe; this is what fixes selectors.
    for (const c of inputs.slice(0, 15)) {
      log(`  input type=${c.type} name=${c.name} id=${c.id} ph=${c.placeholder} aria=${c.ariaLabel} vis=${c.visible}`);
    }
    log(`login-diagnostic: wrote ${pngPath}, ${htmlPath}, ${fieldsPath}`);
  } catch (e) {
    debug('dumpLoginDiagnostics failed:', e?.message);
  }
}

async function login(page, creds) {
  log('navigating to login…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
  await sleep(DELAYS.settle);
  await dismissOverlays(page);

  let emailField = await findLoginForm(page);
  if (!(await emailField.count().catch(() => 0))) {
    // Fall back to the homepage and try to open login from there.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
    await sleep(DELAYS.settle);
    await dismissOverlays(page);
    emailField = await findLoginForm(page);
  }
  if (!(await emailField.count().catch(() => 0))) {
    // Capture what the runner actually sees so selectors can be fixed precisely.
    // Safe: no credentials have been entered at this point.
    await dumpLoginDiagnostics(page, 'debug-login');
    return { ok: false, reason: 'login_form_not_found' };
  }
  if (DEBUG) await dumpLoginDiagnostics(page, 'debug-login-found'); // empty form, pre-fill

  const passwordField = page.locator(SELECTORS.login.password).first();
  await emailField.fill(creds.email).catch(() => {}); // value never logged
  await jitter();
  await passwordField.fill(creds.password).catch(() => {}); // value never logged
  await jitter();

  const submit = page.locator(SELECTORS.login.submit).first();
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DELAYS.nav }).catch(() => {}),
    submit.click({ timeout: 10000 }).catch(() => {}),
  ]);
  await sleep(DELAYS.settle);

  // Respect access controls: if a CAPTCHA/MFA/bot challenge appears, stop here.
  const blockers = await detectBlockers(page);
  if (blockers.length) {
    log(`login halted: access challenge detected — not bypassing (per policy).`);
    return { ok: false, reason: 'challenge_detected', blockers };
  }

  const loggedIn = await page
    .locator(SELECTORS.account)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  return { ok: true, loggedIn };
}

// ---------------------------------------------------------------------------
// Search navigation + lazy-load scrolling (paced)
// ---------------------------------------------------------------------------

async function autoScroll(page) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < DELAYS.maxScroll; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    await page.evaluate((y) => window.scrollTo(0, y), h).catch(() => {});
    await sleep(600 + Math.floor(Math.random() * 700)); // conservative pacing
    const nh = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (nh === last) {
      if (++stable >= 2) return;
    } else {
      stable = 0;
    }
    last = nh;
  }
  debug(`autoScroll hit max steps (${DELAYS.maxScroll}); page may have more below the fold`);
}

async function gotoSearch(page) {
  log('navigating to UPS search…');
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
  await sleep(DELAYS.settle);
  await page
    .locator(SELECTORS.product.card)
    .first()
    .waitFor({ state: 'visible', timeout: DELAYS.nav })
    .catch(() => {});
  await autoScroll(page);
}

// ---------------------------------------------------------------------------
// Price gate (requirement: verify the logged-in page actually shows prices)
// Returns counts only — never the price strings (those go to artifact files).
// ---------------------------------------------------------------------------

async function pageHasPrices(page) {
  const body = (await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')) || '';
  const currencyAmounts = (body.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) || []).length;
  const priceElements = await page.locator(SELECTORS.product.price).count().catch(() => 0);
  return { priceElements, currencyAmounts };
}

// ---------------------------------------------------------------------------
// DOM extraction (fast path: one round-trip over all tiles)
// ---------------------------------------------------------------------------

async function extractFromDom(page, capturedAt) {
  const cards = page.locator(SELECTORS.product.card);
  const total = await cards.count().catch(() => 0);
  if (!total) return { total: 0, products: [] };

  const raw = await cards
    .evaluateAll((els, s) => {
      const txt = (el, q) => {
        if (!q) return null;
        const n = el.querySelector(q);
        const t = n && (n.innerText || n.textContent || '').trim();
        return t || null;
      };
      const href = (el, q) => {
        const a = (q && el.querySelector(q)) || el.querySelector('a[href]');
        const h = a && a.getAttribute('href');
        if (!h) return null;
        try {
          return new URL(h, location.origin).href;
        } catch {
          return h;
        }
      };
      return els.map((el) => ({
        title: txt(el, s.title),
        brand: txt(el, s.brand),
        item_number: txt(el, s.itemNumber),
        cat_mpn: txt(el, s.catMpn),
        upc: txt(el, s.upc),
        category: txt(el, s.category),
        price: txt(el, s.price),
        unit_of_measure: txt(el, s.uom),
        availability: txt(el, s.availability),
        product_url: href(el, s.link),
      }));
    }, SELECTORS.product)
    .catch((e) => {
      debug('extractFromDom evaluateAll failed:', e?.message);
      return [];
    });

  const products = raw
    .filter((p) => p.title || p.price || p.item_number)
    .map((p) => ({ ...p, captured_at: capturedAt, _source: 'dom' }));
  return { total, products };
}

// ---------------------------------------------------------------------------
// JSON harvest (robust path: parse the API payloads the page fetched itself)
// ---------------------------------------------------------------------------

function looksLikeProduct(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o).map((k) => k.toLowerCase());
  const hasName = keys.some((k) => /name|title|description/.test(k));
  const hasPrice = keys.some((k) => /price|amount|cost/.test(k));
  const hasId = keys.some((k) => /sku|item|product|code|mpn|catalog|part|id/.test(k));
  return hasName && (hasPrice || hasId);
}

function harvestProducts(node, out, depth = 0) {
  if (depth > 8 || out.length > 20000 || node == null) return;
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    const productish = objs.filter(looksLikeProduct);
    if (productish.length >= 3 && productish.length >= objs.length * 0.6) {
      out.push(...productish);
    }
    for (const x of node) harvestProducts(x, out, depth + 1);
  } else if (typeof node === 'object') {
    for (const v of Object.values(node)) harvestProducts(v, out, depth + 1);
  }
}

function pick(o, regexes) {
  for (const [k, v] of Object.entries(o)) {
    if (v == null || typeof v === 'object') continue;
    if (regexes.some((re) => re.test(k))) return v;
  }
  return null;
}

function mapJsonProduct(o, capturedAt) {
  let url = pick(o, [/url/i, /link/i, /href/i, /pdp/i, /slug/i]);
  if (url && typeof url === 'string' && url.startsWith('/')) {
    try {
      url = new URL(url, BASE_URL).href;
    } catch {
      /* keep as-is */
    }
  }
  return {
    title: pick(o, [/^name$/i, /productname/i, /title/i, /^description$/i, /shortdescription/i]),
    brand: pick(o, [/brand/i, /manufacturer/i, /vendor/i, /mfr/i]),
    item_number: pick(o, [/itemnumber/i, /item_no/i, /^sku$/i, /productid/i, /^id$/i, /partnumber/i, /^code$/i]),
    cat_mpn: pick(o, [/mpn/i, /catalog/i, /^cat$/i, /manufacturerpart/i, /modelnumber/i, /model/i]),
    upc: pick(o, [/upc/i, /gtin/i, /ean/i, /barcode/i]),
    category: pick(o, [/category/i, /productline/i, /class/i, /department/i]),
    price: pick(o, [/listprice/i, /unitprice/i, /yourprice/i, /price/i, /amount/i, /cost/i]),
    unit_of_measure: pick(o, [/unitofmeasure/i, /uom/i, /^unit$/i, /sellingunit/i]),
    availability: pick(o, [/availab/i, /stock/i, /inventory/i, /instock/i, /quantityonhand/i]),
    product_url: url,
    captured_at: capturedAt,
    _source: 'json',
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const key = [p.item_number, p.product_url, p.title].filter(Boolean).join('|') || JSON.stringify(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function fieldPresence(products) {
  const out = {};
  for (const [key] of COLUMNS) {
    out[key] = products.filter((p) => p[key] != null && String(p[key]).trim() !== '').length;
  }
  return out;
}

function toCsv(products) {
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const header = COLUMNS.map(([, label]) => esc(label)).join(',');
  const rows = products.map((p) => COLUMNS.map(([key]) => esc(p[key])).join(','));
  return [header, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const creds = loadCredentials(); // exits 2 if missing — before any browser launch
  const capturedAt = new Date().toISOString();
  const stamp = fileStamp(capturedAt);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(CONTEXT_OPTS);
  const page = await context.newPage();

  // Capture JSON API payloads the page fetches (robust, site-agnostic source).
  const rawPayloads = [];
  let rawBytes = 0;
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/json/i.test(resp.headers()['content-type'] || '')) return;
      if (!API_HINTS.some((h) => url.toLowerCase().includes(h))) return;
      if (rawBytes >= RAW_CAP_BYTES) return;
      const text = await resp.text();
      rawBytes += text.length;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      rawPayloads.push({ url, status: resp.status(), json });
    } catch {
      /* ignore individual response failures */
    }
  });

  let status = STATUS.OK;
  let reason = null;
  let source = 'none';
  let products = [];
  let jsonProducts = [];
  let domTotal = 0;
  let priceCheck = { priceElements: 0, currencyAmounts: 0 };

  try {
    const loginRes = await login(page, creds);
    await jitter();

    if (loginRes.reason === 'challenge_detected') {
      // Stop deliberately — do not interact further with a challenge.
      status = STATUS.AUTH_FAILED_OR_PRICE_HIDDEN;
      reason = `challenge_detected:${(loginRes.blockers || []).join('|')}`;
    } else {
      await gotoSearch(page);
      await jitter();

      // Harvest products from whatever JSON the page fetched.
      const harvested = [];
      for (const pl of rawPayloads) harvestProducts(pl.json, harvested);
      jsonProducts = dedupe(harvested.map((o) => mapJsonProduct(o, capturedAt)));

      // Price gate — selector-independent currency scan + selector count.
      priceCheck = await pageHasPrices(page);
      const jsonHasPrice = jsonProducts.some((p) => hasDigit(p.price));
      const pricesPresent = priceCheck.currencyAmounts > 0 || jsonHasPrice;

      // DOM extraction (preferred), falling back to JSON-harvested products.
      const domRes = await extractFromDom(page, capturedAt);
      domTotal = domRes.total;
      if (domRes.products.length) {
        products = dedupe(domRes.products);
        source = 'dom';
      } else if (jsonProducts.length) {
        products = jsonProducts;
        source = 'json';
      }

      if (!pricesPresent) {
        status = STATUS.AUTH_FAILED_OR_PRICE_HIDDEN;
        reason = loginRes.ok ? 'no_prices_visible' : `login_unconfirmed:${loginRes.reason || ''}`;
        // Per policy: do not present possibly-bad rows as a good capture.
      } else if (!products.length) {
        status = STATUS.AUTH_FAILED_OR_PRICE_HIDDEN;
        reason = 'prices_present_but_no_products_extracted:selectors_need_tuning';
      } else {
        status = STATUS.OK;
      }
    }
  } catch (err) {
    status = STATUS.ERROR;
    reason = `exception:${err && err.message ? err.message : String(err)}`;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // -- assemble + persist results ------------------------------------------
  const result = {
    status,
    reason,
    captured_at: capturedAt,
    search_url: SEARCH_URL,
    source,
    counts: {
      products: products.length,
      dom_cards: domTotal,
      dom_price_elements: priceCheck.priceElements,
      currency_amounts_on_page: priceCheck.currencyAmounts,
      json_payloads_captured: rawPayloads.length,
      json_products_harvested: jsonProducts.length,
    },
    field_presence: fieldPresence(products),
    products,
  };

  const jsonPath = path.join(OUTPUT_DIR, `rexel-ups-${stamp}.json`);
  const latestPath = path.join(OUTPUT_DIR, 'rexel-ups-latest.json');
  const csvPath = path.join(OUTPUT_DIR, `rexel-ups-${stamp}.csv`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await writeFile(latestPath, JSON.stringify(result, null, 2));
  await writeFile(csvPath, toCsv(products));
  if (rawPayloads.length) {
    // Raw payloads can include account-scoped data — keep artifacts private.
    await writeFile(path.join(OUTPUT_DIR, `raw-responses-${stamp}.json`), JSON.stringify(rawPayloads, null, 2));
  }

  // -- report (counts / presence only; never credentials or price strings) --
  log(`status=${status}${reason ? ` reason=${reason}` : ''} products=${products.length} source=${source}`);
  log(
    `price-signal: dom_price_elements=${priceCheck.priceElements} currency_amounts_on_page=${priceCheck.currencyAmounts} json_products=${jsonProducts.length}`,
  );
  log(`wrote: ${jsonPath}, ${latestPath}, ${csvPath}`);
  if (DEBUG) {
    debug(`dom_cards=${domTotal} json_payloads=${rawPayloads.length} (~${rawBytes} bytes)`);
    const fp = result.field_presence;
    debug('field presence (non-empty / total):');
    for (const [key] of COLUMNS) debug(`  ${key}: ${fp[key]}/${products.length}`);
  }

  if (status === STATUS.AUTH_FAILED_OR_PRICE_HIDDEN) process.exit(SOFT_FAIL ? 0 : 3);
  if (status === STATUS.ERROR) process.exit(1);
  process.exit(0);
}

// Pure helpers are exported for unit testing; importing the module does not run
// the capture (guarded below by the entry-point check).
export { harvestProducts, mapJsonProduct, looksLikeProduct, dedupe, toCsv, fieldPresence, pick };

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    // Last-resort guard — message only, never credential values.
    console.error('[rexel] FATAL:', err && err.message ? err.message : String(err));
    process.exit(1);
  });
}
