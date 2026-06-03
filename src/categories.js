// Product categories for the tracker.
// - "live"    : has captured data (loaded from public/data/latest-capture.json).
// - "planned" : intentionally empty for now; will populate once its distributor
//               search URL is configured and a capture runs. (captureUrl: null)
//
// Right now only UPS is live (the 757-product Graybar capture). Everything else
// is a placeholder you can fill in later by setting status:'live' + captureUrl.

export const CATEGORIES = [
  {
    group: 'Data Center Infrastructure',
    items: [
      { slug: 'ups', name: 'UPS (single & three-phase)', status: 'live', captureUrl: null },
      { slug: 'rack-pdus', name: 'Rack PDUs', status: 'planned', captureUrl: null },
      { slug: 'busway', name: 'Busway / Power Distribution', status: 'planned', captureUrl: null },
      { slug: 'mv-switchgear', name: 'MV Switchgear', status: 'planned', captureUrl: null },
      { slug: 'transformers', name: 'MV / LV Transformers', status: 'planned', captureUrl: null },
      { slug: 'modular-dc', name: 'Prefab / Modular Data Centers', status: 'planned', captureUrl: null },
      { slug: 'crac-crah', name: 'CRAC / CRAH Cooling Units', status: 'planned', captureUrl: null },
      { slug: 'liquid-cooling', name: 'Liquid Cooling (CDUs, Rear-Door HX)', status: 'planned', captureUrl: null },
      { slug: 'racks-enclosures', name: 'Racks & Enclosures (NetShelter)', status: 'planned', captureUrl: null },
      { slug: 'dcim', name: 'DCIM Software (EcoStruxure IT)', status: 'planned', captureUrl: null },
      { slug: 'env-monitoring', name: 'Environmental Monitoring & Sensors', status: 'planned', captureUrl: null },
      { slug: 'kvm', name: 'KVM / Remote Access', status: 'planned', captureUrl: null },
      { slug: 'cabling', name: 'Structured Cabling & Fiber Management', status: 'planned', captureUrl: null },
    ],
  },
  {
    group: 'Electrical & Power Systems',
    items: [
      { slug: 'panelboards', name: 'LV Panelboards & Breakers (Square D)', status: 'planned', captureUrl: null },
      { slug: 'ats', name: 'Automatic Transfer Switches (ATS)', status: 'planned', captureUrl: null },
      { slug: 'power-monitoring', name: 'Power Monitoring Systems', status: 'planned', captureUrl: null },
      { slug: 'bms', name: 'Building Management (EcoStruxure Building)', status: 'planned', captureUrl: null },
      { slug: 'generator-controls', name: 'Generator Controls & Integration', status: 'planned', captureUrl: null },
      { slug: 'surge', name: 'Surge Protection Devices', status: 'planned', captureUrl: null },
      { slug: 'metering', name: 'Metering & Energy Analytics', status: 'planned', captureUrl: null },
      { slug: 'field-services', name: 'Field Services & Maintenance (EcoCare)', status: 'planned', captureUrl: null },
      { slug: 'sidecar', name: 'Sidecar', status: 'planned', captureUrl: null },
    ],
  },
];

export const ALL_CATEGORIES = CATEGORIES.flatMap((g) => g.items);

export function categoryBySlug(slug) {
  return ALL_CATEGORIES.find((c) => c.slug === slug) || ALL_CATEGORIES[0];
}

// Parent companies for the brand filter (extend freely).
export const COMPANIES = ['Schneider', 'Eaton', 'nVent', 'Delta'];

// Map a granular brand string (e.g. "APC (Schneider Electric)") to its parent.
export function companyOf(brand) {
  const b = (brand || '').toLowerCase();
  if (/schneider|\bapc\b|square ?d/.test(b)) return 'Schneider';
  if (/eaton|tripp ?lite/.test(b)) return 'Eaton';
  if (/nvent|hoffman|schroff|eriflex|caddy/.test(b)) return 'nVent';
  if (/delta/.test(b)) return 'Delta';
  return 'Other';
}
