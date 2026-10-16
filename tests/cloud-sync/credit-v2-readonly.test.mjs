import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Rutas de solo lectura de crédito V2: summarizeClient(c, true), debtFilter y el reporte de deuda
// no deben modificar créditos, pagos ni el índice compartido, y deben dar los mismos saldos.
const v2Source = readFileSync(new URL('../../POS/js/modules/client-credit-accounts-v2.js', import.meta.url), 'utf8');
const legacy = readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8');
const reportSource = readFileSync(new URL('../../POS/js/modules/clientes-reporte-deuda.js', import.meta.url), 'utf8');

function realV2() {
  const ctx = { clientes:[], creditos:[], document:{ getElementById:() => null, querySelector:() => null },
    addEventListener() {}, setTimeout:() => 1, clearTimeout() {},
    obtenerHoy:() => '2026-10-15', diasHasta:day => day ? Math.round((Date.parse(day) - Date.parse('2026-10-15')) / 864e5) : null,
    _naNumber:(value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback };
  ctx.window = ctx;
  vm.createContext(ctx);
  const voided = readFileSync(new URL('../../POS/js/core/utils.js', import.meta.url), 'utf8').match(/function _naIsCreditVoided\(cr\)\{[^\n]+/)[0];
  const status = voided + '\n' + legacy.slice(legacy.indexOf('const _naSyncCreditStatus='), legacy.indexOf('// NUEVO FASE 6'));
  const outstanding = legacy.match(/function _naCreditOutstanding\(cr\)\{[^\n]+/)[0];
  const index = legacy.slice(legacy.indexOf('let _naClientCreditIndexRef='), legacy.indexOf('statusCli=function'));
  vm.runInContext(status + '\n' + outstanding + '\n' + index, ctx);
  vm.runInContext(v2Source, ctx);
  vm.runInContext(reportSource, ctx);
  const run = code => vm.runInContext(code, ctx);
  return { ctx, run, api:ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2, report:ctx.NA_CLIENTES_REPORTE_DEUDA };
}
const client = (id, nombre) => ({ id, nombre, dni:'', creditCategories:[] });
const credit = (id, cliId, monto, pagado, extra = {}) => ({ id, credit_id:String(id), cliId, clienteId:cliId,
  monto, pagado, saldo:Number(monto) - Number(pagado), fecha:'2026-09-01', vence:'2026-11-30', status:'vigente', estado:'vigente',
  anulado:false, pagos:Number(pagado) > 0 ? [{ id:'P' + id, monto:Number(pagado), fecha:'2026-09-10' }] : [], items:[{ nombre:'Sintético', subtotal:Number(monto) }], ...extra });
// Datos sintéticos variados: textos numéricos, sobrepago, vencido, pagado, anulado, saldo residual y estado desfasado.
function dataset() {
  return {
    clientes:[client(1, 'Sintético Uno'), client(2, 'Sintético Dos'), client(3, 'Sintético Tres'), client(4, 'Sintético Cuatro')],
    creditos:[credit(11, 1, '100', '40', { status:'desfasado' }), credit(12, 1, 50, 50), credit(13, 1, 30, 0, { vence:'2026-10-01' }),
      credit(21, 2, 80, 120), credit(22, 2, 25.5, 0.25, { vence:'2026-01-01', status:'vigente' }), credit(23, 2, 60, 0, { anulado:true }),
      credit(31, 3, 100, 99.999), credit(32, '3', 15, 5, { cliId:undefined, clienteId:3 }), credit(41, 4, 70, 0, { status:'anulado', estado:'anulado' })]
  };
}
const snapshot = h => JSON.stringify({ creditos:h.ctx.creditos, clientes:h.ctx.clientes });
const plain = value => JSON.parse(JSON.stringify(value));
function balances(h, readOnly) {
  return h.ctx.clientes.map(c => {
    const s = h.api.summarizeClient(c, readOnly);
    return { id:c.id, debt:s.debt, overdueDebt:s.overdueDebt, all:s.all.map(cr => [String(cr.id), cr.status]),
      active:s.active.map(cr => String(cr.id)), closed:s.closed.map(cr => String(cr.id)),
      effective:h.api.debtFilter.effectiveBalance(s, null) };
  });
}

for (const warm of [false, true]) {
  test(`readOnly (índice ${warm ? 'caliente' : 'frío'}) no modifica créditos, pagos ni el índice compartido`, () => {
    const h = realV2();
    Object.assign(h.ctx, dataset());
    if (warm) h.run('_naEnsureClientCreditIndex(true)');
    const before = snapshot(h), index = h.run('[_naClientCreditIndexRef,_naClientCreditsIndex,_naClientSummaryIndex]');
    balances(h, true);
    h.report.buildReport(h.ctx.clientes, h.api, null, 'saldo');
    h.api.debtFilter.filter(h.ctx.clientes.map(c => ({ client:c, summary:h.api.summarizeClient(c, true) })), 'con-deuda', null);
    assert.equal(snapshot(h), before);
    const after = h.run('[_naClientCreditIndexRef,_naClientCreditsIndex,_naClientSummaryIndex]');
    after.forEach((value, i) => assert.equal(value, index[i], 'shared index must not be rebuilt'));
  });
}

test('las filas de solo lectura son copias: modificarlas no toca los créditos ni sus pagos', () => {
  const h = realV2();
  Object.assign(h.ctx, dataset());
  h.run('_naEnsureClientCreditIndex(true)');
  const before = snapshot(h);
  const s = h.api.summarizeClient(h.ctx.clientes[0], true);
  s.all.forEach(cr => { cr.pagado = 0; cr.status = 'x'; if (cr.pagos[0]) cr.pagos[0].monto = 999; cr.pagos.push({ id:'X' }); cr.items[0].subtotal = 0; });
  assert.equal(snapshot(h), before);
});

test('saldos de solo lectura idénticos a la ruta normal (que reconstruye y normaliza) sobre los mismos datos', () => {
  const ro = realV2(); Object.assign(ro.ctx, dataset());
  const rw = realV2(); Object.assign(rw.ctx, dataset());
  const readOnly = plain(balances(ro, true)), normal = plain(balances(rw, false));
  assert.deepEqual(readOnly, normal);
  // El crédito 41 (cliente 4) tiene status/estado 'anulado' sin anulado:true. Antes _naSyncCreditStatus lo
  // reescribía a vigente y sumaba 70; ahora _naIsCreditVoided lo reconoce como anulado: deuda 0 y fuera del reporte.
  assert.deepEqual(readOnly.map(r => r.debt), [90, 25.25, 10, 0]);
  const report = plain(ro.report.buildReport(ro.ctx.clientes, ro.api, null, 'saldo'));
  assert.deepEqual(report.rows.map(r => [r.clientId, r.balance, r.openCredits]), [[1, 90, 2], [2, 25.25, 1], [3, 10, 1]]);
  assert.equal(report.total, 125.25);
});

test('después de registrar un pago (escritura sobre el objeto vivo), la ficha y el filtro muestran el mismo saldo', () => {
  const h = realV2();
  Object.assign(h.ctx, dataset());
  const c1 = h.ctx.clientes[0];
  // La ficha (ruta normal) calienta el índice compartido, como al abrir la cuenta.
  assert.equal(h.api.summarizeClient(c1, false).debt, 90);
  // Pago de 20 sobre el crédito 11 tal como lo hace la escritura existente: muta el objeto compartido.
  const live = h.run('_naClientCreditsFast(1)').find(cr => String(cr.id) === '11');
  assert.equal(live, h.ctx.creditos[0], 'la ruta de escritura sigue recibiendo el objeto vivo');
  live.pagado = Number(live.pagado) + 20; live.pagos.push({ id:'P-NEW', monto:20, fecha:'2026-10-15' });
  const ficha = h.api.summarizeClient(c1, false).debt;
  const filtro = h.api.debtFilter.effectiveBalance(h.api.summarizeClient(c1, true), null);
  const fila = h.report.buildReport([c1], h.api, null, 'saldo').rows[0].balance;
  assert.deepEqual([ficha, filtro, fila], [70, 70, 70]);
  const before = snapshot(h);
  assert.equal(h.api.debtFilter.filter([{ client:c1, summary:h.api.summarizeClient(c1, true) }], 'con-deuda', null).length, 1);
  assert.equal(snapshot(h), before);
});

test('pago que liquida un crédito con índice fresco: la copia queda cancelada y cerrada, el original no se toca', () => {
  const h = realV2();
  Object.assign(h.ctx, dataset());
  const c1 = h.ctx.clientes[0];
  h.run('_naEnsureClientCreditIndex(true)');
  // La escritura existente liquida el crédito 11 sobre el objeto vivo sin reconstruir el índice (sigue fresco).
  const live = h.run('_naClientCreditsFast(1)').find(cr => String(cr.id) === '11');
  live.pagado = 100; live.pagos.push({ id:'P-SETTLE', monto:60, fecha:'2026-10-15' });
  const statusBefore = live.status;
  assert.equal(h.run('_naClientCreditIndexFresh()'), true);
  const before = snapshot(h), index = h.run('[_naClientCreditIndexRef,_naClientCreditsIndex,_naClientSummaryIndex]');
  const rows = h.run('_naClientCreditsReadOnly(1)');
  const settled = rows.find(cr => String(cr.id) === '11');
  assert.equal(settled.status, 'cancelado', 'la copia refleja el pago que liquidó el crédito');
  assert.notEqual(settled, live);
  assert.equal(live.status, statusBefore, 'el original conserva su estado: solo lectura no normaliza');
  const ro = plain(h.api.summarizeClient(c1, true));
  assert.equal(snapshot(h), before);
  h.run('[_naClientCreditIndexRef,_naClientCreditsIndex,_naClientSummaryIndex]').forEach((v, i) => assert.equal(v, index[i]));
  assert.ok(ro.closed.some(cr => String(cr.id) === '11'));
  assert.ok(!ro.active.some(cr => String(cr.id) === '11'));
  assert.equal(ro.debt, 30);
  // Mismo saldo y mismos estados que la ruta normal sobre los mismos datos.
  const rw = realV2(); Object.assign(rw.ctx, dataset());
  rw.ctx.creditos[0].pagado = 100; rw.ctx.creditos[0].pagos.push({ id:'P-SETTLE', monto:60, fecha:'2026-10-15' });
  assert.deepEqual(plain(balances(h, true))[0], plain(balances(rw, false))[0]);
  assert.equal(h.api.debtFilter.filter([{ client:c1, summary:h.api.summarizeClient(c1, true) }], 'con-deuda', null).length, 1);
});

test('pagos en cola: pending=null no descuenta nada; un lote pendiente que liquida deja al cliente sin deuda sin tocar la cola', () => {
  const h = realV2();
  Object.assign(h.ctx, dataset());
  h.run('_naEnsureClientCreditIndex(true)');
  const c3 = h.ctx.clientes[2];
  const s = h.api.summarizeClient(c3, true);
  assert.equal(h.api.debtFilter.effectiveBalance(s, null), 10);
  assert.equal(h.api.debtFilter.effectiveBalance(s, [null, undefined]), 10);
  const queued = { command:'payment.batch', state:'PENDING', payload:{ payments:[
    { operation_id:'OP-Q1', credit_id:'32', amount_cents:1000 },
    { operation_id:'OP-Q1', credit_id:'32', amount_cents:1000 }] } };
  const queueBefore = JSON.stringify(queued), before = snapshot(h);
  assert.equal(h.api.debtFilter.effectiveBalance(s, queued), 0, 'el duplicado del mismo operation_id cuenta una sola vez');
  const rows = h.ctx.clientes.map(c => ({ client:c, summary:h.api.summarizeClient(c, true) }));
  // El cliente 4 solo tiene el crédito 41 (status/estado 'anulado' sin la bandera): ya no tiene deuda.
  assert.deepEqual(h.api.debtFilter.filter(rows, 'sin-deuda', queued).map(r => r.client.id), [3, 4]);
  assert.deepEqual(h.api.debtFilter.filter(rows, 'sin-deuda', null).map(r => r.client.id), [4]);
  assert.deepEqual(h.api.debtFilter.filter(rows, 'con-deuda', null).map(r => r.client.id), [1, 2, 3]);
  assert.equal(JSON.stringify(queued), queueBefore, 'la cola no se modifica');
  assert.equal(snapshot(h), before, 'ni los créditos ni sus pagos');
});

test('índice fresco: un crédito anulado no aparece en solo lectura (lista ni saldo) y coincide con la ruta normal', () => {
  const h = realV2();
  Object.assign(h.ctx, dataset());
  // Crédito anulado con saldo pendiente: si se colara, sumaría 60 a la deuda del cliente 2.
  h.ctx.creditos.push(credit(24, 2, 40, 0, { anulado:true, status:'anulado', estado:'anulado' }));
  h.run('_naEnsureClientCreditIndex(true)');
  assert.equal(h.run('_naClientCreditIndexFresh()'), true);
  const before = snapshot(h);
  const ids = plain(h.run('_naClientCreditsReadOnly(2)')).map(cr => String(cr.id));
  assert.deepEqual(ids, ['21', '22']);
  const s = plain(h.api.summarizeClient(h.ctx.clientes[1], true));
  for (const list of [s.all, s.active, s.closed]) assert.ok(!list.some(cr => ['23', '24'].includes(String(cr.id))));
  assert.equal(s.debt, 25.25);
  assert.equal(h.api.debtFilter.effectiveBalance(s, null), 25.25);
  const row = plain(h.report.buildReport([h.ctx.clientes[1]], h.api, null, 'saldo')).rows[0];
  assert.deepEqual([row.balance, row.openCredits], [25.25, 1]);
  assert.equal(snapshot(h), before, 'solo lectura no toca los créditos');
  const rw = realV2(); Object.assign(rw.ctx, dataset());
  rw.ctx.creditos.push(credit(24, 2, 40, 0, { anulado:true, status:'anulado', estado:'anulado' }));
  assert.deepEqual(plain(balances(h, true))[1], plain(balances(rw, false))[1]);
  assert.deepEqual(plain(rw.run('_naClientCreditsFast(2)')).map(cr => String(cr.id)), ids);
});

const VOID_VARIANTS = [['status', 'anulado'], ['status', 'ANULADO'], ['estado', 'anulado'], ['estado', 'ANULADO'],
  ['source_status', 'anulado'], ['source_status', 'ANULADO'], ['status', ' Anulado ']];
for (const [field, value] of VOID_VARIANTS) {
  test(`${field}=${JSON.stringify(value)} sin anulado:true cuenta como anulado en ficha, filtro, reporte e índice; el original no cambia`, () => {
    const make = () => {
      const extra = { status:'vigente', estado:'vigente', anulado:false }; extra[field] = value;
      return { clientes:[client(5, 'Sintético Cinco')], creditos:[credit(51, 5, 80, 10, extra), credit(52, 5, 20, 5)] };
    };
    const h = realV2(); Object.assign(h.ctx, make());
    const original = JSON.stringify(h.ctx.creditos[0]);
    assert.equal(h.run('_naIsCreditVoided(creditos[0])'), true);
    assert.equal(h.run('_naSyncCreditStatus(creditos[0])'), 'anulado');
    assert.equal(JSON.stringify(h.ctx.creditos[0]), original, 'el estado del original no se pisa');
    for (const fresh of [false, true]) {
      if (fresh) h.run('_naEnsureClientCreditIndex(true)');
      const s = plain(h.api.summarizeClient(h.ctx.clientes[0], true));
      assert.equal(s.debt, 15);
      assert.ok(![...s.all, ...s.active, ...s.closed].some(cr => String(cr.id) === '51'));
      assert.equal(h.api.debtFilter.effectiveBalance(s, null), 15);
      const row = plain(h.report.buildReport(h.ctx.clientes, h.api, null, 'saldo')).rows[0];
      assert.deepEqual([row.balance, row.openCredits], [15, 1]);
    }
    assert.equal(h.api.summarizeClient(h.ctx.clientes[0], false).debt, 15);
    assert.deepEqual(plain(h.run('_naClientCreditsFast(5)')).map(cr => String(cr.id)), ['52']);
    assert.equal(h.run('_naClientDebtFast(5)'), 15);
    assert.equal(JSON.stringify(h.ctx.creditos[0]), original, 'ni el índice ni la ficha modifican el anulado');
    const rw = realV2(); Object.assign(rw.ctx, make());
    assert.deepEqual(plain(balances(h, true)), plain(balances(rw, false)));
  });
}

test('comparación por prefijo «anul»: "anulada" cuenta como anulada; "no anulado", LIVE, RECONCILED y demás no; saldos del resto intactos', () => {
  const h = realV2();
  Object.assign(h.ctx, { clientes:[client(6, 'Sintético Seis')], creditos:[credit(61, 6, 50, 0, { status:'anulada', estado:'anulada' }), credit(62, 6, 30, 10, { source_status:'vigente' }),
    credit(63, 6, 40, 40), credit(64, 6, 25, 0, { estado:'no anulado' }), credit(65, 6, 12, 2, { status:'LIVE', source_status:'VENCIDO' }),
    credit(66, 6, 8, 0, { status:'RECONCILED', estado:'RECONCILED' }), credit(67, 6, 5, 0, { source_status:' ANULADA ' })] });
  const original = JSON.stringify(h.ctx.creditos);
  assert.deepEqual(h.ctx.creditos.map(cr => h.run(`_naIsCreditVoided(creditos.find(c => c.id === ${cr.id}))`)), [true, false, false, false, false, false, true]);
  // 62: 20 · 63: pagado · 64: 25 · 65: 10 · 66: 8 → 63 (los anulados 61 y 67 no suman).
  assert.equal(h.api.summarizeClient(h.ctx.clientes[0], true).debt, 63);
  assert.equal(JSON.stringify(h.ctx.creditos), original);
  assert.equal(h.api.summarizeClient(h.ctx.clientes[0], false).debt, 63);
});

test('puente CANON → legacy: source_status llega al crédito legacy; LIVE/RECONCILED nunca es anulado; saldos de no anulados iguales', () => {
  const h = realV2();
  vm.runInContext(readFileSync(new URL('../../POS/js/adapters/canonical-ui-adapter.js', import.meta.url), 'utf8'), h.ctx);
  const adapter = h.ctx.NuevoAmanecerCanonicalUIAdapter;
  const customers = new Map([['C7', { id:'C7', nombre:'Sintético Siete', dni:'' }]]);
  const canon = (id, status, source_status, original, balance) => ({ credit_id:id, customer_id:'C7', status, source_status,
    original_amount_cents:original, current_balance_cents:balance, issued_value:'2026-09-01', due_value:'2026-11-30', concept:'Sintético' });
  const rows = [canon('K1', 'LIVE', 'VIGENTE', 10000, 4000), canon('K2', 'RECONCILED', 'VENCIDO', 5000, 5000), canon('K3', 'RECONCILED', 'PAGADO', 3000, 0),
    canon('K4', 'LIVE', null, 2000, 1500), canon('K5', 'RECONCILED', 'ANULADO', 7000, 7000), canon('K6', 'LIVE', 'anulada', 900, 900)];
  const before = JSON.stringify(rows);
  const legacy = rows.map(c => adapter.credit(c, customers, new Map(), new Map()));
  assert.equal(JSON.stringify(rows), before, 'el puente no modifica el snapshot CANON');
  assert.deepEqual(plain(legacy.map(cr => [cr.id, cr.status, cr.source_status, cr.monto, cr.pagado])), [
    ['K1', 'VIGENTE', 'VIGENTE', 100, 60], ['K2', 'VENCIDO', 'VENCIDO', 50, 0], ['K3', 'PAGADO', 'PAGADO', 30, 30],
    ['K4', 'LIVE', '', 20, 5], ['K5', 'ANULADO', 'ANULADO', 70, 0], ['K6', 'anulada', 'anulada', 9, 0]]);
  h.ctx.clientes = [{ id:'C7', nombre:'Sintético Siete', dni:'', creditCategories:[] }];
  h.ctx.creditos = legacy;
  assert.deepEqual(legacy.map(cr => h.run(`_naIsCreditVoided(creditos.find(c => c.id === '${cr.id}'))`)), [false, false, false, false, true, true]);
  assert.equal(h.run(`_naIsCreditVoided({ status:'LIVE' })`), false);
  assert.equal(h.run(`_naIsCreditVoided({ status:'RECONCILED', estado:'RECONCILED', source_status:'' })`), false);
  // Deuda = solo no anulados: K1 40 + K2 50 + K4 15 = 105 (K3 pagado; K5 y K6 anulados).
  const ro = h.api.summarizeClient(h.ctx.clientes[0], true);
  assert.equal(ro.debt, 105);
  assert.ok(!ro.all.some(cr => ['K5', 'K6'].includes(String(cr.id))));
  assert.equal(h.api.summarizeClient(h.ctx.clientes[0], false).debt, 105);
  assert.equal(h.run('_naClientDebtFast("C7")'), 105);
});
