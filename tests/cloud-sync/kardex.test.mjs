import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const read = path => readFileSync(path, 'utf8');
const source = read('POS/js/modules/kardex.js');
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  const c = vm.createContext(extra);
  vm.runInContext(source, c);
  return c;
}
const api = context().NA_KARDEX;
const options = { now: '2026-10-16T04:59:59Z' }; // 15 de octubre, Lima
const product = { id: 'p1', name: 'Producto sintético', sku: 'K-01', stock: 10 };
const move = (id, delta, extra = {}) => ({ id, productId: 'p1', type: 'AJUSTE', delta, fecha: '2026-10-15', ...extra });
const sale = (id, qty, extra = {}) => ({ id, fecha: '2026-10-15', items: [{ id: 'p1', qty }], ...extra });

test('default range includes 30 Lima days; timestamps without zone use Lima, with leap day validation', () => {
  assert.deepEqual(plain(api.periodRange(options.now)), { from: '2026-09-16', to: '2026-10-15' });
  assert.equal(api.limaDay('2026-10-16T05:00:00Z'), '2026-10-16');
  assert.equal(api.limaDay('2026-10-15T23:59:59'), '2026-10-15');
  assert.equal(api.limaDay('2026-10-16T01:00:00+02:00'), '2026-10-15');
  assert.deepEqual(plain(api.periodRange('2024-03-01')), { from: '2024-02-01', to: '2024-03-01' });
  for (const value of ['', null, 'invalid', '2026-02-30', '2026-02-30T12:00:00Z']) assert.equal(api.limaDay(value), '');
  for (const range of [{ from: 'bad' }, { to: '2026-10-16' }, { from: '2026-10-15', to: '2026-10-14' }]) {
    assert.throws(() => api.buildLedger(product, [], [], { ...options, ...range }), /rango/);
  }
});

test('ledger sorts by business day/time and ends at current stock; opening absorbs incomplete history', () => {
  const report = api.buildLedger(product, [
    move('out', -3, { type: 'SALE', timestamp: '2026-10-15T11:00:00', referenceId: 's1' }),
    move('in', 5, { type: 'ENTRADA', timestamp: '2026-10-15T09:00:00', reason: 'Compra sintética' }),
    move('adjust', -1, { timestamp: '2026-10-15T10:00:00' }),
  ], [], options);
  assert.equal(report.opening, 9);
  assert.deepEqual(plain(report.rows.map(r => [r.type, r.incoming, r.outgoing, r.balance])), [
    ['Saldo inicial', 0, 0, 9], ['Compra', 5, 0, 14], ['Ajuste', 0, 1, 13], ['Venta', 0, 3, 10],
  ]);
  assert.equal(report.incoming, 5); assert.equal(report.outgoing, 4); assert.equal(report.closing, 10);
});

test('date filtering preserves historical balances using movements AFTER the end date', () => {
  const movements = [move('old', 100, { fecha: '2026-09-01' }), move('in', 5, { fecha: '2026-10-01' }),
    move('sale', -3, { fecha: '2026-10-10', type: 'SALE' }), move('today', -2)];
  const report = api.buildLedger(product, movements, [], { ...options, from: '2026-10-01', to: '2026-10-10' });
  assert.equal(report.opening, 10); assert.equal(report.closing, 12); assert.equal(report.currentStock, 10);
  assert.equal(report.rows.length, 3);
  assert.equal(api.buildLedger(product, movements, [], options).closing, 10);
  assert.equal(api.buildLedger(product, movements, [], { ...options, from: '2026-10-15' }).opening, 12);
});

test('annulled sales excluded from reconstruction; recorded sale/return pairs remain auditable', () => {
  const sales = [sale('void', 99, { anulada: true }), sale('void2', 99, { estado: 'anulada' }),
    sale('void3', 99, { status: 'annulled' }), sale('ok', 2)];
  const report = api.buildLedger(product, [], sales, options);
  assert.equal(report.rows.length, 2); assert.equal(report.outgoing, 2);
  const pair = api.buildLedger(product, [move('v', -3, { type: 'SALE', referenceId: 'void' }),
    move('r', 3, { type: 'SALE_REVERSAL', referenceId: 'void', timestamp: '2026-10-15T15:00:00' })], sales.slice(0, 1), options);
  assert.deepEqual(plain(pair.rows.map(r => r.type)), ['Saldo inicial', 'Venta', 'Anulación']);
  assert.equal(pair.opening, 10); assert.equal(pair.closing, 10);
});

test('canonical signed quantity and manual aliases include reversals and compras without assuming positive entradas', () => {
  const moves = [
    { movement_id: 's', product_id: 'p1', sale_id: 'cs', quantity: -2, movement_type: 'SALE', created_at: '2026-10-15T10:00:00Z' },
    { movement_id: 'r', product_id: 'p1', quantity: 2, movement_type: 'ENTRADA', reason: 'Anulación de venta cs: prueba', created_at: '2026-10-15T11:00:00Z' },
    { movement_id: 'p', product_id: 'p1', quantity: 5, movement_type: 'ENTRADA', reason: 'Compra OCR prueba', operation_id: 'PUR:test:1', created_at: '2026-10-15T12:00:00Z' },
    { movement_id: 'a', product_id: 'p1', quantity: -1, movement_type: 'AJUSTE', created_at: '2026-10-15T13:00:00Z' },
  ];
  const result = api.buildLedger(product, moves, [sale('cs', 2)], options);
  assert.deepEqual(plain(result.rows.map(r => r.type)), ['Saldo inicial', 'Venta', 'Anulación', 'Compra', 'Ajuste']);
  assert.equal(result.rows[3].reference, 'PUR:test:1'); assert.equal(result.outgoing, 3); assert.equal(result.closing, 10);
  const aliases = api.buildLedger(product, [{ productId: 'p1', type: 'SALIDA', quantity: 2, fecha: '2026-10-15' },
    { productId: 'p1', before: 5, after: 7, fecha: '2026-10-15' }], [], options);
  assert.equal(aliases.outgoing, 2); assert.equal(aliases.incoming, 2);
  const adapted = api.buildLedger(product, [move('adapted', 5, { type: 'ENTRADA', reason: 'Compra OCR prueba',
    referenceId: 'p1', operationId: 'PUR:test:1', canonical: true })], [], options);
  assert.equal(adapted.rows[1].reference, 'PUR:test:1', 'manual UI adapter referenceId is the product, not the document');
});

test('durable movement/sale ids deduplicate records and never double-count sales with a ledger', () => {
  const movement = move('m', -3, { type: 'SALE', referenceId: 's' });
  const report = api.buildLedger(product, [movement, movement, move('other', -50, { productId: 'different' })],
    [sale('s', 3), sale('missing', 2), sale('missing', 2)], options);
  assert.equal(report.outgoing, 5); assert.equal(report.rows.length, 3);
});

test('sale fallback uses physical box units, repeated lines and durable ids; never joins products by name', () => {
  const sales = [sale('boxes', 2, { items: [{ productoId: 'p1', cantidad: 2, unitsPerQty: 12 }, { product_id: 'p1', quantity: .5 },
    { id: 'other', name: product.name, qty: 500 }, { id: 'p1', qty: 999, ventaLibre: true }, { id: 'p1', qty: 99, controlInventario: false }] })];
  const report = api.buildLedger(product, [], sales, options);
  assert.equal(report.outgoing, 24.5); assert.equal(report.opening, 34.5); assert.equal(report.closing, 10);
});

test('empty data, zero/negative/missing stock, malformed records and decimal movements stay finite', () => {
  assert.equal(api.buildLedger(product, undefined, undefined, options).rows[0].balance, 10);
  assert.equal(api.buildLedger(undefined, [], [], options).currentStock, null);
  for (const stock of [0, -2, .3]) {
    const r = api.buildLedger({ ...product, stock }, [move('a', -.1), move('b', -.2)], [], options);
    assert.equal(r.closing, stock); assert.equal(r.outgoing, .3);
  }
  const r = api.buildLedger({ ...product, stock: '' }, [null, move('bad', NaN), move('invalid', 1, { fecha: 'invalid' }),
    move('future', 99, { fecha: '2026-10-16' }), move('blank', null), move('zero', 0)],
  [null, sale('bad-qty', Infinity), sale('bad-date', 2, { fecha: 'invalid' })], options);
  assert.equal(r.skipped, 4); assert.equal(r.rows.length, 1); assert.equal(r.closing, null);
});

test('search handles accents, codes and alternate codes without conflating products', () => {
  const products = [{ ...product, name: 'Ácido fólico', alternate_codes: '["ALT-5"]' },
    { id: 'p2', name: 'Ácido fólico', sku: 'K-02' }];
  assert.deepEqual(plain(api.searchProducts(products, 'acido k-01').map(p => p.id)), ['p1']);
  assert.deepEqual(plain(api.searchProducts(products, 'alt-5').map(p => p.id)), ['p1']);
  assert.equal(api.searchProducts(products, 'ausente').length, 0);
  assert.equal(api.searchProducts(undefined, '').length, 0);
});

test('CSV quotes text, guards formulas in names/codes/references and preserves negative numeric balances', () => {
  const r = api.buildLedger({ ...product, name: ' =1+1', sku: '@SUM(A1)' }, [move('m', -20, { referenceId: '\t=evil,"x"\n' })], [], options);
  // buildLedger trims user strings; both a trimmed formula and raw leading tabs are guarded.
  const csv = api.toCsv(r);
  assert.ok(csv.startsWith('\uFEFFProducto,Código,Fecha (Lima)'));
  assert.ok(csv.includes("'=1+1,'@SUM(A1)")); assert.ok(csv.includes('"\'=evil,""x"""'));
  r.product.name = '\t=1'; r.rows[0].balance = -2;
  assert.ok(api.toCsv(r).includes("'\t=1")); assert.ok(api.toCsv(r).includes(',0,0,-2\r\n'));
});

test('CSV guards cells starting with a newline, including a newline alone', () => {
  for (const value of ['\n=1+1', '\n']) {
    const report = api.buildLedger(product, [], [], options);
    // Set raw export values after buildLedger, which trims user strings.
    report.product.name = value;
    report.product.code = value;
    report.rows[0].reference = value;
    const csv = api.toCsv(report);
    assert.ok(csv.includes(`\r\n"'${value}","'${value}",`));
    assert.ok(csv.includes(`,"'${value}",0,0,10\r\n`));
  }
});

test('even frozen pending sales/movements/catalog are never mutated', () => {
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
  const p = freeze({ ...product, _canonicalPendingStock: true }), movements = freeze([move('m', 1)]);
  const sales = freeze([sale('pending', 2, { status: 'pending', operation_id: 'synthetic-pending' })]);
  const before = JSON.stringify({ p, movements, sales });
  const report = api.buildLedger(p, movements, sales, options); report.product.name = 'Projection only'; api.toCsv(report);
  assert.equal(JSON.stringify({ p, movements, sales }), before);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|\.setItem\s*\(|saveAllData|applyInventoryMovement|\.refresh\s*\(/);
});

class Node {
  constructor() { this.children = []; this.attrs = {}; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set innerHTML(_) { throw new Error('User text must never become HTML'); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this[k] = fn; }
}
function renderHarness(extra = {}) {
  const nodes = Object.fromEntries(['content', 'status', 'controls', 'products', 'search', 'from', 'to', 'export'].map(k => [`[data-kardex-${k}]`, new Node()]));
  const page = { querySelector: s => nodes[s] || null };
  const c = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page, createElement: () => new Node() },
    NA_ROLES: { isOwner: () => true }, NA_PERMISSIONS: PERMISSIONS, productos: [product], ventas: [], inventoryMovements: [], ...extra });
  return { api: c.NA_KARDEX, c, nodes };
}

test('render inserts escaped text, uses the canonical snapshot and clears sensitive state before denied reads', () => {
  let owner = true, snapshots = 0;
  const h = renderHarness({ NA_ROLES: { isOwner: () => owner },
    productos: [{ ...product, name: '<img src=x onerror=alert(1)>' }],
    inventoryMovements: [move('local', 100)],
    NuevoAmanecerCanonical: { enabled: () => true, snapshot: () => { snapshots++; return { inventoryMovements: [move('canon', -2, { referenceId: '<svg onload=alert(1)>' })] }; },
      refresh() { throw new Error('Forbidden refresh'); } } });
  assert.equal(h.api.render(), true);
  h.nodes['[data-kardex-products]'].children[0].click();
  const content = h.nodes['[data-kardex-content]'];
  assert.ok(content.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(content.textContent.includes('<svg onload=alert(1)>'));
  assert.equal(content.children.at(-1).children.at(-1).children.length, 2);
  assert.equal(h.nodes['[data-kardex-export]'].disabled, false);
  owner = false; const count = snapshots;
  Object.defineProperty(h.c, 'productos', { get() { throw new Error('Unauthorized read'); } });
  assert.equal(h.api.render(), false); assert.equal(snapshots, count);
  assert.equal(content.children.length, 0); assert.equal(h.nodes['[data-kardex-products]'].children.length, 0);
  assert.equal(h.nodes['[data-kardex-controls]'].hidden, true); assert.equal(h.nodes['[data-kardex-export]'].disabled, true);
  assert.match(h.nodes['[data-kardex-status]'].textContent, /Sin permiso/);
});

test('unlocked Kardex is owner-only in the shared client/server table; unconfirmed roles fail closed', () => {
  assert.equal(PERMISSIONS.FEATURE_LOCKS.kardex, false);
  assert.deepEqual(Array.from(PERMISSIONS.FEATURE_ROLES.kardex), ['owner']);
  assert.equal(PERMISSIONS.canAccessScreen('owner', 'pageKardex'), true);
  for (const role of ['empleado', 'unknown', '', null]) assert.equal(PERMISSIONS.canAccessScreen(role, 'pageKardex'), false);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.deepEqual(Array.from(PERMISSIONS.routeRoles('/features/kardex', method)), ['owner']);
  for (const roles of [undefined, { role: 'owner', confirmed: false }, { isOwner: () => false }]) {
    assert.equal(context({ NA_ROLES: roles, NA_PERMISSIONS: PERMISSIONS }).NA_KARDEX.ownerAllowed(), false);
  }
  assert.equal(context({ NA_ROLES: { isOwner: () => true } }).NA_KARDEX.ownerAllowed(), false);
});

test('integrated page, precache and navigation permit the card without adding side-menu items', () => {
  const c = vm.createContext({ document: { readyState: 'loading', addEventListener() {} }, innerWidth: 390 }); c.window = c;
  const nav = read('POS/js/navigation/menu-navigation.js'); vm.runInContext(nav, c);
  assert.ok(c.NA_MENU_NAVIGATION.pages.includes('pageKardex'));
  for (const permissions of [undefined, PERMISSIONS]) {
    c.NA_PERMISSIONS = permissions;
    for (const roles of [undefined, { role: 'owner' }, { role: 'empleado', isOwner: () => false }]) {
      c.NA_ROLES = roles; assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageKardex'), false);
    }
    c.NA_ROLES = { isOwner: () => true }; assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageKardex'), true);
  }
  assert.doesNotMatch(nav.slice(nav.indexOf('function renderDrawerItems()'), nav.indexOf('function renderDrawerItems()') + 2500), /pageKardex/);
  const html = read('POS/index.html'), sw = read('POS/sw.js');
  for (const file of ['css/kardex.css', 'js/modules/kardex.js']) { assert.ok(html.includes(file)); assert.ok(sw.includes("'./" + file + "'")); }
  assert.match(html, /class="page" id="pageKardex"/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});
