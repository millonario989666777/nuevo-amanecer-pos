import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const source = readFileSync('POS/js/modules/cliente-historial-compras.js', 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  const ctx = vm.createContext(extra);
  vm.runInContext(source, ctx);
  return ctx;
}
const api = context().NA_CLIENTE_HISTORIAL;
const options = { days: 'all', now: '2026-10-16' };
const sale = (extra = {}) => ({ id: 'venta-prueba', clienteId: 'c1', fecha: '2026-10-15', cajeroId: 'v1', cajeroNombre: 'Ana', total: 10,
  items: [{ id: 'p1', name: 'Producto de prueba', qty: 1, subtotal: 10 }], ...extra });
const ids = rows => plain(rows.map(row => row.id));

test('date filters include both edges; empty bounds are unbounded and Desde posterior a Hasta is rejected without mutation', () => {
  const sales = Object.freeze([
    sale({ id: 'before', fecha: '2026-10-12' }), sale({ id: 'from', fecha: '2026-10-13' }),
    sale({ id: 'middle', fecha: '2026-10-14' }), sale({ id: 'to' }), sale({ id: 'after', fecha: '2026-10-16' })
  ].map(Object.freeze));
  const filters = Object.freeze({ from: '2026-10-13', to: '2026-10-15' });
  const before = JSON.stringify({ sales, filters });
  assert.deepEqual(ids(api.filterSales(sales, 'c1', filters)), ['from', 'middle', 'to']);
  assert.deepEqual(ids(api.filterSales(sales, 'c1', { from: filters.to, to: filters.from })), []);
  assert.equal(api.dateRange(filters.to, filters.from).invalid, true);
  assert.equal(api.dateRange(filters.from, filters.to).invalid, false);
  assert.equal(api.buildReport(sales, 'c1', { ...options, from: filters.to, to: filters.from }).sales.length, 0);
  assert.equal(api.filterSales(sales, 'c1', { from: '', to: '' }).length, 5);
  assert.deepEqual(ids(api.filterSales(sales, 'c1', { from: '2026-10-15' })), ['to', 'after']);
  assert.deepEqual(ids(api.filterSales(sales, 'c1', { to: '2026-10-13' })), ['before', 'from']);
  assert.deepEqual(ids(api.filterSales(sales, 'c1', { from: '2026-10-14', to: '2026-10-14' })), ['middle']);
  assert.equal(JSON.stringify({ sales, filters }), before);
});

test('date filters use fecha || timestamp and the Lima day across UTC midnight and Lima midnight', () => {
  const sales = [
    sale({ id: 'utc-next-day', fecha: '2026-10-16T04:30:00Z' }), // 15/10, 23:30 Lima.
    sale({ id: 'lima-offset', fecha: '2026-10-15T23:30:00-05:00' }),
    sale({ id: 'local-time', fecha: '2026-10-15T23:30:00' }),
    sale({ id: 'timestamp', fecha: '', timestamp: '2026-10-16T04:59:59Z' }),
    sale({ id: 'lima-next-day', fecha: '2026-10-16T05:00:00Z' }),
    sale({ id: 'fecha-wins', fecha: '2026-10-14', timestamp: '2026-10-16T04:30:00Z' }),
    sale({ id: 'invalid', fecha: 'invalid', timestamp: '2026-10-16T04:30:00Z' })
  ];
  const filters = { from: '2026-10-15', to: '2026-10-15' };
  assert.deepEqual(ids(api.filterSales(sales, 'c1', filters)), ['utc-next-day', 'lima-offset', 'local-time', 'timestamp']);
  assert.equal(api.buildReport(sales, 'c1', { ...options, ...filters }).purchases, 4);
});

test('seller options use recorded identity, distinct ids, legacy names and No registrado for this client only', () => {
  const sales = [sale(), sale({ cajeroNombre: 'Ana histórica' }), sale({ cajeroId: 'v2', cajeroNombre: 'Ana' }),
    sale({ cajeroId: undefined, cajeroNombre: '', cajero: 'Beatriz' }), sale({ cajeroId: undefined, cajeroNombre: 'Beatriz' }),
    sale({ cajeroId: 7, cajeroNombre: '', cajero: '' }), sale({ cajeroId: undefined, cajeroNombre: ' ' }),
    sale({ clienteId: 'c2', cajeroId: 'other', cajeroNombre: 'Otro cliente' }),
    sale({ anulada: true, cajeroId: 'void', cajeroNombre: 'Anulada' }), sale({ status: 'void', cajeroId: 'void2' }), null];
  assert.deepEqual(plain(api.sellerOptions(sales, 'c1')), [
    { value: 'id:7', label: '7' }, { value: 'id:v1', label: 'Ana' }, { value: 'id:v2', label: 'Ana' },
    { value: 'name:Beatriz', label: 'Beatriz' }, { value: 'missing:', label: 'No registrado' }
  ]);
  assert.deepEqual(plain(api.sellerOptions(sales, '')), []);
  assert.deepEqual(plain(api.sellerOptions(null, 'c1')), []);
  assert.equal(api.filterSales(sales, 'c1', { seller: 'id:v1' }).length, 2);
  assert.equal(api.filterSales(sales, 'c1', { seller: 'name:Beatriz' }).length, 2);
  assert.equal(api.filterSales(sales, 'c1', { seller: 'missing:' }).length, 1);
  assert.equal(api.filterSales(sales, 'c1', { seller: 'id:7' }).length, 1);
  assert.equal(api.filterSales(sales, 'c1', { seller: 'id:other' }).length, 0);
  assert.equal(api.filterSales(sales, 'c1', { seller: '' }).length, 7);
});

test('combined filters apply before all report totals and product aggregation; existing period still applies', () => {
  const sales = [sale({ id: 'selected', total: 8, items: [{ id: 'p1', name: 'Producto elegido', qty: 2, subtotal: 8 }] }),
    sale({ id: 'wrong-seller', cajeroId: 'v2', total: 99 }), sale({ id: 'too-old', fecha: '2026-10-12', total: 88 }),
    sale({ id: 'wrong-client', clienteId: 'c2' }), sale({ id: 'void', anulada: true }),
    sale({ id: 'last-purchase-excluded', fecha: '2026-10-16', cajeroId: 'v2' })];
  const report = api.buildReport(sales, 'c1', { ...options, from: '2026-10-13', to: '2026-10-15', seller: 'id:v1' });
  assert.deepEqual(plain(report.sales.map(row => row.reference)), ['selected']);
  assert.equal(report.total, 8);
  assert.equal(report.purchases, 1);
  assert.equal(report.lastPurchase, '2026-10-15');
  assert.deepEqual(plain(report.products), [{ key: 'id:p1', name: 'Producto elegido', quantity: 2, amount: 8 }]);
  const oldSale = sale({ fecha: '2020-01-01' });
  assert.equal(api.buildReport([oldSale], 'c1', { ...options, days: 30, from: '2020-01-01' }).purchases, 0);
  assert.equal(api.buildReport([oldSale], 'c1', { ...options, from: '', to: '' }).purchases, 1);
  const empty = api.buildReport(sales, 'c1', { ...options, seller: 'id:absent' });
  assert.equal(empty.total, 0); assert.equal(empty.purchases, 0); assert.equal(empty.lastPurchase, '');
  assert.deepEqual(plain(empty.products), []);
});

test('CSV exports only filtered sales and products and guards every formula prefix, commas and quotes', () => {
  const sales = [sale({ id: 'included', comprobante: '=RECIBO', metodo: '@método', items: [{ id: 'p1', name: '-Producto, "prueba"', qty: 1, subtotal: 10 }] }),
    sale({ id: 'excluded-seller', cajeroId: 'v2', items: [{ id: 'p2', name: 'Producto excluido vendedor', qty: 1, subtotal: 99 }] }),
    sale({ id: 'excluded-date', fecha: '2026-10-12', items: [{ id: 'p3', name: 'Producto excluido fecha', qty: 1, subtotal: 88 }] })];
  const csv = api.toCsv(api.buildReport(sales, 'c1', { ...options, from: '2026-10-15', to: '2026-10-15', seller: 'id:v1' }));
  assert.match(csv, /"15\/10\/2026","'=RECIBO","10\.00","'@método"/);
  assert.ok(csv.includes('"\'-Producto, ""prueba""","1","10.00"'));
  assert.doesNotMatch(csv, /excluded|excluido/);
  for (const prefix of ['=', '+', '-', '@', '\t', '\r', '\n']) {
    assert.equal(api.csvCell(prefix + 'prueba'), '"\'' + prefix + 'prueba"');
  }
  assert.equal(api.csvCell('Seguro'), '"Seguro"');
  assert.equal(api.csvCell('a,b"c'), '"a,b""c"');
});

class Node {
  constructor() { this.children = []; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.hidden = false; this.disabled = false; this.dataset = {}; this.attrs = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  replaceChildren() { this.children = []; this.innerHTML = ''; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(event, callback) { this[event] = callback; }
}
test('render and CSV button share current filters, reject inverted dates, default to the last 30 days and clear seller data on denied access', () => {
  const nodes = Object.fromEntries(['content', 'status', 'controls', 'search', 'customer', 'period', 'from', 'to', 'seller', 'export']
    .map(key => ['[data-ch-' + key + ']', new Node()]));
  for (const [key, value] of Object.entries({ customer: 'c1', period: 'all', from: '2026-10-13', to: '2026-10-15', seller: 'id:v1' })) {
    nodes['[data-ch-' + key + ']'].value = value;
  }
  const page = Object.assign(new Node(), { querySelector: s => nodes[s] || null, classList: { contains: () => true } });
  let owner = true, csv = '', clicks = 0;
  const ctx = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page,
    createElement: tag => tag === 'a' ? { click() { clicks++; }, remove() {} } : new Node() },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: PERMISSIONS, addEventListener() {}, setTimeout(callback) { callback(); },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} }, Blob: class { constructor(parts) { csv = parts.join(''); } },
    clientes: [Object.freeze({ id: 'c1', nombre: 'Cliente de prueba' }), Object.freeze({ id: 'c2', nombre: 'Otro cliente' })],
    ventas: Object.freeze([Object.freeze(sale({ id: 'included' })), Object.freeze(sale({ id: 'excluded', cajeroId: 'v2', cajeroNombre: '<Vendedor>' }))]) });
  ctx.NA_CLIENTE_HISTORIAL.init();
  assert.equal(nodes['[data-ch-from]'].value, '2026-10-13'); // No pisa valores ya elegidos.
  assert.equal(nodes['[data-ch-to]'].value, '2026-10-15');
  assert.match(nodes['[data-ch-content]'].innerHTML, /included/);
  assert.doesNotMatch(nodes['[data-ch-content]'].innerHTML, /excluded/);
  assert.match(nodes['[data-ch-seller]'].innerHTML, /&lt;Vendedor&gt;/);
  assert.equal(nodes['[data-ch-export]'].disabled, false);
  nodes['[data-ch-export]'].click();
  assert.equal(clicks, 1); assert.match(csv, /included/); assert.doesNotMatch(csv, /excluded/);
  nodes['[data-ch-seller]'].value = 'id:v2';
  nodes['[data-ch-export]'].click(); // Relee los filtros aunque todavía no haya evento change.
  assert.equal(clicks, 2); assert.match(csv, /excluded/); assert.doesNotMatch(csv, /included/);
  nodes['[data-ch-from]'].value = '2026-10-16'; nodes['[data-ch-to]'].value = '2026-10-15';
  ctx.NA_CLIENTE_HISTORIAL.render();
  assert.match(nodes['[data-ch-status]'].textContent, /no puede ser posterior/);
  assert.equal(nodes['[data-ch-from]'].attrs['aria-invalid'], 'true');
  assert.equal(nodes['[data-ch-export]'].disabled, true);
  assert.equal(nodes['[data-ch-content]'].innerHTML, '');
  nodes['[data-ch-from]'].value = '2026-10-13';
  nodes['[data-ch-customer]'].value = 'c2';
  ctx.NA_CLIENTE_HISTORIAL.render();
  assert.equal(nodes['[data-ch-seller]'].value, '');
  assert.equal(nodes['[data-ch-seller]'].innerHTML, '<option value="">Todos</option>');
  owner = false;
  for (const key of ['clientes', 'ventas']) Object.defineProperty(ctx, key, { get() { throw new Error('unauthorized read'); } });
  nodes['[data-ch-export]'].click();
  assert.equal(clicks, 2);
  assert.equal(nodes['[data-ch-seller]'].innerHTML, '');
  assert.equal(nodes['[data-ch-export]'].disabled, true);
  assert.equal(nodes['[data-ch-content]'].innerHTML, '');
});

test('empty date inputs default once to the last 30 Lima days', () => {
  const nodes = Object.fromEntries(['content', 'status', 'controls', 'search', 'customer', 'period', 'from', 'to', 'seller', 'export']
    .map(key => ['[data-ch-' + key + ']', new Node()]));
  const page = Object.assign(new Node(), { querySelector: s => nodes[s] || null, classList: { contains: () => true } });
  const ctx = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page, createElement: () => new Node() },
    NA_ROLES: { isOwner: () => true }, NA_PERMISSIONS: PERMISSIONS, addEventListener() {}, clientes: [], ventas: [] });
  ctx.NA_CLIENTE_HISTORIAL.render();
  const expected = api.periodRange(30);
  assert.equal(nodes['[data-ch-from]'].value, expected.from);
  assert.equal(nodes['[data-ch-to]'].value, expected.to);
  nodes['[data-ch-from]'].value = ''; nodes['[data-ch-to]'].value = '';
  ctx.NA_CLIENTE_HISTORIAL.render(); // El usuario puede vaciarlas: sin límite.
  assert.equal(nodes['[data-ch-from]'].value, '');
});
