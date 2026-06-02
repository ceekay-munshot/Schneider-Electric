import test from 'node:test';
import assert from 'node:assert/strict';

import {
  harvestProducts,
  mapJsonProduct,
  looksLikeProduct,
  dedupe,
  toCsv,
  fieldPresence,
  pick,
} from '../src/capture-rexel.js';

const CAPTURED_AT = '2026-06-02T00:00:00.000Z';

test('looksLikeProduct distinguishes product objects from noise', () => {
  assert.equal(looksLikeProduct({ name: 'APC UPS', listPrice: 199.99, sku: 'X1' }), true);
  assert.equal(looksLikeProduct({ foo: 'bar', baz: 1 }), false);
  assert.equal(looksLikeProduct(null), false);
  assert.equal(looksLikeProduct([1, 2, 3]), false);
});

test('harvestProducts finds a nested array of product-like objects', () => {
  const payload = {
    data: {
      searchResults: {
        products: [
          { productName: 'APC Back-UPS 600VA', sku: '0731304334989', unitPrice: 89.99 },
          { productName: 'CyberPower 1500VA', sku: 'CP1500', unitPrice: 219.0 },
          { productName: 'Tripp Lite 1000VA', sku: 'TL1000', unitPrice: 175.5 },
        ],
      },
      facets: [{ name: 'Brand', count: 3 }], // not product-like; must be ignored
    },
  };
  const out = [];
  harvestProducts(payload, out);
  assert.equal(out.length, 3);
  assert.ok(out.every((p) => 'productName' in p));
});

test('mapJsonProduct maps messy keys onto the canonical schema', () => {
  const mapped = mapJsonProduct(
    {
      productName: 'APC Back-UPS 600VA',
      manufacturer: 'APC',
      sku: '0731304334989',
      mpn: 'BE600M1',
      gtin: '731304334989',
      category: 'Power / UPS',
      yourPrice: 89.99,
      unitOfMeasure: 'EA',
      inStock: true,
      url: '/p/apc-be600m1',
    },
    CAPTURED_AT,
  );
  assert.equal(mapped.title, 'APC Back-UPS 600VA');
  assert.equal(mapped.brand, 'APC');
  assert.equal(mapped.item_number, '0731304334989');
  assert.equal(mapped.cat_mpn, 'BE600M1');
  assert.equal(mapped.upc, '731304334989');
  assert.equal(mapped.category, 'Power / UPS');
  assert.equal(mapped.price, 89.99);
  assert.equal(mapped.unit_of_measure, 'EA');
  assert.equal(mapped.availability, true);
  assert.equal(mapped.product_url, 'https://www.rexelusa.com/p/apc-be600m1');
  assert.equal(mapped.captured_at, CAPTURED_AT);
  assert.equal(mapped._source, 'json');
});

test('pick returns null when no key matches', () => {
  assert.equal(pick({ a: 1, b: 2 }, [/price/i]), null);
});

test('dedupe collapses rows with the same item number / url / title', () => {
  const rows = [
    { item_number: 'A1', title: 'X', product_url: 'u1' },
    { item_number: 'A1', title: 'X', product_url: 'u1' },
    { item_number: 'A2', title: 'Y', product_url: 'u2' },
  ];
  assert.equal(dedupe(rows).length, 2);
});

test('fieldPresence counts only non-empty values', () => {
  const products = [
    { title: 'A', price: '$1.00', upc: null },
    { title: 'B', price: '', upc: '123' },
  ];
  const fp = fieldPresence(products);
  assert.equal(fp.title, 2);
  assert.equal(fp.price, 1); // empty string is not counted
  assert.equal(fp.upc, 1);
});

test('toCsv emits the mission column order and escapes quotes/commas', () => {
  const csv = toCsv([
    {
      title: 'APC "Smart" UPS, 1500VA',
      brand: 'APC',
      item_number: 'A1',
      cat_mpn: 'SMT1500',
      upc: '123',
      category: 'UPS',
      price: '$219.00',
      unit_of_measure: 'EA',
      availability: 'In Stock',
      product_url: 'https://example/p/a1',
      captured_at: CAPTURED_AT,
    },
  ]);
  const [header, row] = csv.split('\n');
  assert.equal(
    header,
    '"product title","brand/manufacturer","item number","CAT/MPN","UPC","category","price","unit of measure","stock/availability","product URL","captured_at"',
  );
  // Embedded quote is doubled and the comma stays safely inside the quoted cell.
  assert.ok(row.startsWith('"APC ""Smart"" UPS, 1500VA","APC","A1"'));
});
