// Product categories for the tracker — the Schneider AI-datacenter taxonomy from
// the source PDF. UPS + Busway are the original captures; the 4 approved
// AI-datacenter categories are live; the 3 software/service categories that
// Graybar does not distribute are marked "unavailable" (sourced direct from
// Schneider), shown in the nav but never captured.
//
// - "live"        : has captured data (loaded from public/data/<slug>.json).
// - "unavailable" : Graybar carries no catalog data for it (software / service).

export const CATEGORIES = [
  {
    group: 'Power, Racks & Cooling',
    items: [
      { slug: 'ups', name: 'UPS (single & three-phase)', status: 'live', dataUrl: 'data/ups.json' },
      { slug: 'busway', name: 'Busway / Power Distribution', status: 'live', dataUrl: 'data/busway.json' },
      { slug: 'rack-pdus', name: 'Rack PDUs', status: 'live', dataUrl: 'data/rack-pdus.json' },
      { slug: 'rack-systems', name: 'Rack Systems (NetShelter)', status: 'live', dataUrl: 'data/rack-systems.json' },
      { slug: 'pod-modular', name: 'Pod & Modular Infrastructure', status: 'live', dataUrl: 'data/pod-modular.json' },
      {
        slug: 'liquid-cooling',
        name: 'Liquid Cooling (Motivair)',
        status: 'unavailable',
        note: 'Sold direct by Schneider / Motivair — Graybar does not distribute it, so there is no price data to track here.',
      },
    ],
  },
  {
    group: 'Software & Services',
    items: [
      { slug: 'dcim', name: 'DCIM Software (EcoStruxure IT)', status: 'live', dataUrl: 'data/dcim.json' },
      {
        slug: 'reference-designs',
        name: 'Reference Designs & Integration',
        status: 'unavailable',
        note: 'A Schneider engineering / integration service — no catalog products for a distributor to price.',
      },
      {
        slug: 'sustainability',
        name: 'Sustainability & Energy Mgmt',
        status: 'unavailable',
        note: 'A SaaS / advisory service sold direct by Schneider (EcoStruxure Resource Advisor, EcoConsult) — not carried by Graybar.',
      },
    ],
  },
];

export const ALL_CATEGORIES = CATEGORIES.flatMap((g) => g.items);

export function categoryBySlug(slug) {
  return ALL_CATEGORIES.find((c) => c.slug === slug) || ALL_CATEGORIES[0];
}

// Parent companies for the brand filter (extend freely).
export const COMPANIES = ['Schneider', 'Eaton', 'Vertiv', 'Chatsworth', 'Panduit', 'Legrand', 'nVent', 'Delta'];

// Map a granular brand string (e.g. "APC (Schneider Electric)") to its parent.
export function companyOf(brand) {
  const b = (brand || '').toLowerCase();
  if (/schneider|\bapc\b|square ?d/.test(b)) return 'Schneider';
  if (/eaton|tripp ?lite|b-?line|bussmann/.test(b)) return 'Eaton';
  if (/vertiv|liebert/.test(b)) return 'Vertiv';
  if (/chatsworth|\bcpi\b/.test(b)) return 'Chatsworth';
  if (/panduit/.test(b)) return 'Panduit';
  if (/legrand|server ?technology|middle ?atlantic|raritan|wiremold|ortronics|starline/.test(b)) return 'Legrand';
  if (/nvent|hoffman|schroff|eriflex|caddy/.test(b)) return 'nVent';
  if (/delta/.test(b)) return 'Delta';
  return 'Other';
}
