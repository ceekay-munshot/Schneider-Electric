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
 *   - Login is VERIFIED, not assumed: Graybar answers an anonymous session
 *     exactly like a quote-only product (price=null, callForPricing=true), so a
 *     silently failed login used to be published as "no prices". The session is
 *     checked (auth-status endpoint, page dataLayer, and a price probe of SKUs
 *     priced last time) and re-established when it drops mid-run.
 *   - Durable: SKUs priced last time are enriched first, misses are re-tried,
 *     each request has a timeout, and the run stops inside a time budget (and on
 *     SIGINT/SIGTERM) writing what it has, so a slow week yields partial data
 *     instead of nothing.
 *
 * Exit codes: 0 ok (or soft-fail), 1 error, 2 missing creds, 3 auth/price-hidden.
 */

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BASE_URL, LOGIN_URL, SEARCH_URL, CATEGORY, PAGE_PARAM, SELECTORS, API_HINTS } from './graybar-selectors.js';
import { typicalPriced, knownPricedKeys, isPriceOutage, isGoodCoverage } from '../scripts/lib/capture-quality.js';

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
const ENRICH_DELAY = int(process.env.GRAYBAR_ENRICH_DELAY_MS, 600); // per-worker pause between requests
const ENRICH_CONC = int(process.env.GRAYBAR_ENRICH_CONC, 6); // concurrent detail fetches
const ENRICH_RETRY_ROUNDS = int(process.env.GRAYBAR_ENRICH_RETRY_ROUNDS, 2); // re-try passes for misses
const FETCH_TIMEOUT_MS = int(process.env.GRAYBAR_FETCH_TIMEOUT_MS, 60000); // per detail request

// Session robustness.
const LOGIN_ATTEMPTS = int(process.env.GRAYBAR_LOGIN_ATTEMPTS, 3);
const MAX_REAUTH = int(process.env.GRAYBAR_MAX_REAUTH, 4); // mid-run re-logins
const MISS_LIMIT = int(process.env.GRAYBAR_MISS_LIMIT, 18); // known-priced misses in a row → check session
// Stop gracefully (and write what was captured) this long after start; 0 = no limit.
const TIME_BUDGET_MS = int(process.env.GRAYBAR_TIME_BUDGET_MIN, 0) * 60000;
// Last published data for this category: the baseline for "which SKUs should
// have prices" and "how many prices is normal".
const BASELINE_FILE = process.env.GRAYBAR_BASELINE_FILE || path.join('public', 'data', `${CATEGORY}.json`);

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
  ['upc', 'UPC'],
  ['category', 'category'],
  ['price', 'price'],
  ['unit_of_measure', 'unit of measure'],
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
    if (html) writeFileSync(htmlPath, html);
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
    writeFileSync(fieldsPath, JSON.stringify(info, null, 2));
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
// Session verification (is this session actually logged in and priced?)
// ---------------------------------------------------------------------------

// Two cheap login-state signals from the storefront itself: the accelerator's
// auth-status endpoint (401 when anonymous) and the GTM dataLayer flag
// ('logged_in_status': 'false' for guests).
async function authSignals(page) {
  return page
    .evaluate(async () => {
      let status = null;
      try {
        const r = await fetch('/authentication/status', { credentials: 'include', cache: 'no-store' });
        status = r.status;
      } catch {
        /* unknown */
      }
      let dl = null;
      try {
        for (const e of window.dataLayer || []) if (e && e.logged_in_status != null) dl = String(e.logged_in_status);
      } catch {
        /* unknown */
      }
      return { status, dl };
    })
    .catch(() => ({ status: null, dl: null }));
}

/** 'yes' if any signal says logged in (or a known-priced SKU came back
 * priced), 'no' if only negative signals were seen, else 'unknown'. */
function authVerdict(signals, probe = { tried: 0, priced: 0 }) {
  const { status, dl } = signals || {};
  if ((status >= 200 && status < 300) || dl === 'true' || probe.priced > 0) return 'yes';
  if (status === 401 || status === 403 || dl === 'false' || (probe.tried > 0 && probe.priced === 0)) return 'no';
  return 'unknown';
}

// One /p/details request with a timeout, reduced in-page to the fields we use.
async function fetchDetail(page, sku) {
  try {
    return await page.evaluate(
      async ([s, timeoutMs]) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const r = await fetch(`/p/details/${encodeURIComponent(s)}`, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
            signal: ctl.signal,
          });
          if (!r.ok) return { _status: r.status };
          const d = await r.json();
          return {
            price: d.price ?? null,
            listPrice: d.listPrice ?? null,
            stock: d.stock
              ? { stockLevelStatus: d.stock.stockLevelStatus ?? null, stockLevel: d.stock.stockLevel ?? null }
              : null,
            upc: d.upc ?? null,
            defaultUom: d.defaultUom ?? null,
            commerceAltUomCode: d.commerceAltUomCode ?? null,
            categories: Array.isArray(d.categories) ? d.categories.map((c) => ({ name: c && c.name })) : null,
            manPartNum: d.manPartNum ?? null,
            callForPricing: d.callForPricing ?? null,
          };
        } catch (e) {
          return { _err: String((e && e.message) || e) };
        } finally {
          clearTimeout(timer);
        }
      },
      [sku, FETCH_TIMEOUT_MS],
    );
  } catch (e) {
    return { _err: `evaluate:${e?.message || e}` };
  }
}

// Fetch a few SKUs that were priced in the last capture: if none comes back
// priced, this session is not seeing prices.
async function probePrices(page, knownPriced) {
  const sample = [...knownPriced].sort(() => Math.random() - 0.5).slice(0, 6);
  let priced = 0;
  for (const sku of sample) {
    const d = await fetchDetail(page, sku);
    const pr = d && !d._err && !d._status ? d.price || d.listPrice : null;
    if (pr && pr.value != null) priced++;
  }
  return { tried: sample.length, priced };
}

/** Log in and confirm the session is authenticated and priced, re-trying with
 * a clean cookie jar. Returns { ok, verdict, challenge?, noPrices?, detail }. */
async function ensureSession(page, context, creds, baseline) {
  let last = { ok: false, verdict: 'unknown', detail: 'not_attempted' };
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await context.clearCookies().catch(() => {});
      await sleep(15000 * attempt);
    }
    const res = await login(page, creds);
    if (res.reason === 'challenge_detected') return { ok: false, challenge: true, blockers: res.blockers, detail: 'challenge_detected' };
    const signals = await authSignals(page);
    const probe = baseline.knownPriced.size ? await probePrices(page, baseline.knownPriced) : { tried: 0, priced: 0 };
    const verdict = authVerdict(signals, probe);
    const detail = `status=${signals.status ?? '?'} dataLayer=${signals.dl ?? '?'} probe=${probe.priced}/${probe.tried}${res.ok ? '' : ` ${res.reason}`}`;
    log(`session check (attempt ${attempt}/${LOGIN_ATTEMPTS}): ${verdict} [${detail}]`);
    last = { ok: verdict !== 'no', verdict, detail };
    if (verdict === 'yes' && probe.tried > 0 && probe.priced === 0) {
      // Logged in, yet SKUs priced last time come back unpriced: give the price
      // service one more chance, then stop instead of enriching thousands of
      // products for nothing — Graybar is showing this account no prices.
      await sleep(90000);
      const again = await probePrices(page, baseline.knownPriced);
      log(`price re-probe: ${again.priced}/${again.tried}`);
      if (again.priced === 0) return { ok: false, verdict, noPrices: true, detail: `${detail}; re-probe=0/${again.tried}` };
    }
    if (verdict === 'yes') return last;
    if (verdict === 'unknown' && !baseline.knownPriced.size) return last; // nothing better to check against
  }
  return last;
}

// Re-login on a separate page (cookies are context-wide) so in-flight detail
// requests on the search page are not torn down by the navigation.
async function relogin(context, creds) {
  const lp = await context.newPage();
  try {
    await login(lp, creds);
    return await authSignals(lp);
  } finally {
    await lp.close().catch(() => {});
  }
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
    writeFileSync(path.join(OUTPUT_DIR, 'graybar-detail-sample.json'), JSON.stringify(res, null, 2));
    log(`detail-sample: /p/details/${sku} -> ${res.status} ${res.ct} (${res.body.length} bytes saved)`);
    log(`detail-sample body[0:600]: ${res.body.slice(0, 600).replace(/\s+/g, ' ')}`);
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

// Apply one reduced /p/details response to a product. Returns 'priced',
// 'unpriced' or 'error' (request failed — worth re-trying).
function applyDetail(p, d) {
  if (!d || d._status || d._err) return 'error';
  // d.price = negotiated/contract price (null when account has no contract for this SKU);
  // d.listPrice = catalog/MSRP price (available even when callForPricing=true).
  const pr = d.price || d.listPrice || {};
  p.price = pr.formattedValue ?? (pr.value != null ? String(pr.value) : p.price);
  p.price_value = typeof pr.value === 'number' ? pr.value : null;
  p.currency = pr.currencyIso ?? null;
  const st = d.stock || {};
  p.availability = st.stockLevelStatus?.code ?? p.availability;
  p.stock_level = typeof st.stockLevel === 'number' ? st.stockLevel : null;
  // Extra fields available for free in the same detail response.
  p.upc = d.upc ?? p.upc ?? null;
  p.unit_of_measure = d.defaultUom ?? d.commerceAltUomCode ?? p.unit_of_measure ?? null;
  if (!p.category && Array.isArray(d.categories) && d.categories.length) {
    p.category = d.categories.map((c) => c && c.name).filter(Boolean).join(' / ') || null;
  }
  if (!p.mfr) p.mfr = d.manPartNum ?? null;
  p.callForPricing = d.callForPricing === true;
  return hasDigit(p.price) ? 'priced' : 'unpriced';
}

function countPriced(products) {
  return products.filter((p) => hasDigit(p.price)).length;
}

// Enrich each product with price + stock from /p/details/<sku> (clean JSON, the
// same endpoint the site calls when a row is expanded), using the authenticated
// session. A small worker pool (one slow request no longer stalls a batch),
// conservatively paced. SKUs priced last time go first; misses and errors are
// re-tried; a session that drops to anonymous mid-run is re-established.
// Respects ENRICH_CAP (0 = all) and stops when shouldStop() turns true.
async function enrichPrices(page, context, creds, products, known, shouldStop) {
  const targets = products.filter((p) => p.sku);
  // Known-priced SKUs carry the week-over-week comparison, so a run that runs
  // out of time still has the ones that matter.
  targets.sort((a, b) => Number(known.has(b.sku)) - Number(known.has(a.sku)));
  const limit = ENRICH_CAP > 0 ? Math.min(ENRICH_CAP, targets.length) : targets.length;
  const slice = targets.slice(0, limit);
  const attempted = new Set();
  const errored = new Set();
  const st = { reauths: 0, backoffs: 0, misses: 0, gate: null, diagLogged: false, stopped: false };

  // Prices stopped coming back for SKUs that had them: re-login if the
  // storefront now treats us as anonymous, otherwise back off (a few times at
  // most) and let a throttled price service recover. Only the live auth-status
  // call counts here — the page's dataLayer flag dates from when it loaded.
  const recover = async (why, backoffMs) => {
    st.misses = 0;
    const { status } = await authSignals(page);
    const verdict = authVerdict({ status, dl: null });
    if (verdict === 'no' && st.reauths < MAX_REAUTH) {
      st.reauths++;
      log(`enrich: ${why}; session is anonymous — re-logging in (${st.reauths}/${MAX_REAUTH})…`);
      log(`enrich: re-login -> ${authVerdict(await relogin(context, creds))}`);
    } else if (st.backoffs < 5) {
      st.backoffs++;
      log(`enrich: ${why} (session ${verdict}) — pausing ${Math.round(backoffMs / 1000)}s`);
      await sleep(backoffMs);
    }
  };

  const runPass = async (items, conc, label) => {
    const queue = items.slice();
    const total = items.length;
    let done = 0;
    const worker = async (w) => {
      await sleep(w * 200);
      for (;;) {
        if (st.gate) await st.gate;
        if (shouldStop()) {
          st.stopped = true;
          return;
        }
        const p = queue.shift();
        if (!p) return;
        const d = await fetchDetail(page, p.sku);
        if (!st.diagLogged && d && !d._err && !d._status) {
          st.diagLogged = true;
          log(`enrich-diag: first detail price=${JSON.stringify(d.price ?? null)} listPrice=${JSON.stringify(d.listPrice ?? null)} callForPricing=${JSON.stringify(d.callForPricing ?? null)}`);
        }
        attempted.add(p);
        const r = applyDetail(p, d);
        if (r === 'error') errored.add(p);
        else errored.delete(p);
        if (known.has(p.sku) && r !== 'error') st.misses = r === 'priced' ? 0 : st.misses + 1;
        done++;
        if (done % 60 === 0 || done === total) {
          log(`enrich${label}: ${done}/${total} (${countPriced(products)} priced overall, ${errored.size} errors)`);
        }
        if (st.misses >= MISS_LIMIT && !st.gate) {
          st.gate = recover(`${MISS_LIMIT} known-priced SKUs in a row came back unpriced`, 60000).finally(() => {
            st.gate = null;
          });
        }
        await sleep(ENRICH_DELAY + Math.floor(Math.random() * 200));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, total)) }, (_, i) => worker(i)));
  };

  await runPass(slice, ENRICH_CONC, '');
  for (let round = 1; round <= ENRICH_RETRY_ROUNDS && !shouldStop(); round++) {
    const retry = slice.filter((p) => !hasDigit(p.price) && (errored.has(p) || known.has(p.sku)));
    if (!retry.length) break;
    const before = countPriced(products);
    log(`enrich retry ${round}/${ENRICH_RETRY_ROUNDS}: ${retry.length} SKUs errored or missing a price they had last time`);
    await recover('re-try pass', 20000);
    await runPass(retry, Math.max(2, Math.ceil(ENRICH_CONC / 2)), ` retry ${round}`);
    if (countPriced(products) === before) break; // nothing recovered — further rounds won't either
  }
  if (limit < targets.length) {
    log(`enrich: CAPPED at ${limit} of ${targets.length} products (set GRAYBAR_ENRICH_CAP=0 for all)`);
  }
  if (st.stopped) log(`enrich: stopped early (time budget / interrupt) after ${attempted.size} of ${slice.length} products`);
  return {
    withPrice: countPriced(products),
    enriched: attempted.size - errored.size,
    errors: errored.size,
    capped: limit < targets.length,
    stopped: st.stopped,
    reauths: st.reauths,
  };
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
// Success gate + output
// ---------------------------------------------------------------------------

// Last published data for this category → which SKUs should come back priced
// and how many prices a normal week has. Absent file = no expectations.
function loadBaseline(file = BASELINE_FILE) {
  try {
    const history = JSON.parse(readFileSync(file, 'utf8')).history || [];
    return { typical: typicalPriced(history), knownPriced: knownPricedKeys(history) };
  } catch {
    return { typical: 0, knownPriced: new Set() };
  }
}

/** Prices are the success gate. A capture with no prices in a category that
 * normally has them is a failed capture (Graybar answers an anonymous or
 * unpriced session exactly like a quote-only product), never "ok". Partial
 * coverage is still real data and is published, flagged in `reason`. */
function decideStatus({ productCount, priced, typical, enrichRan, allCallForPricing, sessionVerdict, stopped }) {
  if (!productCount) {
    return { status: STATUS.AUTH_FAILED_OR_PRICE_HIDDEN, reason: 'no_products_extracted' };
  }
  if (priced === 0) {
    if (isPriceOutage(priced, typical)) {
      return {
        status: STATUS.AUTH_FAILED_OR_PRICE_HIDDEN,
        reason: `no_prices_returned(expected ~${typical}; session ${sessionVerdict})`,
      };
    }
    // Never-priced category + verified session: genuinely quote-only.
    if (enrichRan && allCallForPricing && sessionVerdict !== 'no') return { status: STATUS.OK, reason: 'all_call_for_pricing' };
    return { status: STATUS.AUTH_FAILED_OR_PRICE_HIDDEN, reason: enrichRan ? 'no_prices_after_enrichment' : 'prices_not_enriched' };
  }
  const notes = [];
  if (stopped) notes.push('stopped_early');
  if (!isGoodCoverage(priced, typical)) notes.push(`partial_price_coverage(${priced}/~${typical})`);
  return { status: STATUS.OK, reason: notes.join(',') || null };
}

function exitCodeFor(status) {
  if (status === STATUS.AUTH_FAILED_OR_PRICE_HIDDEN) return SOFT_FAIL ? 0 : 3;
  if (status === STATUS.ERROR) return 1;
  return 0;
}

// Synchronous so it can also run from a SIGINT/SIGTERM handler (job timeout or
// cancel) and still leave the captured prices on disk for the publish step.
function finalize(run) {
  if (run.exitCode != null) return run.exitCode;
  const { products } = run;
  const priced = countPriced(products);
  let { status, reason } = run.fixed || decideStatus({
    productCount: products.length,
    priced,
    typical: run.baseline.typical,
    enrichRan: run.enrichRan,
    allCallForPricing: products.length > 0 && products.every((p) => p.callForPricing === true),
    sessionVerdict: run.sessionVerdict,
    stopped: run.enrichStats.stopped || run.interrupted,
  });
  if (run.error) {
    // Keep real prices captured before a crash; otherwise report the error.
    if (status === STATUS.OK && priced > 0) reason = [reason, `exception:${run.error}`].filter(Boolean).join(',');
    else [status, reason] = [STATUS.ERROR, `exception:${run.error}`];
  }
  if (run.interrupted) reason = [reason, 'interrupted'].filter(Boolean).join(',');

  const result = {
    status,
    reason,
    category: CATEGORY,
    captured_at: run.capturedAt,
    search_url: SEARCH_URL,
    source: products.length ? 'dom' : 'none',
    counts: {
      products: products.length,
      pages_visited: run.pagesVisited,
      page_cap_hit: run.capped,
      enriched: run.enrichStats.enriched,
      priced,
      enrich_errors: run.enrichStats.errors,
      enrich_capped: run.enrichStats.capped,
      reauths: run.enrichStats.reauths ?? 0,
      expected_priced: run.baseline.typical,
      currency_amounts_on_first_page: run.priceCheck.currencyAmounts,
      json_payloads_captured: run.rawPayloads.length,
    },
    field_presence: fieldPresence(products),
    products,
  };

  const stamp = fileStamp(run.capturedAt);
  const jsonPath = path.join(OUTPUT_DIR, `graybar-${CATEGORY}-${stamp}.json`);
  const latestPath = path.join(OUTPUT_DIR, `graybar-${CATEGORY}-latest.json`);
  const csvPath = path.join(OUTPUT_DIR, `graybar-${CATEGORY}-${stamp}.csv`);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(latestPath, JSON.stringify(result, null, 2));
  writeFileSync(csvPath, toCsv(products));
  if (run.rawPayloads.length) {
    writeFileSync(path.join(OUTPUT_DIR, `graybar-${CATEGORY}-raw-responses-${stamp}.json`), JSON.stringify(run.rawPayloads, null, 2));
  }

  log(`status=${status}${reason ? ` reason=${reason}` : ''} products=${products.length} priced=${priced} (typical ~${run.baseline.typical}) pages=${run.pagesVisited}${run.capped ? ' (PAGE CAP HIT)' : ''}`);
  log(`price-signal: dom_price_elements=${run.priceCheck.priceElements} currency_amounts_on_first_page=${run.priceCheck.currencyAmounts}`);
  log(`wrote: ${jsonPath}, ${latestPath}, ${csvPath}`);
  if (DEBUG) {
    debug('field presence (non-empty / total):');
    for (const [key] of COLUMNS) debug(`  ${key}: ${result.field_presence[key]}/${products.length}`);
    debug(`json payloads captured: ${run.rawPayloads.length}`);
  }
  run.exitCode = exitCodeFor(status);
  return run.exitCode;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const creds = loadCredentials(); // exits 2 before any browser launch if missing
  const startedMs = Date.now();
  const run = {
    capturedAt: new Date(startedMs).toISOString(),
    baseline: loadBaseline(),
    products: [],
    pagesVisited: 0,
    capped: false,
    priceCheck: { priceElements: 0, currencyAmounts: 0 },
    enrichStats: { withPrice: 0, enriched: 0, errors: 0, capped: false, stopped: false, reauths: 0 },
    enrichRan: false,
    sessionVerdict: 'unknown',
    rawPayloads: [],
    fixed: null,
    error: null,
    interrupted: false,
    exitCode: null,
  };
  const overBudget = () => TIME_BUDGET_MS > 0 && Date.now() - startedMs > TIME_BUDGET_MS;
  const shouldStop = () => run.interrupted || overBudget();
  log(
    `baseline: ~${run.baseline.typical} priced per capture, ${run.baseline.knownPriced.size} known-priced SKUs` +
      (TIME_BUDGET_MS ? `; time budget ${TIME_BUDGET_MS / 60000} min` : ''),
  );

  // Job timeout / cancel: write what we have so the publish step can use it.
  const onSignal = (sig) => {
    log(`${sig} received — writing captured data before exit…`);
    run.interrupted = true;
    process.exit(finalize(run));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext(CONTEXT_OPTS);
  const page = await context.newPage();

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
      run.rawPayloads.push({ url, status: resp.status(), json });
    } catch {
      /* ignore */
    }
  });

  try {
    const session = await ensureSession(page, context, creds, run.baseline);
    run.sessionVerdict = session.verdict || 'unknown';
    await jitter();

    if (session.challenge) {
      run.fixed = { status: STATUS.AUTH_FAILED_OR_PRICE_HIDDEN, reason: `challenge_detected:${(session.blockers || []).join('|')}` };
    } else if (session.noPrices) {
      run.fixed = {
        status: STATUS.AUTH_FAILED_OR_PRICE_HIDDEN,
        reason: `account_sees_no_prices(logged in; ${session.detail})`,
      };
    } else if (!session.ok) {
      // Don't spend an hour enriching as an anonymous visitor: nothing it
      // returns could be published.
      run.fixed = { status: STATUS.AUTH_FAILED_OR_PRICE_HIDDEN, reason: `not_authenticated(${session.detail})` };
    } else {
      log(`navigating to ${CATEGORY} search…`);
      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
      await sleep(DELAYS.settle);
      await dismissOverlays(page);
      // Graybar may normalize e.g. ?text=busway -> ?q=query:busway…; paginate
      // off the resolved URL so &page=N lands on the right result set.
      const resolvedSearchUrl = page.url() || SEARCH_URL;

      run.priceCheck = await pageHasPrices(page);
      // Capture the (post-login) search page so its real product-card structure
      // can be read off and the selectors finalised.
      if (DEBUG) await dumpDiagnostics(page, 'graybar-debug-search');

      // Paginate, accumulating de-duplicated rows. Stop when a page yields no
      // new rows (or the cap is hit). Conservative pacing between pages.
      const seen = new Set();
      let noNew = 0;
      for (let i = 0; i < DELAYS.maxPages && !shouldStop(); i++) {
        if (i > 0) {
          await page.goto(pageUrl(resolvedSearchUrl, i), { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
          await sleep(DELAYS.settle);
          await jitter();
        }
        run.pagesVisited = i + 1;
        const pageRows = await extractPage(page, run.capturedAt);
        if (i === 0 && DEBUG && pageRows[0]?.sku) await fetchDetailSample(page, pageRows[0].sku);
        let added = 0;
        for (const p of pageRows) {
          const key = [p.sku, p.product_url, p.title].filter(Boolean).join('|');
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          run.products.push(p);
          added++;
        }
        debug(`page ${i}: ${pageRows.length} rows, ${added} new (total ${run.products.length})`);
        if (added === 0) {
          if (++noNew >= 2) break;
        } else {
          noNew = 0;
        }
        if (i === DELAYS.maxPages - 1) run.capped = true;
      }
      run.products = dedupe(run.products);

      // Failsafe: if extraction produced nothing, capture the search page so a
      // scheduled (non-debug) run is still diagnosable — the markup/endpoint may
      // have drifted. The self-heal routine reads this artifact to re-tune.
      if (!run.products.length) {
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: DELAYS.nav }).catch(() => {});
        await sleep(DELAYS.settle);
        await dismissOverlays(page);
        await dumpDiagnostics(page, 'graybar-search-failure');
      }

      // Enrich price + stock per product via the detail JSON endpoint.
      if (ENRICH && run.products.length) {
        log(`enriching price + stock for ${run.products.length} products via /p/details (paced)…`);
        run.enrichRan = true;
        run.enrichStats = await enrichPrices(page, context, creds, run.products, run.baseline.knownPriced, shouldStop);
      }
    }
  } catch (err) {
    run.error = err && err.message ? err.message : String(err);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  process.exit(finalize(run));
}

export { dedupe, fieldPresence, toCsv, pageUrl, authSignals, authVerdict, applyDetail, decideStatus, fetchDetail, finalize, loadBaseline, STATUS };

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[graybar] FATAL:', err && err.message ? err.message : String(err));
    process.exit(1);
  });
}
