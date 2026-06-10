#!/usr/bin/env node
/**
 * Record the outcome of a capture attempt — success OR failure — so the
 * dashboard can surface silent breakage (failing scheduled runs) instead of
 * just quietly aging. Written by CI after every capture attempt and committed
 * alongside the data file.
 *
 * Usage: node scripts/record-health.js <outJson> [captureJson]
 *   outJson:     public/data/<slug>-health.json (read for streak, then updated)
 *   captureJson: output/graybar-<slug>-latest.json — if present and non-ok,
 *                its status/reason becomes the failure hint.
 * Env: CAPTURE_OUTCOME ("success" | anything else = failed), RUN_URL.
 */
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const OUT = process.argv[2];
const CAPTURE_SRC = process.argv[3] || null;
if (!OUT) {
  console.error('[health] usage: record-health.js <outJson> [captureJson]');
  process.exit(1);
}

const ok = process.env.CAPTURE_OUTCOME === 'success';
const now = new Date().toISOString();

let prev = null;
try {
  prev = JSON.parse(await readFile(OUT, 'utf8'));
} catch {
  /* first record */
}

let hint = null;
if (!ok && CAPTURE_SRC) {
  try {
    const cap = JSON.parse(await readFile(CAPTURE_SRC, 'utf8'));
    if (cap.status && cap.status !== 'ok') hint = cap.reason ? `${cap.status}: ${cap.reason}` : String(cap.status);
  } catch {
    /* capture wrote nothing — the run log is the only diagnostic */
  }
}

const health = {
  last_attempt_at: now,
  last_attempt_status: ok ? 'ok' : 'failed',
  last_success_at: ok ? now : (prev?.last_success_at ?? null),
  consecutive_failures: ok ? 0 : (prev?.consecutive_failures ?? 0) + 1,
  run_url: process.env.RUN_URL ?? null,
  hint: ok ? null : hint,
};

await writeFile(OUT, JSON.stringify(health, null, 2));
console.log(
  `[health] ${OUT}: ${health.last_attempt_status}${ok ? '' : ` (streak ${health.consecutive_failures}${hint ? `, ${hint}` : ''})`}`,
);
