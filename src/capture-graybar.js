#!/usr/bin/env node
/**
 * Graybar — authenticated UPS product capture.
 *
 * Credentials are read from environment variables ONLY:
 *   - process.env.GRAYBAR_EMAIL
 *   - process.env.GRAYBAR_PASSWORD
 * (Set these as GitHub Actions secrets GRAYBAR_EMAIL / GRAYBAR_PASSWORD.)
 *
 * Safety & ethics (enforced in code), identical posture to the Rexel capture:
 *   - Normal interactive login only. NEVER solves or bypasses CAPTCHA, MFA/OTP,
 *     or bot-protection. If a challenge is detected the run stops and reports
 *     `auth_failed_or_price_hidden`.
 *   - Conservative, jittered delays; single browser; fully sequential.
 *   - Credential VALUES are never printed, logged, or written to disk.
 *   - Prices are the success gate: if the logged-in pages show no prices, the
 *     run is marked auth_failed_or_price_hidden and exits non-zero rather than
 *     writing bad data.
 *
 * Exit codes: 0 ok (or soft-fail), 1 error, 2 missing creds, 3 auth/price-hidden.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BASE_URL, LOGIN_URL, SEARCH_URL, PAGE_PARAM, SELECTORS, API_HINTS } from './graybar-selectors.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEBUG = /^(1|true|yes|on)$/i.test(process.env.DEBUG ?? '') || process.argv.includes('--debug');
const HEADLESS = !process.argv.includes('--headed');
const SOFT_FAIL = /^(1|true|yes|on)$/i.test(process.env.GRAYBAR_SOFT_FAIL ?? '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';

const DELAYS = {
  min: int(process.env.GRAYBAR_MIN_DELAY_MS, 1500),
  max: int(process.env.GRAYBAR_MAX_DELAY_MS, 3200),
  nav: int(process.env.GRAYBAR_NAV_TIMEOUT_MS, 45000),
  settle: int(process.env.GRAYBAR_SETTLE_MS, 3000),
  priceWait: int(process.env.GRAYBAR_PRICE_WAIT_MS, 20000),
  maxPages: int(process.env.GRAYBAR_MAX_PAGES, 90),
};
const RAW_CAP_BYTES = int(process.env.GRAYBAR_RAW_CAP_BYTES, 8_000_000);

// Price/stock enrichment via the per-product detail JSON endpoint (/p/details).
const ENRICH = !/^(0|false|no|off)$/i.test(process.env.GRAYBAR_ENRICH ?? '');
const ENRICH_CAP = int(process.env.GRAYBAR_ENRICH_CAP, 0); // 0 = all products
const ENRICH_DELAY = int(process.env.GRAYBAR_ENRICH_DELAY_MS, 600);

const STATUS = {
  OK: 'ok',
  AUTH_FAILED_OR_PRICE_HIDDEN: 'auth_failed_or_price_hidden',
  ERROR: 'error',
};

const CONTEXT_OPTS = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1366, height: 900 },
};

// High-signal CAPTCHA / MFA / bot-challenge indicators — detected to STOP, never bypass.
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

const COLUMNS = [
  ['title', 'product title'],
  ['brand', 'brand/manufacturer'],
  ['sku', 'SKU'],
  ['mfr', 'MFR #'],
  ['category', 'category'],
  ['price', 'price'],
  ['availability', 'stock/availability'],
  ['stock_level', 'stock level'],
  ['product_url', 'product URL'],
  ['captured_at', 'captured_at'],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function log(...a) {
  console.log('[graybar]', ...a);
}
function debug(...a) {
  if (DEBUG) console.log('[graybar:debug]', ...a);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
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

function loadCredentials() {
  const email = process.env.GRAYBAR_EMAIL;
  const password = process.env.GRAYBAR_PASSWORD;
  const missing = [];
  if (!email || !email.trim()) missing.push('GRAYBAR_EMAIL');
  if (!password || !password.trim()) missing.push('GRAYBAR_PASSWORD');
  if (missing.length) {
    console.error(`[graybar] ERROR: missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[graybar] Set them as env vars / GitHub Actions secrets. Values are never printed.');
    process.exit(2);
  }
  return { email, password };
}

// ---------------------------------------------------------------------------
// Challenge detection (detect -> stop; never bypass)
// ---------------------------------------------------------------------------

async function detectBlockers(page) {
  const hits = new Set();
  try {
    const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) || '';
    for (const re of BLOCKER_PATTERNS) if (re.test(text)) hits.add(re.source);
    for (const frame of page.frames()) {
      const url = frame.url() || '';
      if (/recaptcha|hcaptcha|captcha|challenges\.cloudflare|geo\.captcha/i.test(url)) hits.add('captcha-iframe');
    }
  } catch {
    /* best effort */
  }
  return [...hits];
}

// ---------------------------------------------------------------------------
// Login (normal flow only) + secret-safe diagnostics
// ---------------------------------------------------------------------------

async function dismissOverlays(page) {
  const sels = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
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

// For login: called ONLY before credentials are entered, so no secret can
// appear. Also reused for the (post-login) search page to capture its HTML for
// product-selector tuning.
async function dumpDiagnostics(page, label) {
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
          for (const el of root.querySelectorAll('input, button, a[href], select')) {
            const tag = el.tagName.toLowerCase();
            out.push({
              tag,
              type: el.getAttribute('type'),
              name: el.getAttribute('name'),
              id: el.id || null,
              placeholder: el.getAttribute('placeholder'),
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
    log(`diagnostic[${label}]: landed on ${info.url} (title="${info.title}")`);
    log(`diagnostic[${label}]: ${info.controls.length} controls, ${inputs.length} inputs, ${pwd.length} password input(s)`);
    for (const c of inputs.slice(0, 15)) {
      log(`  input type=${c.type} name=${c.name} id=${c.id} ph=${c.placeholder} aria=${c.ariaLabel} vis=${c.visible}`);
    }
  } catch (e) {
    debug('dumpLoginDiagnostics failed:', e?.message);
  }
}

async function findLoginForm(page) {
  let email = page.locator(SELECTORS.login.email).first();
  if ((await email.count().catch(() => 0)) && (await email.isVisible().catch(() => false))) return email;
  for (const trig of SELECTORS.login.triggers) {
    const t = page.locator(trig).first();
    if (await t.count().catch(() => 0)) {
      await t.click({ timeout: 5000 }).catch(() => {});
      await sleep(DELAYS.settle);
      email = page.locator(SELECTORS.login.email).first();
      if ((await email.count().catch(() => 0)) && (await email.isVisible().catch(() => false))) return email;
    }
  }
  return email;
}

async function login(page, creds) {
  log('navigating to login…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
  await sleep(DELAYS.settle);
  await dismissOverlays(page);

  let emailField = await findLoginForm(page);
  if (!(await emailField.count().catch(() => 0))) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
    await sleep(DELAYS.settle);
    await dismissOverlays(page);
    emailField = await findLoginForm(page);
  }
  if (!(await emailField.count().catch(() => 0))) {
    await dumpDiagnostics(page, 'graybar-debug-login'); // safe: no creds entered yet
    return { ok: false, reason: 'login_form_not_found' };
  }
  if (DEBUG) await dumpDiagnostics(page, 'graybar-debug-login-found'); // empty form, pre-fill

  const passwordField = page.locator(SELECTORS.login.password).first();
  await emailField.fill(creds.email).catch(() => {}); // value never logged
  await jitter();
  await passwordField.fill(creds.password).catch(() => {}); // value never logged
  await jitter();

  // Submit by pressing Enter in the password field (reliably posts the Hybris
  // login form including its CSRF token); fall back to a submit button if the
  // password field is still showing afterwards.
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: DELAYS.nav }).catch(() => {}),
    passwordField.press('Enter').catch(() => {}),
  ]);
  await sleep(DELAYS.settle);
  const stillOnForm = await page
    .locator(SELECTORS.login.password)
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (stillOnForm) {
    const submit = page.locator(SELECTORS.login.submit).first();
    if (await submit.count().catch(() => 0)) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: DELAYS.nav }).catch(() => {}),
        submit.click({ timeout: 10000 }).catch(() => {}),
      ]);
      await sleep(DELAYS.settle);
    }
  }

  const blockers = await detectBlockers(page);
  if (blockers.length) {
    log('login halted: access challenge detected — not bypassing (per policy).');
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
// Search + pagination
// ---------------------------------------------------------------------------

// Graybar pages via a 0-indexed `page` query param. Append as a raw string so
// the already-encoded `q` parameter is preserved exactly.
function pageUrl(base, i) {
  if (i === 0) return base;
  const pathAndQuery = base.split('#')[0];
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return `${pathAndQuery}${sep}${PAGE_PARAM}=${i}`;
}

// One-off diagnostic: fetch a single product's detail fragment — the same
// endpoint the site calls when a row is expanded — to reveal exactly where
// price / availability live. Uses the authenticated page session.
async function fetchDetailSample(page, sku) {
  try {
    const res = await page.evaluate(async (s) => {
      const r = await fetch(`/p/details/${s}`, { credentials: 'include' });
      return { status: r.status, ct: r.headers.get('content-type') || '', body: (await r.text()).slice(0, 6000) };
    }, sku);
    await writeFile(path.join(OUTPUT_DIR, 'graybar-detail-sample.json'), JSON.stringify(res, null, 2));
    log(`detail-sample: /p/details/${sku} -> ${res.status} ${res.ct} (${res.body.length} bytes saved)`);
  } catch (e) {
    debug('fetchDetailSample failed:', e?.message);
  }
}

async function extractPage(page, capturedAt) {
  const sel = SELECTORS.product;
  const cards = page.locator(sel.card);
  const total = await cards.count().catch(() => 0);
  if (!total) return [];
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
      return els.map((el) => {
        // Map "SKU" / "MFR #" label/value pairs.
        const pairs = {};
        el.querySelectorAll(s.labelPair).forEach((d) => {
          const l = d.querySelector(s.label);
          const v = d.querySelector(s.value);
          if (l && v) {
            const key = (l.innerText || l.textContent || '').trim().toLowerCase().replace(/[^a-z]/g, '');
            const val = (v.innerText || v.textContent || '').trim();
            if (key && val) pairs[key] = val;
          }
        });
        const url = href(el, s.link);
        const skuFromUrl = url && (url.match(/\/p\/(\w+)/) || [])[1];
        return {
          title: txt(el, s.title),
          brand: txt(el, s.brand),
          sku: pairs.sku || skuFromUrl || null,
          mfr: pairs.mfr || pairs.mfrno || null,
          category: null,
          price: txt(el, s.price),
          availability: txt(el, s.availability),
          product_url: url,
        };
      });
    }, sel)
    .catch((e) => {
      debug('extractPage evaluateAll failed:', e?.message);
      return [];
    });
  return raw
    .filter((p) => p.title || p.price || p.sku)
    .map((p) => ({ ...p, captured_at: capturedAt, _source: 'dom' }));
}

// Enrich each product with price + stock from /p/details/<sku> (clean JSON, the
// same endpoint the site calls when a row is expanded). Conservatively paced;
// uses the authenticated page session. Respects ENRICH_CAP (0 = all).
async function enrichPrices(page, products) {
  const targets = products.filter((p) => p.sku);
  const limit = ENRICH_CAP > 0 ? Math.min(ENRICH_CAP, targets.length) : targets.length;
  let withPrice = 0;
  let errors = 0;
  for (let i = 0; i < limit; i++) {
    const p = targets[i];
    try {
      const d = await page.evaluate(async (sku) => {
        const r = await fetch(`/p/details/${encodeURIComponent(sku)}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) return { _status: r.status };
        return await r.json();
      }, p.sku);
      if (d && !d._status) {
        const pr = d.price || {};
        p.price = pr.formattedValue ?? (pr.value != null ? String(pr.value) : p.price);
        p.price_value = typeof pr.value === 'number' ? pr.value : null;
        p.currency = pr.currencyIso ?? null;
        const st = d.stock || {};
        p.availability = st.stockLevelStatus?.code ?? p.availability;
        p.stock_level = typeof st.stockLevel === 'number' ? st.stockLevel : null;
        if (hasDigit(p.price)) withPrice++;
      } else {
        errors++;
      }
    } catch (e) {
      errors++;
      debug('enrich failed', p.sku, e?.message);
    }
    if ((i + 1) % 25 === 0 || i + 1 === limit) {
      log(`enrich: ${i + 1}/${limit} (${withPrice} priced, ${errors} errors)`);
    }
    await sleep(ENRICH_DELAY + Math.floor(Math.random() * 300)); // conservative pacing
  }
  if (limit < targets.length) {
    log(`enrich: CAPPED at ${limit} of ${targets.length} products (set GRAYBAR_ENRICH_CAP=0 for all)`);
  }
  return { withPrice, enriched: limit, errors, capped: limit < targets.length };
}

async function pageHasPrices(page) {
  const body = (await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')) || '';
  const currencyAmounts = (body.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) || []).length;
  const priceElements = await page.locator(SELECTORS.product.price).count().catch(() => 0);
  return { priceElements, currencyAmounts };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const key = [p.sku, p.product_url, p.title].filter(Boolean).join('|') || JSON.stringify(p);
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
  const creds = loadCredentials(); // exits 2 before any browser launch if missing
  const capturedAt = new Date().toISOString();
  const stamp = fileStamp(capturedAt);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(CONTEXT_OPTS);
  const page = await context.newPage();

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
      /* ignore */
    }
  });

  let status = STATUS.OK;
  let reason = null;
  let products = [];
  let pagesVisited = 0;
  let capped = false;
  let priceCheck = { priceElements: 0, currencyAmounts: 0 };
  let enrichStats = { withPrice: 0, enriched: 0, errors: 0, capped: false };

  try {
    const loginRes = await login(page, creds);
    await jitter();

    if (loginRes.reason === 'challenge_detected') {
      status = STATUS.AUTH_FAILED_OR_PRICE_HIDDEN;
      reason = `challenge_detected:${(loginRes.blockers || []).join('|')}`;
    } else {
      log('navigating to UPS search…');
      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
      await sleep(DELAYS.settle);
      await dismissOverlays(page);

      priceCheck = await pageHasPrices(page);
      // Capture the (post-login) search page so its real product-card structure
      // can be read off and the selectors finalised.
      if (DEBUG) await dumpDiagnostics(page, 'graybar-debug-search');

      // Paginate, accumulating de-duplicated rows. Stop when a page yields no
      // new rows (or the cap is hit). Conservative pacing between pages.
      const seen = new Set();
      let noNew = 0;
      for (let i = 0; i < DELAYS.maxPages; i++) {
        if (i > 0) {
          await page.goto(pageUrl(SEARCH_URL, i), { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
          await sleep(DELAYS.settle);
          await jitter();
        }
        pagesVisited = i + 1;
        const pageRows = await extractPage(page, capturedAt);
        if (i === 0 && DEBUG && pageRows[0]?.sku) await fetchDetailSample(page, pageRows[0].sku);
        let added = 0;
        for (const p of pageRows) {
          const key = [p.sku, p.product_url, p.title].filter(Boolean).join('|');
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          products.push(p);
          added++;
        }
        debug(`page ${i}: ${pageRows.length} rows, ${added} new (total ${products.length})`);
        if (added === 0) {
          if (++noNew >= 2) break;
        } else {
          noNew = 0;
        }
        if (i === DELAYS.maxPages - 1) capped = true;
      }
      products = dedupe(products);

      // Enrich price + stock per product via the detail JSON endpoint.
      if (ENRICH && products.length) {
        log(`enriching price + stock for ${products.length} products via /p/details (paced)…`);
        enrichStats = await enrichPrices(page, products);
      }

      const pricesPresent = products.some((p) => hasDigit(p.price));
      if (!products.length) {
        status = STATUS.AUTH_FAILED_OR_PRICE_HIDDEN;
        reason = loginRes.ok ? 'no_products_extracted' : `login_unconfirmed:${loginRes.reason || ''}`;
      } else if (!pricesPresent) {
        status = STATUS.AUTH_FAILED_OR_PRICE_HIDDEN;
        reason = ENRICH ? 'no_prices_after_enrichment' : 'prices_not_enriched';
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

  const result = {
    status,
    reason,
    captured_at: capturedAt,
    search_url: SEARCH_URL,
    source: products.length ? 'dom' : 'none',
    counts: {
      products: products.length,
      pages_visited: pagesVisited,
      page_cap_hit: capped,
      enriched: enrichStats.enriched,
      priced: enrichStats.withPrice,
      enrich_errors: enrichStats.errors,
      enrich_capped: enrichStats.capped,
      currency_amounts_on_first_page: priceCheck.currencyAmounts,
      json_payloads_captured: rawPayloads.length,
    },
    field_presence: fieldPresence(products),
    products,
  };

  const jsonPath = path.join(OUTPUT_DIR, `graybar-ups-${stamp}.json`);
  const latestPath = path.join(OUTPUT_DIR, 'graybar-ups-latest.json');
  const csvPath = path.join(OUTPUT_DIR, `graybar-ups-${stamp}.csv`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await writeFile(latestPath, JSON.stringify(result, null, 2));
  await writeFile(csvPath, toCsv(products));
  if (rawPayloads.length) {
    await writeFile(path.join(OUTPUT_DIR, `graybar-raw-responses-${stamp}.json`), JSON.stringify(rawPayloads, null, 2));
  }

  log(`status=${status}${reason ? ` reason=${reason}` : ''} products=${products.length} priced=${enrichStats.withPrice} pages=${pagesVisited}${capped ? ' (PAGE CAP HIT)' : ''}`);
  log(`price-signal: dom_price_elements=${priceCheck.priceElements} currency_amounts_on_first_page=${priceCheck.currencyAmounts}`);
  log(`wrote: ${jsonPath}, ${latestPath}, ${csvPath}`);
  if (DEBUG) {
    const fp = result.field_presence;
    debug('field presence (non-empty / total):');
    for (const [key] of COLUMNS) debug(`  ${key}: ${fp[key]}/${products.length}`);
    debug(`json payloads captured: ${rawPayloads.length} (~${rawBytes} bytes)`);
  }

  if (status === STATUS.AUTH_FAILED_OR_PRICE_HIDDEN) process.exit(SOFT_FAIL ? 0 : 3);
  if (status === STATUS.ERROR) process.exit(1);
  process.exit(0);
}

export { dedupe, fieldPresence, toCsv, pageUrl };

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[graybar] FATAL:', err && err.message ? err.message : String(err));
    process.exit(1);
  });
}
