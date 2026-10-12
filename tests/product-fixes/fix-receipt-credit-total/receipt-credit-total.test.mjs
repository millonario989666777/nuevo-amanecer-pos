// Comprobante de venta a crédito: "Estado de cuenta del cliente" (deuda total).
// También: fechas de Historial / Caja en hora de Lima aunque el equipo esté en UTC.
process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SHARE = 'POS/js/modules/ticket/share-receipt.js';
const read = p => readFileSync(p, 'utf8');

// DALILA (DNI 99999967) en CANON: deuda S/ 1353.90 en 91 créditos abiertos,
// línea manual S/ 1500 → disponible S/ 146.10. 90 créditos previos + V-094.
const DALILA = { id: 'C-DALILA', nombre: 'DALILA @', dni: '99999967', tel: '', lineaCreditoManualActiva: true, lineaCreditoManual: 1500 };
function previousCredits() {
  const rows = [];
  // 89 x 13.90 + 1 x 14.30 = 1251.40
  for (let i = 1; i <= 89; i++) rows.push({ id: 'CR-' + i, cliId: 'C-DALILA', ventaId: 'V-' + String(i).padStart(3, '0'), monto: 13.9, pagado: 0, saldo: 13.9 });
  rows.push({ id: 'CR-90', cliId: 'C-DALILA', ventaId: 'V-090', monto: 20, pagado: 5.7, saldo: 14.3 });
  // Not open / not hers: never counted.
  rows.push({ id: 'CR-PAID', cliId: 'C-DALILA', ventaId: 'V-091', monto: 50, pagado: 50, saldo: 0 });
  rows.push({ id: 'CR-VOID', cliId: 'C-DALILA', ventaId: 'V-092', monto: 99, saldo: 99, anulado: true });
  rows.push({ id: 'CR-OTHER', cliId: 'C-OTRO', ventaId: 'V-093', monto: 500, saldo: 500 });
  return rows;
}
const V094 = { id: 'V-094', fecha: '2026-10-11', hora: '08:25:00 p. m.', metodo: 'credito', clienteId: 'C-DALILA', clienteNombre: 'DALILA @', cajero: 'Frank', items: [{ name: 'Arroz', qty: 1, precio: 102.5 }] };

function realTicket(extra = {}) {
  const ctx = vm.createContext({ console, Blob, TextEncoder, Uint8Array, atob, Intl, navigator: {}, document: { addEventListener() {} }, _naDefaults: { ticket: {} }, appConfig: { ticket: {} },
    _naGetBusiness: () => ({ nombre: 'Nuevo Amanecer', cajero: 'Frank' }), totalV: s => (s.items || []).reduce((sum, i) => sum + i.qty * i.precio, 0),
    desglosarIGV: total => ({ subtotal: total, igv: 0, total }), obtenerHoy: () => '2026-10-11', nowT: () => '20:25', _naHydrateTicket() {}, _naSaveTicketSettings() {}, ...extra });
  for (const p of ['POS/js/modules/ticket/legacy.js', 'POS/js/modules/ticket/zones.js', SHARE]) vm.runInContext(read(p), ctx);
  return ctx;
}
const block = text => text.slice(text.indexOf('ESTADO DE CUENTA DEL CLIENTE'));
const flat = text => text.replace(/\s*\n\s*/g, ' ');

test('fresh credit sale pending sync: debt is accurate while the technical state remains private', () => {
  const projection = { credits: [{ id: 'pending:V-094', sale_id: 'V-094', customer_id: 'C-DALILA', balance_cents: 10250, status: 'PENDING_SYNC', source: 'CANONICAL_OUTBOX' }] };
  const ctx = realTicket({ clientes: [DALILA], creditos: previousCredits(), NuevoAmanecerCanonicalSaleIntegration: { lastProjection: () => projection } });
  const r = ctx.NAReceiptShare.build({ kind: 'sale', sale: V094, customer: DALILA, fresh: true, pendingSync: true, due: '2026-10-25' });
  const b = block(r.text);
  assert.match(r.text, /Saldo pendiente: S\/ 102\.50/);
  assert.match(b, /Deuda anterior: S\/ 1251\.40/);
  assert.match(b, /Esta venta: S\/ 102\.50/);
  assert.match(b, /Deuda total: S\/ 1353\.90/);
  assert.match(b, /Créditos abiertos: 91\b/);
  assert.match(b, /Línea de crédito: S\/ 1500\.00/);
  assert.match(b, /Línea disponible: S\/ 146\.10/);
  assert.doesNotMatch(r.text, /pendiente de sincronizar|guardado local|puerto sungaro\)/i);
  assert.equal(ctx.NAReceiptShare.accountSummary({kind:'sale',sale:V094,customer:DALILA,pendingSync:true}).thisPending,true,'pending sync state still exists internally');
  assert.match(b, /^Al: \d{4}-\d{2}-\d{2} [ 1]\d:\d{2} [ap]\.m\.$/m);
  assert.ok(r.lines.every(l => l.length <= r.width), 'no line exceeds ticket width');
});

test('after sync the same sale is counted once (no double counting with the replica or a stale projection)', () => {
  const synced = previousCredits().concat([{ id: 'CR-94', cliId: 'C-DALILA', ventaId: 'V-094', monto: 102.5, pagado: 0, saldo: 102.5 }]);
  const stale = { credits: [{ id: 'pending:V-094', sale_id: 'V-094', customer_id: 'C-DALILA', balance_cents: 10250, status: 'PENDING_SYNC' }] };
  const ctx = realTicket({ clientes: [DALILA], creditos: synced, NuevoAmanecerCanonicalSaleIntegration: { lastProjection: () => stale } });
  // Re-share from history (saleInput finds the credit by ventaId).
  ctx.ventas = [V094];
  const r = ctx.NAReceiptShare.build({ kind: 'sale', sale: V094, credit: synced.at(-1), customer: DALILA, fresh: false });
  const b = block(r.text);
  assert.match(b, /Deuda anterior: S\/ 1251\.40/);
  assert.match(b, /Esta venta: S\/ 102\.50/);
  assert.match(b, /Deuda total: S\/ 1353\.90/);
  assert.match(b, /Créditos abiertos: 91\b/);
  assert.doesNotMatch(b, /pendiente de sincronizar/);
});

test('other unsynced credit sales are included once without showing internal labels', () => {
  const projection = { credits: [
    { id: 'pending:V-095', sale_id: 'V-095', customer_id: 'C-DALILA', balance_cents: 1000, status: 'PENDING_SYNC' },
    { id: 'pending:V-096', sale_id: 'V-096', customer_id: 'C-DALILA', balance_cents: 500, status: 'PENDING_SYNC' },
    { id: 'pending:V-097', sale_id: 'V-097', customer_id: 'C-OTRO', balance_cents: 9900, status: 'PENDING_SYNC' }] };
  const ctx = realTicket({ clientes: [DALILA], creditos: [{ id: 'CR-1', cliId: 'C-DALILA', ventaId: 'V-001', monto: 40, saldo: 40 }], NuevoAmanecerCanonicalSaleIntegration: { lastProjection: () => projection } });
  const sale = { ...V094, id: 'V-096', items: [{ name: 'Azúcar', qty: 1, precio: 5 }] };
  const b = block(ctx.NAReceiptShare.build({ kind: 'sale', sale, customer: DALILA, fresh: true, pendingSync: true }).text);
  assert.match(b, /Deuda anterior: S\/ 50\.00/);
  assert.match(b, /Esta venta: S\/ 5\.00/);
  assert.match(b, /Deuda total: S\/ 55\.00/);
  assert.match(b, /Créditos abiertos: 3\b/);
  assert.doesNotMatch(b, /pendiente de sincronizar/);
  assert.equal(ctx.NAReceiptShare.accountSummary({kind:'sale',sale,customer:DALILA,fresh:true,pendingSync:true}).pendingOthers,1);
});

test('no block for cash sales, generic customer, or a customer without id; no line when no manual line', () => {
  const ctx = realTicket({ clientes: [DALILA], creditos: previousCredits() });
  const cash = ctx.NAReceiptShare.build({ kind: 'sale', sale: { ...V094, metodo: 'efectivo', recibido: 110, vuelto: 7.5 }, customer: DALILA, fresh: true });
  assert.doesNotMatch(cash.text, /ESTADO DE CUENTA/);
  const generic = ctx.NAReceiptShare.build({ kind: 'sale', sale: { ...V094, clienteId: 'GEN', clienteNombre: 'Consumidor final' }, customer: { id: 'GEN', nombre: 'Consumidor final' }, fresh: true });
  assert.doesNotMatch(generic.text, /ESTADO DE CUENTA/);
  const anonymous = ctx.NAReceiptShare.build({ kind: 'sale', sale: { ...V094, clienteId: null }, fresh: true });
  assert.doesNotMatch(anonymous.text, /ESTADO DE CUENTA/);
  const noLine = realTicket({ clientes: [{ ...DALILA, lineaCreditoManualActiva: false }], creditos: previousCredits() });
  const t = noLine.NAReceiptShare.build({ kind: 'sale', sale: V094, customer: { ...DALILA, lineaCreditoManualActiva: false }, fresh: true, pendingSync: true }).text;
  assert.match(t, /Deuda total: S\/ 1353\.90/);
  assert.doesNotMatch(t, /Línea/);
});

test('payment receipts are unchanged (no account block)', () => {
  const ctx = realTicket({ clientes: [DALILA], creditos: previousCredits() });
  const r = ctx.NAReceiptShare.build({ kind: 'payment', credit: { id: 'CR-1', monto: 13.9, saldo: 3.9 }, payment: { id: 'P-1', monto: 10, saldoAntes: 13.9, saldoDespues: 3.9 }, customer: DALILA });
  assert.doesNotMatch(r.text, /ESTADO DE CUENTA/);
});

test('printed ticket (Ver ticket / imprimir / ESC-POS) gets the same block once, ASCII-safe, and does not mutate data', () => {
  const credits = previousCredits().concat([{ id: 'CR-94', cliId: 'C-DALILA', ventaId: 'V-094', monto: 102.5, pagado: 0, saldo: 102.5 }]);
  const before = JSON.stringify(credits);
  const ctx = realTicket({ clientes: [DALILA], creditos: credits });
  const printed = ctx._naBuildThermalTicket(V094, false);
  const b = block(printed.text);
  assert.equal((printed.text.match(/ESTADO DE CUENTA DEL CLIENTE/g) || []).length, 1);
  assert.match(b, /Deuda anterior: S\/ 1251\.40/);
  assert.match(b, /Deuda total: S\/ 1353\.90/);
  assert.match(b, /Creditos abiertos: 91\b/);
  assert.match(b, /Linea disponible: S\/ 146\.10/);
  assert.ok(printed.lines.every(l => /^[\x20-\x7E]*$/.test(l)), 'printer lines are ASCII');
  assert.equal(printed.text, printed.lines.join('\n'));
  // Share build must not get the block twice (generator block skipped).
  const shared = ctx.NAReceiptShare.build({ kind: 'sale', sale: V094, credit: credits.at(-1), customer: DALILA });
  assert.equal((shared.text.match(/ESTADO DE CUENTA DEL CLIENTE/g) || []).length, 1);
  // Cash ticket unchanged.
  const cash = ctx._naBuildThermalTicket({ ...V094, metodo: 'efectivo' }, false);
  assert.doesNotMatch(cash.text, /ESTADO DE CUENTA/);
  assert.equal(JSON.stringify(credits), before);
  // Wrapper is idempotent.
  assert.equal(ctx.NAReceiptShare.installPrintedAccountSummary(), false);
});

test('"Al:" line: Lima date, 12-hour a.m./p.m. without leading zero (place still available only internally)', () => {
  const ctx = realTicket({ _naGetBusiness: () => ({ nombre: 'Multiservicios Nuevo Amanecer', direccion: 'Puerto Súngaro, Huánuco', cajero: 'Frank' }) });
  const f = ctx.NAReceiptShare.formatAsOf;
  assert.equal(f(Date.parse('2026-10-12T01:33:00Z')), '2026-10-11  8:33 p.m.');
  assert.equal(f(Date.parse('2026-10-11T15:05:00Z')), '2026-10-11 10:05 a.m.');
  assert.equal(f(Date.parse('2026-10-11T17:00:00Z')), '2026-10-11 12:00 p.m.');
  assert.equal(f(Date.parse('2026-10-11T05:07:00Z')), '2026-10-11 12:07 a.m.');
  assert.equal(f(Date.parse('2026-10-11T04:59:00Z')), '2026-10-10 11:59 p.m.');
  assert.equal(ctx.NAReceiptShare.placeLabel(), 'PUERTO SUNGARO');
  assert.equal(realTicket({ _naGetBusiness: () => ({ direccion: 'Jr. Lima 123, Tingo María, Huánuco' }) }).NAReceiptShare.placeLabel(), 'TINGO MARIA');
  assert.equal(realTicket({ _naGetBusiness: () => ({ ciudad: 'Pucallpa', direccion: 'Puerto Súngaro' }) }).NAReceiptShare.placeLabel(), 'PUCALLPA');
  assert.equal(realTicket({ _naGetBusiness: () => ({ direccion: '' }) }).NAReceiptShare.placeLabel(), 'PUERTO SUNGARO');
  assert.equal(realTicket({ _naGetBusiness: () => { throw new Error('x'); } }).NAReceiptShare.placeLabel(), 'PUERTO SUNGARO');
});

test('shared and printed tickets carry the exact same "Al:" text without location suffix', () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-12T01:33:00Z');
  try {
    const credits = previousCredits().concat([{ id: 'CR-94', cliId: 'C-DALILA', ventaId: 'V-094', monto: 102.5, pagado: 0, saldo: 102.5 }]);
    const ctx = realTicket({ Date, clientes: [DALILA], creditos: credits, _naGetBusiness: () => ({ nombre: 'Nuevo Amanecer', direccion: 'Puerto Súngaro, Huánuco', cajero: 'Frank' }) });
    const expected = 'Al: 2026-10-11  8:33 p.m.';
    const shared = ctx.NAReceiptShare.build({ kind: 'sale', sale: V094, credit: credits.at(-1), customer: DALILA });
    assert.ok(shared.lines.includes(expected), shared.text);
    const printed = ctx._naBuildThermalTicket(V094, false);
    assert.ok(printed.lines.includes(expected), printed.text);
    assert.ok(expected.length<=42, 'fits an 80 mm (42 col) ticket');
    assert.doesNotMatch(shared.text, /\(PUERTO SUNGARO\)|pendiente de sincronizar/i);
  } finally { Date.now = realNow; }
});
