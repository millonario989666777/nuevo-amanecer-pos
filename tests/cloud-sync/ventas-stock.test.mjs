import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = () => readFileSync('POS/js/modules/ventas-stock.js', 'utf8');
function load(extra = {}) { const ctx = vm.createContext({ module: { exports: {} }, ...extra }); vm.runInContext(source(), ctx); return ctx.NA_VENTAS_STOCK; }
const now = '2026-10-16';
const products = [
  { id: 'zero', name: 'Agotado', stock: 0, stockMin: 1, costo: 99 },
  { id: 'low', name: 'Ácido, "especial"', sku: 'AC-1', cat: 'Farmácia', stock: 3.5 },
  { id: 'idle', name: 'Quieto', stock: 9 },
  { id: 'ok', name: 'Suficiente', stock: 100 },
  { id: 'min', name: 'Mínimo', stock: 2, stockMin: 2 },
];
const sales = [{ fecha: now, items: [
  { id: 'zero', qty: 2, precio: 1.235 }, { id: 'low', qty: 30, precio: 2 },
  { id: 'ok', cantidad: 3, precioUnitario: 4 }, { id: 'missing', name: 'Fuera', qty: 1, precio: 5 },
  { id: 'low', qty: 0, precio: 999 },
] }];
const report = (options = {}) => load().buildReport(sales, products, { now, ...options });
test('statuses, coverage, cents, totals, transactions and priority order', () => {
  const r = report();
  assert.deepEqual(Array.from(r.rows, x => x.status), ['sin_stock', 'reponer', 'reponer', 'sin_movimiento', 'ok', 'sin_control']);
  const low = r.rows.find(x => x.id === 'low');
  assert.equal(low.avgDaily, 1); assert.equal(low.coverageDays, 3.5); assert.equal(low.revenueCents, 6000);
  assert.equal(low.transactions, 1); assert.equal(r.unitsSold, 36); assert.equal(r.revenue, 79.47);
  assert.equal(r.rows.at(-1).stock, null); assert.equal(r.counts.reponer, 2);
});
test('voided, invalid, future and out-of-range sales excluded; periods include their first day', () => {
  const api = load();
  for (const days of [7, 30, 90]) {
    const range = api.periodRange(days, now); assert.equal(range.days, days);
    const data = [{ fecha: range.from, items: [{ id: 'x', qty: 1, precio: 1 }] },
      { fecha: now, anulada: true, items: [{ id: 'x', qty: 99 }] },
      ...['2020-01-01', '2026-10-17', 'invalid'].map(fecha => ({ fecha, items: [{ id: 'x', qty: 99 }] }))];
    assert.equal(api.buildReport(data, [], { now, days }).unitsSold, 1);
  }
  assert.equal(api.periodRange(undefined, now).days, 30);
  assert.equal(api.periodRange(7, '2026-10-16T02:00:00Z').to, '2026-10-15');
});
test('category and name/code search normalize accents and case', () => {
  assert.equal(report({ category: 'FARMACIA', query: 'acido' }).rows.length, 1);
  assert.equal(report({ query: 'ac-1' }).rows.length, 1);
  assert.equal(report({ query: 'absent' }).rows.length, 0);
});
test('sort ties use coverage, units descending then name; stock boundaries', () => {
  const api = load();
  const r = api.buildReport([{ fecha: now, items: [{ id: 'a', qty: 30 }, { id: 'b', qty: 60 }] }],
    [{ id: 'a', name: 'A', stock: 7 }, { id: 'b', name: 'B', stock: 14 }, { id: 'c', name: 'C', stock: 0 }, { id: 'd', name: 'D', stock: -1, stockMin: 1 }], { now });
  assert.equal(r.rows[0].status, 'sin_stock');
  assert.deepEqual(Array.from(r.rows.filter(x => x.status === 'ok'), x => x.id), ['b', 'a']);
  // Stock 0 sin ventas ni mínimo no es «OK»: queda como sin movimiento (no urgente).
  assert.equal(r.rows.find(x => x.id === 'c').status, 'sin_movimiento');
  assert.equal(report({ lowCoverageDays: 3 }).rows.find(x => x.id === 'low').status, 'ok');
});
test('CSV uses BOM, CRLF, RFC4180 quotes, dot decimals, guards formulas and omits costs', () => {
  const api = load(); const r = report();
  for (const prefix of ['=', '+', '-', '@']) r.rows.push({ ...r.rows[1], name: prefix + 'formula' });
  const csv = api.toCsv(r);
  assert.ok(csv.startsWith('\uFEFFProducto,Código,Categoría,Unidades vendidas,Importe,Stock,Promedio diario,Días de cobertura,Estado\r\n'));
  assert.ok(csv.includes('"Ácido, ""especial"""')); assert.ok(csv.includes('3.5'));
  for (const prefix of ['=', '+', '-', '@']) assert.ok(csv.includes("'" + prefix + 'formula'));
  assert.ok(!/costo|cost|precioCompra|margin/i.test(csv)); assert.ok(!csv.replaceAll('\r\n', '').includes('\n'));
});
test('pure report does not mutate inputs or expose costs; owner gate denies by default', () => {
  const before = JSON.stringify({ sales, products }); const r = report();
  assert.equal(JSON.stringify({ sales, products }), before);
  assert.ok(!/costo|precioCompra|margin/.test(JSON.stringify(r)));
  assert.equal(load().ownerAllowed(), false);
  assert.equal(load({ NA_ROLES: { isOwner: () => true }, NA_PERMISSIONS: { canAccessScreen: (role, id) => role === 'owner' && id === 'pageVentasStock' } }).ownerAllowed(), true);
});

class Node {
  constructor() { this.children = []; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  setAttribute() {}
}
test('render uses text nodes and clears data before denying access without reading sales', () => {
  const content = new Node(), status = new Node(), controls = new Node(), period = new Node(); period.value = '30';
  const nodes = { '[data-vs-content]': content, '[data-vs-status]': status, '[data-vs-controls]': controls, '[data-vs-period]': period };
  let owner = true;
  const ctx = vm.createContext({ module: { exports: {} },
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => ({ querySelector: s => nodes[s] }), createElement: () => new Node() },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: { canAccessScreen: () => true },
    productos: [{ id: 'x', name: '<img onerror=unsafe>', stock: 1 }], ventas: [],
    _naCategoryLabel() { throw new Error('writing helper'); } });
  vm.runInContext(source(), ctx);
  assert.equal(ctx.module.exports, ctx.NA_VENTAS_STOCK); assert.ok(Object.isFrozen(ctx.NA_VENTAS_STOCK));
  assert.equal(ctx.NA_VENTAS_STOCK.render(), true); assert.ok(content.textContent.includes('<img onerror=unsafe>'));
  owner = false; Object.defineProperty(ctx, 'ventas', { get() { throw new Error('unauthorized read'); } });
  assert.equal(ctx.NA_VENTAS_STOCK.render(), false); assert.equal(content.children.length, 0);
  assert.equal(status.textContent, 'Sin permiso. Pídele acceso al dueño.'); assert.equal(controls.hidden, true);
});
test('catalogue identity and short visible codes match ABC without joining distinct ids', () => {
  const api = load();
  const r = api.buildReport([{ timestamp: now, items: [{ sku: 'SKU', qty: 1 }, { id: 'different', sku: 'SKU', qty: 2 }, { id: 'GENERIC:123456789', name: 'Varios', qty: 1 }] }],
    [{ id: 'known', sku: 'SKU', name: 'Known', stock: 10 }], { now });
  assert.equal(r.rows.find(x => x.id === 'known').unitsSold, 1);
  assert.equal(r.rows.find(x => x.id === 'different').stock, null);
  assert.equal(r.rows.find(x => x.name === 'Varios').code, 'ID 12345678');
});

test('CSV: números negativos no se tratan como fórmula y los decimales se redondean', () => {
  const api = load();
  const r = api.buildReport([{ fecha: now, items: [{ id: 'n', qty: 1, precio: 1 }, { id: 'p', qty: 1, precio: 1 }] }],
    [{ id: 'n', name: 'Negativo', stock: -2 }, { id: 'p', name: 'Tercio', stock: 10 }], { now });
  const csv = api.toCsv(r);
  assert.match(csv, /\r\nNegativo,ID n,Sin categoría,1,1\.00,-2,0\.03,,Sin stock\r\n/);
  assert.match(csv, /\r\nTercio,ID p,Sin categoría,1,1\.00,10,0\.03,300,OK\r\n/);
});
