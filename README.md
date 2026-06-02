# Rexel USA — UPS Capture

Authenticated capture of UPS product data from [rexelusa.com](https://www.rexelusa.com),
run on demand or daily via GitHub Actions.

The scraper logs in with a **normal login flow** using credentials supplied as
environment variables, navigates to the UPS search results, verifies that prices
are actually visible, and exports the products it finds.

This repo also contains a separate **Cloudflare Pages dashboard** (Vite + React)
that displays the latest capture. The two are fully independent: the dashboard is
a static, read-only UI that never runs the scraper and holds no secrets.

## Dashboard (Cloudflare Pages)

A static Vite + React UI (`index.html`, `src/App.jsx`, `src/styles.css`) — the
"Critical Power & Data Center Infrastructure Pricing Tracker".

**Cloudflare Pages settings**

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 20 (pinned via `.node-version`) |

Add one Pages **environment variable** so the build doesn't download a Chromium
it never uses (the repo also includes Playwright for the scraper):

```
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = 1
```

**Local dev / build**

```bash
npm install
npm run dev      # local dev server (vite --host 0.0.0.0)
npm run build    # outputs to dist/
npm run preview  # serve the built dist/
```

**Data:** the dashboard loads `public/data/latest-capture.json` if present, and
otherwise shows a safe "Awaiting first successful Rexel capture" empty state. It
never fabricates prices or history. A future workflow step can publish the
scraper's latest successful capture to that path to populate the UI.

## Secrets / credentials

Credentials are read **only** from environment variables:

| Env var | Source in CI |
| --- | --- |
| `REXELUSA_EMAIL` | GitHub Actions repository secret `REXELUSA_EMAIL` |
| `REXELUSA_PASSWORD` | GitHub Actions repository secret `REXELUSA_PASSWORD` |

The workflow maps the secrets to env vars with the **exact same names**, and the
scraper reads `process.env.REXELUSA_EMAIL` / `process.env.REXELUSA_PASSWORD`.
Credential **values are never printed, logged, or written to disk.**

## Running in GitHub Actions

Workflow: [`.github/workflows/rexel-capture.yml`](.github/workflows/rexel-capture.yml)

- **Manual:** Actions tab → *Rexel UPS Capture* → *Run workflow*. There is a
  `debug` toggle that prints counts and field-presence only (never secrets).
- **Scheduled:** daily at `02:30 UTC` (`cron: "30 2 * * *"`).

The job fails fast and clearly if either secret is missing (without printing
values). Results are uploaded as the **`rexel-ups-capture-<run_id>`** artifact —
download it from the run summary. (Output is uploaded, not committed.)

## Running locally

```bash
npm ci
npx playwright install --with-deps chromium

# Node 20.6+: load credentials from a .env file (copy .env.example first)
node --env-file=.env src/capture-rexel.js --debug

# or pass inline
REXELUSA_EMAIL=... REXELUSA_PASSWORD=... npm run capture:rexel
```

Add `--headed` to watch the browser. Output lands in `output/`.

## Output

Each run writes to `output/`:

- `rexel-ups-<timestamp>.json` and `rexel-ups-latest.json` — full result
- `rexel-ups-<timestamp>.csv` — flat table of products
- `raw-responses-<timestamp>.json` — raw JSON API payloads the page fetched
  (useful for tuning; **may contain account-scoped data — keep artifacts private**)

Captured fields per product: product title, brand/manufacturer, item number,
CAT/MPN, UPC, category, price, unit of measure, stock/availability, product URL,
and `captured_at`. Fields not present on the search tile are `null` (e.g. UPC
often lives on the product detail page rather than the search results).

The top-level `status` is one of:

- `ok` — prices were visible and products were captured
- `auth_failed_or_price_hidden` — login was blocked, prices were not visible, or
  no products could be extracted; **no data is presented as good** and the run
  exits non-zero (set `REXEL_SOFT_FAIL=1` to exit 0 instead)
- `error` — an unexpected exception (details in `reason`)

## Safety & ethics

- **Normal login only.** The scraper never attempts to solve or bypass CAPTCHA,
  MFA/OTP, or bot-protection. If a challenge is detected it stops and reports
  `auth_failed_or_price_hidden`.
- **Conservative pacing.** Single browser, fully sequential, with jittered
  delays between actions (tunable via `REXEL_*` env vars).
- You are responsible for ensuring this use is permitted under your Rexel
  account agreement and the site's Terms of Service. Use only an account you are
  authorized to use.

## Tuning selectors (after the first authenticated run)

rexelusa.com is a JavaScript app and its DOM class names are not public, so the
selectors in [`src/selectors.js`](src/selectors.js) are broad best guesses. If a
run reports `prices_present_but_no_products_extracted` or extracts sparse fields:

1. Run once with debug on and download the artifact.
2. Open `raw-responses-*.json` — these are the real API payloads (clean fields +
   exact endpoint paths).
3. Tighten `API_HINTS` and/or `SELECTORS.product.*` in `src/selectors.js`.
