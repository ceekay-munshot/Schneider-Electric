#!/usr/bin/env node
/**
 * Publish a capture to the dashboard's data file (public/data/<slug>.json).
 *
 * Maps a capture (Graybar or Rexel schema) onto the dashboard schema and writes
 * it where the Vite dashboard fetches it. ONLY publishes successful ("ok")
 * captures, so the dashboard never shows partial/failed data — a failed capture
 * leaves the previous good data (or the empty state) in place.
 *
 * The data file accumulates a `history` array (one compact entry per capture:
 * summary stats + an item→price map) so the dashboard can compute real
 * period-over-period analytics (WoW / MoM / QoQ). Re-publishing a capture with
 * a captured_at already on record replaces that entry (idempotent), so backfill
 * and re-runs are safe in any order. Top-level fields (products, counts,
 * field_presence, …) always describe the NEWEST capture on record.
 *
 * Usage: node scripts/publish-dashboard-data.js [sourceJson] [outJson]
 *   defaults: output/graybar-ups-latest.json  ->  public/data/latest-capture.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { companyOf } from '../src/categories.js';

const SRC = process.argv[2] || 'output/graybar-ups-latest.json';
const OUT = process.argv[3] || 'public/data/latest-capture.json';

// History entries keep their per-item price map only this many captures back
// (weekly cadence ≈ 14 months — plenty for like-for-like QoQ). Older entries
// keep summary stats forever; those are ~120 bytes each.
const PRICE_MAP_KEEP = 60;

const DASH_FIELDS = [
  'title',
  'brand',
  'item_number',
  'cat_mpn',
  'upc',
  'category',
  'price',
  'unit_of_measure',
  'availability',
  'product_url',
  'captured_at',
];

function mapProduct(p, capturedAt) {
  // Append "(stock_level)" to availability unless it is already suffixed —
  // dashboard-schema inputs (re-publish/backfill) arrive pre-composed.
  let availability = p.availability != null && p.availability !== '' ? String(p.availability) : null;
  if (availability && p.stock_level != null && !availability.includes(`(${p.stock_level})`)) {
    availability = `${availability} (${p.stock_level})`;
  }
  return {
    title: p.title ?? null,
    brand: p.brand ?? null,
    item_number: p.item_number ?? p.sku ?? null,
    cat_mpn: p.cat_mpn ?? p.mfr ?? null,
    upc: p.upc ?? null,
    category: p.category ?? null,
    price: p.price ?? null,
    unit_of_measure: p.unit_of_measure ?? p.currency ?? null,
    availability,
    product_url: p.product_url ?? null,
    captured_at: p.captured_at ?? capturedAt ?? null,
    // keep raw extras (the dashboard ignores unknown keys)
    sku: p.sku ?? null,
    mfr: p.mfr ?? null,
    stock_level: p.stock_level ?? null,
    price_value: p.price_value ?? null,
  };
}

function priceValueOf(p) {
  if (typeof p.price_value === 'number' && p.price_value > 0) return p.price_value;
  if (p.price != null) {
    const m = String(p.price).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function itemKeyOf(p) {
  return p.item_number ?? p.sku ?? p.cat_mpn ?? p.upc ?? p.product_url ?? null;
}

function isInStock(p) {
  if (typeof p.stock_level === 'number') return p.stock_level > 0;
  const a = String(p.availability || '').toLowerCase();
  if (!a) return false;
  if (a.includes('outofstock') || a.includes('out of stock')) return false;
  return /in\s?stock|low\s?stock/.test(a);
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Compact per-capture history entry: summary stats + item→price map, plus an
 * item→parent-company map (brand_of) so the dashboard can compute per-brand
 * like-for-like price change without storing (and risking drift on) per-company
 * aggregates. brand_of is keyed identically to prices (priced items only). */
function historyEntryOf(capturedAt, products) {
  const prices = {};
  const brand_of = {};
  const values = [];
  let inStock = 0;
  for (const p of products) {
    if (isInStock(p)) inStock += 1;
    const v = priceValueOf(p);
    const k = itemKeyOf(p);
    if (v != null && k != null) {
      const key = String(k);
      prices[key] = round2(v);
      brand_of[key] = companyOf(p.brand); // priced items only -> keys(brand_of) === keys(prices)
      values.push(v);
    }
  }
  values.sort((a, b) => a - b);
  const avg = values.length ? round2(values.reduce((s, v) => s + v, 0) / values.length) : null;
  const mid = values.length ? round2(values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : null;
  return {
    captured_at: capturedAt,
    rows: products.length,
    priced: values.length,
    in_stock: inStock,
    avg_price: avg,
    median_price: mid,
    prices,
    brand_of,
  };
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  let raw;
  try {
    raw = JSON.parse(await readFile(SRC, 'utf8'));
  } catch (e) {
    console.error(`[publish] cannot read ${SRC}: ${e.message} — nothing published.`);
    process.exit(0);
  }
  if (raw.status !== 'ok') {
    console.error(`[publish] source status is "${raw.status}" (not ok) — not publishing; dashboard keeps current data.`);
    process.exit(0);
  }
  if (!raw.captured_at) {
    console.error(`[publish] source has no captured_at — not publishing.`);
    process.exit(0);
  }

  const products = (raw.products || []).map((p) => mapProduct(p, raw.captured_at));

  // ---- merge into the existing history (if any) ----------------------------
  const existing = await readJsonOrNull(OUT);
  const history = new Map(); // captured_at -> entry
  if (existing && Array.isArray(existing.history)) {
    for (const h of existing.history) if (h && h.captured_at) history.set(h.captured_at, h);
  } else if (existing && existing.status === 'ok' && existing.captured_at && Array.isArray(existing.products)) {
    // Migrate a pre-history data file: its own latest capture becomes history.
    const prev = existing.products.map((p) => mapProduct(p, existing.captured_at));
    history.set(existing.captured_at, historyEntryOf(existing.captured_at, prev));
  }
  history.set(raw.captured_at, historyEntryOf(raw.captured_at, products));

  const entries = [...history.values()].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  // Older entries keep summary stats only — drop their bulky per-item maps.
  entries.forEach((h, i) => {
    if (i < entries.length - PRICE_MAP_KEEP) {
      delete h.prices;
      delete h.brand_of;
    }
  });

  const newest = entries[entries.length - 1];
  const isNewest = newest.captured_at === raw.captured_at;
  if (!isNewest) {
    console.error(
      `[publish] note: source capture ${raw.captured_at} is older than newest on record (${newest.captured_at}) — history updated, latest view kept.`,
    );
  }

  // Top-level fields describe the newest capture on record.
  const headProducts = isNewest ? products : existing.products;
  const field_presence = {};
  for (const f of DASH_FIELDS) {
    field_presence[f] = headProducts.filter((p) => p[f] != null && String(p[f]).trim() !== '').length;
  }

  const srcMeta = {
    source: raw.source === 'dom' || !raw.source ? 'graybar' : raw.source,
    search_url: raw.search_url ?? null,
    counts: {
      products: products.length,
      priced: products.filter((p) => priceValueOf(p) != null).length,
      ...(raw.counts || {}),
    },
  };

  const out = {
    status: 'ok',
    reason: null,
    captured_at: newest.captured_at,
    source: isNewest ? srcMeta.source : existing.source,
    search_url: isNewest ? srcMeta.search_url : existing.search_url,
    counts: isNewest ? srcMeta.counts : existing.counts,
    total_rows_on_record: entries.reduce((s, h) => s + (h.rows || 0), 0),
    scrapes_on_record: entries.length,
    field_presence,
    history: entries,
    products: headProducts,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(
    `[publish] wrote ${OUT}: ${out.counts.products} products, ${out.counts.priced} priced (source=${out.source}); ${out.scrapes_on_record} capture(s) on record.`,
  );
}

main();
