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
