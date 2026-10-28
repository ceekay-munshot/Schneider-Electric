import test from 'node:test';
import assert from 'node:assert/strict';

import { typicalPriced, isPriceOutage, isGoodCoverage, knownPricedKeys, isoWeekKey } from '../scripts/lib/capture-quality.js';
import { rejectReason, historyEntryOf } from '../scripts/publish-dashboard-data.js';
import { assess, plan } from '../scripts/plan-captures.js';
import { cleanHistory } from '../scripts/repair-dashboard-data.js';
import { authVerdict, decideStatus, applyDetail, STATUS } from '../src/capture-graybar.js';

const entry = (captured_at, priced, extra = {}) => ({
  captured_at,
  rows: 100,
  priced,
  prices: Object.fromEntries(Array.from({ length: priced }, (_, i) => [`S${i}`, 10 + i])),
  ...extra,
});

// Weekly UPS-like history: ~520 priced, then two anonymous-session captures.
const UPS = [
  entry('2026-09-28T10:00:00Z', 532),
  entry('2026-10-05T10:00:00Z', 520),
  entry('2026-10-12T10:00:00Z', 521),
  entry('2026-10-19T10:00:00Z', 0),
  entry('2026-10-26T10:00:00Z', 0),
];

test('typicalPriced ignores zero-priced captures and takes the median', () => {
  assert.equal(typicalPriced(UPS), 521);
  assert.equal(typicalPriced([entry('2026-10-01T00:00:00Z', 0)]), 0);
  assert.equal(typicalPriced([]), 0);
});

test('price outage = zero prices in a normally-priced category', () => {
  assert.equal(isPriceOutage(0, 521), true);
  assert.equal(isPriceOutage(0, 0), false); // quote-only category
  assert.equal(isPriceOutage(3, 521), false);
});

test('good coverage: half of typical, any price for tiny categories', () => {
  assert.equal(isGoodCoverage(300, 521), true);
  assert.equal(isGoodCoverage(200, 521), false);
  assert.equal(isGoodCoverage(1, 4), true);
  assert.equal(isGoodCoverage(0, 4), false);
  assert.equal(isGoodCoverage(0, 0), true);
});

test('knownPricedKeys unions recent priced captures only', () => {
  const keys = knownPricedKeys([entry('2026-10-05T00:00:00Z', 3), entry('2026-10-12T00:00:00Z', 0)]);
  assert.deepEqual([...keys].sort(), ['S0', 'S1', 'S2']);
});

test('isoWeekKey matches the dashboard week buckets (App.jsx isoWeek)', () => {
  const DAY = 86400000;
  const appKey = (iso) => {
    const d = new Date(iso);
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((dt - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  for (let t = Date.UTC(2024, 11, 1); t < Date.UTC(2028, 1, 1); t += DAY / 2) {
    const iso = new Date(t).toISOString();
    assert.equal(isoWeekKey(iso), appKey(iso), iso);
  }
});

test('publish refuses a zero-price capture of a priced category', () => {
  const existing = { history: UPS.slice(0, 3) };
  assert.match(rejectReason(entry('2026-10-19T10:00:00Z', 0), existing), /0 prices/);
  assert.equal(rejectReason(entry('2026-10-19T10:00:00Z', 510), existing), null);
});

test('publish keeps the better capture within one ISO week', () => {
  const existing = { history: UPS.slice(0, 3) };
  // Same week as 2026-10-12 (Mon) — a weak re-try must not replace it.
  assert.match(rejectReason(entry('2026-10-14T10:00:00Z', 200), existing), /keeping the better one/);
  assert.equal(rejectReason(entry('2026-10-14T10:00:00Z', 519), existing), null);
  // Re-publishing the same capture is idempotent, not a rival.
  assert.equal(rejectReason(entry('2026-10-12T10:00:00Z', 521), existing), null);
});

test('historyEntryOf counts priced items from a capture', () => {
  const h = historyEntryOf('2026-10-26T00:00:00Z', [
    { item_number: 'A', price_value: 10, brand: 'APC', availability: 'inStock' },
    { item_number: 'B', price: null, brand: 'Eaton' },
  ]);
  assert.equal(h.priced, 1);
  assert.deepEqual(h.prices, { A: 10 });
});

test('planner: capture when the week has no good data point', () => {
  const now = new Date('2026-10-28T03:30:00Z'); // Wed, week 2026-W44
  assert.equal(assess(null, null, now).need, true);
  assert.equal(assess({ history: UPS }, null, now).need, true); // W44 has nothing yet
  const good = { history: [...UPS.slice(0, 3), entry('2026-10-26T09:00:00Z', 515)] };
  assert.equal(assess(good, null, now).need, false);
  const weak = { history: [...UPS.slice(0, 3), entry('2026-10-26T09:00:00Z', 90)] };
  assert.equal(assess(weak, null, now).need, true);
  // …but not twice within the cool-down window.
  assert.equal(assess(weak, { last_attempt_at: '2026-10-28T00:00:00Z' }, now).need, false);
});

test('planner modes: stale / all / explicit slugs', () => {
  const targets = [{ slug: 'ups', url: 'u' }, { slug: 'dcim', url: 'd' }];
  const now = new Date('2026-10-28T03:30:00Z');
  const load = (slug) => ({
    data: slug === 'ups' ? { history: [...UPS.slice(0, 3), entry('2026-10-26T09:00:00Z', 515)] } : null,
    health: null,
  });
  assert.deepEqual(plan('stale', targets, load, now).filter((r) => r.need).map((r) => r.slug), ['dcim']);
  assert.equal(plan('all', targets, load, now).filter((r) => r.need).length, 2);
  assert.deepEqual(plan('ups', targets, load, now).map((r) => r.slug), ['ups']);
});

test('repair drops only zero-price captures of priced categories', () => {
  const { keep, dropped } = cleanHistory(UPS);
  assert.deepEqual(dropped.map((h) => h.captured_at.slice(0, 10)), ['2026-10-19', '2026-10-26']);
  assert.equal(keep.length, 3);
  assert.equal(cleanHistory([entry('2026-10-01T00:00:00Z', 0)]).dropped.length, 0); // quote-only: keep
});

test('authVerdict combines storefront signals and the price probe', () => {
  assert.equal(authVerdict({ status: 401, dl: 'false' }), 'no');
  assert.equal(authVerdict({ status: 200, dl: null }), 'yes');
  assert.equal(authVerdict({ status: 401, dl: 'false' }, { tried: 6, priced: 2 }), 'yes');
  assert.equal(authVerdict({ status: null, dl: null }, { tried: 6, priced: 0 }), 'no');
  assert.equal(authVerdict({ status: 500, dl: null }), 'unknown');
});

test('success gate: no prices in a priced category is a failure, never ok', () => {
  const base = { productCount: 955, enrichRan: true, allCallForPricing: true, sessionVerdict: 'unknown', stopped: false };
  assert.equal(decideStatus({ ...base, priced: 0, typical: 521 }).status, STATUS.AUTH_FAILED_OR_PRICE_HIDDEN);
  assert.equal(decideStatus({ ...base, priced: 0, typical: 0 }).status, STATUS.OK); // genuinely quote-only
  assert.equal(decideStatus({ ...base, priced: 0, typical: 0, sessionVerdict: 'no' }).status, STATUS.AUTH_FAILED_OR_PRICE_HIDDEN);
  const partial = decideStatus({ ...base, priced: 120, typical: 521, stopped: true });
  assert.equal(partial.status, STATUS.OK);
  assert.match(partial.reason, /stopped_early/);
  assert.match(partial.reason, /partial_price_coverage/);
  assert.equal(decideStatus({ ...base, priced: 515, typical: 521 }).reason, null);
  assert.equal(decideStatus({ ...base, productCount: 0, priced: 0, typical: 521 }).status, STATUS.AUTH_FAILED_OR_PRICE_HIDDEN);
});

test('applyDetail maps a detail response and flags failed requests', () => {
  const p = { sku: '1', price: null };
  const r = applyDetail(p, {
    price: { value: 1252.86, formattedValue: '$1,252.86', currencyIso: 'USD' },
    stock: { stockLevelStatus: { code: 'inStock' }, stockLevel: 12 },
    upc: '7313',
    defaultUom: 'ea',
    categories: [{ name: 'UPS' }],
    callForPricing: false,
  });
  assert.equal(r, 'priced');
  assert.equal(p.price_value, 1252.86);
  assert.equal(p.stock_level, 12);
  assert.equal(applyDetail({ sku: '2' }, { price: null, listPrice: null, callForPricing: true }), 'unpriced');
  assert.equal(applyDetail({ sku: '3' }, { _err: 'AbortError' }), 'error');
  assert.equal(applyDetail({ sku: '4' }, { _status: 500 }), 'error');
});
