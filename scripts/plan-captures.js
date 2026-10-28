#!/usr/bin/env node
/**
 * Decide which Graybar categories this workflow run should capture, and emit
 * them as a GitHub Actions matrix. This is what makes the schedule self-healing:
 * the workflow runs daily, and on each run only categories WITHOUT a good
 * capture in the current ISO week are captured. Monday's run therefore does
 * every category; a category whose Monday capture failed, timed out or came
 * back with poor price coverage is re-tried on the following days until it has
 * a good data point for the week.
 *
 * Usage: node scripts/plan-captures.js
 * Env:
 *   PLAN_MODE  "stale" (default; scheduled runs) | "all" | comma-separated slugs
 *   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  (set by Actions; optional locally)
 *   DATA_DIR   default public/data
 */
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { typicalPriced, isGoodCoverage, isoWeekKey, pricedOf } from './lib/capture-quality.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGETS_FILE = path.join(HERE, 'graybar-targets.json');
// Don't re-attempt a category more often than this (manual + scheduled runs).
const COOLDOWN_HOURS = 12;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Does `slug` still need a capture this week? Returns { need, why }. */
export function assess(data, health, now = new Date()) {
  const week = isoWeekKey(now.toISOString());
  const history = Array.isArray(data?.history) ? data.history : [];
  if (!history.length) return { need: true, why: 'no data on record' };
  const typical = typicalPriced(history);
  const thisWeek = history.filter((h) => h?.captured_at && isoWeekKey(h.captured_at) === week);
  const best = thisWeek.reduce((m, h) => Math.max(m, pricedOf(h)), 0);
  if (thisWeek.length && isGoodCoverage(best, typical)) {
    return { need: false, why: `${week} already captured (${best} priced, typical ~${typical})` };
  }
  const lastTry = health?.last_attempt_at ? new Date(health.last_attempt_at) : null;
  if (lastTry && now - lastTry < COOLDOWN_HOURS * 3600e3) {
    return { need: false, why: `attempted ${Math.round((now - lastTry) / 3600e3)}h ago — cooling down` };
  }
  return {
    need: true,
    why: thisWeek.length ? `${week} coverage weak (${best} priced, typical ~${typical})` : `no capture yet in ${week}`,
  };
}

export function plan(mode, targets, load, now = new Date()) {
  const m = (mode || 'stale').trim();
  const wanted = m === 'all' || m === 'stale' ? null : new Set(m.split(',').map((s) => s.trim()).filter(Boolean));
  const rows = [];
  for (const t of targets) {
    if (wanted && !wanted.has(t.slug)) continue;
    if (m !== 'stale') {
      rows.push({ ...t, need: true, why: m === 'all' ? 'requested: all' : 'requested' });
      continue;
    }
    const { data, health } = load(t.slug);
    rows.push({ ...t, ...assess(data, health, now) });
  }
  return rows;
}

function main() {
  const dataDir = process.env.DATA_DIR || path.join('public', 'data');
  const targets = readJson(TARGETS_FILE) || [];
  const load = (slug) => ({
    data: readJson(path.join(dataDir, `${slug}.json`)),
    health: readJson(path.join(dataDir, `${slug}-health.json`)),
  });
  const rows = plan(process.env.PLAN_MODE, targets, load);
  const include = rows.filter((r) => r.need).map(({ slug, url }) => ({ slug, url }));

  for (const r of rows) console.log(`[plan] ${r.need ? 'CAPTURE' : 'skip   '} ${r.slug}: ${r.why}`);
  console.log(`[plan] ${include.length} categor${include.length === 1 ? 'y' : 'ies'} to capture`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include })}\ncount=${include.length}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['### Capture plan', '', '| Category | Action | Why |', '| --- | --- | --- |'];
    for (const r of rows) lines.push(`| ${r.slug} | ${r.need ? 'capture' : 'skip'} | ${r.why} |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) main();
