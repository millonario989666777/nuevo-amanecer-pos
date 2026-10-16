import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const source = readFileSync('POS/js/modules/rotacion-abc.js', 'utf8');
const read = path => readFileSync(path, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  const ctx = vm.createContext(extra);
  vm.runInContext(read('POS/js/core/lima-time.js'), ctx);
  vm.runInContext(source, ctx);
  return ctx;
}
const api = context().NA_ROTACION_ABC;
const now = '2026-10-16T04:59:59Z'; // todavía 15 de octubre en Lima
const options = { now };
const product = (id, cat = 'farmacia') => ({ id, name: 'Producto ' + id, cat });
const item = (id, precio, qty = 1) => ({ id, name: 'Producto ' + id, precio, qty });
const sale = (items, extra = {}) => ({ fecha: '2026-10-15', items, ...extra });

test('Lima periods are inclusive and independent of device timezone, including leap years', () => {
  assert.deepEqual(plain(api.periodRange(30, now)), { days: 30, from: '2026-09-16', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange('90', now)), { days: 90, from: '2026-07-18', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange(30, '2024-03-01')), { days: 30, from: '2024-02-01', to: '2024-03-01' });
  assert.equal(api.limaDay('2026-10-16T05:00:00Z'), '2026-10-16');
  assert.equal(api.limaDay('2026-10-15T23:59:59'), '2026-10-15');
  assert.equal(api.limaDay('2026-10-16T01:00:00+02:00'), '2026-10-15');
  for (const value of ['', null, 'invalid', '2026-02-30', '2026-02-30T12:00:00Z']) assert.equal(api.limaDay(value), '');
  assert.throws(() => api.periodRange(30, 'invalid'), /Fecha/);
});

test('excludes annulled, old, future and invalid sales; fecha takes precedence over timestamp', () => {
  const sales = [
    sale([item(1, 5)], { fecha: '2026-09-16' }),
    sale([item(1, 5)], { fecha: '', timestamp: now }),
    sale([item(1, 100)], { anulada: true }),
    sale([item(1, 100)], { fecha: '2026-09-15' }),
    sale([item(1, 100)], { fecha: '', timestamp: '2026-10-16T05:00:00Z' }),
    sale([item(1, 100)], { fecha: 'invalid', timestamp: now }), null,
  ];
  const report = api.buildReport(sales, [product(1), product(2)], options);
  assert.equal(report.revenue, 10);
  assert.equal(report.transactions, 2);
  assert.equal(report.groups[0].rows[1].abc, 'C');
  assert.equal(report.groups[0].rows[1].noSales, true);
  assert.equal(api.buildReport(sales, [], { now, days: 90 }).revenue, 110);
});

test('Pareto exact 80/95 cuts, dominant product, crossing cuts and stable ties', () => {
  const report = api.buildReport([sale([item('a', 80), item('b', 15), item('c', 5)])], [], options);
  assert.deepEqual(plain(report.groups[0].rows.map(r => [r.id, r.abc, r.cumulative])), [['a', 'A', 80], ['b', 'B', 95], ['c', 'C', 100]]);
  for (const amounts of [[70, 15, 10, 5], [85, 10, 5], [100]]) {
    const result = api.buildReport([sale(amounts.map((n, i) => item(i, n)))], [], options);
    assert.equal(result.groups[0].rows[0].abc, 'A');
    if (amounts[0] === 70) assert.deepEqual(plain(result.groups[0].rows.map(r => r.abc)), ['A', 'A', 'B', 'C']);
  }
  const ties = api.buildReport([sale([item('z', 50), item('a', 50)])], [], options);
  assert.deepEqual(plain(ties.groups[0].rows.map(r => r.id)), ['a', 'z']);
});

test('ABC is per category; filtering preserves classes, including Sin categoría', () => {
  const products = [product(1), product(2), product(3, 'abarrotes'), product(4, 'abarrotes'), product(5, '')];
  const sales = [sale([item(1, 800), item(2, 200), item(3, 8), item(4, 2)])];
  const all = api.buildReport(sales, products, options);
  assert.equal(all.groups.find(g => g.category === 'abarrotes').rows[0].abc, 'A');
  const filtered = api.buildReport(sales, products, { ...options, category: 'Abarrotes' });
  assert.equal(filtered.revenue, 10);
  assert.deepEqual(plain(filtered.groups), plain(all.groups.filter(g => g.category === 'abarrotes')));
  assert.equal(api.buildReport(sales, products, { ...options, category: '' }).groups[0].rows[0].noSales, true);
  assert.equal(api.buildReport(sales, products, { ...options, category: 'absent' }).groups.length, 0);
});

test('historical item prices and aliases match sales-reports and do not multiply box revenue by physical units', () => {
  const lines = [item(1, 0.1, 3), { productoId: '1', precioUnitario: 0.2, cantidad: 1 },
    { id: 2, precio: 20, qty: 2, unitsPerQty: 12, cat: 'farmacia' }];
  const c = context({ productos: [], ventasRender() {}, document: { addEventListener() {}, getElementById() { return null; } },
    _naNumber: n => Number.isFinite(Number(n)) ? Number(n) : 0, _naClean: n => String(n ?? '').trim(),
    _naUnitsSold: i => (i.qty ?? i.cantidad ?? 0) * (i.unitsPerQty ?? 1) });
  c.window = c;
  vm.runInContext(read('POS/js/legacy-inline/inline-05.js'), c);
  const sales = [sale(lines, { id: 'synthetic', estado: 'credito' })];
  const actual = api.buildReport(sales, [product(1), { ...product(2), precio: 999 }], options);
  const existing = c._naF8ProductRows(sales);
  for (const expected of existing) assert.equal(actual.groups[0].rows.find(r => r.id === expected.id).revenue, expected.revenue);
  assert.equal(actual.revenue, 40.5);
  assert.equal(actual.groups[0].rows.find(r => r.id === '1').transactions, 1);
});

test('catalog ids, SKU fallback, missing products, same-name identities and historical categories', () => {
  const products = [{ ...product(1), sku: 'SKU-A' }, { ...product(2), name: 'Igual' }, { ...product(3), name: 'Igual' }];
  const sales = [sale([{ sku: 'SKU-A', name: 'Antiguo', precio: 5, qty: 1 },
    { id: 2, name: 'Igual', cat: 'anterior', precio: 4, qty: 1 },
    { id: 3, name: 'Igual', precio: 3, qty: 1 },
    { id: 99, name: 'Retirado', cat: 'histórica', precio: 2, qty: 1 }])];
  const report = api.buildReport(sales, products, options);
  assert.equal(report.groups.find(g => g.category === 'farmacia').rows.length, 3);
  assert.equal(report.groups.find(g => g.category === 'farmacia').rows.find(r => r.id === '1').revenue, 5);
  assert.equal(report.groups.find(g => g.category === 'historica').rows[0].name, 'Retirado');
  assert.equal(report.categories.includes('anterior'), false);
});

test('empty data, free products and invalid lines cannot corrupt amounts or classify zero as A', () => {
  assert.equal(api.buildReport(undefined, undefined, options).revenue, 0);
  const report = api.buildReport([sale([item(1, 0), item(2, NaN), item(3, -5), item(4, Infinity), item(5, 20, 0), null])], [product(1), product(5)], options);
  assert.equal(report.revenue, 0);
  assert.ok(report.groups.every(g => g.rows.every(r => r.abc === 'C' && r.share === 0 && r.cumulative === 0)));
  const rows = report.groups.flatMap(g => g.rows);
  assert.equal(rows.find(r => r.id === '1').noSales, false);
  assert.equal(rows.find(r => r.id === '5').noSales, true);
});

test('calculation does not mutate even frozen sales, catalog or pending records', () => {
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  const sales = freeze([sale([item(1, 10)], { status: 'pending', operation_id: 'synthetic-pending' })]);
  const products = freeze([product(1), product(2)]);
  const before = JSON.stringify({ sales, products });
  const report = api.buildReport(sales, products, options);
  report.groups[0].rows[0].name = 'Changed projection';
  assert.equal(JSON.stringify({ sales, products }), before);
  assert.equal(report.revenue, 10);
});

class Node {
  constructor() { this.children = []; this.attrs = {}; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
}
test('render guards owner, clears stale data on denial, escapes names and never invokes writing category helper', () => {
  const content = new Node(), status = new Node(), controls = new Node(), period = new Node(), filter = new Node();
  period.value = '30'; filter.value = '*';
  const nodes = { '[data-abc-content]': content, '[data-abc-status]': status, '[data-abc-controls]': controls, '[data-abc-period]': period, '[data-abc-category]': filter };
  const page = { querySelector: s => nodes[s] || null };
  let owner = true;
  const config = Object.freeze({ customCategories: Object.freeze([{ value: 'especial', label: 'Especial de prueba' }]) });
  const c = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page, createElement: () => new Node() },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: PERMISSIONS,
    productos: [{ id: 'x', name: '<img src=x onerror=alert(1)>', cat: 'especial' }], ventas: [], appConfig: config,
    _naCategoryLabel() { throw new Error('helper mutates config'); } });
  assert.equal(c.NA_ROTACION_ABC.render(), true);
  assert.ok(content.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(content.textContent.includes('Especial de prueba'));
  owner = false;
  Object.defineProperty(c, 'ventas', { get() { throw new Error('unauthorized state read'); } });
  assert.equal(c.NA_ROTACION_ABC.render(), false);
  assert.equal(content.children.length, 0);
  assert.equal(controls.hidden, true);
  assert.match(status.textContent, /Sin permiso/);
  assert.equal(config.customCategories[0].label, 'Especial de prueba');
});

test('roles without isOwner and shared client/server default-deny protect the future screen', () => {
  assert.equal(PERMISSIONS.canAccessScreen('owner', 'pageRotacionAbc'), true);
  for (const role of ['empleado', 'unknown', '', null]) assert.equal(PERMISSIONS.canAccessScreen(role, 'pageRotacionAbc'), false);
  for (const roles of [undefined, { role: 'owner', confirmed: false }, { isOwner: () => false }]) {
    assert.equal(context({ NA_ROLES: roles, NA_PERMISSIONS: PERMISSIONS }).NA_ROTACION_ABC.ownerAllowed(), false);
  }
  assert.equal(context({ NA_ROLES: { isOwner: () => true } }).NA_ROTACION_ABC.ownerAllowed(), false);
});

test('drawer whitelist includes ABC and hides it for employee or unconfirmed identity, even without permissions', () => {
  const c = vm.createContext({ document: { readyState: 'loading', addEventListener() {} }, innerWidth: 390 });
  c.window = c;
  vm.runInContext(read('POS/js/navigation/menu-navigation.js'), c);
  assert.ok(c.NA_MENU_NAVIGATION.pages.includes('pageRotacionAbc'));
  for (const permissions of [undefined, PERMISSIONS]) {
    c.NA_PERMISSIONS = permissions;
    for (const roles of [undefined, { role: 'owner' }, { role: 'owner', confirmed: false, isOwner: () => false }, { role: 'empleado', confirmed: true, isOwner: () => false }]) {
      c.NA_ROLES = roles;
      assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageRotacionAbc'), false);
    }
    c.NA_ROLES = { isOwner: () => true };
    assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageRotacionAbc'), true);
  }
});

test('rows show the product name or a short code, never the raw internal id', () => {
  const report = api.buildReport([
    sale([
      { id: 'GENERIC:7f3c2a91-5b1e-4d0a-9c7e-2f8b6a1d4e55', name: 'Paracetamol 500 mg', sku: '7750001', precio: 10, qty: 1 },
      { id: 'GENERIC:aa11bb22-cc33-dd44-ee55-ff6677889900', sku: 'ABR-12', precio: 5, qty: 1 },
      { id: 'GENERIC:0011', barcode: 'GENERIC:0011', precio: 2, qty: 1 }
    ])
  ], [], options);
  const rows = report.groups.flatMap(g => g.rows);
  assert.deepEqual(plain(rows.map(r => [r.name, r.code])).sort(), [['ABR-12', 'ABR-12'], ['Paracetamol 500 mg', '7750001'], ['Producto sin nombre', '']].sort());
  for (const r of rows) { assert.doesNotMatch(r.name, /GENERIC:/); assert.doesNotMatch(r.code, /GENERIC:/); }
});

test('rendered rows never print the internal id', () => {
  const src = readFileSync('POS/js/modules/rotacion-abc.js', 'utf8');
  assert.doesNotMatch(src, /element\('small', '', row\.id\)/);
  assert.match(src, /element\('small', '', row\.code\)/);
});

test("filas 'VARIOS' muestran una segunda línea (código corto o id visible) sin 'GENERIC:'", () => {
  const report = api.buildReport([
    sale([
      { id: 'GENERIC:7f3c2a91-5b1e-4d0a-9c7e-2f8b6a1d4e55', name: 'VARIOS', precio: 4, qty: 1 },
      { id: 'GENERIC:aa11bb22-cc33-dd44-ee55-ff6677889900', name: 'VARIOS', precio: 3, qty: 1 },
      { id: 'GENERIC:0011', name: 'Varios', generic_line: { name: 'Varios', code: '278' }, precio: 2, qty: 1 },
      { id: 'GENERIC:', name: 'VARIOS', precio: 1, qty: 1 }
    ])
  ], [], options);
  const rows = report.groups.flatMap(g => g.rows);
  assert.deepEqual(plain(rows.map(r => [r.name, r.code])).sort(),
    [['VARIOS', 'ID 7f3c2a91'], ['VARIOS', 'ID aa11bb22'], ['Varios', '278'], ['VARIOS', '']].sort());
  for (const r of rows) { assert.doesNotMatch(r.name, /GENERIC/i); assert.doesNotMatch(r.code, /GENERIC/i); }
});
