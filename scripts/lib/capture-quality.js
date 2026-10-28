/**
 * Shared rules for judging how complete a capture's pricing is. One source of
 * truth for the scraper's success gate, the publish guard, the data-repair
 * tool and the capture planner, so they never disagree about what a "good"
 * week of data looks like.
 *
 * A history entry is the compact per-capture record kept in
 * public/data/<slug>.json → history[] ({captured_at, rows, priced, prices, …}).
 */

// How many recent priced captures define a category's "typical" coverage.
const TYPICAL_WINDOW = 8;
// A capture is "good" when it prices at least this share of the typical count…
export const GOOD_COVERAGE = 0.5;
// …except in tiny categories (≤ this many priced items), where any price will do.
const SMALL_CATEGORY = 5;

export function pricedOf(h) {
  if (!h) return 0;
  if (typeof h.priced === 'number') return h.priced;
  return h.prices ? Object.keys(h.prices).length : 0;
}

function byTime(a, b) {
  return new Date(a.captured_at) - new Date(b.captured_at);
}

/** Median priced-item count over the most recent captures that had any prices
 * (0 when the category has never been priced — i.e. genuinely quote-only). */
export function typicalPriced(history) {
  const counts = (history || [])
    .filter((h) => h && h.captured_at && pricedOf(h) > 0)
    .sort(byTime)
    .slice(-TYPICAL_WINDOW)
    .map(pricedOf)
    .sort((a, b) => a - b);
  if (!counts.length) return 0;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : Math.round((counts[mid - 1] + counts[mid]) / 2);
}

/** A capture with zero prices in a category that normally has them is a failed
 * capture (Graybar answers like an anonymous visitor), not real data. */
export function isPriceOutage(priced, typical) {
  return priced === 0 && typical > 0;
}

/** Enough prices to count as this week's capture for the category. */
export function isGoodCoverage(priced, typical) {
  if (typical <= 0) return true; // quote-only category: any successful capture counts
  if (typical <= SMALL_CATEGORY) return priced > 0;
  return priced >= GOOD_COVERAGE * typical;
}

/** SKUs priced in any of the last `n` priced captures — the items worth
 * enriching first and re-trying when they come back without a price. */
export function knownPricedKeys(history, n = 4) {
  const keys = new Set();
  const recent = (history || []).filter((h) => h && h.prices && pricedOf(h) > 0).sort(byTime).slice(-n);
  for (const h of recent) for (const k of Object.keys(h.prices)) keys.add(k);
  return keys;
}

/** ISO week key (UTC, Thursday rule) — "2026-W43". Mirrors the dashboard's
 * week buckets so "one capture per week" means the same thing everywhere. */
export function isoWeekKey(iso) {
  const d = new Date(iso);
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 3); // nearest Thursday
  const year = dt.getUTCFullYear();
  const week = 1 + Math.floor((dt - Date.UTC(year, 0, 1)) / 86400000 / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
