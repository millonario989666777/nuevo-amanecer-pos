import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const read = path => readFileSync(path, 'utf8');
const source = read('POS/js/modules/dashboard-tesoreria.js');
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) { const c = vm.createContext(extra); vm.runInContext(source, c); return c; }
const api = context().NA_DASHBOARD_TESORERIA;
const now = '2026-10-16T04:59:59Z'; // Todavía 15/10 en Lima.
const options = { now };
const session = (id, extra = {}) => ({ session_id: id, opened_at: '2026-10-15T13:00:00Z',
  closed_at: '2026-10-16T04:00:00Z', status: 'CLOSED', expected_cents: 12000, counted_cents: 11000, ...extra });
const move = (id, extra = {}) => ({ movement_id: id, sale_id: 'sale-' + id, session_id: 'shift-1',
  created_at: '2026-10-15T20:00:00Z', cash_cents: 1000, digital_cents: 0, credit_cents: 0, ...extra });
const report = (sessions, moves, opts = options) => api.buildReport({ cashSessions: sessions, cashMovements: moves }, opts);
const day = (r, date = '2026-10-15') => r.rows.find(row => row.date === date);

test('7/30 inclusive Lima days, default 7, UTC boundary, leap years and unzoned timestamps', () => {
  assert.deepEqual(plain(api.periodRange(7, now)), { days: 7, from: '2026-10-09', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange('30', now)), { days: 30, from: '2026-09-16', to: '2026-10-15' });
  assert.deepEqual(plain(api.periodRange(7, '2024-03-01')), { days: 7, from: '2024-02-24', to: '2024-03-01' });
  assert.equal(api.periodRange(90, now).days, 7);
  assert.equal(api.limaDay('2026-10-16T05:00:00Z'), '2026-10-16');
  assert.equal(api.limaDay('2026-10-15T23:59:59'), '2026-10-15');
  assert.equal(api.limaDay('2026-10-15 23:59:59'), '2026-10-15');
  assert.equal(api.limaDay('2026-10-16T01:00:00+02:00'), '2026-10-15');
  assert.equal(api.limaDay(Date.parse(now)), '2026-10-15');
  for (const value of ['', null, 'invalid', '2026-02-30', '2026-02-30T12:00:00Z']) assert.equal(api.limaDay(value), '');
  assert.throws(() => api.periodRange(7, 'invalid'), /Fecha/);
});

test('daily sales split cash/digital/credit, support tarjeta and unknown methods, exclude credit collections and expenses', () => {
  const r = report([session('shift-1')], [move('mixed', { cash_cents: 300, digital_cents: 700, digital_method: 'yape', credit_cents: 500 }),
    move('plin', { cash_cents: 0, digital_cents: 150, digital_method: 'plin' }),
    move('card', { cash_cents: 0, digital_cents: 225, digital_method: 'tarjeta' }),
    move('transfer', { cash_cents: 0, digital_cents: 100 }),
    move('other', { cash_cents: 0, digital_cents: 50, digital_method: 'otro-medio' }),
    move('collection', { event_type: 'PAYMENT', cash_cents: 9000 }), move('expense', { sale_id: null, cash_cents: 9999 }), null]);
  assert.deepEqual(plain(day(r).methods), { efectivo: 300, yape: 700, plin: 150, tarjeta: 225, transferencia: 100, credito: 500, otros: 50 });
  assert.equal(day(r).expected, 12000);
  assert.equal(day(r).counted, 11000);
  assert.equal(day(r).difference, -1000);
  assert.equal(r.rows.length, 7);
  assert.equal(r.rows[0].date, '2026-10-15');
  assert.equal(r.rows[6].date, '2026-10-09');
});

test('multiple shifts per opening day, cross-midnight closes/sales, range edges and duplicate durable identities', () => {
  const a = session('shift-1', { opened_at: '2026-10-14T23:00:00-05:00', closed_at: '2026-10-15T07:00:00Z' });
  const b = session('shift-2', { opened_at: '2026-10-14T08:00:00-05:00', expected_cents: 2000, counted_cents: 2500 });
  const edge = session('edge', { opened_at: '2026-10-09T05:00:00Z' });
  const old = session('old', { opened_at: '2026-10-08T23:00:00-05:00' });
  const r = report([a, b, a, edge, old, session('future', { opened_at: '2026-10-16T05:00:00Z' }), session('invalid', { opened_at: 'bad' })],
    [move('night', { created_at: '2026-10-15T06:00:00Z' }), move('night'), move('b', { session_id: 'shift-2' }),
      move('edge', { session_id: 'edge' }), move('old', { session_id: 'old' }), move('future', { session_id: 'future' }),
      move('unassociated', { session_id: null, created_at: '2026-10-16T04:59:59Z' })]);
  assert.equal(day(r, '2026-10-14').closures, 2);
  assert.equal(day(r, '2026-10-14').methods.efectivo, 2000);
  assert.equal(day(r, '2026-10-14').expected, 14000);
  assert.equal(day(r, '2026-10-14').counted, 13500);
  assert.equal(day(r, '2026-10-14').difference, -500);
  assert.equal(day(r, '2026-10-09').methods.efectivo, 1000);
  assert.equal(day(r).methods.efectivo, 1000);
});

test('legacy closures and movements use soles, mixed digital/card/credit, subtract reversals and ignore collections', () => {
  const r = api.buildReport({ cashClosures: [{ id: 'close', sessionId: 1, fechaApertura: '2026-10-15', esperado: 25, contado: 24 }], cajMovs: [
    { id: 'mixed', sessionId: 1, tipo: 'ing', ventaId: 1, metodo: 'mixto', monto: 10, detallePago: { efectivo: 2, digital: 3, digitalMethod: 'tarjeta', credito: 5 } },
    { id: 'plin', sessionId: 1, tipo: 'ing', cat: 'Venta retail', metodo: 'plin', monto: 4.25 },
    { id: 'reversal', sessionId: 1, tipo: 'egr', ventaId: 1, reversalOf: 1, reversal: true, metodo: 'efectivo', monto: 1 },
    { tipo: 'cob', sessionId: 1, monto: 500 }, { tipo: 'gas', sessionId: 1, monto: 100 },
    { tipo: 'ing', sessionId: 1, cat: 'Ingreso manual', monto: 900 }
  ] }, options);
  assert.deepEqual(plain(day(r).methods), { efectivo: 100, yape: 0, plin: 425, tarjeta: 300, transferencia: 0, credito: 500, otros: 0 });
  assert.equal(day(r).expected, 2500);
  assert.equal(day(r).counted, 2400);
  assert.equal(day(r).difference, -100);
  const fallback = api.buildReport({ cajMovs: [{ tipo: 'ing', ventaId: 1, fecha: '2026-10-15', metodo: 'mixto', monto: 10, efectivo: 2 }] }, options);
  assert.equal(day(fallback).methods.transferencia, 800);
});

test('missing counts, open shifts and missing movement breakdown never invent a reconciled zero', () => {
  const missing = day(report([session('shift-1', { counted_cents: null }), session('shift-2')], [move('sale')]));
  assert.equal(missing.expected, 24000);
  assert.equal(missing.counted, null);
  assert.equal(missing.difference, null);
  assert.equal(missing.uncounted, 1);
  assert.equal(missing.methods, null);
  const open = day(report([session('shift-1', { status: 'OPEN' })], [move('sale')]));
  assert.equal(open.expected, null); assert.equal(open.counted, null); assert.equal(open.difference, null);
  assert.equal(open.methods.efectivo, 1000);
  const invalid = day(report([session('shift-1', { expected_cents: 'invalid' })], [move('sale')]));
  assert.equal(invalid.expected, null); assert.equal(invalid.difference, null);
  const zero = day(report([session('shift-1', { expected_cents: 0, counted_cents: 0, difference_cents: 999 })], [move('sale')]));
  assert.equal(zero.difference, 0); // Calculado: contado − esperado, sin reutilizar una diferencia inconsistente.
  assert.equal(day(report([session('shift-1')], [])).methods, null);
  const empty = api.buildReport(null, options);
  assert.equal(empty.hasData, false); assert.equal(empty.rows.length, 7);
  assert.equal(day(empty).expected, null);
});

test('range 30 admits older shifts; projections detach from frozen inputs including pending operations', () => {
  const s = Object.freeze(session('shift-1', { opened_at: '2026-09-16T12:00:00Z' }));
  const m = Object.freeze(move('sale', { pending: true }));
  const data = Object.freeze({ cashSessions: Object.freeze([s]), cashMovements: Object.freeze([m]), outbox: Object.freeze([{ pending: true }]) });
  const before = JSON.stringify(data);
  assert.equal(api.buildReport(data, options).hasData, false);
  const r = api.buildReport(data, { ...options, days: 30 });
  assert.equal(r.rows.length, 30); assert.equal(day(r, '2026-09-16').methods.efectivo, 1000);
  day(r, '2026-09-16').methods.efectivo = 0;
  assert.equal(JSON.stringify(data), before);
});

test('CSV starts with active filter, quotes text, guards every formula prefix and preserves numeric negative differences', () => {
  for (const prefix of ['=', '+', '-', '@', '\t', '\r', '\n']) {
    const guarded = api.csvCell(prefix + 'formula');
    assert.ok(guarded.startsWith("'") || guarded.startsWith('"\''), JSON.stringify(prefix));
    assert.ok(api.csvCell('  ' + prefix + 'formula').includes("'  "));
  }
  assert.equal(api.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(api.csvCell('normal'), 'normal');
  assert.equal(api.csvCell(-12), '-12');
  const csv = api.toCsv(report([session('shift-1')], [move('sale')], { ...options, days: 30 }));
  assert.ok(csv.startsWith('\uFEFFFiltro activo,Últimos 30 días,2026-09-16,2026-10-15,Lima · fecha de apertura\r\n'));
  assert.ok(csv.includes('Fecha,Efectivo,Yape,Plin,Tarjeta,Transferencia,Crédito,Otros,Esperado,Contado,Diferencia\r\n'));
  assert.ok(csv.includes('15/10/2026,10.00,0.00,0.00,0.00,0.00,0.00,0.00,120.00,110.00,-10.00\r\n'));
  assert.equal(api.money(1234), 'S/\u00a012.34');
  assert.equal(api.money(-1234), '-S/\u00a012.34');
});

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  set innerHTML(_) { throw new Error('textContent only'); }
  click() { this.clicked = true; }
  remove() {}
}
function harness(canonical = false) {
  const content = new Node(), status = new Node(), controls = new Node(), period = new Node(), exportButton = new Node();
  period.value = '7';
  const nodes = { '[data-dt-content]': content, '[data-dt-status]': status, '[data-dt-controls]': controls,
    '[data-dt-period]': period, '[data-dt-export]': exportButton };
  const page = new Node(); page.querySelector = s => nodes[s] || null;
  let owner = true, reads = 0, downloads = [], revoked = [];
  const data = { cashSessions: [session('shift-1', { opened_at: api.periodRange(7).to + 'T08:00:00-05:00' })], cashMovements: [move('sale')] };
  const c = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: () => page, createElement: tag => new Node(tag) },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: PERMISSIONS,
    NuevoAmanecerCanonical: { enabled() { throw new Error('enabled reads storage'); }, snapshot() { reads++; return canonical ? data : {}; } },
    cashClosures: [{ sessionId: 1, fechaApertura: api.periodRange(7).to, esperado: 12, contado: 10 }],
    cajMovs: [{ id: '<img src=x onerror=alert(1)>', sessionId: 1, tipo: 'ing', ventaId: 1, metodo: 'efectivo', monto: 10 }],
    fetch() { throw new Error('No network'); }, localStorage: new Proxy({}, { get() { throw new Error('No storage'); } }),
    URL: { createObjectURL(blob) { downloads.push(blob.data); return 'blob:test'; }, revokeObjectURL(url) { revoked.push(url); } },
    Blob: class { constructor(data) { this.data = data.join(''); } }, setTimeout(fn) { fn(); } });
  return { c, content, status, controls, period, exportButton, downloads, revoked, get reads() { return reads; }, deny() { owner = false; } };
}
const walk = node => [node, ...node.children.flatMap(walk)];

test('render/export read only memory, use textContent and right-align numeric headers; export uses current filter', () => {
  for (const canonical of [false, true]) {
    const h = harness(canonical), a = h.c.NA_DASHBOARD_TESORERIA;
    assert.equal(a.render(), true);
    assert.equal(h.controls.hidden, false); assert.equal(h.exportButton.disabled, false);
    assert.match(h.status.textContent, /Lima.*datos cargados/);
    const cells = walk(h.content);
    assert.equal(cells.filter(n => n.tagName === 'img').length, 0);
    assert.equal(cells.filter(n => n.tagName === 'th' && n.scope === 'col' && n.className === 'cf-num').length, 10);
    assert.ok(cells.some(n => n.className === 'cf-num dt-negative' && n.textContent.includes('faltante')));
    h.period.value = '30';
    assert.equal(a.exportCsv(), true);
    assert.ok(h.downloads[0].includes('Filtro activo,Últimos 30 días'));
    assert.deepEqual(h.revoked, ['blob:test']);
  }
});

test('revoked or unconfirmed access clears data and denies export BEFORE reading memory, snapshot, Blob or storage', () => {
  const h = harness(true), a = h.c.NA_DASHBOARD_TESORERIA;
  a.render(); const reads = h.reads;
  h.deny();
  h.c.NuevoAmanecerCanonical = new Proxy({}, { get() { throw new Error('Unauthorized snapshot access'); } });
  for (const key of ['cashClosures', 'cajMovs']) Object.defineProperty(h.c, key, { get() { throw new Error('Unauthorized state read'); } });
  assert.equal(a.render(), false); assert.equal(a.exportCsv(), false);
  assert.equal(h.reads, reads); assert.equal(h.content.children.length, 0);
  assert.equal(h.controls.hidden, true); assert.equal(h.exportButton.disabled, true);
  assert.match(h.status.textContent, /Sin permiso/); assert.equal(h.downloads.length, 0);
  for (const roles of [undefined, { role: 'owner', confirmed: false }, { isOwner: () => false }]) {
    assert.equal(context({ NA_ROLES: roles, NA_PERMISSIONS: PERMISSIONS }).NA_DASHBOARD_TESORERIA.ownerAllowed(), false);
  }
  assert.equal(context({ NA_ROLES: { isOwner: () => true } }).NA_DASHBOARD_TESORERIA.ownerAllowed(), false);
});

test('empty data and failed snapshot disable export and clear a previously rendered report', () => {
  const h = harness(true), a = h.c.NA_DASHBOARD_TESORERIA;
  assert.equal(a.render(), true);
  h.c.NuevoAmanecerCanonical.snapshot = () => { throw new Error('Unavailable replica'); };
  assert.equal(a.render(), false); assert.equal(a.exportCsv(), false);
  assert.equal(h.content.children.length, 0); assert.equal(h.exportButton.disabled, true);
  assert.match(h.status.textContent, /No se pudieron leer/);
  h.c.NuevoAmanecerCanonical.snapshot = () => ({});
  h.c.cashClosures = []; h.c.cajMovs = [];
  assert.equal(a.render(), true); assert.equal(a.exportCsv(), false);
  assert.match(h.content.textContent, /No hay turnos/);
  assert.equal(h.exportButton.disabled, true); assert.equal(h.downloads.length, 0);
});

test('owner-only page and feature share policy; server cash replica currently permits employees, unlike cash-closes', () => {
  assert.deepEqual(Array.from(PERMISSIONS.SCREENS.pageDashboardTesoreria), ['owner']);
  assert.deepEqual(Array.from(PERMISSIONS.FEATURE_ROLES['dashboard-tesoreria']), ['owner']);
  assert.equal(PERMISSIONS.FEATURE_LOCKS['dashboard-tesoreria'], true);
  assert.equal(PERMISSIONS.featureLocked('dashboard-tesoreria'), true);
  for (const role of ['empleado', 'unknown', '', null]) assert.equal(PERMISSIONS.canAccessScreen(role, 'pageDashboardTesoreria'), false);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.deepEqual(Array.from(PERMISSIONS.routeRoles('/features/dashboard-tesoreria', method)), ['owner']);
  for (const path of ['/read/canonical/cash-sessions', '/read/canonical/cash-movements', '/read/canonical/snapshot'])
    assert.deepEqual(Array.from(PERMISSIONS.routeRoles(path, 'GET')), ['owner', 'empleado']);
  assert.deepEqual(Array.from(PERMISSIONS.routeRoles('/auth/cash-closes', 'GET')), ['owner']);
});

test('page wiring/precache without drawer items; locked registry still opens preview; module has no writes/network/storage', async () => {
  const c = vm.createContext({});
  vm.runInContext(read('POS/js/config/pos-permissions.js'), c);
  vm.runInContext(read('POS/js/modules/proximamente-registry.js'), c);
  vm.runInContext(read('POS/js/modules/proximamente.js'), c);
  await c.NA_PROXIMAMENTE.load();
  const feature = c.NA_PROXIMAMENTE.get('dashboard-tesoreria');
  assert.equal(feature.page, 'pageDashboardTesoreria'); assert.equal(feature.pending, true);
  assert.equal(feature.enabled, false); assert.equal(c.NA_PROXIMAMENTE.isUnlocked(feature), false);
  assert.equal(feature.module, 'Caja');
  const html = read('POS/index.html'), sw = read('POS/sw.js'), navigation = read('POS/js/navigation/menu-navigation.js');
  assert.match(html, /id="pageDashboardTesoreria"/);
  for (const asset of ['css/dashboard-tesoreria.css', 'js/modules/dashboard-tesoreria.js']) {
    assert.ok(html.includes(asset)); assert.ok(sw.includes("'./" + asset + "'"));
  }
  const nav = vm.createContext({ document: { readyState: 'loading', addEventListener() {} }, innerWidth: 390 }); nav.window = nav;
  vm.runInContext(navigation, nav);
  assert.ok(nav.NA_MENU_NAVIGATION.pages.includes('pageDashboardTesoreria'));
  for (const permissions of [undefined, PERMISSIONS]) {
    nav.NA_PERMISSIONS = permissions;
    for (const roles of [undefined, { role: 'owner' }, { isOwner: () => false }]) {
      nav.NA_ROLES = roles; assert.equal(nav.NA_MENU_NAVIGATION.canShowDrawerPage('pageDashboardTesoreria'), false);
    }
    nav.NA_ROLES = { isOwner: () => true }; assert.equal(nav.NA_MENU_NAVIGATION.canShowDrawerPage('pageDashboardTesoreria'), true);
  }
  assert.doesNotMatch(navigation.slice(navigation.indexOf('function renderDrawerItems()'), navigation.indexOf('function openMobileDrawer')), /pageDashboardTesoreria/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|\.setItem\s*\(|indexedDB|\.innerHTML\s*=|\b(?:POST|PUT|PATCH|DELETE)\b/);
});
