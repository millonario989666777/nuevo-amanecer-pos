import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const read = path => readFileSync(path, 'utf8');
const source = read('POS/js/modules/cliente-historial-compras.js');
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  const ctx = vm.createContext(extra);
  vm.runInContext(source, ctx);
  return ctx;
}
const api = context().NA_CLIENTE_HISTORIAL;
const now = '2026-10-16T04:59:59Z'; // 15 de octubre en Lima.
const options = { now };
const item = (id, precio, qty = 1, extra = {}) => ({ id, name: 'Producto ' + id, precio, qty, ...extra });
const sale = (extra = {}) => ({ id: 'venta-prueba', clienteId: 'c1', fecha: '2026-10-15', total: 10, metodo: 'efectivo', items: [item('p1', 10)], ...extra });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('inclusive 30/90/365/all periods use Lima and validate leap days', () => {
  for (const [days, from] of [[30, '2026-09-16'], [90, '2026-07-18'], [365, '2025-10-16'], ['all', '']]) {
    assert.deepEqual(plain(api.periodRange(days, now)), { days, from, to: '2026-10-15' });
  }
  assert.equal(api.periodRange(30, '2024-03-01').from, '2024-02-01');
  assert.equal(api.limaDay('2024-02-29'), '2024-02-29');
  for (const invalid of ['2026-02-29', '2026-02-30T12:00:00', 'invalid', '', null]) assert.equal(api.limaDay(invalid), '');
  assert.equal(api.limaDay('2026-10-16T00:30:00'), '2026-10-16');
  assert.equal(api.limaDay(Date.parse(now)), '2026-10-15');
  assert.throws(() => api.periodRange(30, 'invalid'), /Fecha/);
});

test('matches durable customer id only; excludes void, invalid, future and out-of-period sales', () => {
  const sales = freeze([
    sale({ id: 'start', fecha: '2026-09-16' }), sale({ id: 'end' }),
    sale({ id: 'old', fecha: '2026-09-15' }), sale({ fecha: '2026-10-16' }),
    sale({ fecha: 'invalid', timestamp: now }), sale({ anulada: true }), sale({ estado: 'anulada' }),
    sale({ status: 'void' }), sale({ clienteId: 'c2', clienteNombre: 'Mismo nombre', clienteDni: '00000001' }),
    sale({ clienteId: null, clienteNombre: 'Mismo nombre', clienteDni: '00000001' }),
    sale({ clienteId: '', customer_id: 'c1' }), null, 5
  ]);
  const before = JSON.stringify(sales);
  const report = api.buildReport(sales, 'c1', options);
  assert.equal(report.total, 20);
  assert.equal(report.purchases, 2);
  assert.equal(report.lastPurchase, '2026-10-15');
  assert.deepEqual(plain(report.sales.map(s => s.reference)), ['end', 'start']);
  assert.equal(api.buildReport(sales, 'c1', { ...options, days: 90 }).purchases, 3);
  assert.equal(JSON.stringify(sales), before);
});

test('totals use recorded sale amounts; product aggregation uses subtotals and preserves distinct ids', () => {
  const sales = freeze([
    sale({ id: 'earlier', hora24: '08:00', total: 17.5, metodoPago: 'credito', items: [
      item('p1', 10, 2, { subtotal: 17.5, name: 'Igual' }),
      item('p2', 0, 1, { name: 'Igual' })
    ] }),
    sale({ id: 'later', hora24: '12:00', total: 3.25, comprobante: 'B001-0002', items: [
      item('p1', 3.25), { productoId: 'p3', nombre: 'Fracción', cantidad: 0.5, precioUnitario: 2 },
      null, item('negative', -5, -1), item('nan', NaN, 0), item('infinite', Infinity, Infinity)
    ] }),
    sale({ clienteId: undefined, customer_id: 'c1', id: undefined, sale_id: 'canonical', total: undefined, total_cents: 99,
      payment_method: 'yape', metodo: undefined, items: [{ product_id: 'p4', nombre: 'Canónico', quantity: 3, unit_price_cents: 33, line_total_cents: 99 }] })
  ]);
  const report = api.buildReport(sales, 'c1', options);
  assert.equal(report.total, 21.74);
  assert.equal(report.purchases, 3);
  assert.deepEqual(plain(report.products.map(p => [p.key, p.quantity, p.amount])), [
    ['id:p1', 3, 20.75], ['id:p3', 0.5, 1], ['id:p4', 3, 0.99], ['id:p2', 1, 0]
  ]);
  assert.equal(report.sales[0].reference, 'B001-0002');
  assert.equal(report.sales.find(s => s.reference === 'earlier').method, 'credito');
  assert.ok(report.sales.some(s => s.reference === 'canonical' && s.method === 'yape'));
});

test('numeric ids, missing totals, empty data, malformed items and all-history boundaries', () => {
  const sales = [sale({ clienteId: 7, total: undefined, items: [item('p1', 0.1, 3)] }),
    sale({ clienteId: 7, fecha: '2020-01-01', total: 0, items: null }),
    sale({ clienteId: 7, fecha: '2026-10-16' })];
  assert.equal(api.buildReport(sales, '7', options).total, 0.3);
  assert.equal(api.buildReport(sales, '7', { ...options, days: 'all' }).purchases, 2);
  for (const input of [[], undefined, {}, [null]]) {
    const report = api.buildReport(input, 'c1', options);
    assert.equal(report.total, 0); assert.equal(report.purchases, 0); assert.equal(report.lastPurchase, '');
    assert.deepEqual(plain(report.products), []);
  }
  assert.equal(api.buildReport([sale({ clienteId: null })], '', options).purchases, 0);
  const absent = api.buildReport([sale({ items: undefined, total: 4 })], 'c1', options);
  assert.equal(absent.total, 4); assert.equal(absent.purchases, 1); assert.equal(absent.products.length, 0);
});

test('search by name/DNI is accent-insensitive, tolerates canonical customers and does not mutate input', () => {
  const customers = freeze([{ id: 'c1', nombre: 'José Prueba', dni: '00000001' },
    { id: 'c2', nombre: 'José Prueba', dni: '00000002' },
    { customer_id: 7, name: 'María Ejemplo', document: '00000003' }, null, {}, { id: 'c1', nombre: 'Duplicado' }]);
  const before = JSON.stringify(customers);
  assert.deepEqual(plain(api.searchCustomers(customers, ' JOSE ').map(c => c.id)), ['c1', 'c2']);
  assert.deepEqual(plain(api.searchCustomers(customers, '00000003')), [{ id: '7', name: 'María Ejemplo', dni: '00000003' }]);
  assert.equal(api.searchCustomers(customers, 'no existe').length, 0);
  assert.equal(api.searchCustomers(null, '').length, 0);
  assert.equal(JSON.stringify(customers), before);
});

test('HTML escapes customer, product, receipt and payment text in every generated cell', () => {
  const malicious = '<img src=x onerror="alert(1)"> & \'texto\'';
  assert.equal(api.escapeHtml(malicious), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;texto&#39;');
  const report = api.buildReport([sale({ comprobante: malicious, metodo: malicious, items: [item('p1', 10, 1, { name: malicious })] })], 'c1', options);
  const html = api.reportHtml(report, { name: malicious });
  assert.doesNotMatch(html, /<img|onerror="|<script/i);
  assert.equal(html.split(api.escapeHtml(malicious)).length - 1, 4);
  assert.match(html, /data-ch-table="sales"/); assert.match(html, /data-ch-table="products"/);
  assert.match(api.reportHtml(api.buildReport([], 'c1', options), { name: 'Prueba' }), /no tiene compras/);
  assert.match(api.reportHtml(api.buildReport([sale({ items: [] })], 'c1', options), { name: 'Prueba' }), /no tienen productos detallados/);
});

class Node {
  constructor() { this.children = []; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.hidden = false; }
  replaceChildren() { this.children = []; this.innerHTML = ''; }
  appendChild(node) { this.children.push(node); return node; }
}
test('render clears stale customer data before denial and never reads unauthorized state or calls writers', () => {
  const nodes = Object.fromEntries(['content', 'status', 'controls', 'search', 'customer', 'period'].map(key => ['[data-ch-' + key + ']', new Node()]));
  nodes['[data-ch-period]'].value = '30'; nodes['[data-ch-customer]'].value = 'c1';
  const page = { querySelector: s => nodes[s] || null };
  let owner = true;
  const ctx = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page, createElement: () => new Node() },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: PERMISSIONS,
    clientes: freeze([{ id: 'c1', nombre: '<script>cliente</script>', dni: '00000001' }]), ventas: freeze([sale({ fecha: api.limaDay(Date.now()) })]),
    fetch() { throw new Error('network call'); }, save() { throw new Error('state write'); },
    localStorage: { setItem() { throw new Error('storage write'); } } });
  assert.equal(ctx.NA_CLIENTE_HISTORIAL.render(), true);
  assert.match(nodes['[data-ch-content]'].innerHTML, /&lt;script&gt;cliente&lt;\/script&gt;/);
  assert.equal(nodes['[data-ch-customer]'].children[1].textContent, '<script>cliente</script> · 00000001');
  owner = false;
  for (const key of ['clientes', 'ventas']) Object.defineProperty(ctx, key, { get() { throw new Error('unauthorized read'); } });
  assert.equal(ctx.NA_CLIENTE_HISTORIAL.render(), false);
  assert.equal(nodes['[data-ch-content]'].innerHTML, '');
  assert.equal(nodes['[data-ch-customer]'].children.length, 0);
  assert.equal(nodes['[data-ch-controls]'].hidden, true);
  assert.match(nodes['[data-ch-status]'].textContent, /Sin permiso/);
});

test('shared browser/server lock and role policy fail closed for employee and unconfirmed roles', () => {
  assert.equal(PERMISSIONS.FEATURE_LOCKS['cliente-historial-compras'], false);
  assert.deepEqual(PERMISSIONS.FEATURE_ROLES['cliente-historial-compras'], ['owner']);
  assert.deepEqual(PERMISSIONS.SCREENS.pageClienteHistorial, ['owner']);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.deepEqual(PERMISSIONS.routeRoles('/features/cliente-historial-compras', method), ['owner']);
  for (const role of ['empleado', 'unknown', '', null]) assert.equal(PERMISSIONS.canAccessScreen(role, 'pageClienteHistorial'), false);
  for (const roles of [undefined, { role: 'owner', confirmed: false }, { isOwner: () => false }]) {
    assert.equal(context({ NA_ROLES: roles, NA_PERMISSIONS: PERMISSIONS }).NA_CLIENTE_HISTORIAL.ownerAllowed(), false);
  }
  assert.equal(context({ NA_ROLES: { isOwner: () => true } }).NA_CLIENTE_HISTORIAL.ownerAllowed(), false);
  assert.equal(context({ NA_ROLES: { isOwner: () => true }, NA_PERMISSIONS: { ...PERMISSIONS, featureLocked: () => true } }).NA_CLIENTE_HISTORIAL.ownerAllowed(), false);
});

test('integrated page, assets, registry and navigation follow ABC without a drawer entry or write APIs', () => {
  const ctx = context({ document: { readyState: 'loading', addEventListener() {} }, innerWidth: 390 }); ctx.window = ctx;
  vm.runInContext(read('POS/js/navigation/menu-navigation.js'), ctx);
  assert.ok(ctx.NA_MENU_NAVIGATION.pages.includes('pageClienteHistorial'));
  for (const permissions of [undefined, PERMISSIONS]) {
    ctx.NA_PERMISSIONS = permissions;
    ctx.NA_ROLES = { isOwner: () => false };
    assert.equal(ctx.NA_MENU_NAVIGATION.canShowDrawerPage('pageClienteHistorial'), false);
  }
  assert.doesNotMatch(read('POS/js/navigation/menu-navigation.js'), /\['[^']+', '[^']+', 'pageClienteHistorial'/);
  vm.runInContext(read('POS/js/modules/proximamente-registry.js'), ctx);
  const entry = ctx.NA_PROXIMAMENTE_REGISTRY.find(f => f.id === 'cliente-historial-compras');
  assert.equal(entry.page, 'pageClienteHistorial'); assert.equal(!!entry.pending, false);
  assert.deepEqual(plain(entry.roles), ['owner']);
  const html = read('POS/index.html'), sw = read('POS/sw.js');
  assert.match(html, /id="pageClienteHistorial"/);
  for (const asset of ['css/cliente-historial-compras.css', 'js/modules/cliente-historial-compras.js']) {
    assert.ok(html.includes(asset)); assert.ok(sw.includes('./' + asset));
  }
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|localStorage|indexedDB|\b(?:POST|PUT|PATCH|DELETE)\b|\b(?:save|guardar|persist)\w*\s*\(/);
});

test('page heading and Próximamente card share the name; numeric cells are marked and CSS stays scoped', () => {
  const ctx = vm.createContext({});
  vm.runInContext(read('POS/js/modules/proximamente-registry.js'), ctx);
  const entry = ctx.NA_PROXIMAMENTE_REGISTRY.find(f => f.id === 'cliente-historial-compras');
  assert.equal(entry.name, 'Historial de compras por cliente');
  assert.equal(entry.page, 'pageClienteHistorial');
  const heading = read('POS/index.html').match(/<h1 id="clienteHistorialTitle">([^<]+)<\/h1>/)[1];
  assert.equal(heading, entry.name);
  const report = api.buildReport([sale()], 'c1', options);
  const html = api.reportHtml(report, { name: 'Cliente' });
  for (const label of ['Total', 'Cantidad', 'Importe']) assert.match(html, new RegExp('<th scope="col" class="ch-num">' + label + '</th>'));
  assert.doesNotMatch(html, /<th scope="col" class="ch-num">(Fecha|Producto|Comprobante \/ ID|Método de pago)</);
  const css = read('POS/css/cliente-historial-compras.css');
  css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')[0].trim()).filter(s => s && !s.startsWith('@'))
    .forEach(sel => sel.split(/,(?![^(]*\))/).forEach(part => assert.match(part.trim(), /#pageClienteHistorial\b/, part)));
  const outside = css.split('@media')[0];
  assert.match(outside, /#pageClienteHistorial \.ch-table :is\(th, td\) \{ display: table-cell; \}/);
  assert.match(outside, /\.ch-table thead th \{[^}]*white-space: nowrap/);
  assert.match(outside, /\.ch-table \.ch-num \{[^}]*text-align: right[^}]*white-space: nowrap/);
  assert.match(outside, /\.ch-table tbody th \{[^}]*text-transform: none/);
});

test('kardex amount cells never break between S/ and the number', () => {
  const css = read('POS/css/kardex.css');
  const outside = css.split('@media')[0];
  assert.match(outside, /#pageKardex \.kardex-table :is\(th,td\)\{display:table-cell\}/);
  assert.match(outside, /#pageKardex \.kardex-table \.kardex-num \{[^}]*white-space: nowrap/);
});
