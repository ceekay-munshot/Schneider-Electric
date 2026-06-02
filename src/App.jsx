import { useCallback, useEffect, useMemo, useState } from 'react';

// Where the dashboard looks for capture data. A future GitHub Actions step can
// copy the scraper's latest successful capture to public/data/latest-capture.json.
// If the file is absent, the UI shows a safe empty state — it never fabricates data.
const DATA_URL = `${import.meta.env.BASE_URL}data/latest-capture.json`;

const TABS = ['Overview', 'Product Universe', 'Methodology'];

// Canonical product columns (matches the scraper's output schema).
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
    products,
  };
}

// A capture is "usable" only when login succeeded and real rows came back.
// Anything else (no file, auth_failed_or_price_hidden, empty) -> empty state.
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
  const tone = hrs <= 26 ? 'fresh' : hrs <= 24 * 7 ? 'aging' : 'stale';
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

// ---- small presentational pieces -----------------------------------------

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
      <h2>Awaiting first successful Rexel capture</h2>
      <p>
        This dashboard populates automatically after the GitHub Actions scraper completes a capture in which
        distributor prices are actually visible. Until then it shows no rows, prices, or trends — this tool never
        displays fabricated or placeholder pricing.
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

// ---- tab bodies -----------------------------------------------------------

function Overview({ loading, usable, data }) {
  if (loading) return <div className="card muted">Loading latest capture…</div>;
  if (!usable) return <EmptyState data={data} />;
  return (
    <>
      <section className="stats">
        <StatCard label="Capture status" value={<span className="ok-pill">{data.status}</span>} />
        <StatCard label="Captured at" value={fmtUTC(data.captured_at)} />
        <StatCard label="Rows this scrape" value={num(data.rows_this_scrape)} />
        <StatCard label="Source" value={data.source ?? '—'} />
      </section>

      <section className="card">
        <h3>Field coverage · latest capture</h3>
        <FieldCoverage presence={data.field_presence} total={data.rows_this_scrape} />
      </section>

      <section className="card">
        <h3>Average Price Trends · Period-over-Period</h3>
        <p className="muted">
          Period-over-period analytics (WoW / MoM / QoQ) activate once at least two captures are on record. Until a
          second capture exists, no historical or comparative figures are shown.
        </p>
        <div className="periods-empty">Awaiting a second capture to compute movement.</div>
      </section>
    </>
  );
}

function Universe({ loading, usable, data, filter, setFilter }) {
  const rows = useMemo(() => {
    if (!usable) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data.products;
    return data.products.filter((p) =>
      [p.title, p.brand, p.item_number, p.cat_mpn, p.upc, p.category]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [usable, data, filter]);

  if (loading) return <div className="card muted">Loading latest capture…</div>;
  if (!usable) return <EmptyState data={data} />;

  const capped = rows.slice(0, 1000);
  return (
    <section className="card">
      <div className="universe-head">
        <h3>Product Universe · {num(data.products.length)} rows</h3>
        <input
          className="filter"
          placeholder="Filter by title, brand, item #, UPC…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
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
          Showing first {num(capped.length)} of {num(rows.length)} matching rows. Use the filter or Download XLSX for
          the full set.
        </p>
      )}
      {rows.length === 0 && <p className="muted">No rows match “{filter}”.</p>}
    </section>
  );
}

function Methodology() {
  return (
    <section className="card prose">
      <h3>Methodology</h3>
      <p>
        This is a finance-grade tracker for distributor pricing, stock, and lead-time signals across critical power and
        data-center infrastructure. <strong>Rexel USA UPS is the first vertical slice</strong>; power distribution,
        cooling, and broader data-center infrastructure follow the same pattern once the first slice is solid.
      </p>
      <h4>Data source</h4>
      <p>
        Pricing and availability are captured from authenticated rexelusa.com sessions by a Playwright scraper that runs
        on a schedule in <strong>GitHub Actions</strong> — never from this site. Distributor pricing is account-specific
        and is only exposed after a normal login.
      </p>
      <h4>Integrity rules</h4>
      <ul>
        <li>No fabricated or placeholder prices. If prices are not visible, the capture is marked <code>auth_failed_or_price_hidden</code> and excluded.</li>
        <li>No invented history. Period-over-period analytics begin only once two or more real captures are on record.</li>
        <li>Fields not present on a product (e.g. UPC on a search tile) are shown as “—”, not guessed.</li>
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
  const [raw, setRaw] = useState(undefined); // undefined = loading, null = none, object = loaded
  const [tab, setTab] = useState('Overview');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${DATA_URL}?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) {
        setRaw(null);
        return;
      }
      setRaw(await res.json());
    } catch {
      // Missing or invalid data must never break the UI.
      setRaw(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const data = useMemo(() => normalize(raw), [raw]);
  const loading = raw === undefined;
  const usable = isUsable(data);
  const fresh = freshness(data?.captured_at, usable);

  const downloadXlsx = useCallback(async () => {
    if (!usable) return;
    const XLSX = await import('xlsx'); // lazy-loaded only on click
    const rows = data.products.map((p) => ({
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
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Rexel UPS');
    const stamp = (data.captured_at || '').slice(0, 10) || 'latest';
    XLSX.writeFile(wb, `critical-power-capture-${stamp}.xlsx`);
  }, [usable, data]);

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-titles">
          <h1>Critical Power &amp; Data Center Infrastructure Pricing Tracker</h1>
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
          <button className="btn" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn btn-primary"
            onClick={downloadXlsx}
            disabled={!usable}
            title={usable ? 'Export this capture to XLSX' : 'No capture data to export yet'}
          >
            Download XLSX
          </button>
        </div>
      </header>

      <div className="meta">
        <Meta label="Last Scrape" value={fmtUTC(data?.captured_at)} />
        <Meta label="Rows This Scrape" value={usable ? num(data.rows_this_scrape) : '—'} />
        <Meta label="Total Rows On Record" value={usable ? num(data.total_rows_on_record) : '—'} />
        <Meta label="Scrapes On Record" value={usable ? num(data.scrapes_on_record) : '—'} />
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'Overview' && <Overview loading={loading} usable={usable} data={data} />}
        {tab === 'Product Universe' && (
          <Universe loading={loading} usable={usable} data={data} filter={filter} setFilter={setFilter} />
        )}
        {tab === 'Methodology' && <Methodology />}
      </main>

      <footer className="foot">
        <span>Static dashboard built by Cloudflare Pages · scraping runs only in GitHub Actions.</span>
      </footer>
    </div>
  );
}
