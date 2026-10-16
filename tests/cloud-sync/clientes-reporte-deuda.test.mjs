import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const source = readFileSync(new URL('../../POS/js/modules/clientes-reporte-deuda.js', import.meta.url), 'utf8');
const v2Source = readFileSync(new URL('../../POS/js/modules/client-credit-accounts-v2.js', import.meta.url), 'utf8');
const legacySource = readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8');
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const clients = freeze([
  { id:101, nombre:'Cliente de prueba A', dni:'', tel:'', dir:'', color:0, totalCompras:0, creditCategories:[] },
  { id:102, nombre:'Cliente de prueba B', dni:'', tel:'', dir:'', color:1, totalCompras:0, creditCategories:[] },
  { id:103, nombre:'Cliente de prueba pagado', dni:'', tel:'', dir:'', color:2, totalCompras:0, creditCategories:[] }
]);
const credit = (id, saldo, extra = {}) => ({ id, credit_id:String(id), cliId:101, clienteId:101,
  clienteNombre:'Cliente de prueba A', clienteDni:'', monto:100, pagado:100 - saldo, saldo,
  fecha:'2024-03-08', hora:'10:00:00', hora24:'10:00:00', timestamp:'2024-03-08T15:00:00Z',
  vence:'2099-12-31', status:'vigente', estado:'vigente', anulado:false, ventaId:null,
  cajero:'Prueba', cajeroNombre:'Prueba', cajeroId:'TEST-CASHIER', pagos:[], items:[], ...extra });
const summaries = freeze({
  101:{ debt:99, overdueDebt:10, active:[credit(1001, 10), credit(1002, 20, { fecha:'2023-01-01' }),
    credit(1003, 0, { fecha:'2000-01-01' })], all:[], closed:[], evaluation:null },
  102:{ debt:1, overdueDebt:20, active:[credit(1004, 1, { fecha:'', timestamp:'2022-12-31T23:00:00-05:00' })],
    all:[], closed:[], evaluation:null },
  103:{ debt:0, overdueDebt:0, active:[], all:[], closed:[], evaluation:null }
});

function harness({ owner = true, canonical, api, withDOM = false } = {}) {
  let permitted = owner;
  const listeners = new Map();
  const nodes = {};
  const timers = [];
  function el(tag) {
    return { tag, children:[], dataset:{}, style:{}, hidden:false, textContent:'', attrs:{},
      classList:{ contains:() => true },
      append(...children) { children.forEach(child => { child.parentNode = this; this.children.push(child); }); },
      insertBefore(child) { this.append(child); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      contains(child) { return this.children.includes(child) || this.children.some(node => node.contains(child)); },
      focus() { document.activeElement = this; },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(name, fn) { this['on' + name] = fn; },
      querySelector(selector) { return this.selectors?.[selector] || null; },
      querySelectorAll() { return this.controls || []; } };
  }
  nodes.pageReporteDeuda = el('div');
  nodes.pageReporteDeuda.selectors = { '[data-rd-content]':el('div'), '[data-rd-status]':el('p'),
    '[data-rd-sort]':el('select'), '[data-rd-back]':el('button') };
  nodes.pageReporteDeuda.controls = [nodes.pageReporteDeuda.selectors['[data-rd-sort]']];
  const bar = el('div');
  const chrome = el('div');
  chrome.append(bar);
  const document = { readyState:'complete', createElement:el,
    getElementById:id => nodes[id] || chrome.children.find(n => n.id === id) || null,
    querySelector:selector => selector === '#pageClientes .filter-bar' ? bar : null };
  const writes = [];
  const forbidden = () => { writes.push('write'); throw new Error('No writes allowed'); };
  const context = {
    clientes:clients, NA_ROLES:{ isOwner:() => permitted }, NuevoAmanecerCanonical:canonical,
    NA_CLIENT_CREDIT_ACCOUNTS_V2:api,
    localStorage:{ setItem:forbidden, removeItem:forbidden }, saveAllData:forbidden, fetch:forbidden,
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    setTimeout(fn) { timers.push(fn); return timers.length; }
  };
  if (withDOM) context.document = document;
  vm.runInNewContext(source, context);
  return { context, report:context.NA_CLIENTES_REPORTE_DEUDA, nodes, writes,
    bar: { get children() { return chrome.children.filter(node => node !== bar); } },
    emit(name) { (listeners.get(name) || []).forEach(fn => fn()); },
    flush() { while (timers.length) timers.shift()(); },
    setOwner(value) { permitted = value; (listeners.get('na:role') || []).forEach(fn => fn()); } };
}
const buildReport = harness().report.buildReport;
const plain = value => JSON.parse(JSON.stringify(value));

test('delegates every balance to the public API, with readOnly=true and the same pending snapshot', () => {
  const pending = freeze({ state:'PENDING', command:'payment.create', payload:{ operation_id:'TEST-PAY',
    credit_id:'1001', amount_cents:1000 } });
  const calls = [];
  const api = { summarizeClient(client, readOnly) { assert.equal(readOnly, true); calls.push(client.id); return summaries[client.id]; },
    debtFilter:{ effectiveBalance(summary, snapshot) { assert.equal(snapshot, pending); return summary.debt; } } };
  const before = JSON.stringify({ clients, summaries, pending });
  const result = plain(buildReport(clients, api, pending));
  assert.deepEqual(calls, [101, 102, 103]);
  assert.deepEqual(result.rows.map(r => r.clientId), [101, 102]);
  assert.equal(result.rows[0].balance, 99, 'must not sum the individual credits (30)');
  assert.equal(result.rows[0].overdueDebt, 10);
  assert.equal(result.rows[0].oldestDate, '2023-01-01');
  assert.equal(result.rows[0].openCredits, 2);
  assert.equal(result.rows[1].oldestDate, '2022-12-31');
  assert.equal(result.total, 100);
  assert.equal(result.count, 2);
  assert.equal(JSON.stringify({ clients, summaries, pending }), before);
});

test('sort by overdue debt desc; ties remain stable and inputs are never reordered', () => {
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt } };
  // 102 tiene overdueDebt 20 pero saldo 1: su deuda vencida queda limitada a 1.
  assert.deepEqual(Array.from(buildReport(clients, api, null, 'vencida').rows, r => r.clientId), [101, 102]);
  const same = { summarizeClient:() => ({ debt:10, overdueDebt:0, active:[] }), debtFilter:{ effectiveBalance:s => s.debt } };
  assert.deepEqual(Array.from(buildReport(clients, same, null).rows, r => r.clientId), [101, 102, 103]);
  assert.deepEqual(clients.map(c => c.id), [101, 102, 103]);
});

test('effective balance controls zero exclusion, one-cent debts and footer totals in cents', () => {
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt === 99 ? 0 : s.debt ? 0.01 : 0 } };
  assert.deepEqual(plain(buildReport(clients, api, null)), { rows:[{ clientId:102, name:clients[1].nombre,
    balance:0.01, overdueDebt:0.01, oldestDate:'2022-12-31', openCredits:1 }], total:0.01, count:1 });
  const decimals = { summarizeClient:c => ({ debt:c.id === 101 ? 0.1 : 0.2, overdueDebt:0, active:[] }),
    debtFilter:{ effectiveBalance:s => s.debt } };
  assert.equal(buildReport(clients.slice(0, 2), decimals, null).total, 0.3);
});

test('missing dates show no invented date; fecha wins over timestamp and vence is never used', () => {
  const api = { summarizeClient:() => ({ debt:10, overdueDebt:0, active:[credit(1, 10,
    { fecha:'2024-04-01', timestamp:'2020-01-01T10:00:00Z', vence:'1999-01-01' })] }),
    debtFilter:{ effectiveBalance:s => s.debt } };
  assert.equal(buildReport([clients[0]], api, null).rows[0].oldestDate, '2024-04-01');
  api.summarizeClient = () => ({ debt:10, overdueDebt:0,
    active:[credit(1, 10, { fecha:'invalid', timestamp:'', vence:'1999-01-01' })] });
  assert.equal(buildReport([clients[0]], api, null).rows[0].oldestDate, '');
  assert.equal(buildReport([clients[0]], api, null).rows[0].openCredits, 1);
});

test('empty clients produce a zero footer; unavailable or invalid summaries never produce partial totals', () => {
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt } };
  assert.deepEqual(plain(buildReport(null, api, null)), { rows:[], total:0, count:0 });
  assert.throws(() => buildReport(clients, null, null), /no disponible/);
  api.summarizeClient = () => { throw new Error('unavailable'); };
  assert.throws(() => buildReport(clients, api, null), /unavailable/);
  api.summarizeClient = c => summaries[c.id];
  for (const value of [NaN, Infinity, -1, null, undefined, '', '10', Number.MAX_SAFE_INTEGER]) {
    api.debtFilter.effectiveBalance = () => value;
    assert.throws(() => buildReport(clients, api, null), /no disponible/);
  }
});

test('render reads one pending snapshot per projection; a failed read clears totals and never reads debt', () => {
  const snapshots = [];
  let snapshotCalls = 0;
  const api = { summarizeClient:c => summaries[c.id],
    debtFilter:{ effectiveBalance(s, pending) { snapshots.push(pending); return s.debt; } } };
  const pending = freeze({ command:'payment.create', state:'PENDING', payload:{ operation_id:'TEST-READ', credit_id:'1001', amount_cents:100 } });
  const h = harness({ withDOM:true, api, canonical:{ pendingSnapshot() { snapshotCalls++; return pending; } } });
  assert.equal(h.report.render(), true);
  assert.equal(snapshotCalls, 2, 'initialization and explicit refresh each read once');
  assert.equal(snapshots.length, 6);
  assert.ok(snapshots.every(s => s === pending));
  const content = h.nodes.pageReporteDeuda.selectors['[data-rd-content]'];
  assert.equal(content.children[0].children.length, 2);
  assert.equal(h.bar.children.length, 1, 'one native entry button');
  assert.equal(h.bar.children[0].hidden, false);
  assert.equal(h.report.init(), undefined);
  assert.equal(h.bar.children.length, 1, 'initialization is idempotent');
  h.context.NuevoAmanecerCanonical.pendingSnapshot = () => { throw new Error('offline'); };
  assert.equal(h.report.render(), false);
  assert.equal(content.children.length, 0);
  assert.equal(snapshots.length, 6, 'unavailable pending snapshot must stop before reading debt');
  assert.match(h.nodes.pageReporteDeuda.selectors['[data-rd-status]'].textContent, /No se pudo cargar/);
  assert.deepEqual(h.writes, [], 'caught write attempts must also fail the test');
});

test('employee, unknown and throwing roles fail closed without reading debt; role loss clears rendered data', () => {
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt } };
  const h = harness({ withDOM:true, api });
  h.setOwner(false);
  assert.equal(h.bar.children[0].hidden, true, 'hide the owner entry immediately on role loss');
  const content = h.nodes.pageReporteDeuda.selectors['[data-rd-content]'];
  assert.equal(content.children.length, 0);
  assert.match(h.nodes.pageReporteDeuda.selectors['[data-rd-status]'].textContent, /Sin permiso/);
  assert.equal(h.report.open(), false);
  assert.equal(h.report.openClient(101), false);
  for (const role of [undefined, { isOwner:() => false }, { isOwner() { throw new Error('unconfirmed'); } }]) {
    h.context.NA_ROLES = role;
    h.context.NA_CLIENT_CREDIT_ACCOUNTS_V2 = { summarizeClient() { assert.fail('employee must not read balances'); } };
    assert.equal(h.report.render(), false);
  }
  const employee = harness({ withDOM:true, owner:false, api });
  assert.equal(employee.bar.children.length, 0);
});

test('a row uses the existing public client entry after pageClientes, and never bypasses refused navigation', () => {
  const h = harness();
  const calls = [];
  h.context.NA_MENU_NAVIGATION = { navigate(id) { calls.push(id); return true; } };
  h.context.naCanonOpenClientAccount = id => calls.push(id);
  assert.equal(h.report.openClient(101), true);
  assert.deepEqual(calls, ['pageClientes', 101]);
  h.context.NA_MENU_NAVIGATION.navigate = () => false;
  assert.equal(h.report.openClient(102), false);
  assert.deepEqual(calls, ['pageClientes', 101]);
  delete h.context.NA_MENU_NAVIGATION;
  h.context.goPage = id => { calls.push(id); };
  assert.equal(h.report.openClient(102), true);
  assert.deepEqual(calls.slice(2), ['pageClientes', 102]);
});

test('native rows use text nodes for client names and clear totals if the API becomes unavailable', () => {
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt } };
  const h = harness({ withDOM:true, api });
  const content = h.nodes.pageReporteDeuda.selectors['[data-rd-content]'];
  const row = content.children[0].children[0].children[0];
  assert.equal(row.tag, 'button');
  assert.equal(row.type, 'button');
  assert.match(row.attrs['aria-label'], /Abrir ficha/);
  h.context.clientes = freeze([{ ...clients[0], nombre:'<img src=x onerror=alert(1)>' }]);
  h.report.render();
  const renderedName = content.children[0].children[0].children[0].children[0].children[1];
  assert.equal(renderedName.tag, 'strong');
  assert.equal(renderedName.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(renderedName.children.length, 0);
  h.context.NA_CLIENT_CREDIT_ACCOUNTS_V2 = null;
  assert.equal(h.report.render(), false);
  assert.equal(content.children.length, 0);
  assert.match(h.nodes.pageReporteDeuda.selectors['[data-rd-status]'].textContent, /No se pudo cargar/);
});

test('open credits use monto − pagado, never a stale saldo field', () => {
  const api = { summarizeClient: () => ({ debt: 50, overdueDebt: 0, all: [], closed: [], evaluation: null,
      active: [{ id: 1, monto: 100, pagado: 50, saldo: 0, fecha: '2024-02-01' }, { id: 2, monto: 30, pagado: 30, saldo: 30, fecha: '2020-01-01' }] }),
    debtFilter: { effectiveBalance: summary => summary.debt } };
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.runInNewContext(source, ctx);
  const report = ctx.NA_CLIENTES_REPORTE_DEUDA.buildReport([{ id: 7, nombre: 'Cliente sintético' }], api, null, 'saldo');
  assert.equal(report.rows[0].openCredits, 1);
  assert.equal(report.rows[0].oldestDate, '2024-02-01');
});

function realV2() {
  const events = new Map();
  const ctx = { clientes:[], creditos:[], document:{ getElementById:() => null, querySelector:() => null },
    addEventListener(name, fn) { const list = events.get(name) || []; list.push(fn); events.set(name, list); },
    setTimeout:() => 1, clearTimeout() {},
    obtenerHoy:() => '2026-10-15', diasHasta:day => day === '2000-01-01' ? -1 : 1,
    _naNumber:value => Number.isFinite(Number(value)) ? Number(value) : 0 };
  ctx.window = ctx;
  vm.createContext(ctx);
  // Usa las funciones legacy reales, incluido el índice que normaliza in situ.
  const status = legacySource.slice(legacySource.indexOf('const _naSyncCreditStatus='), legacySource.indexOf('// NUEVO FASE 6'));
  const outstanding = legacySource.match(/function _naCreditOutstanding\(cr\)\{[^\n]+/)[0];
  const index = legacySource.slice(legacySource.indexOf('let _naClientCreditIndexRef='), legacySource.indexOf('statusCli=function'));
  vm.runInContext(status + '\n' + outstanding + '\n' + index, ctx);
  vm.runInContext(v2Source, ctx);
  return { ctx, api:ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2,
    emit(type, detail) { (events.get(type) || []).forEach(fn => fn({ type, detail })); },
    warm() { vm.runInContext('_naEnsureClientCreditIndex(true)', ctx); } };
}

test('real V2: pending batch/replays/receipts do not double deduct or mutate a warm replica', () => {
  const h = realV2();
  h.ctx.clientes = plain(clients);
  h.ctx.creditos = [credit(1001, 80), credit(1002, 20), credit(1003, 0),
    credit(1004, 50, { cliId:102, vence:'2000-01-01' })];
  h.warm();
  freeze(h.ctx.clientes); freeze(h.ctx.creditos);
  h.ctx._naEvaluateClientCredit = () => assert.fail('read-only summary must never evaluate client credit');
  const pay = { operation_id:'TEST-REAL-PAY', credit_id:'1001', amount_cents:3000 };
  const pending = freeze({ state:'PENDING', command:'payment.batch', payload:{ payments:[pay, pay,
    { operation_id:'TEST-CLOSED', credit_id:'1003', amount_cents:99900 },
    { operation_id:'TEST-UNRELATED', credit_id:'OTHER', amount_cents:99900 }] } });
  const before = JSON.stringify({ clients:h.ctx.clientes, credits:h.ctx.creditos, pending });
  let report = buildReport(h.ctx.clientes, h.api, pending);
  assert.equal(report.total, 120);
  assert.equal(report.rows[0].balance, 70);
  assert.equal(report.rows[0].openCredits, 2);
  assert.equal(report.rows[1].overdueDebt, 50);
  h.emit('na:canonical-payment-receipt', { version:1, command:'payment.create', payload:pay,
    receipt:{ operation_id:pay.operation_id, credit_id:pay.credit_id, status:'created', current_balance_cents:5000 } });
  report = buildReport(h.ctx.clientes, h.api, pending);
  assert.equal(report.total, 120, 'durable receipt and its still-pending intent count once');
  assert.equal(JSON.stringify({ clients:h.ctx.clientes, credits:h.ctx.creditos, pending }), before);
});

test('P1 fixed: real V2 readOnly no longer normalizes originals or rebuilds a cold shared index', () => {
  const h = realV2();
  h.ctx.clientes = plain(clients);
  h.ctx.creditos = [credit(1001, 10, { monto:'100', pagado:'90', status:'desfasado' })];
  const before = JSON.stringify(h.ctx.creditos);
  const report = buildReport(h.ctx.clientes, h.api, null);
  assert.equal(JSON.stringify(h.ctx.creditos), before);
  assert.equal(h.ctx.creditos[0].monto, '100');
  assert.equal(h.ctx.creditos[0].status, 'desfasado');
  assert.equal(vm.runInContext('_naClientCreditIndexRef', h.ctx), null, 'cold index stays cold');
  assert.equal(report.rows[0].balance, 10);
  assert.equal(report.rows[0].openCredits, 1);
});

test('forensic characterization P1: opening the actual account evaluates policy and normalizes live credits', t => {
  const h = realV2();
  h.ctx.clientes = plain(clients);
  h.ctx.creditos = [credit(1001, 10)];
  h.warm();
  h.ctx.creditos[0].pagado = '90';
  h.ctx.appConfig = { creditPolicy:{} };
  h.ctx.ventas = []; h.ctx.productos = [];
  h.ctx._naRoundMoney = value => Number((Number(value) || 0).toFixed(2));
  h.ctx._naInt = (value, fallback) => Number.parseInt(value, 10) || fallback;
  h.ctx._naDocumentValue = value => String(value || '');
  h.ctx.NA_DOC = { displayDoc:() => '' };
  const evaluation = readFileSync(new URL('../../POS/js/legacy-inline/inline-04.js', import.meta.url), 'utf8');
  vm.runInContext(evaluation.slice(0, evaluation.indexOf('calcularScoreCredito=function')), h.ctx);
  const before = JSON.stringify({ credits:h.ctx.creditos, config:h.ctx.appConfig });
  const navigation = harness();
  navigation.context.NA_MENU_NAVIGATION = { navigate:() => true };
  navigation.context.naCanonOpenClientAccount = h.ctx.naCanonOpenClientAccount;
  assert.equal(navigation.report.openClient(101), true);
  assert.notEqual(JSON.stringify({ credits:h.ctx.creditos, config:h.ctx.appConfig }), before);
  assert.equal(typeof h.ctx.creditos[0].pagado, 'number');
  assert.equal(h.ctx.appConfig.creditPolicy.enabled, true);
  t.diagnostic('P1 pendiente: la ficha pública usa resumen mutable y evaluación legacy; el reporte no puede hacer pura esa ruta.');
});

test('real V2 with 1000 clients and 10000 credits summarizes each client exactly once', t => {
  const h = realV2();
  h.ctx.clientes = Array.from({ length:1000 }, (_, i) => ({ id:i, nombre:'Cliente sintético ' + i }));
  h.ctx.creditos = Array.from({ length:10000 }, (_, i) => credit(i, 10, { cliId:i % 1000 }));
  h.warm();
  freeze(h.ctx.creditos); freeze(h.ctx.clientes);
  let calls = 0;
  const api = { ...h.api, summarizeClient(c, readOnly) { calls++; return h.api.summarizeClient(c, readOnly); } };
  const start = performance.now();
  const result = buildReport(h.ctx.clientes, api, null);
  t.diagnostic('Proyección V2 con índice preparado: ' + (performance.now() - start).toFixed(1) + ' ms (sin navegador).');
  assert.equal(calls, 1000);
  assert.equal(result.count, 1000);
  assert.equal(result.total, 100000);
  assert.ok(result.rows.every(row => row.openCredits === 10));
});

test('unchanged focus refresh preserves row identity; changed or removed rows retain keyboard focus', () => {
  let balance = 99;
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt === 99 ? balance : s.debt } };
  const h = harness({ withDOM:true, api });
  const content = h.nodes.pageReporteDeuda.selectors['[data-rd-content]'];
  const row = content.children[0].children[0].children[0];
  row.focus();
  h.emit('focus'); h.emit('storage'); h.flush();
  assert.equal(content.children[0].children[0].children[0], row);
  assert.equal(h.context.document.activeElement, row);
  balance = 98;
  h.emit('na:canonical-updated'); h.flush();
  const replacement = content.children[0].children[0].children[0];
  assert.notEqual(replacement, row);
  assert.equal(h.context.document.activeElement, replacement);
  balance = 0;
  h.report.render();
  assert.equal(h.context.document.activeElement, h.nodes.pageReporteDeuda.selectors['[data-rd-sort]']);
  assert.deepEqual(h.writes, []);
});

test('entry has its own row outside the fixed mobile search bar and opening moves keyboard focus', () => {
  const h = harness({ withDOM:true, api:{ summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt } } });
  const entry = h.bar.children[0];
  assert.equal(entry.parentNode.children[0].children.length, 0, 'search bar has no appended report control');
  h.context.NA_MENU_NAVIGATION = { navigate:() => true };
  assert.equal(h.report.open(), true);
  assert.equal(h.context.document.activeElement, h.nodes.pageReporteDeuda.selectors['[data-rd-back]']);
});

test('dates reject impossible days and fallback timestamps use Lima even across midnight', () => {
  const api = { summarizeClient:() => ({ debt:10, overdueDebt:0,
    active:[credit(1, 10, { fecha:'2024-02-30', timestamp:'2024-03-01T02:00:00Z' })] }),
    debtFilter:{ effectiveBalance:s => s.debt } };
  assert.equal(buildReport([clients[0]], api, null).rows[0].oldestDate, '2024-02-29');
  api.summarizeClient = () => ({ debt:10, overdueDebt:0,
    active:[credit(1, 10, { fecha:'', timestamp:'2024-03-01T02:00:00' })] });
  assert.equal(buildReport([clients[0]], api, null).rows[0].oldestDate, '2024-03-01');
});

test('invalid source debt cannot silently become an empty report in the real balance filter', () => {
  const h = realV2();
  for (const debt of [NaN, Infinity, null, undefined, '']) {
    const api = { ...h.api, summarizeClient:() => ({ debt, overdueDebt:0, active:[] }) };
    assert.throws(() => buildReport(clients, api, null), /no disponible/);
  }
});

test('shared browser/server screen policy grants the report only to owner; unlisted API remains default-deny', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(new URL('../../POS/js/config/pos-permissions.js', import.meta.url), 'utf8'), ctx);
  for (const policy of [ctx.NA_PERMISSIONS, PERMISSIONS]) {
    for (const role of ['owner', 'empleado', 'unknown', undefined]) {
      assert.equal(policy.canAccessScreen(role, 'pageReporteDeuda'), role === 'owner');
    }
    assert.deepEqual(Array.from(policy.routeRoles('/read/canonical/reporte-deuda', 'GET')), ['owner']);
  }
});

test('overdue debt is capped at the effective balance, in the row and in the overdue sort', () => {
  const data = { 1:{ debt:100, overdueDebt:90, active:[] }, 2:{ debt:60, overdueDebt:60, active:[] }, 3:{ debt:5, overdueDebt:0, active:[] } };
  const api = { summarizeClient:c => data[c.id],
    // Pago en cola de 50 sobre el cliente 1: saldo efectivo 50, por debajo de su vencido (90).
    debtFilter:{ effectiveBalance:s => s === data[1] ? 50 : s.debt } };
  const list = [{ id:1, nombre:'Sintético 1' }, { id:2, nombre:'Sintético 2' }, { id:3, nombre:'Sintético 3' }];
  const report = plain(buildReport(list, api, null, 'vencida'));
  assert.deepEqual(report.rows.map(r => [r.clientId, r.balance, r.overdueDebt]), [[2, 60, 60], [1, 50, 50], [3, 5, 0]]);
  for (const row of report.rows) assert.ok(row.overdueDebt <= row.balance);
});

test('open-credit criterion: Clientes counts every non-annulled credit, the report only those with balance > 0.001', () => {
  const h = realV2();
  h.ctx.clientes = [{ id:201, nombre:'Cliente sintético', dni:'', creditCategories:[] }];
  const mine = extra => ({ cliId:201, clienteId:201, clienteNombre:'Cliente sintético', ...extra });
  // Dos abiertos, uno pagado (saldo 0) y uno con saldo residual de 0,001; uno anulado no cuenta en ninguno.
  h.ctx.creditos = [credit(2001, 40, mine({})), credit(2002, 10, mine({})), credit(2003, 0, mine({})),
    credit(2004, 0, mine({ monto:100, pagado:99.999 })), credit(2005, 30, mine({ anulado:true, status:'anulado', estado:'anulado' }))];
  h.warm();
  const summary = h.api.summarizeClient(h.ctx.clientes[0], true);
  assert.equal(summary.all.length, 4, 'la tarjeta de Clientes muestra «4 créditos» (no anulados, incluidos pagados)');
  const report = buildReport(h.ctx.clientes, h.api, null);
  assert.equal(report.rows[0].openCredits, 2);
  assert.equal(report.rows[0].balance, 50);
});

test('the report explains the open-credit criterion in a tooltip and a note', () => {
  assert.match(source, /OPEN_CREDITS_NOTE = 'Créditos abiertos cuenta solo los créditos con saldo pendiente\. /);
  assert.match(source, /metric\(row, 'Créditos abiertos', data\.openCredits, '', OPEN_CREDITS_NOTE\)/);
  assert.match(source, /element\('p', 'rd-note', OPEN_CREDITS_NOTE\)/);
});
