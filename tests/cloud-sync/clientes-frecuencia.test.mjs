import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const read = path => readFileSync(path, 'utf8');
const source = read('POS/js/modules/clientes-frecuencia.js');
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}, withLima = true) {
  const ctx = vm.createContext(extra);
  if (withLima) vm.runInContext(read('POS/js/core/lima-time.js'), ctx);
  vm.runInContext(source, ctx);
  return ctx;
}
const api = context().NA_CLIENTES_FRECUENCIA;
const now = '2026-10-16T04:59:59Z'; // 15 de octubre en Lima
const options = { now };
const customer = (id, nombre = 'Cliente ' + id) => ({ id, nombre });
const sale = (id, fecha, extra = {}) => ({ clienteId: id, fecha, items: [{ precio: 10, qty: 1 }], ...extra });
const row = sales => api.buildReport(sales, [], options).rows[0];

test('90/180/365 day periods are inclusive and use Lima including leap years and unzoned dates', () => {
  assert.deepEqual(plain(api.periodRange(90, now)), { days: 90, from: '2026-07-18', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange('180', now)), { days: 180, from: '2026-04-19', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange(365, now)), { days: 365, from: '2025-10-16', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange(90, '2024-03-01')), { days: 90, from: '2023-12-03', to: '2024-03-01' });
  assert.equal(api.periodRange(30, now).days, 90);
  for (const testApi of [api, context({}, false).NA_CLIENTES_FRECUENCIA]) {
    assert.equal(testApi.limaDay('2026-10-16T05:00:00Z'), '2026-10-16');
    assert.equal(testApi.limaDay('2026-10-15T23:59:59'), '2026-10-15');
    assert.equal(testApi.limaDay('2026-10-16T01:00:00+02:00'), '2026-10-15');
    assert.equal(testApi.limaDay(Date.parse(now)), '2026-10-15');
    for (const value of ['', null, 'invalid', '2026-02-30', '2026-02-30T12:00:00Z']) assert.equal(testApi.limaDay(value), '');
  }
  assert.throws(() => api.periodRange(90, 'invalid'), /Fecha/);
});

test('average is days between first and last divided by purchases minus one, independent of order', () => {
  const report = api.buildReport([sale(1, '2026-10-01'), sale(1, '2026-09-01'), sale(1, '2026-09-16')], [customer(1)], options);
  assert.deepEqual(plain(report.rows[0]), { id: '1', name: 'Cliente 1', purchases: 3, averageDays: 15,
    lastPurchase: '2026-10-01', daysSinceLast: 14, status: 'Al día', revenueCents: 3000, revenue: 30 });
  assert.equal(report.purchases, 3);
  assert.equal(report.revenue, 30);
  assert.equal(report.overdue, 0);
  assert.equal(row([sale(1, '2026-10-01'), sale(1, '2026-10-04'), sale(1, '2026-10-08')]).averageDays, 3.5);
});

test('strict status thresholds at average, double average, and 60 days; one purchase and zero-day intervals', () => {
  assert.equal(api.purchaseStatus(3, 10, 10), 'Al día');
  assert.equal(api.purchaseStatus(3, 10, 11), 'Por volver');
  assert.equal(api.purchaseStatus(3, 10, 20), 'Por volver');
  assert.equal(api.purchaseStatus(3, 10, 21), 'Inactivo');
  assert.equal(api.purchaseStatus(2, 100, 60), 'Al día');
  assert.equal(api.purchaseStatus(2, 100, 61), 'Inactivo');
  assert.equal(api.purchaseStatus(1, null, 60), 'Una sola compra');
  assert.equal(api.purchaseStatus(1, null, 61), 'Inactivo');
  assert.equal(row([sale(1, '2026-10-01'), sale(1, '2026-10-01')]).status, 'Inactivo');
  assert.equal(row([sale(1, '2026-10-15'), sale(1, '2026-10-15')]).status, 'Al día');
  assert.equal(row([sale(1, '2026-10-15'), sale(1, '2026-10-15')]).purchases, 2);
  assert.equal(row([sale(1, '2026-10-15')]).averageDays, null);
  assert.equal(row([sale(1, '2026-07-18')]).status, 'Inactivo');
});

test('annulled, anonymous, invalid, future and outside-period sales are excluded; fecha takes precedence', () => {
  const sales = [sale(1, '2026-07-18'), sale(1, '', { timestamp: now }), sale(1, '2026-07-17'),
    sale(1, '2026-10-16'), sale(1, 'invalid', { timestamp: now }), sale(1, '2026-10-15', { anulada: true }),
    sale(1, '2026-10-15', { anulado: true }), sale(1, '2026-10-15', { estado: 'ANULADA' }),
    sale(1, '2026-10-15', { status: 'anulado' }), sale(null, '2026-10-15', { clienteNombre: 'Consumidor final' }),
    sale('', '2026-10-15', { clienteNombre: 'Nombre sin identidad' }), null, 'invalid'];
  const report = api.buildReport(sales, [], options);
  assert.equal(report.purchases, 2);
  assert.equal(report.revenue, 20);
  assert.equal(api.buildReport(sales, [], { ...options, days: 180 }).purchases, 3);
  const history = [sale(1, '2026-10-15'), sale(1, '2026-06-01'), sale(1, '2026-01-01')];
  assert.equal(api.buildReport(history, [], options).rows[0].status, 'Una sola compra');
  assert.equal(api.buildReport(history, [], { ...options, days: 180 }).rows[0].averageDays, 136);
  const year = api.buildReport(history, [], { ...options, days: 365 }).rows[0];
  assert.equal(year.purchases, 3);
  assert.equal(year.averageDays, 143.5);
});

test('durable customer ids support canonical aliases and current names without merging namesakes or numeric ids', () => {
  const sales = [sale(1, '2026-10-15', { clienteNombre: 'Nombre anterior' }),
    sale(null, '2026-10-14', { customer_id: '1' }), sale(null, '2026-10-13', { cliente_id: 2 }),
    sale(0, '2026-10-15', { clienteNombre: 'Cliente cero' }),
    sale('deleted', '2026-10-15', { clienteNombre: 'Cliente histórico' }), sale('missing', '2026-10-15')];
  const report = api.buildReport(sales, [customer('1', 'Nombre compartido'), { customer_id: '2', name: 'Nombre compartido' }], options);
  const byId = new Map(report.rows.map(r => [r.id, r]));
  assert.equal(byId.get('1').purchases, 2);
  assert.equal(byId.get('2').purchases, 1);
  assert.equal(byId.get('1').name, 'Nombre compartido');
  assert.equal(byId.get('2').name, 'Nombre compartido');
  assert.equal(byId.get('0').name, 'Cliente cero');
  assert.equal(byId.get('deleted').name, 'Cliente histórico');
  assert.equal(byId.get('missing').name, 'Cliente sin nombre');
});

test('overdue first, ordered by overdue days with deterministic ties; search handles accents and summaries', () => {
  const sales = [sale('current', '2026-10-05'), sale('current', '2026-10-15'),
    sale('due', '2026-09-20'), sale('due', '2026-09-30'),
    sale('inactive', '2026-09-01'), sale('inactive', '2026-09-11'),
    sale('single', '2026-10-15'), sale('tie-z', '2026-10-15'), sale('tie-a', '2026-10-15')];
  const customers = [customer('due', 'José Álvarez'), customer('inactive'), customer('current'), customer('single'), customer('tie-a', 'Igual'), customer('tie-z', 'Igual')];
  const report = api.buildReport(sales, customers, options);
  assert.deepEqual(plain(report.rows.map(r => r.id)), ['inactive', 'due', 'current', 'single', 'tie-a', 'tie-z']);
  assert.equal(report.overdue, 2);
  const search = api.buildReport(sales, customers, { ...options, search: '  JOSE ALV  ' });
  assert.equal(search.rows.length, 1);
  assert.equal(search.purchases, 2);
  assert.equal(search.revenue, 20);
  assert.equal(api.buildReport(sales, customers, { ...options, search: 'absent' }).rows.length, 0);
  assert.deepEqual(plain(api.buildReport(sales.slice().reverse(), customers, options)), plain(report));
});

test('historical amounts use item price/quantity aliases and cents, without current prices or physical multipliers', () => {
  const sales = [sale(1, '2026-10-15', { total: 999, items: [{ precio: 0.1, qty: 3 }, { precioUnitario: 0.2, cantidad: 1 },
    { precio: 20, qty: 2, unitsPerQty: 12 }, null, { precio: -100, qty: 1 }, { precio: Infinity, qty: 1 }] }),
    { customer_id: '1', fecha: '2026-10-15', total_cents: 125 },
    { customer_id: '1', fecha: '2026-10-15', total: 1.5 }];
  assert.equal(row(sales).revenue, 43.25);
  assert.equal(row(sales).revenueCents, 4325);
  assert.equal(row([sale(1, '2026-10-15', { total: 999, items: [] })]).revenue, 0);
});

test('empty inputs are safe, frozen inputs and pending operations remain unchanged, projections are detached', () => {
  const empty = api.buildReport(null, undefined, options);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.purchases, 0);
  assert.equal(empty.overdue, 0);
  assert.equal(empty.revenue, 0);
  const sales = Object.freeze([Object.freeze(sale(1, '2026-10-15', { pending: true, items: Object.freeze([Object.freeze({ precio: 10, qty: 1 })]) }))]);
  const customers = Object.freeze([Object.freeze(customer(1))]);
  const pending = Object.freeze([{ operation_id: 'synthetic-pending', status: 'pending' }]);
  const before = JSON.stringify({ sales, customers, pending });
  const report = api.buildReport(sales, customers, options);
  report.rows[0].name = 'Changed projection';
  report.rows.push({});
  assert.equal(JSON.stringify({ sales, customers, pending }), before);
});

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  set innerHTML(_) { throw new Error('Customer text must never be parsed as HTML'); }
}
test('render inserts customer names as literal text, guards before state reads, and clears stale data on role denial', () => {
  const content = new Node(), status = new Node(), controls = new Node(), period = new Node(), search = new Node();
  period.value = '90';
  const nodes = { '[data-cf-content]': content, '[data-cf-status]': status, '[data-cf-controls]': controls, '[data-cf-period]': period, '[data-cf-search]': search };
  const page = { querySelector: s => nodes[s] || null };
  let owner = true;
  const name = '<img src=x onerror=alert(1)> & "Cliente"';
  const c = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page, createElement: tag => new Node(tag) },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: PERMISSIONS,
    clientes: [customer(1, name)], ventas: [sale(1, api.periodRange(90).to)],
    fetch() { throw new Error('No network'); }, localStorage: { setItem() { throw new Error('No writes'); } } });
  assert.equal(c.NA_CLIENTES_FRECUENCIA.render(), true);
  assert.ok(content.textContent.includes(name));
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.equal(walk(content).filter(n => n.tagName === 'img').length, 0);
  assert.equal(controls.hidden, false);
  search.value = 'absent';
  assert.equal(c.NA_CLIENTES_FRECUENCIA.render(), true);
  assert.match(content.textContent, /No hay compras/);
  owner = false;
  for (const key of ['ventas', 'clientes']) Object.defineProperty(c, key, { get() { throw new Error('Unauthorized state read'); } });
  assert.equal(c.NA_CLIENTES_FRECUENCIA.render(), false);
  assert.equal(content.children.length, 0);
  assert.equal(controls.hidden, true);
  assert.match(status.textContent, /Sin permiso/);
});

test('lock=false and owner-only screen/feature roles are shared by browser and worker; missing roles deny', () => {
  assert.equal(PERMISSIONS.FEATURE_LOCKS['clientes-frecuencia'], false);
  assert.equal(PERMISSIONS.featureLocked('clientes-frecuencia'), false);
  assert.deepEqual(Array.from(PERMISSIONS.SCREENS.pageClientesFrecuencia), ['owner']);
  assert.deepEqual(Array.from(PERMISSIONS.FEATURE_ROLES['clientes-frecuencia']), ['owner']);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.deepEqual(Array.from(PERMISSIONS.routeRoles('/features/clientes-frecuencia', method)), ['owner']);
  for (const role of ['empleado', 'unknown', '', null]) assert.equal(PERMISSIONS.canAccessScreen(role, 'pageClientesFrecuencia'), false);
  for (const roles of [undefined, { role: 'owner', confirmed: false }, { isOwner: () => false }]) {
    assert.equal(context({ NA_ROLES: roles, NA_PERMISSIONS: PERMISSIONS }).NA_CLIENTES_FRECUENCIA.ownerAllowed(), false);
  }
  assert.equal(context({ NA_ROLES: { isOwner: () => true } }).NA_CLIENTES_FRECUENCIA.ownerAllowed(), false);
});

test('navigation whitelist/fallback denies employee and unconfirmed roles without adding drawer items', () => {
  const navigation = read('POS/js/navigation/menu-navigation.js');
  const c = vm.createContext({ document: { readyState: 'loading', addEventListener() {} }, innerWidth: 390 });
  c.window = c;
  vm.runInContext(navigation, c);
  assert.ok(c.NA_MENU_NAVIGATION.pages.includes('pageClientesFrecuencia'));
  for (const permissions of [undefined, PERMISSIONS]) {
    c.NA_PERMISSIONS = permissions;
    for (const roles of [undefined, { role: 'owner' }, { role: 'owner', confirmed: false, isOwner: () => false }, { role: 'empleado', confirmed: true, isOwner: () => false }]) {
      c.NA_ROLES = roles;
      assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageClientesFrecuencia'), false);
    }
    c.NA_ROLES = { isOwner: () => true };
    assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage('pageClientesFrecuencia'), true);
  }
  assert.doesNotMatch(navigation.slice(navigation.indexOf('function renderDrawerItems()'), navigation.indexOf('function openMobileDrawer')), /pageClientesFrecuencia/);
});

test('registry points to the standalone page with meaningful preview; assets are wired and cached; module is read-only', () => {
  const c = vm.createContext({});
  vm.runInContext(read('POS/js/modules/proximamente-registry.js'), c);
  const feature = c.NA_PROXIMAMENTE_REGISTRY.find(f => f.id === 'clientes-frecuencia');
  assert.equal(feature.page, 'pageClientesFrecuencia');
  assert.equal(feature.pending, undefined);
  assert.deepEqual(plain(feature.preview), { type: 'table', columns: ['Cliente', 'Compras', 'Cada (días)', 'Estado'] });
  const html = read('POS/index.html'), sw = read('POS/sw.js');
  assert.match(html, /id="pageClientesFrecuencia"/);
  for (const asset of ['css/clientes-frecuencia.css', 'js/modules/clientes-frecuencia.js']) {
    assert.ok(html.includes(asset)); assert.ok(sw.includes("'./" + asset + "'"));
  }
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|sendBeacon|\.setItem\s*\(|indexedDB|\.innerHTML\s*=|\b(?:POST|PUT|PATCH|DELETE)\b/);
});
