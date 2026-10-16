import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('POS/js/modules/reporte-arqueo.js', 'utf8');
function load(extra = {}) {
  const ctx = vm.createContext({ module: { exports: {} }, ...extra });
  vm.runInContext(source, ctx);
  return ctx.NA_REPORTE_ARQUEO;
}
const range = { desde: '2026-10-01', hasta: '2026-10-16' };
const closed = (id, at, extra = {}) => ({ session_id: id, status: 'CLOSED', opened_at: '2026-09-30T15:00:00Z',
  closed_at: at, expected_cents: 1250, counted_cents: 1200, difference_cents: -50,
  opened_by_name: 'Abrió prueba', closed_by_name: 'Cerró prueba', ...extra });
const sessions = [
  closed('first', '2026-10-01T05:00:00Z'),
  closed('late', '2026-10-17T04:30:00Z', { counted_cents: 1300, difference_cents: 50 }),
  closed('null', '2026-10-10T20:00:00Z', { expected_cents: 250, counted_cents: null, difference_cents: null, opened_by_name: null, closed_by_name: '' }),
  closed('open', '2026-10-16T18:00:00Z', { status: 'OPEN', expected_cents: 999999 }),
  closed('before', '2026-10-01T04:59:59Z'),
  closed('after', '2026-10-17T05:00:00Z'),
];

test('inclusive Lima close dates, including 23:30 at next-day UTC; OPEN excluded; newest first', () => {
  const report = load().buildReport(sessions, range);
  assert.deepEqual(Array.from(report.rows, row => row.sessionId), ['late', 'null', 'first']);
  assert.equal(report.rows[0].fecha, '2026-10-16');
  assert.equal(report.rows[0].fechaLabel, '16/10/2026');
  assert.equal(report.rows[0].hora, '23:30');
  assert.equal(report.rows.at(-1).hora, '00:00');
  assert.equal(load().buildReport(sessions, { desde: '2026-10-16', hasta: '2026-10-16' }).rows.length, 1);
});
test('totals remain in cents, null counts stay null, missing names use No registrado; snapshot or array accepted', () => {
  const api = load(), report = api.buildReport({ cashSessions: sessions }, range);
  assert.equal(JSON.stringify(report), JSON.stringify(api.buildReport(sessions, range)));
  assert.deepEqual({ ...report.totals }, { count: 3, esperado: 2750, contado: 2500, diferencia: 0 });
  assert.equal(report.rows[1].contado, null); assert.equal(report.rows[1].diferencia, null);
  assert.equal(report.rows[1].openedByName, 'No registrado'); assert.equal(report.rows[1].closedByName, 'No registrado');
  assert.equal(api.buildReport(undefined, range).totals.count, 0);
});
test('fallback uses Lima opening date only when the close timestamp is missing or invalid', () => {
  const report = load().buildReport([
    closed('fallback', null, { opened_at: '2026-10-17T04:30:00Z' }),
    closed('invalid-close', 'invalid', { opened_at: '2026-10-16T18:00:00Z' }),
    closed('wrong-opening', '2026-10-17T05:00:00Z', { opened_at: '2026-10-16T15:00:00Z' }),
    closed('invalid-dates', '2026-02-30T12:00:00Z', { opened_at: 'invalid' }),
    null, {},
  ], range);
  assert.deepEqual(Array.from(report.rows, row => row.sessionId), ['fallback', 'invalid-close']);
  assert.equal(report.rows[0].fecha, '2026-10-16'); assert.equal(report.rows[0].hora, '');
});
test('default range is 30 inclusive days ending today in Lima, independently of UTC day', () => {
  class FixedDate extends Date { static now() { return Date.parse('2026-10-17T02:00:00Z'); } }
  const report = load({ Date: FixedDate }).buildReport([]);
  assert.deepEqual({ ...report.range }, { desde: '2026-09-17', hasta: '2026-10-16' });
});
test('invalid or reversed ranges fail with Spanish validation instead of exporting data', () => {
  const api = load();
  assert.throws(() => api.buildReport(sessions, { desde: '2026-10-17', hasta: '2026-10-16' }), /Desde no puede ser posterior a Hasta/);
  for (const day of ['2026-02-30', 'invalid', '', '16/10/2026']) {
    assert.throws(() => api.buildReport(sessions, { ...range, desde: day }), /fechas válidas/);
  }
});
test('pure projection matches canonical cash history cents and Lima labels without changing its input', () => {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync('POS/js/sync/canonical-cash-history.js', 'utf8'), ctx);
  const immutable = Object.freeze(sessions.map(row => Object.freeze({ ...row })));
  const snapshot = Object.freeze({ cashSessions: immutable });
  const before = JSON.stringify(snapshot), api = load({
    fetch() { throw new Error('network'); },
    localStorage: { getItem() { throw new Error('storage read'); }, setItem() { throw new Error('storage write'); } },
  });
  const report = api.buildReport(snapshot, range);
  const canonical = ctx.NuevoAmanecerCashHistory.summarize(snapshot, {});
  for (const row of report.rows) {
    const expected = canonical.find(item => item.sessionId === row.sessionId);
    assert.equal(row.fecha, expected.cierreFecha); assert.equal(row.hora, expected.cierre);
    for (const key of ['esperado', 'contado', 'diferencia']) assert.equal(row[key], expected[key]);
  }
  api.toCsv(report); assert.equal(JSON.stringify(snapshot), before);
});
test('CSV header, BOM, CRLF, fixed numeric decimals, missing amounts and Total line', () => {
  const api = load(), csv = api.toCsv(api.buildReport(sessions, range));
  assert.ok(csv.startsWith('\uFEFFFecha cierre,Hora cierre,Abrió,Cerró,Esperado,Contado,Diferencia\r\n'));
  assert.ok(csv.includes('16/10/2026,23:30,Abrió prueba,Cerró prueba,12.50,13.00,0.50\r\n'));
  assert.ok(csv.includes('10/10/2026,15:00,No registrado,No registrado,2.50,,\r\n'));
  assert.ok(csv.includes('01/10/2026,00:00,Abrió prueba,Cerró prueba,12.50,12.00,-0.50\r\n'));
  assert.ok(csv.endsWith('Total,3,,,27.50,25.00,0.00\r\n'));
  assert.doesNotMatch(csv, /(?<!\r)\n/);
  assert.ok(api.toCsv(api.buildReport([], range)).endsWith('Total,0,,,0.00,0.00,0.00\r\n'));
});
test('CSV guards original text including leading spaces, tab and CR, quotes cells, leaves negative numbers unprefixed', () => {
  const api = load();
  const guarded = [' =1+1', '  @SUM(A1)', '\tabc', '\rabc', '+formula', '-formula', ' =HYPERLINK(1)'];
  const data = guarded.map((name, index) => closed('guard-' + index, '2026-10-16T18:00:00Z', { opened_by_name: name, closed_by_name: 'Texto, "con comillas"\nsegunda línea' }));
  const report = api.buildReport(data, range), csv = api.toCsv(report);
  for (const name of guarded) {
    assert.ok(report.rows.some(row => row.openedByName === name), 'do not trim the original name');
    const protectedText = "'" + name;
    assert.ok(csv.includes(name === '\rabc' ? '"' + protectedText + '"' : protectedText), JSON.stringify(csv));
  }
  assert.ok(csv.includes('"Texto, ""con comillas""\nsegunda línea"'));
  assert.equal(csv.match(/,12\.50,12\.00,-0\.50\r\n/g).length, guarded.length);
  assert.ok(csv.endsWith('Total,7,,,87.50,84.00,-3.50\r\n'));
  assert.doesNotMatch(csv, /'-(?:0\.50|3\.50)/);
});

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attrs = {}; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, callback) { this.events[type] = callback; }
}
function harness() {
  const content = new Node(), status = new Node(), controls = new Node(), desde = new Node(), hasta = new Node(), button = new Node('button');
  const nodes = { '[data-ra-content]': content, '[data-ra-status]': status, '[data-ra-controls]': controls,
    '[data-ra-desde]': desde, '[data-ra-hasta]': hasta, '[data-ra-export]': button };
  const page = new Node(); page.querySelector = selector => nodes[selector]; page.classList = { contains: () => false };
  let owner = true, screenAllowed = true, reads = 0, initialize;
  const events = {}, downloads = [], blobs = [];
  const ctx = vm.createContext({ module: { exports: {} },
    document: { readyState: 'loading', addEventListener(type, callback) { initialize = callback; }, getElementById: () => page,
      createElement(tag) { const node = new Node(tag); node.click = () => downloads.push(node.download); return node; } },
    addEventListener(type, callback) { events[type] = callback; }, setTimeout(callback) { callback(); },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} }, Blob: class { constructor(parts) { blobs.push(parts.join('')); } },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: { canAccessScreen: () => screenAllowed },
    NuevoAmanecerCanonical: { enabled: () => true, snapshot() { reads++; return { cashSessions: [closed('x', '2026-10-16T18:00:00Z', { opened_by_name: '<img onerror=unsafe>' })] }; }, refresh() { throw new Error('refresh'); } },
    fetch() { throw new Error('network'); }, localStorage: { setItem() { throw new Error('storage write'); } },
  });
  vm.runInContext(source, ctx);
  return { ctx, api: ctx.NA_REPORTE_ARQUEO, content, status, controls, desde, hasta, button, events, downloads, blobs,
    initialize: () => initialize(), owner: value => { owner = value; }, screenAllowed: value => { screenAllowed = value; }, reads: () => reads };
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
test('shared client/Worker policy unlocks arqueo only for owner and rejects unknown identities', () => {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync('POS/js/config/pos-permissions.js', 'utf8'), ctx);
  const permissions = ctx.NA_PERMISSIONS;
  assert.deepEqual(Array.from(permissions.SCREENS.pageReporteArqueo), ['owner']);
  assert.deepEqual(Array.from(permissions.FEATURE_ROLES['reporte-arqueo']), ['owner']);
  assert.equal(permissions.FEATURE_LOCKS['reporte-arqueo'], false);
  assert.equal(permissions.canAccessScreen('owner', 'pageReporteArqueo'), true);
  for (const role of ['empleado', 'unknown', '', null]) assert.equal(permissions.canAccessScreen(role, 'pageReporteArqueo'), false);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.deepEqual(Array.from(permissions.routeRoles('/features/reporte-arqueo', method)), ['owner']);
  }
});
test('owner render uses safe text and tfoot; employee clears populated data before reading the replica', () => {
  const h = harness(); h.desde.value = range.desde; h.hasta.value = range.hasta;
  assert.equal(h.ctx.module.exports, h.api); assert.ok(Object.isFrozen(h.api));
  assert.equal(h.api.render(), true); assert.ok(h.content.textContent.includes('<img onerror=unsafe>'));
  assert.ok(h.content.textContent.includes('-S/ 0.50 (faltante)'));
  const foot = descendants(h.content).find(node => node.tagName === 'tfoot');
  assert.equal(foot.textContent, 'Total · 1 cierreS/ 12.50S/ 12.00-S/ 0.50 (faltante)');
  assert.equal(h.controls.hidden, false);
  const reads = h.reads(); h.owner(false);
  Object.defineProperty(h.ctx, 'NuevoAmanecerCanonical', { get() { throw new Error('unauthorized read'); } });
  assert.equal(h.api.render(), false); assert.equal(h.reads(), reads); assert.equal(h.content.children.length, 0);
  assert.equal(h.status.textContent, 'Sin permiso. Pídele acceso al dueño.'); assert.equal(h.controls.hidden, true);
});
test('owner gate also fails closed for missing roles or denied screen permissions', () => {
  for (const missing of ['NA_ROLES', 'NA_PERMISSIONS']) {
    const h = harness(); delete h.ctx[missing];
    assert.equal(h.api.render(), false); assert.equal(h.reads(), 0); assert.equal(h.content.children.length, 0);
  }
  const h = harness(); h.screenAllowed(false);
  assert.equal(h.api.render(), false); assert.equal(h.reads(), 0);
});
test('render keeps null amounts as a dash, shows surplus sign and totals even for an empty range', () => {
  const h = harness(); h.desde.value = range.desde; h.hasta.value = range.hasta;
  h.ctx.NuevoAmanecerCanonical.snapshot = () => ({ cashSessions: sessions });
  assert.equal(h.api.render(), true);
  assert.ok(h.content.textContent.includes('+S/ 0.50 (sobrante)'));
  const body = descendants(h.content).find(node => node.tagName === 'tbody');
  assert.equal(body.children[1].children[4].textContent, '—');
  h.desde.value = '2026-10-18'; h.hasta.value = '2026-10-18';
  assert.equal(h.api.render(), true); assert.ok(h.content.textContent.includes('No hay cierres'));
  assert.ok(descendants(h.content).find(node => node.tagName === 'tfoot').textContent.includes('Total · 0 cierres'));
});
test('invalid range clears previous rows, disables export and does not read the replica; can recover', () => {
  const h = harness(); h.desde.value = range.desde; h.hasta.value = range.hasta; h.api.render();
  const reads = h.reads(); h.desde.value = '2026-10-17';
  assert.equal(h.api.render(), false); assert.equal(h.content.children.length, 0);
  assert.match(h.status.textContent, /Desde no puede ser posterior a Hasta/);
  assert.equal(h.button.disabled, true); assert.equal(h.reads(), reads);
  h.desde.value = ''; assert.equal(h.api.render(), false); assert.match(h.status.textContent, /fechas válidas/);
  h.desde.value = range.desde; assert.equal(h.api.render(), true); assert.equal(h.button.disabled, false);
});
test('CSV download uses range filename; revoked owner clears content and cannot download', () => {
  const h = harness(); h.initialize(); h.desde.value = range.desde; h.hasta.value = range.hasta;
  h.api.render(); h.button.events.click();
  assert.deepEqual(h.downloads, ['arqueo-caja-2026-10-01-a-2026-10-16.csv']);
  assert.ok(h.blobs[0].startsWith('\uFEFFFecha cierre'));
  h.owner(false); h.events['na:role']();
  assert.equal(h.content.children.length, 0); assert.equal(h.controls.hidden, true);
  h.button.events.click(); assert.equal(h.downloads.length, 1);
});
