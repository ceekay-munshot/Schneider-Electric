#!/usr/bin/env node
/**
 * Repair published dashboard data after failed captures slipped through.
 *
 * A capture with ZERO prices in a category that normally has them is a failed
 * capture (Graybar answered an anonymous / unpriced session), but older code
 * published such captures as "ok". Each one became the newest data point for
 * its week, so week-over-week comparisons went blank and the product table
 * lost its prices. This tool, for each category data file:
 *   1. drops zero-priced history entries from categories that normally have
 *      prices (same rule as the publish guard, scripts/lib/capture-quality.js);
 *   2. if the newest capture was dropped, restores the top-level fields
 *      (products, counts, field_presence, …) of the newest remaining capture
 *      from git history, where every published version of the file lives;
 *   3. marks the category's health file as failing (the dropped captures were
 *      failed attempts), pointing last_success_at at the restored capture.
 * Idempotent: a clean file is left untouched. Needs full git history.
 *
 * Usage: node scripts/repair-dashboard-data.js [slug ...]   (default: all targets)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { typicalPriced, isPriceOutage, pricedOf } from './lib/capture-quality.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join('public', 'data');

const byTime = (a, b) => new Date(a.captured_at) - new Date(b.captured_at);

/** Split history into kept entries and dropped (price-outage) ones. */
export function cleanHistory(history) {
  const typical = typicalPriced(history);
  const keep = [];
  const dropped = [];
  for (const h of history) (isPriceOutage(pricedOf(h), typical) ? dropped : keep).push(h);
  return { keep: keep.sort(byTime), dropped: dropped.sort(byTime), typical };
}

// The version of `file` whose newest capture is `capturedAt`, from git history.
function versionWithHead(file, capturedAt) {
  const commits = execFileSync('git', ['log', '--format=%H', '--', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const c of commits) {
    try {
      const d = JSON.parse(execFileSync('git', ['show', `${c}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 30 }));
      if (d.captured_at === capturedAt && Array.isArray(d.products)) return d;
    } catch {
      /* unreadable version — keep looking */
    }
  }
  return null;
}

function repair(slug) {
  const file = path.join(DATA_DIR, `${slug}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log(`[repair] ${slug}: no data file — skipped`);
    return;
  }
  const { keep, dropped, typical } = cleanHistory(data.history || []);
  if (!dropped.length) {
    console.log(`[repair] ${slug}: clean (typical ~${typical} priced) — unchanged`);
    return;
  }
  const newest = keep[keep.length - 1];
  let head = data;
  if (newest && newest.captured_at !== data.captured_at) {
    head = versionWithHead(file, newest.captured_at);
    if (!head) {
      console.log(`[repair] ${slug}: cannot find the ${newest.captured_at} product list in git history — left unchanged`);
      return;
    }
  }
  const out = {
    status: 'ok',
    reason: null,
    captured_at: head.captured_at,
    source: head.source,
    search_url: head.search_url,
    counts: head.counts,
    total_rows_on_record: keep.reduce((s, h) => s + (h.rows || 0), 0),
    scrapes_on_record: keep.length,
    field_presence: head.field_presence,
    history: keep,
    products: head.products,
  };
  writeFileSync(file, JSON.stringify(out, null, 2));

  // Health: the dropped captures were failed attempts.
  const healthFile = path.join(DATA_DIR, `${slug}-health.json`);
  let health = {};
  try {
    health = JSON.parse(readFileSync(healthFile, 'utf8'));
  } catch {
    /* none yet */
  }
  const lastDropped = dropped[dropped.length - 1].captured_at;
  if (head !== data && new Date(lastDropped) > new Date(out.captured_at)) {
    const trailing = dropped.filter((h) => new Date(h.captured_at) > new Date(out.captured_at)).length;
    writeFileSync(
      healthFile,
      JSON.stringify(
        {
          last_attempt_at: health.last_attempt_at ?? lastDropped,
          last_attempt_status: 'failed',
          last_success_at: out.captured_at,
          consecutive_failures: Math.max(health.last_attempt_status === 'failed' ? health.consecutive_failures || 0 : 0, trailing),
          run_url: health.run_url ?? null,
          hint: 'auth_failed_or_price_hidden: Graybar returned no prices (session not logged in); showing the last priced capture',
        },
        null,
        2,
      ),
    );
  }
  console.log(
    `[repair] ${slug}: dropped ${dropped.length} zero-price capture(s) [${dropped.map((h) => h.captured_at.slice(0, 10)).join(', ')}]` +
      (head !== data ? `; restored products from ${out.captured_at} (${out.products.length} rows)` : ''),
  );
}

function main() {
  const slugs = process.argv.slice(2);
  const targets = slugs.length ? slugs : JSON.parse(readFileSync(path.join(HERE, 'graybar-targets.json'), 'utf8')).map((t) => t.slug);
  for (const slug of targets) repair(slug);
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) main();
