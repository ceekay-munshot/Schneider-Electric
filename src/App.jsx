import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORIES, ALL_CATEGORIES, categoryBySlug, COMPANIES, companyOf } from './categories.js';

// Each live category loads its own data file (categories.js -> dataUrl, e.g.
// data/ups.json, data/busway.json). Absent/failed file -> safe empty state.
const LIVE_CATEGORIES = ALL_CATEGORIES.filter((c) => c.status === 'live');

const TABS = ['Analysis', 'Overview', 'Table', 'Methodology'];

const COLUMNS = [
  ['title', 'Product'],
  ['brand', 'Brand'],
  ['item_number', 'Item #'],
  ['cat_mpn', 'CAT/MPN'],
  ['upc', 'UPC'],
  ['category', 'Category'],
  ['price', 'Price'],
  ['unit_of_measure', 'UoM'],
  ['availability', 'Stock'],
];

// ---- data helpers ---------------------------------------------------------

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const products = Array.isArray(raw.products) ? raw.products : Array.isArray(raw.rows) ? raw.rows : [];
  const rows = typeof raw?.counts?.products === 'number' ? raw.counts.products : products.length;
  return {
    status: raw.status ?? null,
    reason: raw.reason ?? null,
    captured_at: raw.captured_at ?? null,
    search_url: raw.search_url ?? null,
    source: raw.source ?? null,
    field_presence: raw.field_presence ?? null,
    rows_this_scrape: rows,
    total_rows_on_record: typeof raw.total_rows_on_record === 'number' ? raw.total_rows_on_record : rows,
    scrapes_on_record: typeof raw.scrapes_on_record === 'number' ? raw.scrapes_on_record : raw.captured_at ? 1 : null,
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && h.captured_at) : [],
    products,
  };
}

function isUsable(d) {
  return !!d && d.status === 'ok' && Array.isArray(d.products) && d.products.length > 0;
}

function fmtUTC(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())} UTC`;
}

function freshness(iso, usable) {
  if (!usable || !iso) return { label: 'NO DATA', tone: 'none' };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { label: 'NO DATA', tone: 'none' };
  const hrs = Math.max(0, (Date.now() - t) / 3.6e6);
  const rel = hrs < 1 ? `${Math.round(hrs * 60)}M AGO` : hrs < 48 ? `${Math.round(hrs)}H AGO` : `${Math.round(hrs / 24)}D AGO`;
  const tone = hrs <= 24 * 8 ? 'fresh' : hrs <= 24 * 16 ? 'aging' : 'stale';
  const word = tone === 'fresh' ? 'FRESH' : tone === 'aging' ? 'AGING' : 'STALE';
  return { label: `${word} · ${rel}`, tone };
}

function num(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : (n ?? '—');
}
function cell(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}
function hasPrice(p) {
  return (typeof p?.price_value === 'number' && p.price_value > 0) || (p?.price != null && /\d/.test(String(p.price)));
}
function inStock(p) {
  if (typeof p?.stock_level === 'number') return p.stock_level > 0;
  const a = String(p?.availability || '').toLowerCase();
  if (!a) return false;
  if (a.includes('outofstock') || a.includes('out of stock')) return false;
  return /in\s?stock|low\s?stock/.test(a);
}

// ---- small pieces ---------------------------------------------------------

function Meta({ label, value }) {
  return (
    <div className="meta-item">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </div>
  );
}
function StatCard({ label, value }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
function FieldCoverage({ presence, total }) {
  if (!presence || !total) return <p className="muted">No field-coverage detail in this capture.</p>;
  return (
    <div className="coverage">
      {COLUMNS.map(([key, label]) => {
        const n = presence[key] ?? 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        return (
          <div className="cov-row" key={key}>
            <span className="cov-name">{label}</span>
            <span className="cov-bar">
              <span className="cov-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="cov-num">
              {num(n)}/{num(total)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ data }) {
  const attempted = !!data?.captured_at;
  return (
    <div className="card empty">
      <div className="empty-tag">NO CAPTURE ON RECORD</div>
      <h2>Awaiting first successful capture</h2>
      <p>
        This category populates automatically after the GitHub Actions scraper completes a capture in which distributor
        prices are actually visible. Until then it shows no rows, prices, or trends — this tool never displays fabricated
        or placeholder pricing.
      </p>
      {attempted && (
        <p className="muted attempt">
          Last attempt: <strong>{fmtUTC(data.captured_at)}</strong> · status <code>{data.status ?? 'unknown'}</code>
          {data.reason ? <> · {data.reason}</> : null}
        </p>
      )}
    </div>
  );
}

function PlannedCategory({ cat }) {
  const unavailable = cat.status === 'unavailable';
  return (
    <div className="card empty">
      <div className="empty-tag">{unavailable ? 'NOT ON GRAYBAR' : 'PLANNED CATEGORY'}</div>
      <h2>{cat.name}</h2>
      <p>
        {cat.note ||
          'This category isn’t captured yet. It will populate once its distributor search URL is configured and the weekly capture runs.'}
      </p>
    </div>
  );
}

// ---- tab bodies (live category) -------------------------------------------

// ---- period-over-period trends ---------------------------------------------

const DAY = 864e5;
const PERIODS = [
  { key: 'WoW', name: 'Week over week', days: 7 },
  { key: 'MoM', name: 'Month over month', days: 30 },
  { key: 'QoQ', name: 'Quarter over quarter', days: 91 },
];

function fmtDay(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtUsd(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// Compare the latest capture against the one closest to (latest - days).
// A baseline only qualifies inside [0.5x, 2x] of the window, so a "WoW" figure
// is never quietly computed against a months-old capture. Like-for-like: the
// average moves only on items priced in BOTH captures, immune to catalog mix
// shifts (new brands / delisted rows).
function comparePeriod(history, days) {
  const latest = history[history.length - 1];
  const tLatest = new Date(latest.captured_at).getTime();
  const lo = 0.5 * days * DAY;
  const hi = 2 * days * DAY;
  let base = null;
  let best = Infinity;
  for (const h of history.slice(0, -1)) {
    const gap = tLatest - new Date(h.captured_at).getTime();
    if (gap < lo || gap > hi) continue;
    const dist = Math.abs(gap - days * DAY);
    if (dist < best) {
      best = dist;
      base = h;
    }
  }
  if (!base) {
    const span = (tLatest - new Date(history[0].captured_at).getTime()) / DAY;
    return { active: false, needDays: Math.ceil(0.5 * days), haveDays: Math.max(0, Math.floor(span)) };
  }
  const gapDays = Math.round((tLatest - new Date(base.captured_at).getTime()) / DAY);
  if (latest.prices && base.prices) {
    const keys = Object.keys(latest.prices).filter((k) => typeof base.prices[k] === 'number');
    if (keys.length >= 5) {
      const now = keys.reduce((s, k) => s + latest.prices[k], 0) / keys.length;
      const then = keys.reduce((s, k) => s + base.prices[k], 0) / keys.length;
      return { active: true, matched: keys.length, now, then, gapDays, baseDate: base.captured_at };
    }
  }
  if (typeof latest.avg_price === 'number' && typeof base.avg_price === 'number') {
    return { active: true, matched: 0, now: latest.avg_price, then: base.avg_price, gapDays, baseDate: base.captured_at };
  }
  return { active: false, needDays: Math.ceil(0.5 * days), haveDays: 0 };
}

function PeriodCard({ period, cmp }) {
  if (!cmp.active) {
    const pct = Math.min(100, Math.round((cmp.haveDays / cmp.needDays) * 100));
    return (
      <div className="period inactive">
        <div className="period-key">
          <span>{period.key}</span>
          <span className="period-name">{period.name}</span>
        </div>
        <p className="period-wait">
          Needs a baseline capture ≥{cmp.needDays}d old — history spans {cmp.haveDays}d so far.
        </p>
        <span className="cov-bar period-progress">
          <span className="cov-fill" style={{ width: `${pct}%` }} />
        </span>
      </div>
    );
  }
  const pct = cmp.then > 0 ? ((cmp.now - cmp.then) / cmp.then) * 100 : 0;
  const tone = Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
  const arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '–';
  return (
    <div className="period">
      <div className="period-key">
        <span>{period.key}</span>
        <span className="period-name">{period.name}</span>
      </div>
      <div className={`period-delta delta-${tone} mono`}>
        <span className="delta-arrow">{arrow}</span> {Math.abs(pct).toFixed(2)}%
      </div>
      <div className="period-vals mono">
        {fmtUsd(cmp.then)} → {fmtUsd(cmp.now)}
      </div>
      <div className="period-base">
        vs {fmtDay(cmp.baseDate)} · {cmp.gapDays}d gap ·{' '}
        {cmp.matched ? `${num(cmp.matched)} matched items` : 'all priced items (mix may vary)'}
      </div>
    </div>
  );
}

function Sparkline({ history }) {
  const pts = history.filter((h) => typeof h.avg_price === 'number');
  if (pts.length < 2) return null;
  const W = 600;
  const H = 56;
  const PX = 5;
  const PY = 9;
  const ts = pts.map((h) => new Date(h.captured_at).getTime());
  const vs = pts.map((h) => h.avg_price);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  let v0 = Math.min(...vs);
  let v1 = Math.max(...vs);
  if (v1 - v0 < 1e-9) {
    v0 -= 1;
    v1 += 1;
  }
  const x = (t) => PX + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PX);
  const y = (v) => H - PY - ((v - v0) / (v1 - v0)) * (H - 2 * PY);
  const line = pts.map((h, i) => `${x(ts[i]).toFixed(2)},${y(vs[i]).toFixed(2)}`).join(' ');
  const area = `${PX},${H - 2} ${line} ${W - PX},${H - 2}`;
  return (
    <div className="spark-wrap">
      <svg
        className="spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Average price across ${pts.length} captures, ${fmtUsd(vs[0])} on ${fmtDay(pts[0].captured_at)} to ${fmtUsd(vs[vs.length - 1])} on ${fmtDay(pts[pts.length - 1].captured_at)}`}
      >
        <polygon className="spark-area" points={area} />
        <polyline className="spark-line" points={line} vectorEffect="non-scaling-stroke" />
        {pts.map((h, i) => (
          // zero-length round-capped path = a dot that stays circular even
          // though the svg stretches (preserveAspectRatio="none")
          <path
            key={h.captured_at}
            className={`spark-dot ${i === pts.length - 1 ? 'last' : ''}`}
            d={`M ${x(ts[i]).toFixed(2)} ${y(vs[i]).toFixed(2)} l 0.0001 0`}
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${fmtDay(h.captured_at)} · ${fmtUsd(h.avg_price)} avg · ${num(h.priced)} priced`}</title>
          </path>
        ))}
      </svg>
      <div className="spark-axis mono">
        <span>{fmtDay(pts[0].captured_at)}</span>
        <span className="spark-cap">avg of all priced items per capture · catalog mix varies</span>
        <span>
          {fmtUsd(vs[vs.length - 1])} avg · {fmtDay(pts[pts.length - 1].captured_at)}
        </span>
      </div>
    </div>
  );
}

// ---- capture health ---------------------------------------------------------
// CI records every attempt (success or failure) in data/<slug>-health.json.
// Failing or stalled automation surfaces here instead of silently aging.

function healthAlert(health, capturedAt) {
  if (health && health.last_attempt_status === 'failed' && health.consecutive_failures > 0) {
    return {
      kind: 'failing',
      n: health.consecutive_failures,
      attemptAt: health.last_attempt_at,
      lastGood: health.last_success_at ?? capturedAt ?? null,
      runUrl: health.run_url ?? null,
      hint: health.hint ?? null,
    };
  }
  const seen = [health?.last_attempt_at, capturedAt].filter(Boolean).map((d) => new Date(d).getTime());
  const last = seen.length ? Math.max(...seen) : null;
  // Weekly cadence: anything past 9 days means at least one missed attempt.
  if (last && Date.now() - last > 9 * DAY) {
    return { kind: 'overdue', sinceDays: Math.floor((Date.now() - last) / DAY) };
  }
  return null;
}

function HealthBanner({ alert }) {
  if (!alert) return null;
  if (alert.kind === 'failing') {
    return (
      <div className="health-banner failing" role="alert">
        <i className="dot" />
        <div>
          <strong>Capture attempts are failing</strong> — {alert.n === 1 ? 'one attempt' : `${alert.n} in a row`}, last
          tried {fmtUTC(alert.attemptAt)}.{alert.hint ? <> <code>{alert.hint}</code>.</> : null} Table shows the last
          good capture{alert.lastGood ? <> from {fmtUTC(alert.lastGood)}</> : null}.
          {alert.runUrl ? (
            <>
              {' '}
              <a href={alert.runUrl} target="_blank" rel="noreferrer noopener">
                View the failed run →
              </a>
            </>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="health-banner overdue" role="status">
      <i className="dot" />
      <div>
        <strong>No capture attempt in {alert.sinceDays} days</strong> — the weekly schedule (Mondays 03:30 UTC) looks
        stalled. Data below is from the last successful capture.
      </div>
    </div>
  );
}

// Prominent top banner — the headline analytics once 2+ captures exist.
function PriceTrends({ history }) {
  const ready = history.length >= 2;
  return (
    <section className="card trends-top">
      <div className="trends-head">
        <h3>Average Price Trends · Period-over-Period</h3>
        {ready && (
          <span className="trends-span mono">
            {num(history.length)} captures · {fmtDay(history[0].captured_at)} → {fmtDay(history[history.length - 1].captured_at)}
          </span>
        )}
      </div>
      {!ready ? (
        <>
          <p className="muted">
            Period-over-period analytics (WoW / MoM / QoQ) activate once at least two captures are on record. Until a
            second capture exists, no historical or comparative figures are shown.
          </p>
          <div className="periods-empty">Awaiting a second capture to compute movement.</div>
        </>
      ) : (
        <>
          <p className="muted trends-note">
            Like-for-like change in average price over items priced in both captures — new or delisted catalog rows
            never move the needle. Each card states its real baseline date.
          </p>
          <div className="periods">
            {PERIODS.map((p) => (
              <PeriodCard key={p.key} period={p} cmp={comparePeriod(history, p.days)} />
            ))}
          </div>
          <Sparkline history={history} />
        </>
      )}
    </section>
  );
}

// ---- cross-category analysis matrix (the "Analysis" tab) -------------------
// TI-style price-change grid: rows = calendar periods (week / month / quarter),
// columns = a blended "Average" + per-category brand sub-columns. Each cell is
// the like-for-like % change between consecutive periods' representative
// captures — only items priced in BOTH periods (and tagged that company in
// both) move the average, so catalog-mix shifts never fake a price move. Same
// convention as the Overview cards: ▲ up = red (cost rose), ▼ down = green.

const GRANS = [
  { key: 'week', label: 'Week on Week', short: 'WoW', noun: 'weeks' },
  { key: 'month', label: 'Month on Month', short: 'MoM', noun: 'months' },
  { key: 'quarter', label: 'Quarter on Quarter', short: 'QoQ', noun: 'quarters' },
];
const MIN_MATCH = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ISO-week number (UTC, Thursday rule).
function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (dt.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  dt.setUTCDate(dt.getUTCDate() - day + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return { year: dt.getUTCFullYear(), week };
}
// Calendar-bucket key for a capture (UTC). String-sortable within a granularity.
function periodKey(iso, gran) {
  const d = new Date(iso);
  if (gran === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (gran === 'quarter') return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
function weekStartIso(iso) {
  const d = new Date(iso);
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // back to Monday
  return dt.toISOString();
}
function periodRowLabel(row, gran) {
  if (gran === 'week') return `Wk ${fmtDay(weekStartIso(row.repIso))}`;
  const [y, tail] = row.key.split('-');
  if (gran === 'month') return `${MONTHS[Number(tail) - 1]} '${y.slice(2)}`;
  return `${tail} '${y.slice(2)}`; // quarter: "Q2 '26"
}

// Representative capture per bucket = the latest capture in that bucket.
function bucketReps(history, gran) {
  const reps = new Map();
  for (const h of history) {
    if (!h || !h.captured_at) continue;
    const k = periodKey(h.captured_at, gran);
    const cur = reps.get(k);
    if (!cur || new Date(h.captured_at) > new Date(cur.captured_at)) reps.set(k, h);
  }
  return reps;
}

// Like-for-like avg-price % change between two representatives over a key-set.
// memberOf(key, entry) filters to a company; null = all priced items.
function likeForLike(prev, curr, memberOf) {
  if (!prev || !curr || !prev.prices || !curr.prices) return { active: false };
  const keys = Object.keys(curr.prices).filter(
    (k) => typeof prev.prices[k] === 'number' && (!memberOf || (memberOf(k, curr) && memberOf(k, prev))),
  );
  if (keys.length < MIN_MATCH) return { active: false, matched: keys.length };
  const now = keys.reduce((s, k) => s + curr.prices[k], 0) / keys.length;
  const then = keys.reduce((s, k) => s + prev.prices[k], 0) / keys.length;
  const pct = then > 0 ? ((now - then) / then) * 100 : 0;
  const tone = Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
  return { active: true, matched: keys.length, now, then, pct, tone, arrow: tone === 'up' ? '▲' : tone === 'down' ? '▼' : '' };
}
// Same key a capture uses in its prices/brand_of maps (mirror of the publish
// script's itemKeyOf), so the current catalog can be joined back onto a cell's
// matched items to recover titles + Graybar product links for traceability.
function itemKeyFor(p) {
  const k = p.item_number ?? p.sku ?? p.cat_mpn ?? p.upc ?? p.product_url;
  return k == null ? null : String(k);
}
// Merge every category's representative for one bucket into a single namespaced
// map, so the "Average" column is a true cross-category like-for-like.
function mergedRep(cats, k) {
  const prices = {};
  const brand_of = {};
  let iso = null;
  for (const c of cats) {
    const r = c.reps.get(k);
    if (!r || !r.prices) continue;
    if (!iso || new Date(r.captured_at) > new Date(iso)) iso = r.captured_at;
    for (const key of Object.keys(r.prices)) {
      const nk = `${c.slug}::${key}`;
      prices[nk] = r.prices[key];
      if (r.brand_of) brand_of[nk] = r.brand_of[key];
    }
  }
  return iso ? { captured_at: iso, prices, brand_of } : null;
}

// Build the whole matrix model for one granularity from the loaded categories.
function buildMatrix(usableCats, gran) {
  const cats = usableCats.map((c) => {
    const reps = bucketReps(c.d.history, gran);
    // item -> {title, url} from the latest capture, to name & link a cell's items
    const meta = new Map();
    for (const p of c.d.products || []) {
      const k = itemKeyFor(p);
      if (k && !meta.has(k)) meta.set(k, { title: p.title || null, url: p.product_url || null });
    }
    return { slug: c.slug, name: c.name, reps, keysDesc: [...reps.keys()].sort().reverse(), meta };
  });
  // Only categories with >= 2 populated buckets can produce a real change at this
  // granularity; a category with a single capture would be all-"—" noise, so it
  // stays out of the matrix until it has enough history (its sidebar count still
  // shows it exists).
  const shown = cats.filter((c) => c.keysDesc.length >= 2);
  const allKeys = new Set();
  shown.forEach((c) => c.keysDesc.forEach((k) => allKeys.add(k)));
  const periodKeys = [...allKeys].sort().reverse(); // newest first

  // Columns: per category, the parent companies with >= MIN_MATCH priced items
  // in that category's newest bucket get their own sub-column (ordered by count),
  // plus an "All" column. Degenerate (all-"—") brand columns are pruned.
  const groups = shown.map((c) => {
    const newestKey = periodKeys.find((k) => c.reps.has(k));
    const rep = newestKey ? c.reps.get(newestKey) : null;
    const counts = {};
    if (rep && rep.brand_of) for (const co of Object.values(rep.brand_of)) counts[co] = (counts[co] || 0) + 1;
    const brands = Object.entries(counts)
      .filter(([, n]) => n >= MIN_MATCH)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([co]) => co);
    const subCols = [
      ...brands.map((co) => ({ id: `${c.slug}:${co}`, brand: co, company: co, slug: c.slug })),
      { id: `${c.slug}:All`, brand: 'All', company: null, slug: c.slug },
    ];
    return { slug: c.slug, name: c.name, subCols };
  });
  const leaf = groups.flatMap((g) => g.subCols.map((sc, i) => ({ ...sc, groupStart: i === 0 })));

  // Rows: every populated period except the very oldest (which has no baseline).
  const rowKeys = periodKeys.slice(0, Math.max(0, periodKeys.length - 1));
  const rows = rowKeys.map((k, i) => {
    const prevKey = periodKeys[i + 1];
    const cells = new Map();
    const avg = likeForLike(mergedRep(shown, prevKey), mergedRep(shown, k), null);
    avg.ref = { kind: 'avg', curKey: k, baseKey: prevKey, colLabel: 'Average · all categories' };
    cells.set('avg', avg);
    for (const g of groups) {
      const c = shown.find((x) => x.slug === g.slug);
      const cur = c.reps.get(k);
      // per-category baseline = this cat's own next-older populated bucket
      const ci = c.keysDesc.indexOf(k);
      const basK = ci >= 0 ? c.keysDesc[ci + 1] : undefined;
      const bas = basK ? c.reps.get(basK) : null;
      for (const sc of g.subCols) {
        const memberOf = sc.company ? (key, e) => e.brand_of && e.brand_of[key] === sc.company : null;
        const cc = cur ? likeForLike(bas, cur, memberOf) : { active: false };
        cc.ref = {
          kind: sc.company ? 'brand' : 'all',
          slug: g.slug,
          company: sc.company,
          curKey: k,
          baseKey: basK,
          colLabel: `${g.name} · ${sc.brand}`,
        };
        cells.set(sc.id, cc);
      }
    }
    let repIso = null;
    for (const c of shown) {
      const r = c.reps.get(k);
      if (r && (!repIso || new Date(r.captured_at) > new Date(repIso))) repIso = r.captured_at;
    }
    return { key: k, repIso, cells, isLive: i === 0 };
  });

  // KPI extremes over the live row's leaf cells.
  let up = null;
  let down = null;
  if (rows[0]) {
    for (const col of leaf) {
      const cc = rows[0].cells.get(col.id);
      if (!cc || !cc.active) continue;
      const where = `${groups.find((g) => g.slug === col.slug)?.name ?? col.slug} · ${col.brand}`;
      if (up === null || cc.pct > up.pct) up = { pct: cc.pct, tone: cc.tone, arrow: cc.arrow, where };
      if (down === null || cc.pct < down.pct) down = { pct: cc.pct, tone: cc.tone, arrow: cc.arrow, where };
    }
  }
  const overall = rows[0]?.cells.get('avg');
  return {
    groups,
    leaf,
    rows,
    cats: shown, // kept so a clicked cell can be traced back to its items on demand
    kpi: {
      overall: overall && overall.active ? overall : null,
      riser: up && up.pct >= 0.005 ? up : null, // non-flat only ("nothing rose" reads as —)
      faller: down && down.pct <= -0.005 ? down : null,
    },
  };
}

// A human-readable label for a period bucket key ("Wk Jun 22" / "Jun '26" / "Q2 '26").
function keyLabel(matrix, key, gran) {
  if (!key) return null;
  if (gran !== 'week') {
    const [y, tail] = key.split('-');
    return gran === 'month' ? `${MONTHS[Number(tail) - 1]} '${y.slice(2)}` : `${tail} '${y.slice(2)}`;
  }
  let iso = null;
  for (const c of matrix.cats) {
    const r = c.reps.get(key);
    if (r && (!iso || new Date(r.captured_at) > new Date(iso))) iso = r.captured_at;
  }
  return iso ? `Wk ${fmtDay(weekStartIso(iso))}` : key;
}

// Reconstruct, on demand, exactly how one cell was computed: its component
// breakdown one level down (categories for Average, brands for a category "All")
// and the full set of matched items with then→now prices and Graybar links.
function computeDetail(matrix, ref, gran) {
  const { kind, slug, company, curKey, baseKey, colLabel } = ref;
  const curLabel = keyLabel(matrix, curKey, gran);
  const baseLabel = keyLabel(matrix, baseKey, gran);
  const base = { colLabel, curLabel, baseLabel, kind };

  let cur;
  let prev;
  let metaFor;
  let groupOf = null;
  if (kind === 'avg') {
    cur = mergedRep(matrix.cats, curKey);
    prev = baseKey ? mergedRep(matrix.cats, baseKey) : null;
    metaFor = (nk) => {
      const i = nk.indexOf('::');
      const s = nk.slice(0, i);
      const key = nk.slice(i + 2);
      return { key, slug: s, ...(matrix.cats.find((c) => c.slug === s)?.meta.get(key) || {}) };
    };
    groupOf = (nk) => nk.slice(0, nk.indexOf('::')); // by category slug
  } else {
    const cat = matrix.cats.find((c) => c.slug === slug);
    cur = cat ? cat.reps.get(curKey) : null;
    prev = cat && baseKey ? cat.reps.get(baseKey) : null;
    metaFor = (k) => ({ key: k, slug, ...(cat?.meta.get(k) || {}) });
    if (kind === 'all') groupOf = (k) => (cur && cur.brand_of ? cur.brand_of[k] : 'Other'); // by brand
  }

  if (!cur || !cur.prices || !prev || !prev.prices) {
    return { ...base, active: false, matched: 0, items: [], components: [], reason: 'no comparable prior period on record' };
  }
  const inCo = company ? (k) => cur.brand_of && cur.brand_of[k] === company && prev.brand_of && prev.brand_of[k] === company : null;
  const keys = Object.keys(cur.prices).filter((k) => typeof prev.prices[k] === 'number' && (!inCo || inCo(k)));

  const items = keys
    .map((k) => {
      const m = metaFor(k);
      const then = prev.prices[k];
      const now = cur.prices[k];
      const pct = then > 0 ? ((now - then) / then) * 100 : 0;
      return { key: m.key, title: m.title || null, url: m.url || null, then, now, pct };
    })
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  let components = [];
  if (groupOf) {
    const byG = new Map();
    for (const k of keys) {
      const g = groupOf(k) || 'Other';
      if (!byG.has(g)) byG.set(g, []);
      byG.get(g).push(k);
    }
    components = [...byG.entries()]
      .map(([g, ks]) => {
        const n = ks.reduce((s, k) => s + cur.prices[k], 0) / ks.length;
        const t = ks.reduce((s, k) => s + prev.prices[k], 0) / ks.length;
        const pct = t > 0 ? ((n - t) / t) * 100 : 0;
        const label = kind === 'avg' ? matrix.cats.find((c) => c.slug === g)?.name || g : g;
        return { label, matched: ks.length, pct };
      })
      .sort((a, b) => b.matched - a.matched);
  }

  const now = items.length ? items.reduce((s, x) => s + x.now, 0) / items.length : null;
  const then = items.length ? items.reduce((s, x) => s + x.then, 0) / items.length : null;
  const pct = then ? ((now - then) / then) * 100 : 0;
  return {
    ...base,
    active: items.length >= MIN_MATCH,
    matched: items.length,
    then,
    now,
    pct,
    tone: Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down',
    components,
    items,
  };
}

function toneOf(pct) {
  return Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
}
function signedPct(pct) {
  const t = toneOf(pct);
  return `${t === 'up' ? '▲' : t === 'down' ? '▼' : ''}${Math.abs(pct).toFixed(2)}%`;
}

function CellDetailModal({ detail, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!detail) return null;
  return (
    <div className="mtx-modal-backdrop" onClick={onClose}>
      <div
        className="mtx-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${detail.colLabel} · ${detail.curLabel}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="mtx-modal-x" onClick={onClose} aria-label="Close" autoFocus>
          ×
        </button>
        <div className="mtx-modal-body">
        <div className="mtx-modal-head">
          <h3>{detail.colLabel}</h3>
          <p className="muted">
            {detail.curLabel}
            {detail.baseLabel ? <> vs {detail.baseLabel}</> : null}
          </p>
        </div>

        {detail.active ? (
          <>
            <div className={`mtx-modal-big mono kpi-${detail.tone}`}>{signedPct(detail.pct)}</div>
            <div className="mtx-modal-sub mono">
              {fmtUsd(detail.then)} → {fmtUsd(detail.now)} · like-for-like avg over {num(detail.matched)} items priced in
              both periods
            </div>
            <p className="mtx-modal-method">
              Only items priced in <strong>both</strong> periods move this number, so new or delisted products never
              distort it. Prices are captured from authenticated Graybar sessions — click an item to open its Graybar
              page.
            </p>

            {detail.components.length > 0 && (
              <div className="mtx-modal-section">
                <div className="mtx-modal-label">
                  Breakdown · {detail.kind === 'avg' ? 'by category' : 'by brand'}
                </div>
                {detail.components.map((c) => (
                  <div className="mtx-comp-row" key={c.label}>
                    <span className="mtx-comp-name">{c.label}</span>
                    <span className="mono muted">{num(c.matched)} items</span>
                    <span className={`mono kpi-${toneOf(c.pct)}`}>{signedPct(c.pct)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mtx-modal-section">
              <div className="mtx-modal-label">Every contributing item · biggest move first</div>
              <div className="mtx-items">
                {detail.items.map((it) => (
                  <div className="mtx-item" key={it.key}>
                    <span className="mtx-item-name">
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noreferrer noopener">
                          {it.title || it.key}
                        </a>
                      ) : (
                        it.title || it.key
                      )}
                      {it.title ? <span className="mtx-item-key mono"> · {it.key}</span> : null}
                    </span>
                    <span className="mtx-item-px mono">
                      {fmtUsd(it.then)} → {fmtUsd(it.now)}
                    </span>
                    <span className={`mtx-item-pct mono kpi-${toneOf(it.pct)}`}>{signedPct(it.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="mtx-modal-section">
            <div className="mtx-modal-big mono cell-na">—</div>
            <p className="muted">
              {detail.reason
                ? 'No comparable prior period yet — this is the earliest capture at this granularity, so there is nothing to compare against.'
                : `Only ${num(detail.matched)} item${detail.matched === 1 ? ' was' : 's were'} priced in both periods — at least ${MIN_MATCH} are needed for a trustworthy average, so this cell is deliberately left blank rather than shown as a shaky number.`}
            </p>
            {detail.items.length > 0 && (
              <div className="mtx-items">
                {detail.items.map((it) => (
                  <div className="mtx-item" key={it.key}>
                    <span className="mtx-item-name">
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noreferrer noopener">
                          {it.title || it.key}
                        </a>
                      ) : (
                        it.title || it.key
                      )}
                    </span>
                    <span className="mtx-item-px mono">
                      {fmtUsd(it.then)} → {fmtUsd(it.now)}
                    </span>
                    <span className={`mtx-item-pct mono kpi-${toneOf(it.pct)}`}>{signedPct(it.pct)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function MatrixCell({ cell, className = '', onSelect }) {
  const active = cell && cell.active;
  const toneCls = active ? `cell-${cell.tone}` : 'cell-na';
  const inner = active ? (
    <>
      {cell.arrow && (
        <span className="cell-arrow" aria-hidden="true">
          {cell.arrow}
        </span>
      )}
      {Math.abs(cell.pct).toFixed(2)}%
    </>
  ) : (
    '—'
  );
  const clickable = cell && cell.ref && onSelect;
  return (
    <td className={`matrix-cell ${toneCls} mono ${className}`}>
      {clickable ? (
        <button type="button" className="mtx-cell-btn" onClick={() => onSelect(cell.ref)} title="Trace how this is calculated">
          {inner}
        </button>
      ) : (
        <span className="mtx-cell-static">{inner}</span>
      )}
    </td>
  );
}

function GranularityToggle({ value, onChange }) {
  return (
    <div className="gran-toggle" role="tablist" aria-label="Comparison granularity">
      {GRANS.map((g) => (
        <button
          key={g.key}
          role="tab"
          aria-selected={value === g.key}
          className={`gran-pill ${value === g.key ? 'on' : ''}`}
          onClick={() => onChange(g.key)}
        >
          <span className="gran-full">{g.label}</span>
          <span className="gran-abbr">{g.short}</span>
        </button>
      ))}
    </div>
  );
}

function MatrixKPIs({ granShort, kpi, captures, fresh, periods }) {
  const mover = (m) =>
    m ? (
      <span className="kpi-mover">
        <span className={`kpi-${m.tone} mono`}>
          {m.arrow} {Math.abs(m.pct).toFixed(2)}%
        </span>
        <span className="kpi-where">{m.where}</span>
      </span>
    ) : (
      '—'
    );
  return (
    <section className="stats matrix-kpis">
      <StatCard
        label={`Overall ${granShort}`}
        value={
          kpi.overall ? (
            <span className={`kpi-${kpi.overall.tone} mono`}>
              {kpi.overall.arrow ? `${kpi.overall.arrow} ` : ''}
              {Math.abs(kpi.overall.pct).toFixed(2)}%
            </span>
          ) : (
            '—'
          )
        }
      />
      <StatCard label="Steepest rise" value={mover(kpi.riser)} />
      <StatCard label="Steepest fall" value={mover(kpi.faller)} />
      <StatCard
        label="On record"
        value={
          <span className="mono">
            {num(captures)} captures · {num(periods)} {granShort === 'WoW' ? 'wks' : granShort === 'MoM' ? 'mos' : 'qtrs'} ·{' '}
            <span className={`kpi-fresh badge badge-${fresh.tone}`}>{fresh.label}</span>
          </span>
        }
      />
    </section>
  );
}

function MatrixTable({ groups, leaf, rows, gran, onSelect }) {
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr className="matrix-group-row">
            <th className="col-period matrix-corner" rowSpan={2}>
              Period
            </th>
            <th className="col-avg matrix-grouphead matrix-avghead" rowSpan={2}>
              <span className="grouphead-title">Average</span>
              <span className="grouphead-sub">all categories</span>
            </th>
            {groups.map((g) => (
              <th key={g.slug} className="matrix-grouphead col-group-start" colSpan={g.subCols.length}>
                {g.name}
              </th>
            ))}
          </tr>
          <tr className="matrix-sub-row">
            {groups.map((g) =>
              g.subCols.map((sc, i) => (
                <th
                  key={sc.id}
                  className={`matrix-subhead ${i === 0 ? 'col-group-start' : ''} ${sc.brand === 'All' ? 'sub-all' : ''}`}
                >
                  {sc.brand}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={`matrix-row ${row.isLive ? 'live' : ''}`}>
              <th scope="row" className="col-period matrix-period">
                {row.isLive && <i className="live-dot" aria-hidden="true" />}
                <span className="period-label">{periodRowLabel(row, gran)}</span>
                {row.isLive && <span className="period-tag">to-date</span>}
              </th>
              <MatrixCell className="col-avg" cell={row.cells.get('avg')} onSelect={onSelect} />
              {leaf.map((col) => (
                <MatrixCell
                  key={col.id}
                  className={col.groupStart ? 'col-group-start' : ''}
                  cell={row.cells.get(col.id)}
                  onSelect={onSelect}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixLegend() {
  return (
    <div className="matrix-legend">
      <span className="lg-item">
        <i className="lg-swatch up" /> increase (price rose)
      </span>
      <span className="lg-item">
        <i className="lg-swatch down" /> decrease (price fell)
      </span>
      <span className="lg-sep">·</span>
      <span className="lg-item">
        <i className="live-dot" /> live row — updates each capture
      </span>
      <span className="lg-item">closed periods show realized %</span>
      <span className="lg-item">
        <b>—</b> = fewer than {MIN_MATCH} matched items / still accumulating
      </span>
      <span className="lg-sep">·</span>
      <span className="lg-item lg-hint">click any cell to trace it to source</span>
    </div>
  );
}

function AnalysisMatrix({ dataMap, granularity, onGranularity }) {
  const anyLoading = LIVE_CATEGORIES.some((c) => dataMap[c.slug] === undefined);
  const [detailRef, setDetailRef] = useState(null);
  useEffect(() => setDetailRef(null), [granularity]); // period keys change with granularity

  const model = useMemo(() => {
    const usableCats = LIVE_CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, d: normalize(dataMap[c.slug]) })).filter(
      (c) => isUsable(c.d) && c.d.history.length > 0,
    );
    if (!usableCats.length) return { usableCats };
    // distinct populated-bucket count per granularity (for the accumulating nudge)
    const periodCounts = {};
    for (const g of GRANS) {
      const set = new Set();
      usableCats.forEach((c) => c.d.history.forEach((h) => h.captured_at && set.add(periodKey(h.captured_at, g.key))));
      periodCounts[g.key] = set.size;
    }
    const captures = usableCats.reduce((s, c) => s + c.d.history.length, 0);
    let newest = null;
    usableCats.forEach((c) => {
      const t = c.d.captured_at;
      if (t && (!newest || new Date(t) > new Date(newest))) newest = t;
    });
    const matrix = buildMatrix(usableCats, granularity);
    return { usableCats, periodCounts, captures, fresh: freshness(newest, true), matrix };
  }, [dataMap, granularity]);

  const granMeta = GRANS.find((g) => g.key === granularity);
  const header = (
    <div className="matrix-head">
      <div className="matrix-titles">
        <h3>Price Change Matrix · by Category &amp; Brand</h3>
        <p className="muted matrix-sub">
          Like-for-like average price change across calendar {granMeta.noun} — only items priced in both periods move a
          cell. ▲ up = cost rose (red), ▼ down = fell (green).
        </p>
      </div>
      <GranularityToggle value={granularity} onChange={onGranularity} />
    </div>
  );

  // ---- states: loading -> empty -> accumulating -> table ----
  if (anyLoading && !model.usableCats?.length) {
    return (
      <section className="card">
        {header}
        <div className="card muted matrix-state">Loading captures…</div>
      </section>
    );
  }
  if (!model.usableCats.length) {
    return (
      <section className="card">
        {header}
        <div className="card empty matrix-state">
          <div className="empty-tag">NO CAPTURES ON RECORD</div>
          <h2>Awaiting the first captures</h2>
          <p>
            This matrix populates automatically once at least two weekly captures are on record for a live category. It
            never shows fabricated or placeholder movement.
          </p>
        </div>
      </section>
    );
  }

  const rows = model.matrix.rows;
  if (!rows.length) {
    // fewer than two populated buckets at this granularity — suggest one that works
    const better = GRANS.filter((g) => model.periodCounts[g.key] >= 2).map((g) => `${g.label} (${model.periodCounts[g.key]} ${g.noun})`);
    return (
      <section className="card">
        {header}
        <div className="periods-empty matrix-accum">
          <strong>{granMeta.label}</strong> activates once captures span two calendar {granMeta.noun}. So far they fall
          in a single {granMeta.noun.replace(/s$/, '')} ({model.periodCounts[granularity]} on record).
          {better.length ? (
            <>
              {' '}
              Try <strong>{better.join(' or ')}</strong>, which already {better.length > 1 ? 'have' : 'has'} enough
              history.
            </>
          ) : (
            ' More captures accrue every Monday.'
          )}
        </div>
      </section>
    );
  }

  const detail = detailRef ? computeDetail(model.matrix, detailRef, granularity) : null;
  return (
    <section className="card">
      {header}
      <MatrixKPIs
        granShort={granMeta.short}
        kpi={model.matrix.kpi}
        captures={model.captures}
        periods={model.periodCounts[granularity]}
        fresh={model.fresh}
      />
      <MatrixTable
        groups={model.matrix.groups}
        leaf={model.matrix.leaf}
        rows={rows}
        gran={granularity}
        onSelect={setDetailRef}
      />
      <MatrixLegend />
      {detail && <CellDetailModal detail={detail} onClose={() => setDetailRef(null)} />}
    </section>
  );
}

// Overview tab: trends banner + capture stat cards + field coverage (full width).
function Overview({ data, catName }) {
  return (
    <>
      <PriceTrends history={data.history} />
      <section className="stats">
        <StatCard label="Category" value={catName} />
        <StatCard label="Capture status" value={<span className="ok-pill">{data.status}</span>} />
        <StatCard label="Captured at" value={fmtUTC(data.captured_at)} />
        <StatCard label="Rows this scrape" value={num(data.rows_this_scrape)} />
      </section>
      <section className="card">
        <h3>Field coverage · latest capture</h3>
        <FieldCoverage presence={data.field_presence} total={data.rows_this_scrape} />
      </section>
    </>
  );
}

function Universe({
  loading,
  usable,
  data,
  catName,
  filter,
  setFilter,
  companies,
  setCompanies,
  companyCounts,
  priceFilter,
  setPriceFilter,
  stockFilter,
  setStockFilter,
}) {
  // brand + text filtered (before the price/stock filters), so the pills can show
  // accurate counts for the current selection.
  const baseRows = useMemo(() => {
    if (!usable) return [];
    let r = data.products;
    if (companies.length) r = r.filter((p) => companies.includes(companyOf(p.brand)));
    const q = filter.trim().toLowerCase();
    if (q) {
      r = r.filter((p) =>
        [p.title, p.brand, p.item_number, p.cat_mpn, p.upc, p.category]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    return r;
  }, [usable, data, filter, companies]);
  const pricedCount = useMemo(() => baseRows.filter(hasPrice).length, [baseRows]);
  const inStockCount = useMemo(() => baseRows.filter(inStock).length, [baseRows]);
  // price + stock filters AND together (and with brand/text above).
  const rows = useMemo(() => {
    let r = baseRows;
    if (priceFilter === 'priced') r = r.filter(hasPrice);
    else if (priceFilter === 'unpriced') r = r.filter((p) => !hasPrice(p));
    if (stockFilter === 'instock') r = r.filter(inStock);
    else if (stockFilter === 'outstock') r = r.filter((p) => !inStock(p));
    return r;
  }, [baseRows, priceFilter, stockFilter]);

  if (loading) return <div className="card muted">Loading latest capture…</div>;
  if (!usable) return <EmptyState data={data} />;

  const toggle = (c) => setCompanies(companies.includes(c) ? companies.filter((x) => x !== c) : [...companies, c]);
  const pills = [...COMPANIES, ...(companyCounts.Other ? ['Other'] : [])];
  const capped = rows.slice(0, 1000);

  return (
    <section className="card">
      <div className="universe-head">
        <h3>
          {catName} · {num(rows.length)} of {num(data.products.length)} rows
        </h3>
        <input
          className="filter"
          placeholder="Filter by title, brand, item #, UPC…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="brandbar">
        <span className="brandbar-label">Brand</span>
        {pills.map((c) => (
          <button
            key={c}
            className={`brandpill ${companies.includes(c) ? 'on' : ''}`}
            onClick={() => toggle(c)}
            disabled={!companyCounts[c]}
            title={companyCounts[c] ? '' : 'No products from this company in the current data'}
          >
            {c} <span className="brandpill-n">{companyCounts[c] || 0}</span>
          </button>
        ))}
        {companies.length > 0 && (
          <button className="brandpill clear" onClick={() => setCompanies([])}>
            Clear
          </button>
        )}
      </div>

      <div className="brandbar">
        <span className="brandbar-label">Price</span>
        {[
          ['all', 'All', baseRows.length],
          ['priced', 'With price', pricedCount],
          ['unpriced', 'No price', baseRows.length - pricedCount],
        ].map(([key, label, n]) => (
          <button
            key={key}
            className={`brandpill ${priceFilter === key ? 'on' : ''}`}
            onClick={() => setPriceFilter(key)}
          >
            {label} <span className="brandpill-n">{n}</span>
          </button>
        ))}
      </div>

      <div className="brandbar">
        <span className="brandbar-label">Stock</span>
        {[
          ['all', 'All', baseRows.length],
          ['instock', 'In stock', inStockCount],
          ['outstock', 'Out of stock', baseRows.length - inStockCount],
        ].map(([key, label, n]) => (
          <button
            key={key}
            className={`brandpill ${stockFilter === key ? 'on' : ''}`}
            onClick={() => setStockFilter(key)}
          >
            {label} <span className="brandpill-n">{n}</span>
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
              <th>Link</th>
            </tr>
          </thead>
          <tbody>
            {capped.map((p, i) => (
              <tr key={p.item_number || p.product_url || i}>
                {COLUMNS.map(([key]) => (
                  <td key={key} className={key === 'price' ? 'mono' : undefined}>
                    {cell(p[key])}
                  </td>
                ))}
                <td>
                  {p.product_url ? (
                    <a href={p.product_url} target="_blank" rel="noreferrer noopener">
                      view
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > capped.length && (
        <p className="muted">
          Showing first {num(capped.length)} of {num(rows.length)} matching rows. Narrow with a filter or Download XLSX for
          the full set.
        </p>
      )}
      {rows.length === 0 && <p className="muted">No rows match the current filters.</p>}
    </section>
  );
}

function Methodology() {
  return (
    <section className="card prose">
      <h3>Methodology</h3>
      <p>
        A finance-grade tracker for distributor pricing, stock, and lead-time signals across critical power and
        data-center infrastructure. <strong>UPS (single &amp; three-phase) is the first live category</strong>; the other
        categories are scaffolded and populate as their captures come online.
      </p>
      <h4>Data source</h4>
      <p>
        Pricing and availability are captured from authenticated distributor sessions by a Playwright scraper that runs on
        a schedule in <strong>GitHub Actions</strong> — never from this site. Distributor pricing is account-specific and
        is only exposed after a normal login.
      </p>
      <h4>Integrity rules</h4>
      <ul>
        <li>No fabricated or placeholder prices. If prices are not visible, the capture is marked <code>auth_failed_or_price_hidden</code> and excluded.</li>
        <li>No invented history. Period-over-period analytics begin only once two or more real captures are on record.</li>
        <li>Fields not present on a product are shown as “—”, not guessed.</li>
      </ul>
      <h4>Separation of concerns</h4>
      <p>
        The scraper and this dashboard are independent. Scraping runs only in GitHub Actions and uses repository secrets
        that are never exposed here. This Cloudflare Pages site is a static, read-only view: it builds the UI, loads the
        latest published capture if one exists, and holds no credentials and runs no browser automation.
      </p>
    </section>
  );
}

// ---- app shell ------------------------------------------------------------

export default function App() {
  const [dataMap, setDataMap] = useState({}); // slug -> raw json | null | undefined(unloaded)
  const [healthMap, setHealthMap] = useState({}); // slug -> health json | null
  const [tab, setTab] = useState('Analysis');
  const [gran, setGran] = useState('week'); // Analysis matrix granularity: week | month | quarter
  const [filter, setFilter] = useState('');
  const [companies, setCompanies] = useState([]);
  const [priceFilter, setPriceFilter] = useState('all'); // all | priced | unpriced
  const [stockFilter, setStockFilter] = useState('all'); // all | instock | outstock
  const [activeCat, setActiveCat] = useState('ups');
  const [busy, setBusy] = useState(false);

  const loadCat = useCallback(async (slug) => {
    const c = categoryBySlug(slug);
    if (c.status !== 'live' || !c.dataUrl) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${c.dataUrl}?ts=${Date.now()}`, { cache: 'no-store' });
      const json = res.ok ? await res.json() : null;
      setDataMap((m) => ({ ...m, [slug]: json }));
    } catch {
      setDataMap((m) => ({ ...m, [slug]: null }));
    }
    // Health file is optional (absent until the first post-upgrade run; a Pages
    // SPA fallback can also return HTML for it) — any failure means "no health".
    try {
      const hres = await fetch(`${import.meta.env.BASE_URL}data/${slug}-health.json?ts=${Date.now()}`, { cache: 'no-store' });
      const health = hres.ok ? await hres.json() : null;
      setHealthMap((m) => ({ ...m, [slug]: health && health.last_attempt_at ? health : null }));
    } catch {
      setHealthMap((m) => ({ ...m, [slug]: null }));
    }
  }, []);

  // Load every live category once so the sidebar can show each one's count.
  useEffect(() => {
    LIVE_CATEGORIES.forEach((c) => loadCat(c.slug));
  }, [loadCat]);

  const refresh = useCallback(async () => {
    setBusy(true);
    await loadCat(activeCat);
    setBusy(false);
  }, [loadCat, activeCat]);

  const catCount = (slug) => {
    const r = dataMap[slug];
    if (r === undefined) return '…';
    const d = normalize(r);
    return isUsable(d) ? num(d.products.length) : '0';
  };

  const cat = categoryBySlug(activeCat);
  const isLive = cat.status === 'live';
  const raw = dataMap[activeCat];
  const data = useMemo(() => normalize(raw), [raw]);
  const loading = isLive && raw === undefined;
  const usable = isLive && isUsable(data);
  const fresh = freshness(data?.captured_at, usable);
  const alert = isLive && !loading ? healthAlert(healthMap[activeCat], data?.captured_at) : null;

  const companyCounts = useMemo(() => {
    const counts = { Other: 0 };
    COMPANIES.forEach((c) => (counts[c] = 0));
    if (usable) data.products.forEach((p) => (counts[companyOf(p.brand)] = (counts[companyOf(p.brand)] || 0) + 1));
    return counts;
  }, [usable, data]);

  const selectCategory = (slug) => {
    setActiveCat(slug);
    setFilter('');
    setCompanies([]);
    setPriceFilter('all');
    setStockFilter('all');
    // The Analysis matrix is cross-category — don't yank the user off it when
    // they click a category; every other tab jumps to the per-category Table.
    setTab((t) => (t === 'Analysis' ? 'Analysis' : 'Table'));
  };

  const downloadXlsx = useCallback(async () => {
    if (!usable) return;
    const XLSX = await import('xlsx');
    let rows = data.products;
    if (companies.length) rows = rows.filter((p) => companies.includes(companyOf(p.brand)));
    if (priceFilter === 'priced') rows = rows.filter(hasPrice);
    else if (priceFilter === 'unpriced') rows = rows.filter((p) => !hasPrice(p));
    if (stockFilter === 'instock') rows = rows.filter(inStock);
    else if (stockFilter === 'outstock') rows = rows.filter((p) => !inStock(p));
    const sheet = rows.map((p) => ({
      Product: p.title ?? '',
      Brand: p.brand ?? '',
      'Item #': p.item_number ?? '',
      'CAT/MPN': p.cat_mpn ?? '',
      UPC: p.upc ?? '',
      Category: p.category ?? '',
      Price: p.price ?? '',
      UoM: p.unit_of_measure ?? '',
      Stock: p.availability ?? '',
      'Product URL': p.product_url ?? '',
      'Captured At': p.captured_at ?? data.captured_at ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(sheet);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'UPS');
    const stamp = (data.captured_at || '').slice(0, 10) || 'latest';
    XLSX.writeFile(wb, `schneider-${activeCat}-${stamp}.xlsx`);
  }, [usable, data, companies, priceFilter, stockFilter, activeCat]);

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-titles">
          <h1>Schneider &mdash; Power &amp; Data Center Infrastructure Pricing Tracker</h1>
          <p className="sub">
            A finance-grade tracker that captures distributor pricing, stock, and lead-time signals for UPS, power
            distribution, cooling, and data-center infrastructure.
          </p>
        </div>
        <div className="hdr-actions">
          <span className={`badge badge-${fresh.tone}`}>
            <i className="dot" />
            {fresh.label}
          </span>
          <button className="btn" onClick={refresh} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn btn-primary"
            onClick={downloadXlsx}
            disabled={!usable}
            title={usable ? 'Export the current view to XLSX' : 'No capture data to export yet'}
          >
            Download XLSX
          </button>
        </div>
      </header>

      <div className="meta">
        <Meta label="Last Scrape" value={usable ? fmtUTC(data?.captured_at) : '—'} />
        <Meta label="Rows This Scrape" value={usable ? num(data.rows_this_scrape) : '—'} />
        <Meta label="Total Rows On Record" value={usable ? num(data.total_rows_on_record) : '—'} />
        <Meta label="Scrapes On Record" value={usable ? num(data.scrapes_on_record) : '—'} />
      </div>

      <div className="layout">
        <aside className="catnav">
          <div className="catnav-title">Categories</div>
          {CATEGORIES.map((g) => (
            <div className="catgroup" key={g.group}>
              <div className="catgroup-title">{g.group}</div>
              {g.items.map((it) => {
                const live = it.status === 'live';
                return (
                  <button
                    key={it.slug}
                    className={`catitem ${it.slug === activeCat ? 'active' : ''} ${live ? 'live' : 'planned'}`}
                    onClick={() => selectCategory(it.slug)}
                  >
                    <span className="catitem-name">{it.name}</span>
                    <span className="catitem-count">
                      {live ? catCount(it.slug) : it.status === 'unavailable' ? 'n/a' : 'soon'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        <div className="panel">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>
          <main className="content">
            {tab !== 'Analysis' && <HealthBanner alert={alert} />}
            {tab === 'Analysis' ? (
              <AnalysisMatrix dataMap={dataMap} granularity={gran} onGranularity={setGran} />
            ) : !isLive ? (
              tab === 'Methodology' ? <Methodology /> : <PlannedCategory cat={cat} />
            ) : tab === 'Methodology' ? (
              <Methodology />
            ) : loading ? (
              <div className="card muted">Loading latest capture…</div>
            ) : !usable ? (
              <EmptyState data={data} />
            ) : tab === 'Overview' ? (
              <Overview data={data} catName={cat.name} />
            ) : (
              <Universe
                loading={loading}
                usable={usable}
                data={data}
                catName={cat.name}
                filter={filter}
                setFilter={setFilter}
                companies={companies}
                setCompanies={setCompanies}
                companyCounts={companyCounts}
                priceFilter={priceFilter}
                setPriceFilter={setPriceFilter}
                stockFilter={stockFilter}
                setStockFilter={setStockFilter}
              />
            )}
          </main>
        </div>
      </div>

      <footer className="foot">
        <span>Static dashboard built by Cloudflare Pages · scraping runs only in GitHub Actions.</span>
      </footer>
    </div>
  );
}
