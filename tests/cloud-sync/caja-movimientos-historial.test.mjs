import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const ctx = vm.createContext({});
vm.runInContext(readFileSync('POS/js/modules/caja-movimientos-historial.js', 'utf8'), ctx);
const h = ctx.NuevoAmanecerCajaViews;
const plain = value => JSON.parse(JSON.stringify(value));
test('Lima presets around UTC midnight and month boundary', () => {
  assert.equal(h.limaToday('2026-10-14T02:00:00Z'), '2026-10-13');
  for (const [key, expected] of [['hoy', ['2026-10-13', '2026-10-13']], ['ayer', ['2026-10-12', '2026-10-12']], ['7', ['2026-10-07', '2026-10-13']], ['mes', ['2026-10-01', '2026-10-13']]]) {
    const r = h.presetRange(key, '2026-10-14T02:00:00Z'); assert.deepEqual([r.desde, r.hasta], expected);
  }
  assert.equal(h.presetRange('mes', '2026-11-01T04:59:00Z').desde, '2026-10-01');
  assert.equal(h.presetRange('ayer', '2026-11-01T05:00:00Z').desde, '2026-10-31');
});
test('range includes opening day only, including a shift closed after midnight', () => {
  const rows = [{ timestampApertura: '2026-10-14T01:00:00Z', timestampCierre: '2026-10-14T05:40:00Z', ventas: 100 }, { fechaApertura: '2026-10-14', ventas: 200 }];
  assert.equal(h.filterClosesByOpening(rows, '2026-10-13', '2026-10-13').length, 1);
  assert.equal(h.inRangeByOpening(rows[0], '2026-10-14', '2026-10-14'), false);
  assert.deepEqual(plain(h.salesPerDay(rows, '2026-10-12', '2026-10-14')).map(r => r.total), [0, 100, 200]);
  assert.equal(h.filterClosesByOpening(rows, '2026-10-14', '2026-10-13').length, 0);
});
test('classification separates credit sales from money received', () => {
  for (const [move, type] of [[{ tipo: 'ing', ventaId: 'V', metodo: 'credito' }, 'credito'], [{ tipo: 'ing', cat: 'Venta retail' }, 'contado'], [{ tipo: 'cob' }, 'cob'], [{ tipo: 'egr' }, 'egr'], [{ tipo: 'gas' }, 'gas'], [{ tipo: 'ing', desc: 'Fondo adicional' }, 'ing']]) assert.equal(h.classifyMove(move), type);
});
test('donut totals, mixed payment, collections and credit reversal', () => {
  const t = h.movementTotals([{ tipo: 'ing', ventaId: 1, monto: 100, metodo: 'mixto', detallePago: { efectivo: 30, digital: 70, digitalMethod: 'yape' } }, { tipo: 'ing', ventaId: 2, monto: 50, metodo: 'credito' }, { tipo: 'cob', monto: 20, metodo: 'plin' }, { tipo: 'gas', monto: 10, metodo: 'efectivo' }]);
  assert.equal(t.ventas, 15000); assert.equal(t.entrada, 12000); assert.equal(t.neto, 11000);
  assert.deepEqual(plain(t.salesMethods), { efectivo: 3000, yape: 7000, plin: 0, transferencia: 0, credito: 5000 });
  const rev = h.movementTotals([{ tipo: 'egr', reversal: true, ventaId: 2, reversalOf: 2, metodo: 'credito', monto: 50 }]);
  assert.equal(rev.salidas, 0); assert.equal(rev.ventas, -5000);
});
test('local wall times stay Lima and timestamp fallback converts once', () => {
  const rows = h.localRows([{ id: 'a', fechaApertura: '2026-10-13', hora24: '20:00', horaCierre24: '00:40', timestampApertura: '2026-10-14T01:00:00Z' }, { id: 'b', timestampApertura: '2026-10-14T01:00:00Z', timestampCierre: '2026-10-14T05:40:00Z' }], []);
  assert.equal(rows[0].apertura, '20:00'); assert.equal(rows[1].fecha, '2026-10-13'); assert.equal(rows[1].cierre, '00:40');
});
test('local breakdown prefers session identity, falls back to unassigned opening-date moves, and marks missing data', () => {
  const rows = h.localRows([{ sessionId: 'A', fechaApertura: '2026-10-13' }, { sessionId: 'B', fechaApertura: '2026-10-12' }, { sessionId: 'C', fechaApertura: '2026-10-11' }], [
    { sessionId: 'A', fecha: '2026-10-14', tipo: 'ing', ventaId: 1, metodo: 'efectivo', monto: 20 },
    { fecha: '2026-10-13', tipo: 'ing', ventaId: 2, metodo: 'yape', monto: 999 },
    { fecha: '2026-10-12', tipo: 'ing', ventaId: 3, metodo: 'mixto', monto: 80, detallePago: { efectivo: 10, yape: 20, plin: 10, transferencia: 10, credito: 30 } },
    { fecha: '2026-10-12', tipo: 'cob', metodo: 'efectivo', monto: 5 },
    { sessionId: 'other', fecha: '2026-10-12', tipo: 'ing', ventaId: 4, monto: 999 }
  ]);
  assert.equal(rows[0].ventas, 2000);
  assert.equal(rows[1].ventas, 8000);
  assert.equal(rows[1].cobros, 500);
  assert.deepEqual(plain(rows[1].metodos), { efectivo: 1500, yape: 2000, plin: 1000, transferencia: 1000, credito: 3000 });
  assert.equal(rows[2].ventas, null);
  assert.equal(rows[2].localMissing, true);
});
test('open shift summary keeps pre-midnight sales after midnight and falls back to today', () => {
  const moves = [
    { sessionId: 'S1', timestamp: '2026-10-14T04:30:00Z', tipo: 'ing', ventaId: 1, metodo: 'efectivo', monto: 10 },
    { sessionId: 'S1', timestamp: '2026-10-14T05:30:00Z', tipo: 'ing', ventaId: 2, metodo: 'yape', monto: 5 },
    { sessionId: 'S0', timestamp: '2026-10-14T05:20:00Z', tipo: 'ing', ventaId: 3, metodo: 'efectivo', monto: 99 }
  ];
  const s = h.shiftMoves(moves, { abierta: true, cerrada: false, sessionId: 'S1', fechaApertura: '2026-10-13' }, '2026-10-14T05:45:00Z');
  assert.equal(s.label, 'Ventas del turno'); assert.equal(h.movementTotals(s.moves).ventas, 1500);
  const byDate = h.shiftMoves([{ fecha: '2026-10-13', tipo: 'ing', ventaId: 1, monto: 10 }, { fecha: '2026-10-14', tipo: 'ing', ventaId: 2, monto: 5 }, { fecha: '2026-10-12', tipo: 'ing', ventaId: 3, monto: 7 }], { abierta: true, cerrada: false, fechaApertura: '2026-10-13' }, '2026-10-14T05:45:00Z');
  assert.equal(h.movementTotals(byDate.moves).ventas, 1500);
  const closed = h.shiftMoves(moves, { abierta: false, cerrada: true, sessionId: 'S1' }, '2026-10-14T05:45:00Z');
  assert.equal(closed.label, 'Ventas del día'); assert.equal(closed.moves.length, 2);
});
test('lima() reads zone-less timestamps as Lima time', () => {
  assert.deepEqual(plain(h.lima('2026-10-14T23:30:00')), { date: '2026-10-14', time: '23:30' });
  assert.deepEqual(plain(h.lima('2026-10-14 00:10')), { date: '2026-10-14', time: '00:10' });
  assert.deepEqual(plain(h.lima('2026-10-14')), { date: '2026-10-14', time: '00:00' });
  assert.deepEqual(plain(h.lima('2026-10-14T04:30:00Z')), { date: '2026-10-13', time: '23:30' });
  assert.deepEqual(plain(h.lima('2026-10-14T04:30:00-05:00')), { date: '2026-10-14', time: '04:30' });
  assert.deepEqual(plain(h.lima('basura')), { date: '', time: '' });
});
test('open shift with sessionId ignores same-day rows from other or unknown shifts', () => {
  const moves = [
    { sessionId: 'S1', fecha: '2026-10-14', tipo: 'ing', ventaId: 1, metodo: 'efectivo', monto: 10 },
    { fecha: '2026-10-14', tipo: 'ing', ventaId: 2, metodo: 'efectivo', monto: 40 },
    { sessionId: 'S0', fecha: '2026-10-14', tipo: 'ing', ventaId: 3, metodo: 'efectivo', monto: 99 }
  ];
  const state = { abierta: true, cerrada: false, sessionId: 'S1', fechaApertura: '2026-10-14' };
  assert.equal(h.movementTotals(h.shiftMoves(moves, state).moves).ventas, 1000);
  assert.equal(h.movementTotals(h.shiftMoves(moves.slice(1), state).moves).ventas, 4000, 'legacy rows without sessionId fall back to the opening date');
});
test('preset range recomputes past midnight', () => {
  assert.deepEqual(plain(h.presetRange('7', '2026-10-14T04:59:00Z')), { desde: '2026-10-07', hasta: '2026-10-13' });
  assert.deepEqual(plain(h.presetRange('7', '2026-10-14T05:01:00Z')), { desde: '2026-10-08', hasta: '2026-10-14' });
  assert.match(readFileSync('POS/js/modules/caja-movimientos-historial.js', 'utf8'), /function renderHistory\(host\) \{\s*if \(activePreset\) range = presetRange\(activePreset\);/);
});
test('server distribution counts sales only, excluding cobros', () => {
  const r = h.canonicalSalesMethods([
    { session_id: 'S', sale_id: 'V1', cash_cents: 1000, digital_cents: 500, digital_method: 'yape', credit_cents: 0 },
    { session_id: 'S', sale_id: 'V2', cash_cents: 0, digital_cents: 0, credit_cents: 700 },
    { session_id: 'S', sale_id: null, cash_cents: 300, digital_cents: 0, credit_cents: 0 },
    { session_id: 'S', event_type: 'PAYMENT', cash_cents: 200 },
    { session_id: 'X', sale_id: 'V3', cash_cents: 999 }
  ], 'S');
  assert.deepEqual(plain(r), { efectivo: 1000, yape: 500, plin: 0, transferencia: 0, credito: 700 });
});
test('close date is formatted dd/mm/aaaa', () => {
  assert.equal(h.fmtDate('2026-10-14'), '14/10/2026'); assert.equal(h.fmtDate(''), '');
  assert.match(readFileSync('POS/js/modules/caja-movimientos-historial.js', 'utf8'), /fmtDate\(r\.cierreFecha\)/);
});
