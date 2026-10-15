import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const in05 = readFileSync('POS/js/legacy-inline/inline-05.js', 'utf8');
const in02 = readFileSync('POS/js/legacy-inline/inline-02.js', 'utf8');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n', i)); };
const ctx = extra => { const c = vm.createContext({ _naNumber: (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; }, productos: [{ id: 'A', name: 'A', costo: 9 }], ...extra }); return c; };

test('CSV cells neutralise formula injection but keep plain numbers', () => {
  const c = ctx(); vm.runInContext(fn(in05, '_naF8CsvCell'), c);
  const cell = v => vm.runInContext('_naF8CsvCell(v)', Object.assign(c, { v }));
  for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) assert.ok(cell(bad).replace(/^"/, '').startsWith("'"), JSON.stringify(bad));
  assert.equal(cell(-5), '-5'); assert.equal(cell('-5.50'), '-5.50'); assert.equal(cell('Pan'), 'Pan');
  assert.equal(cell('a;b'), '"a;b"');
});

test('unit cost uses only the cost stored in the sale (no current-product fallback, 0 = sin costo)', () => {
  const c = ctx(); vm.runInContext(fn(in05, '_naF8SaleUnitCost'), c);
  const u = item => vm.runInContext('_naF8SaleUnitCost(item)', Object.assign(c, { item }));
  assert.equal(u({ id: 'A', costo: 4 }), 4);
  assert.equal(u({ id: 'A' }), 0, 'missing cost never falls back to productos[].costo');
  assert.equal(u({ id: 'A', costo: 0 }), 0);
  assert.equal(u({ id: 'A', costo: 'x' }), 0);
  assert.doesNotMatch(fn(in05, '_naF8SaleUnitCost'), /productos/);
});

test('null profit is neutral, never green; annulled sales stay out of Ventas/Ganancia', () => {
  const c = ctx(); vm.runInContext(fn(in05, '_naF8Tone'), c);
  const t = v => vm.runInContext('_naF8Tone(v)', Object.assign(c, { v }));
  assert.equal(t(null), ''); assert.equal(t(undefined), ''); assert.equal(t(0), 'positive'); assert.equal(t(-1), 'negative');
  assert.doesNotMatch(in05, /class="num positive">\$\{_naF8Financial/);
  assert.doesNotMatch(in05, /\.net>=0\?'positive'/);
  assert.match(fn(in05, '_naF8SaleRows'), /!v\.anulada/);
});

test('report label shows last sync time in Lima', () => {
  const c = ctx({ window: { _naF8SyncAt: Date.UTC(2026, 9, 15, 14, 5) } }); vm.runInContext(fn(in05, '_naF8SyncLabel'), c);
  assert.equal(vm.runInContext('_naF8SyncLabel()', c), 'datos al 15/10 09:05');
  c.window._naF8SyncAt = 0; assert.match(vm.runInContext('_naF8SyncLabel()', c), /sin sincronizar/);
});

test('closure ids carry a device tag; legacy ids stay plain strings', () => {
  assert.match(in02, /cashClosures\.push\(\{id:`C-\$\{cajEstado\.sessionId\?\?`X\$\{Date\.now\(\)\}`\}-\$\{_naClosureDeviceTag\(\)\}`/);
  const store = {}; const c = ctx({ window: { NA_ROLES: { deviceId: () => 'dev-ABC123456789' } }, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, crypto: { randomUUID: () => '1234abcd-0000' } });
  vm.runInContext(fn(in02, '_naClosureDeviceTag'), c);
  assert.equal(vm.runInContext('_naClosureDeviceTag()', c), '23456789');
  c.window.NA_ROLES = null; const a = vm.runInContext('_naClosureDeviceTag()', c);
  assert.equal(a, '1234abcd'); assert.equal(vm.runInContext('_naClosureDeviceTag()', c), a, 'stable per device');
});
