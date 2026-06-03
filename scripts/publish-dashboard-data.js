#!/usr/bin/env node
/**
 * Publish a capture to the dashboard's data file (public/data/latest-capture.json).
 *
 * Maps a capture (Graybar or Rexel schema) onto the dashboard schema and writes
 * it where the Vite dashboard fetches it. ONLY publishes successful ("ok")
 * captures, so the dashboard never shows partial/failed data — a failed capture
 * leaves the previous good data (or the empty state) in place.
 *
 * Usage: node scripts/publish-dashboard-data.js [sourceJson] [outJson]
 *   defaults: output/graybar-ups-latest.json  ->  public/data/latest-capture.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SRC = process.argv[2] || 'output/graybar-ups-latest.json';
const OUT = process.argv[3] || 'public/data/latest-capture.json';

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
  const stock = p.stock_level != null ? ` (${p.stock_level})` : '';
  const availability = p.availability != null && p.availability !== '' ? `${p.availability}${stock}` : null;
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

  const products = (raw.products || []).map((p) => mapProduct(p, raw.captured_at));
  const field_presence = {};
  for (const f of DASH_FIELDS) {
    field_presence[f] = products.filter((p) => p[f] != null && String(p[f]).trim() !== '').length;
  }

  const out = {
    status: 'ok',
    reason: null,
    captured_at: raw.captured_at,
    source: raw.source === 'dom' || !raw.source ? 'graybar' : raw.source,
    search_url: raw.search_url ?? null,
    counts: {
      products: products.length,
      priced: products.filter((p) => p.price && /\d/.test(String(p.price))).length,
      ...(raw.counts || {}),
    },
    total_rows_on_record: products.length,
    scrapes_on_record: 1,
    field_presence,
    products,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`[publish] wrote ${OUT}: ${products.length} products, ${out.counts.priced} priced (source=${out.source}).`);
}

main();
