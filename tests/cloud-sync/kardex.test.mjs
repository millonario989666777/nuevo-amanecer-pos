import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';
import { redactKardexCostsForRole } from '../../tools/cloudflare-lab/src/pos-kardex-costs.js';
import { activeCanon } from './canon-browser-harness.mjs';

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

test('documents resolve purchase line operations and sale ids to readable numbers, including annulments', () => {
  const purchaseId = '11111111-1111-4111-8111-111111111111', saleId = '22222222-2222-4222-8222-222222222222';
  const purchases = [{ purchase_id: purchaseId, document_ref: 'F001-000042' },
    { id: 'purchase-series', serie: 'F002', correlativo: '000007' },
    { purchase_id: 'purchase-number', purchase_number: 'C-000015' }];
  const sales = [sale(saleId, 1, { ticket_number: 'T-000123' }), sale('fallback-ticket', 1, { receipt_number: 'B001-000005' }),
    sale('V-000006', 1, { operation: '33333333-3333-4333-8333-333333333333' })];
  const report = api.buildLedger(product, [
    move('purchase-line', 1, { type: 'COMPRA', operation_id: purchaseId + ':1', referenceId: 'p1' }),
    move('purchase-id', 1, { type: 'COMPRA', purchaseId: 'purchase-series' }),
    move('purchase-number', 1, { type: 'COMPRA', operationId: 'purchase-number:2' }),
    move('sale-id', -1, { type: 'SALE', sale_id: saleId, document: saleId }),
    move('annulment', 1, { type: 'SALE_REVERSAL', saleId }),
    move('direct', 1, { document_number: 'G001-000008' }),
  ], sales, { ...options, purchases });
  const refs = Object.fromEntries(report.rows.map(r => [r.id, r.reference]));
  assert.equal(refs['purchase-line'], 'F001-000042');
  assert.equal(refs['purchase-id'], 'F002-000007');
  assert.equal(refs['purchase-number'], 'C-000015');
  assert.equal(refs['sale-id'], 'T-000123'); assert.equal(refs.annulment, 'T-000123');
  assert.equal(refs.direct, 'G001-000008');
  assert.equal(refs['sale:fallback-ticket'], 'B001-000005');
  assert.equal(refs['sale:V-000006'], 'V-000006');
});

test('documents retain UUID references only when movements and related records lack readable numbers', () => {
  const purchaseId = '11111111-1111-4111-8111-111111111111', saleId = '22222222-2222-4222-8222-222222222222';
  const movements = [move('p', 1, { type: 'COMPRA', purchase_id: purchaseId }),
    move('s', -1, { type: 'SALE', sale_id: saleId })];
  for (const purchases of [[], [{ purchase_id: purchaseId }]]) {
    const report = api.buildLedger(product, movements, [sale(saleId, 1)], { ...options, purchases });
    assert.equal(report.rows.find(r => r.id === 'p').reference, purchaseId);
    assert.equal(report.rows.find(r => r.id === 's').reference, saleId);
  }
  const report = api.buildLedger(product, [], [sale(saleId, 1)], options);
  assert.equal(report.rows[1].reference, saleId);
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
  assert.deepEqual(plain(api.searchProducts(products, 'acido folico').map(p => p.id)), ['p1', 'p2']);
  assert.equal(api.searchProducts(products, 'ausente').length, 0);
  assert.equal(api.searchProducts(undefined, '').length, 0);
});

test('search deduplicates product ids before matching, preferring recent then complete records without mutating input', () => {
  const records = [
    { id: 'latest', name: 'Nombre antiguo', sku: 'OLD', stock: 99, updated_at: '2026-10-01' },
    { product_id: 'latest', name: 'Nombre vigente', sku: 'NEW', stock: 4, updated_at: '2026-10-15' },
    { id: 'complete', name: 'Producto completo', barcode: '789', stock: 7 },
    { id: 'complete', name: 'Producto completo' },
    { id: 'revision', name: 'Revisión vigente', metadataRevision: 3 },
    { id: 'revision', name: 'Revisión antigua', metadataRevision: 2 },
    { id: 'tie', name: 'Versión previa' }, { id: 'tie', name: 'Última versión cargada' }, null, {},
  ];
  records.forEach(p => { if (p) Object.freeze(p); }); Object.freeze(records);
  const result = api.searchProducts(records, '');
  assert.equal(result.length, 4);
  assert.ok(result.includes(records[1])); assert.ok(result.includes(records[2]));
  assert.ok(result.includes(records[4])); assert.ok(result.includes(records[7]));
  assert.equal(api.searchProducts(records, 'OLD').length, 0);
  assert.equal(api.searchProducts(records, 'NEW')[0], records[1]);
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
    NA_ROLES: { role: 'owner', isOwner: () => true }, NA_PERMISSIONS: PERMISSIONS, productos: [product], ventas: [], inventoryMovements: [], ...extra });
  return { api: c.NA_KARDEX, c, nodes };
}
const renderedTable = content => content.children.find(n => n.className === 'kardex-table-wrap').children[0];

test('same-name suggestions stay separate with sku, barcode, codigo or distinguishable short ids beside their names', () => {
  const name = 'Mismo nombre';
  const h = renderHarness({ productos: [
    { id: 'sku-id', name, sku: 'SKU-1' }, { id: 'barcode-id', name, barcode: '789123' },
    { id: 'codigo-id', name, codigo: 'COD-3' }, { id: 'abcdef123456', name },
    { id: 'shared-one', name }, { id: 'shared-two', name },
  ] });
  h.api.render();
  const buttons = h.nodes['[data-kardex-products]'].children;
  assert.equal(buttons.length, 6);
  const labels = Object.fromEntries(buttons.map(b => [b.attrs['data-product-id'], b.children[1].textContent]));
  assert.deepEqual(labels, { 'sku-id': 'SKU-1', 'barcode-id': '789123', 'codigo-id': 'COD-3',
    abcdef123456: 'ID abcdef', 'shared-one': 'ID shared-one', 'shared-two': 'ID shared-two' });
  assert.ok(buttons.every(b => b.children[0].textContent === name));
});

test('a duplicated product renders one suggestion and the selected ledger uses its latest stock', () => {
  const h = renderHarness({ productos: [{ ...product, name: 'Antiguo', stock: 99, updatedAt: '2026-10-01' },
    { ...product, name: 'Vigente', stock: 4, updatedAt: '2026-10-15' }] });
  h.api.render();
  const buttons = h.nodes['[data-kardex-products]'].children;
  assert.equal(buttons.length, 1); assert.match(buttons[0].textContent, /Vigente/);
  buttons[0].click();
  const table = renderedTable(h.nodes['[data-kardex-content]']);
  assert.equal(table.children.at(-1).children[0].children[7].textContent, '4');
});

test('all quantity and cost headers carry the numeric alignment class, including when costs are denied', () => {
  for (const canViewCosts of [true, false]) {
    const h = renderHarness({ NA_PERMISSIONS: { ...PERMISSIONS, canDo: () => canViewCosts } });
    h.api.render(); h.nodes['[data-kardex-products]'].children[0].click();
    const headers = renderedTable(h.nodes['[data-kardex-content]']).children[1].children[0].children;
    assert.equal(headers.length, canViewCosts ? 9 : 6);
    assert.ok(headers.slice(3).every(th => th.className === 'kardex-num'));
    assert.ok(headers.slice(0, 3).every(th => !th.className));
  }
});

test('render inserts escaped text, uses the canonical snapshot and clears sensitive state before denied reads', () => {
  let owner = true, snapshots = 0;
  const h = renderHarness({ NA_ROLES: { role: owner ? 'owner' : 'empleado', isOwner: () => owner },
    productos: [{ ...product, name: '<img src=x onerror=alert(1)>' }],
    inventoryMovements: [move('local', 100)],
    NuevoAmanecerCanonical: { enabled: () => true, snapshot: () => { snapshots++; return { inventoryMovements: [move('canon', -2, { referenceId: '<svg onload=alert(1)>' })] }; },
      refresh() { throw new Error('Forbidden refresh'); } } });
  assert.equal(h.api.render(), true);
  h.nodes['[data-kardex-products]'].children[0].click();
  const content = h.nodes['[data-kardex-content]'];
  assert.ok(content.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(content.textContent.includes('<svg onload=alert(1)>'));
  const table = renderedTable(content);
  assert.equal(table.children.at(-1).children.length, 2);
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
  assert.equal(context({ NA_ROLES: { role: 'owner', isOwner: () => true } }).NA_KARDEX.ownerAllowed(), false);
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
    c.NA_ROLES = { role: 'owner', isOwner: () => true }; assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageKardex'), true);
  }
  assert.doesNotMatch(nav.slice(nav.indexOf('function renderDrawerItems()'), nav.indexOf('function renderDrawerItems()') + 2500), /pageKardex/);
  const html = read('POS/index.html'), sw = read('POS/sw.js');
  for (const file of ['css/kardex.css', 'js/modules/kardex.js']) { assert.ok(html.includes(file)); assert.ok(sw.includes("'./" + file + "'")); }
  assert.match(html, /class="page" id="pageKardex"/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('weighted average values each exit at its historical average, retaining precision until display', () => {
  const report = api.buildLedger({ ...product, stock: 15 }, [
    move('a', 10, { type: 'COMPRA', unit_cost_cents: 200, timestamp: '2026-10-15T08:00:00' }),
    move('b', 10, { type: 'COMPRA', unit_cost_cents: 400, timestamp: '2026-10-15T09:00:00' }),
    move('c', -5, { type: 'SALE', unit_cost_cents: 9999, timestamp: '2026-10-15T10:00:00' }),
  ], [], options);
  assert.deepEqual(plain(report.rows.map(r => [r.balance, r.balanceValue])), [[0, 0], [10, 20], [20, 60], [15, 45]]);
  assert.equal(report.rows[2].averageCost, 3);
  assert.equal(report.rows[3].outgoingValue, 15);
  assert.equal(report.rows[3].unitCost, 3, 'exit ignores any supplied purchase cost');
  assert.equal(report.closingValue, 45); assert.equal(report.lastCost, 4);
  assert.equal(report.lastPurchase, '2026-10-15'); assert.equal(report.lastSale, '2026-10-15');
  assert.equal(report.uncosted, 0);
  const fractional = api.buildLedger({ ...product, stock: 2 }, [
    move('a', 1, { unit_cost_cents: 100 }), move('b', 2, { unit_cost_cents: 101 }), move('c', -1),
  ], [], options);
  assert.ok(Math.abs(fractional.rows[2].averageCost - 3.02 / 3) < 1e-12);
  assert.ok(Math.abs(fractional.closingValue - 2 * 3.02 / 3) < 1e-12);
});

test('missing entry cost uses the current average and is explicitly estimated; zero cost is known', () => {
  const report = api.buildLedger({ ...product, stock: 13 }, [
    move('a', 10, { unit_cost_cents: 200 }), move('b', 5), move('c', -2),
  ], [], options);
  assert.equal(report.rows[2].incomingValue, 10);
  assert.equal(report.rows[2].costStatus, 'costo estimado');
  assert.equal(report.rows[2].averageCost, 2);
  assert.equal(report.rows[3].outgoingValue, 4); assert.equal(report.closingValue, 26);
  assert.equal(report.uncosted, 0);
  const zero = api.buildLedger({ ...product, stock: 1 }, [move('a', 1, { unit_cost_cents: 0 }), move('b', 1), move('c', -1)], [], options);
  assert.equal(zero.rows[1].unitCost, 0); assert.equal(zero.rows[2].costStatus, 'costo estimado');
  assert.equal(zero.closingValue, 0); assert.equal(zero.uncosted, 0);
});

test('no average: missing entries and exits add no value and count as sin costo; catalog cost never backfills', () => {
  const report = api.buildLedger({ ...product, stock: 4, costo: 99 }, [move('a', 5), move('b', -1)], [], options);
  assert.equal(report.rows[1].costStatus, 'sin costo'); assert.equal(report.rows[1].incomingValue, null);
  assert.equal(report.rows[2].costStatus, 'sin costo'); assert.equal(report.rows[2].outgoingValue, null);
  assert.equal(report.closingValue, 0); assert.equal(report.uncosted, 2); assert.equal(report.uncostedBalance, 4);
  assert.equal(report.lastCost, 99);
  const partial = api.buildLedger({ ...product, stock: 10 }, [move('a', 5), move('b', 5, { unit_cost_cents: 200 })], [], options);
  assert.equal(partial.closingValue, 10); assert.equal(partial.rows[2].averageCost, 2);
  assert.equal(partial.uncostedBalance, 5); assert.equal(partial.uncosted, 1);
  const noStock = api.buildLedger({ id: 'p1' }, [move('a', 1, { unit_cost_cents: 200 })], [], options);
  assert.equal(noStock.closingValue, null);
  const negative = api.buildLedger({ ...product, stock: -2 }, [move('a', 1, { unit_cost_cents: 200 }), move('b', -3)], [], options);
  assert.equal(negative.closingValue, 0); assert.ok(Number.isFinite(negative.rows[2].outgoingValue));
});

test('range filtering carries prior average and excludes later purchases from historical exit valuation', () => {
  const movements = [move('old', 10, { fecha: '2026-09-01', unit_cost_cents: 200, type: 'COMPRA' }),
    move('out', -2, { fecha: '2026-10-01', type: 'SALE' }),
    move('later', 10, { unit_cost_cents: 400, type: 'COMPRA' })];
  const report = api.buildLedger({ ...product, stock: 18 }, movements, [], { ...options, from: '2026-10-01', to: '2026-10-01' });
  assert.equal(report.openingValue, 20); assert.equal(report.rows[1].outgoingValue, 4); assert.equal(report.closingValue, 16);
  assert.equal(report.rows[1].unitCost, 2); assert.equal(report.lastCost, 4);
});

test('purchase costs join only durable operation and product ids, including applied partial lines, without new stock rows', () => {
  const purchases = [{ purchase_id: 'PUR:test', status: 'en_curso', lines: [
    { line_number: 1, product_id: 'p1', quantity: 2, unit_cost_cents: 350 },
    { line_number: 2, product_id: 'p1', quantity: 99, unit_cost_cents: 99999 },
    { line_number: 3, product_id: 'other', quantity: 99, unit_cost_cents: 99999 },
  ] }];
  const before = JSON.stringify(purchases);
  const report = api.buildLedger({ ...product, stock: 2 }, [move('a', 2, { operation_id: 'PUR:test:1', type: 'COMPRA' })], [], { ...options, purchases });
  assert.equal(report.rows.length, 2); assert.equal(report.incoming, 2);
  assert.equal(report.rows[1].incomingValue, 7); assert.equal(report.lastCost, 3.5);
  assert.equal(JSON.stringify(purchases), before);
  const wrong = api.buildLedger({ ...product, stock: 2 }, [move('a', 2, { operation_id: 'PUR:test:3' })], [], { ...options, purchases });
  assert.equal(wrong.uncosted, 1);
});

test('CSV adds costs only for confirmed permitted owners, with every required formula prefix guarded', () => {
  const owner = context({ NA_ROLES: { role: 'owner', isOwner: () => true }, NA_PERMISSIONS: PERMISSIONS }).NA_KARDEX;
  const report = owner.buildLedger({ ...product, stock: 1 }, [move('a', 1, { unit_cost_cents: 250 })], [], options);
  assert.match(owner.toCsv(report), /Costo entrada \(S\/\)/);
  assert.match(owner.toCsv(report), /Valor saldo \(S\/\)/);
  assert.match(owner.toCsv(report), /2\.50/);
  assert.doesNotMatch(api.toCsv(report), /Costo|Valor saldo|2\.50/);
  for (const prefix of ['=', '+', '@', '\t', '\r', '\n', '-']) {
    report.product.name = prefix + '1'; report.product.code = prefix + '1'; report.rows[0].reference = prefix + '1';
    assert.ok(owner.toCsv(report).includes("'" + prefix + '1'));
  }
  assert.ok(source.includes('/^[=+@\\t\\r\\n-]/'));
  for (const extra of [{ NA_ROLES: { isOwner: () => false }, NA_PERMISSIONS: PERMISSIONS },
    { NA_ROLES: { role: 'owner', isOwner: () => true }, NA_PERMISSIONS: { ...PERMISSIONS, canDo: () => false } }]) {
    assert.doesNotMatch(context(extra).NA_KARDEX.toCsv(report), /Costo entrada|Valor saldo/);
  }
});

test('server cost filter preserves owner bytes, strips nested movement/product costs and fails closed', () => {
  const payload = { products: [{ product_id: 'p1', cost_cents: 900, price_cents: 1200 }],
    inventory_movements: [{ movement_id: 'm1', quantity: 2, unit_cost_cents: 500, balanceValue: 10 }] };
  const before = JSON.stringify(payload);
  assert.equal(redactKardexCostsForRole(payload, 'owner'), payload);
  for (const role of ['empleado', 'unknown', null, undefined]) {
    const stripped = redactKardexCostsForRole(payload, role);
    assert.equal('cost_cents' in stripped.products[0], false);
    assert.equal('unit_cost_cents' in stripped.inventory_movements[0], false);
    assert.equal('balanceValue' in stripped.inventory_movements[0], false);
    assert.equal(stripped.products[0].price_cents, 1200); assert.equal(stripped.inventory_movements[0].quantity, 2);
  }
  assert.equal(JSON.stringify(payload), before);
});

test('actual worker strips costs from employee catalog/snapshot and purchase endpoints used by Kardex', async t => {
  const f = await activeCanon(t, { migrations: ['0010_session_auth.sql', '0024_pos_roles_owner_pin.sql', '0028_pos_purchases.sql',
    '0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql'] });
  f.addDevice('k-owner', 'writer', 'active', 'k-owner-token');
  const request = (path, token, body) => f.fetch('http://localhost' + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const pairing = await request('/auth/pairing-code', 'k-owner-token', {});
  assert.equal(pairing.status, 201);
  const { code } = await pairing.json();
  const paired = await request('/auth/pair', '', { code });
  assert.equal(paired.status, 201); const { session_token } = await paired.json();
  f.database.exec("INSERT INTO pos_purchases(purchase_id,promotion_id,status,line_count,total_cost_cents,principal_id,created_at) VALUES('k-purchase','synthetic','aplicada',1,500,'k-owner','2026-10-15T15:00:00Z')");
  f.database.exec("INSERT INTO pos_purchase_lines(purchase_id,line_number,product_id,quantity,unit_cost_cents) VALUES('k-purchase',1,'00003',1,500)");
  for (const path of ['/read/canonical/products', '/read/canonical/snapshot', '/read/canonical/inventory-movements', '/auth/purchases', '/auth/purchases?id=k-purchase']) {
    const ownerResponse = await request(path, 'k-owner-token'), employeeResponse = await request(path, session_token);
    assert.equal(ownerResponse.status, 200, path); assert.equal(employeeResponse.status, 200, path);
    const owner = await ownerResponse.json(), employee = await employeeResponse.json();
    assert.doesNotMatch(JSON.stringify(employee), /"(?:cost_cents|unit_cost_cents|total_cost_cents)":/, path);
    if (path !== '/read/canonical/inventory-movements') assert.match(JSON.stringify(owner), /"(?:cost_cents|unit_cost_cents)":/, path);
  }
});

test('purchase loading disables export, joins costs read-only and discards a late response after role revocation', async () => {
  let owner = true, resolve, reads = 0;
  const h = renderHarness({
    NA_ROLES: { role: owner ? 'owner' : 'empleado', isOwner: () => owner, api: (path, body, method) => {
      assert.equal(path, '/auth/purchases'); assert.equal(body, undefined); assert.equal(method, 'GET');
      reads++; return new Promise(done => { resolve = done; });
    } },
    inventoryMovements: [move('a', 2, { type: 'COMPRA', operation_id: 'PUR:1' })],
  });
  h.api.render(); h.nodes['[data-kardex-products]'].children[0].click();
  assert.equal(reads, 1); assert.equal(h.nodes['[data-kardex-export]'].disabled, true);
  resolve({ purchases: [{ purchase_id: 'PUR', document_ref: 'F001-000009', lines: [{ line_number: 1, product_id: 'p1', unit_cost_cents: 500 }] }] });
  await new Promise(done => setImmediate(done));
  assert.equal(h.nodes['[data-kardex-export]'].disabled, false);
  assert.match(h.nodes['[data-kardex-content]'].textContent, /S\/ 10\.00/);
  assert.match(h.nodes['[data-kardex-content]'].textContent, /F001-000009/);
  assert.equal(reads, 1);

  let late;
  const revoked = renderHarness({ NA_ROLES: { role: owner ? 'owner' : 'empleado', isOwner: () => owner, api: () => new Promise(done => { late = done; }) } });
  revoked.api.render(); revoked.nodes['[data-kardex-products]'].children[0].click();
  owner = false; revoked.api.render();
  late({ purchases: [{ purchase_id: 'secret', lines: [{ unit_cost_cents: 99999 }] }] });
  await new Promise(done => setImmediate(done));
  assert.equal(revoked.nodes['[data-kardex-content]'].textContent, '');
  assert.equal(revoked.nodes['[data-kardex-export]'].disabled, true);
});

test('cost permission denial renders only quantity columns even with locally available costs', () => {
  const h = renderHarness({ NA_PERMISSIONS: { ...PERMISSIONS, canDo: () => false },
    inventoryMovements: [move('a', 2, { unit_cost_cents: 500 })] });
  h.api.render(); h.nodes['[data-kardex-products]'].children[0].click();
  const content = h.nodes['[data-kardex-content]'], table = renderedTable(content);
  assert.equal(table.children[1].children[0].children.length, 6);
  assert.doesNotMatch(content.textContent, /S\/|Costo entrada|Último costo/);
});

test('a purchase after an exit weights the remaining balance, not all historic entries', () => {
  const report = api.buildLedger({ ...product, stock: 10 }, [
    move('a', 10, { unit_cost_cents: 200 }), move('b', -5), move('c', 5, { unit_cost_cents: 400 }),
  ], [], options);
  assert.equal(report.rows[2].outgoingValue, 10);
  assert.equal(report.rows[3].averageCost, 3);
  assert.equal(report.closingValue, 30);
});

test('Kardex table columns override the global mobile hide rule before mobile card styles', () => {
  const css = read('POS/css/kardex.css');
  const rule = '#pageKardex .kardex-table :is(th,td){display:table-cell}';
  assert.ok(css.includes(rule));
  assert.ok(css.indexOf(rule) < css.indexOf('@media'));
  assert.match(css.slice(css.indexOf('@media (max-width: 599px)')), /#pageKardex \.kardex-table td \{ display: block/);
});
