import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../POS/js/modules/clientes-reporte-deuda.js', import.meta.url), 'utf8');
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
  function el(tag) {
    return { tag, children:[], dataset:{}, style:{}, hidden:false, textContent:'', attrs:{},
      classList:{ contains:() => true },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
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
  const document = { readyState:'complete', createElement:el,
    getElementById:id => nodes[id] || bar.children.find(n => n.id === id) || null,
    querySelector:selector => selector === '#pageClientes .filter-bar' ? bar : null };
  const forbidden = () => { throw new Error('No writes allowed'); };
  const context = {
    clientes:clients, NA_ROLES:{ isOwner:() => permitted }, NuevoAmanecerCanonical:canonical,
    NA_CLIENT_CREDIT_ACCOUNTS_V2:api,
    localStorage:{ setItem:forbidden, removeItem:forbidden }, saveAllData:forbidden, fetch:forbidden,
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    setTimeout() { return 1; }
  };
  if (withDOM) context.document = document;
  vm.runInNewContext(source, context);
  return { context, report:context.NA_CLIENTES_REPORTE_DEUDA, nodes, bar,
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
  assert.deepEqual(Array.from(buildReport(clients, api, null, 'vencida').rows, r => r.clientId), [102, 101]);
  const same = { summarizeClient:() => ({ debt:10, overdueDebt:0, active:[] }), debtFilter:{ effectiveBalance:s => s.debt } };
  assert.deepEqual(Array.from(buildReport(clients, same, null).rows, r => r.clientId), [101, 102, 103]);
  assert.deepEqual(clients.map(c => c.id), [101, 102, 103]);
});

test('effective balance controls zero exclusion, one-cent debts and footer totals in cents', () => {
  const api = { summarizeClient:c => summaries[c.id], debtFilter:{ effectiveBalance:s => s.debt === 99 ? 0 : s.debt ? 0.01 : 0 } };
  assert.deepEqual(plain(buildReport(clients, api, null)), { rows:[{ clientId:102, name:clients[1].nombre,
    balance:0.01, overdueDebt:20, oldestDate:'2022-12-31', openCredits:1 }], total:0.01, count:1 });
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
  for (const value of [NaN, Infinity, -1]) {
    api.debtFilter.effectiveBalance = () => value;
    assert.throws(() => buildReport(clients, api, null), /no disponible/);
  }
});

test('render falls back to a null pending snapshot when canonical throws; it never calls persistence', () => {
  const snapshots = [];
  const api = { summarizeClient:c => summaries[c.id],
    debtFilter:{ effectiveBalance(s, pending) { snapshots.push(pending); return s.debt; } } };
  const h = harness({ withDOM:true, api, canonical:{ pendingSnapshot() { throw new Error('offline'); } } });
  assert.equal(h.report.render(), true);
  assert.ok(snapshots.length >= 3);
  assert.ok(snapshots.every(s => s === null));
  const content = h.nodes.pageReporteDeuda.selectors['[data-rd-content]'];
  assert.equal(content.children[0].children.length, 2);
  assert.equal(h.bar.children.length, 1, 'one native entry button');
  assert.equal(h.bar.children[0].hidden, false);
  assert.equal(h.report.init(), undefined);
  assert.equal(h.bar.children.length, 1, 'initialization is idempotent');
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
