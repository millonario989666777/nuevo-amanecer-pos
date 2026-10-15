// PR B: pestañas fijas, Reportes (sin costo, inversión por compras, flujo), Nocturno y controles. Celular sin cambios.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const css = readFileSync('POS/css/canon-ux-fixes.css', 'utf8');
const in05 = readFileSync('POS/js/legacy-inline/inline-05.js', 'utf8');
const index = readFileSync('POS/index.html', 'utf8');
const in01 = readFileSync('POS/js/legacy-inline/inline-01.js', 'utf8');
const fn = name => { const i = in05.indexOf('function ' + name + '('); return in05.slice(i, in05.indexOf('\n', i)); };

function ctx(extra = {}) {
  const c = { productos: [{ id: 'A', costo: 3 }, { id: 'B', costo: 0 }], _naNumber: (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; },
    _naUnitsSold: i => Number(i.qty || 0), totalV: s => s.items.reduce((t, i) => t + i.precio * i.qty, 0), _naF8Money: n => Math.round(n * 100) / 100,
    _naClean: v => String(v || '').trim(), _naF8DateInRange: (d, r) => d >= r.from && d <= r.to, window: {}, cajMovs: [], ...extra };
  vm.createContext(c);
  vm.runInContext(['_naF8SaleUnitCost', '_naF8SaleMetrics', '_naF8PurchaseRows', '_naF8PaymentSummary', '_naF8CashFlow'].map(fn).join('\n') + '\nglobalThis.m=_naF8SaleMetrics;globalThis.pr=_naF8PurchaseRows;globalThis.cf=_naF8CashFlow;', c);
  return c;
}

test('Reportes cuenta productos sin costo (unidades y ventas) y marca la ganancia como estimada', () => {
  const c = ctx();
  const m = c.m([{ items: [{ id: 'A', precio: 5, qty: 2 }, { id: 'B', precio: 4, qty: 3 }, { id: 'VARIOS', name: 'Varios', precio: 10, qty: 1 }] }]);
  assert.equal(m.cost, 6); assert.equal(m.noCostProducts, 2); assert.equal(m.noCostUnits, 4); assert.equal(m.noCostRevenue, 22);
  assert.ok(in05.includes("report.metrics.noCostProducts?'Ganancia bruta (sin costo completo)':'Ganancia bruta'"));
  assert.match(fn('_naF8NoCostNotice'), /producto\(s\) sin costo/);
});

test('las compras registradas (aplicadas, del período) cuentan como inversión en inventario', () => {
  const c = ctx(); c.window._naF8PurchaseCache = { at: Date.now(), rows: [
    { status: 'aplicada', total_cost_cents: 4000, completed_at: '2026-10-05T10:00:00Z' },
    { status: 'en_curso', total_cost_cents: 999, created_at: '2026-10-05' },
    { status: 'aplicada', total_cost_cents: 500, completed_at: '2026-09-30T10:00:00Z' }] };
  const rows = c.pr({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(rows.length, 1); assert.equal(rows[0].total_cost_cents, 4000);
  assert.match(fn('_naF8BuildReport'), /investment=_naF8Money\(investmentExpenses\+purchases\)/);
  c.window._naF8PurchaseCache = null; assert.equal(c.pr({ from: '2026-10-01', to: '2026-10-31' }), null, 'sin datos: se avisa, no se inventa 0');
});

test('flujo de caja separa efectivo y digital y el detalle suma el total', () => {
  const c = ctx({ _naIsSaleIncomeMove: m => m.tipo === 'ing' && m.venta, _naIsSaleReversalMove: () => false, _naSalePaymentParts: () => ({}),
    cajMovs: [{ tipo: 'ing', venta: 1, metodo: 'efectivo', monto: 10, fecha: '2026-10-02' }, { tipo: 'ing', venta: 1, metodo: 'yape', monto: 6, fecha: '2026-10-02' },
      { tipo: 'cob', metodo: 'efectivo', monto: 5, fecha: '2026-10-03' }, { tipo: 'cob', metodo: 'yape', monto: 2, fecha: '2026-10-03' }] });
  const sales = [{ metodo: 'efectivo', items: [{ precio: 10, qty: 1 }] }, { metodo: 'yape', items: [{ precio: 6, qty: 1 }] }];
  const f = c.cf({ from: '2026-10-01', to: '2026-10-31' }, sales, []);
  assert.deepEqual([f.saleCash, f.saleDigital, f.collectionsCash, f.collectionsDigital, f.net], [10, 6, 5, 2, 23]);
  assert.equal(f.saleCash + f.saleDigital + f.collectionsCash + f.collectionsDigital + f.otherIncome - f.saleOutflow - f.expenseOut - f.otherOut, f.net);
  assert.ok(in05.includes("'Por cobrar de ventas del período'"));
});

test('tablet/PC: pestañas fijas, sin salto en Reportes, Nocturno legible, controles de 44 px; celular intacto', () => {
  const block = css.slice(css.indexOf('/* PR B'));
  const media = block.slice(0, block.indexOf('\n}\n'));
  assert.match(media, /@media \(min-width:701px\)/);
  assert.match(media, /#pageCaja\.active \.tabs-wrap,#pageVentas\.active \.tabs-wrap\{position:sticky!important;top:0/);
  assert.match(media, /#ventasKPI\{min-height/);
  assert.match(media, /body\.dark #pageInventario\{--dark:#f1f5f9/);
  assert.match(media, /min-height:44px/);
  assert.doesNotMatch(css.slice(0, css.indexOf('/* PR B')), /PR B/);
});

test('Nocturno en Nueva compra y Descuento; Nuevo cliente sin emoji', () => {
  assert.match(css, /body\.dark \.na-review-box,body\.dark \.na-ds-sheet\{background:#0f172a/);
  const mcli = index.split('\n').find(l => l.includes('id="mCli"'));
  assert.ok(!/➕|💾/.test(mcli));
  assert.ok(in01.includes("textContent='Nuevo cliente'"));
});
