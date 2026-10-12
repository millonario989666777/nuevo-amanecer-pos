// Auditoría inventario/clientes: P0-2 (OCR «Aplicar compra» en CANON), P2-1 (motivo),
// P2-2 (decimales en kg/l) y P2-3 (búsqueda insensible a mayúsculas).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { activeCanon, device } from './canon-browser-harness.mjs';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const MIG = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql'];
const SCRIPTS = [
  ['canonical-inventory-bridge.js', read('POS/js/sync/canonical-inventory-bridge.js')],
];
function loadIntegration() {
  const ctx = vm.createContext({ console });
  ctx.globalThis = ctx;
  vm.runInContext(read('POS/js/ocr/ocr-purchase-integration.js'), ctx);
  return ctx.createPurchaseOcrIntegration;
}

async function tab(f, { productId = null, type = 'entrada', onFetch, token = 'device-a-token', deviceId = 'device-a', localStorage } = {}) {
  const globals = {
    invMovId: productId, invMovT: type,
    securityIsLocked() { return false; }, storage: { getItem() { return null; } },
    LOCK_KEYS: { master: 'na_master_lock', readOnly: 'na_readonly', modules: { productos: 'na_lock_productos' } },
    invRender() {}, posRender() {}, updateDashboard() {},
  };
  const opts = { token, scripts: SCRIPTS, globals, onFetch, localStorage };
  if (!localStorage) opts.deviceId = deviceId;
  return device(f, opts);
}
async function unitProduct(x, id = 'LIVE-UNI-1') {
  await x.api.refresh();
  await x.api.createProduct({
    product_id: id, name: 'Galleta unidad', sku: id, barcode: '7750' + id.replace(/\D/g, '').padStart(8, '0'), alternate_codes: [], category: 'abarrotes',
    brand: 'Test', description: null, icon: '📦', image: null, unit: 'unidad', purchase_unit: 'unidad', purchase_factor: 1,
    cost_cents: 100, price_cents: 200, box_price_cents: null, units_per_box: null, initial_stock_quantity: 5, stock_min_quantity: 1,
    expiry_date: null, includes_igv: true, tax_type: 'gravado', complementary_tax: '', tracks_inventory: true,
  });
  await x.api.refresh();
  return id;
}
function trackedProducts(f) {
  const a = f.sql('SELECT product_id,current_stock_quantity FROM products WHERE tracks_inventory=1 ORDER BY product_id LIMIT 1');
  const b = f.sql('SELECT product_id,current_stock_quantity FROM products WHERE tracks_inventory=1 AND product_id>? ORDER BY product_id LIMIT 1', a.product_id);
  return [a, b];
}
const stockOf = (f, id) => f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=? UNION ALL SELECT current_stock_quantity FROM canonical_live_products WHERE product_id=?', id, id).q;
const manualCount = (f) => f.sql('SELECT COUNT(*) n FROM canonical_manual_inventory_movements').n;

// The integration keeps the reviewed batch privately; drive applyPurchase through the
// bridge exactly as applyReviewed does, and separately check applyReviewed routes to it.
const confirmed = (rows) => rows.map((r, i) => ({ decision: 'CONFIRMED', sourceIndex: i, productId: r.productId, quantity: r.quantity }));

test('P0-2/R5: OCR en CANON aplica cada fila como inventory.adjust ENTRADA y es idempotente', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const [a, b] = trackedProducts(f);
  const x = await tab(f);
  const bridge = x.context.NuevoAmanecerCanonicalInventoryBridge;
  const rows = confirmed([{ productId: a.product_id, quantity: 4 }, { productId: b.product_id, quantity: 6 }, { productId: a.product_id, quantity: 1 }]);
  rows.push({ decision: 'DISCARDED', sourceIndex: 3, productId: b.product_id, quantity: 99 });

  const first = await bridge.applyPurchase(rows, { operationId: 'OCR-PURCHASE-00112233aabbccdd' });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.applied.length, 3);
  assert.equal(stockOf(f, a.product_id), a.current_stock_quantity + 5);
  assert.equal(stockOf(f, b.product_id), b.current_stock_quantity + 6);
  const ops = f.sql("SELECT group_concat(operation_id,',') ids FROM (SELECT operation_id FROM canonical_manual_inventory_movements ORDER BY operation_id)").ids;
  assert.equal(ops, 'OCR-PURCHASE-00112233aabbccdd:0,OCR-PURCHASE-00112233aabbccdd:1,OCR-PURCHASE-00112233aabbccdd:2');
  assert.match(f.sql("SELECT reason FROM canonical_manual_inventory_movements WHERE operation_id LIKE '%:1'").reason, /^Compra OCR OCR-PURCHASE-00112233aabbccdd, línea 1: \+6$/);

  // Same document applied again (other device too): nothing is added twice.
  const again = await bridge.applyPurchase(rows, { operationId: 'OCR-PURCHASE-00112233aabbccdd' });
  assert.equal(again.ok, true);
  assert.equal(again.applied.length, 0);
  assert.equal(again.skipped.filter((r) => r.reason === 'ALREADY_APPLIED').length, 3);
  const other = await tab(f, { token: 'device-b-token', deviceId: 'device-b' });
  const fromB = await other.context.NuevoAmanecerCanonicalInventoryBridge.applyPurchase(rows, { operationId: 'OCR-PURCHASE-00112233aabbccdd' });
  assert.equal(fromB.applied.length, 0);
  assert.equal(manualCount(f), 3);
  assert.equal(stockOf(f, a.product_id), a.current_stock_quantity + 5);
  assert.equal(x.api.pendingSnapshot(), null);
});

test('P0-2: ACK perdido a mitad de la compra: reintentar completa sin duplicar', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const [a, b] = trackedProducts(f);
  let calls = 0;
  const x = await tab(f, { onFetch: async (url, _o, real) => {
    if (url.endsWith('/commands/inventory.adjust') && ++calls === 2) { await real(); throw new TypeError('Failed to fetch'); }
    return null;
  } });
  const bridge = x.context.NuevoAmanecerCanonicalInventoryBridge;
  const rows = confirmed([{ productId: a.product_id, quantity: 2 }, { productId: b.product_id, quantity: 3 }, { productId: a.product_id, quantity: 7 }]);
  const first = await bridge.applyPurchase(rows, { operationId: 'OCR-PURCHASE-lost' });
  assert.equal(first.ok, false);
  assert.equal(first.applied.length, 1);
  assert.match(first.errors[0].message, /Aplicar compra» de nuevo/);
  assert.equal(x.api.pendingSnapshot().payload.operation_id, 'OCR-PURCHASE-lost:1');

  const second = await bridge.applyPurchase(rows, { operationId: 'OCR-PURCHASE-lost' });
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.equal(manualCount(f), 3);
  assert.equal(stockOf(f, a.product_id), a.current_stock_quantity + 9);
  assert.equal(stockOf(f, b.product_id), b.current_stock_quantity + 3);
  assert.equal(x.api.pendingSnapshot(), null);
});

test('P0-2: filas inválidas no envían nada y otra operación pendiente bloquea con mensaje claro', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const [a] = trackedProducts(f);
  const x = await tab(f);
  const bridge = x.context.NuevoAmanecerCanonicalInventoryBridge;
  const bad = await bridge.applyPurchase(confirmed([{ productId: a.product_id, quantity: 2 }, { productId: 'NO-EXISTE', quantity: 1 }]), { operationId: 'OCR-PURCHASE-bad' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /producto no encontrado/);
  const uni = await unitProduct(x);
  const before = manualCount(f);
  const frac = await bridge.applyPurchase(confirmed([{ productId: uni, quantity: 1.5 }]), { operationId: 'OCR-PURCHASE-frac' });
  assert.equal(frac.ok, false);
  assert.match(frac.errors[0].message, /solo unidades enteras/);
  assert.equal(manualCount(f), before);
  // Another (non-OCR) pending CANON command blocks the purchase before any row is sent.
  let drop = true;
  const y = await tab(f, { token: 'inv-p-token', deviceId: 'inv-p', onFetch: async (url, _o, real) => {
    if (drop && url.endsWith('/commands/inventory.adjust')) { drop = false; throw new TypeError('Failed to fetch'); }
    return null;
  } });
  await assert.rejects(y.api.adjustInventory({ product_id: a.product_id, movement_type: 'ENTRADA', quantity: 1, reason: 'manual' }));
  const blocked = await y.context.NuevoAmanecerCanonicalInventoryBridge.applyPurchase(confirmed([{ productId: a.product_id, quantity: 2 }]), { operationId: 'OCR-PURCHASE-blk' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors[0].message, /otra operación CANON pendiente/);
  assert.equal(manualCount(f), before);
});

test('P0-2/R5: applyReviewed en CANON usa el bridge canónico (no la persistencia legacy bloqueada)', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const [a] = trackedProducts(f);
  const x = await tab(f);
  let legacyCalled = false;
  const status = { textContent: '', dataset: {} };
  const reviewRows = confirmed([{ productId: a.product_id, quantity: 3 }]);
  const integration = loadIntegration()({
    canonicalInventory: x.context.NuevoAmanecerCanonicalInventoryBridge,
    document: { getElementById() { return null; } },
    elements: { status },
    dependencies: {
      extract: async () => ({ ok: true, rawText: 'x' }),
      process: () => ({ ok: true, proposals: reviewRows }),
      createReview: () => ({ getReviewedPurchaseProposals: () => reviewRows, destroy() {} }),
      apply: async () => { legacyCalled = true; return { ok: false, errors: [{ code: 'PERSISTENCE_NOT_VERIFIED' }] }; },
    },
    createOperationId: async () => 'OCR-PURCHASE-integration',
    refreshInventory() {},
  });
  integration.selectImage({ name: 'factura.png', type: 'image/png', size: 10 });
  await integration.processSelectedImage();
  const result = await integration.applyReviewed();
  assert.equal(legacyCalled, false);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(stockOf(f, a.product_id), a.current_stock_quantity + 3);
  assert.match(status.textContent, /Compra aplicada: 1 movimiento/);
});

test('P2-1 motivo elegido llega a CANON; P2-2 2.5 kg se acepta y 2.5 unidades se rechaza', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const maker = await tab(f);
  await maker.api.createProduct({
    product_id: 'LIVE-KG-1', name: 'Azúcar a granel', sku: 'KG-1', barcode: '775009990001', alternate_codes: [], category: 'abarrotes',
    brand: 'Test', description: null, icon: '📦', image: null, unit: 'kilogramo', purchase_unit: 'kilogramo', purchase_factor: 1,
    cost_cents: 100, price_cents: 200, box_price_cents: null, units_per_box: null, initial_stock_quantity: 10, stock_min_quantity: 1,
    expiry_date: null, includes_igv: true, tax_type: 'gravado', complementary_tax: '', tracks_inventory: true,
  });
  const kg = await tab(f, { productId: 'LIVE-KG-1', type: 'salida', token: 'device-b-token', deviceId: 'device-b' });
  kg.el('mMovCant').value = '2.5';
  kg.el('mMovMotivo').value = 'Merma / daño';
  assert.equal(await kg.context.NuevoAmanecerCanonicalInventoryBridge.save(), true, JSON.stringify(kg.toasts));
  const m = f.sql("SELECT reason,delta FROM canonical_manual_inventory_movements WHERE product_id='LIVE-KG-1'");
  assert.equal(m.reason, 'Merma / daño: -2.5');
  assert.equal(m.delta, -2.5);
  assert.equal(stockOf(f, 'LIVE-KG-1'), 7.5);

  const uni = await unitProduct(maker);
  const unit = await tab(f, { productId: uni, type: 'entrada', token: 'inv-c-token', deviceId: 'inv-c' });
  unit.el('mMovCant').value = '2.5';
  unit.el('mMovMotivo').value = 'Compra a proveedor';
  assert.equal(await unit.context.NuevoAmanecerCanonicalInventoryBridge.save(), false);
  assert.match(unit.toasts.at(-1)[0], /unidades enteras/);
  unit.el('mMovCant').value = '4';
  assert.equal(await unit.context.NuevoAmanecerCanonicalInventoryBridge.save(), true);
  assert.equal(f.sql('SELECT reason FROM canonical_manual_inventory_movements WHERE product_id=?', uni).reason, 'Compra a proveedor: +4');
});

test('P2-3 búsqueda: descripción y código de barras ignoran mayúsculas (POS e Inventario)', () => {
  const sinTildes = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const product = { name: 'Leche', descripcion: 'Evaporada ENTERA Gloria', marca: '', sku: '', barcode: 'ABC775X', alternateCodes: [] };
  const line01 = read('POS/js/legacy-inline/inline-01.js').split('\n')[400];
  const body = line01.trim().replace(/^return\s+/, '').replace(/;$/, '');
  const fn = vm.runInNewContext(`(product,search)=>(${body})`, { sinTildes, _naProductAltCodes: () => [] });
  assert.equal(fn(product, 'entera'), true);
  assert.equal(fn(product, 'abc775x'), true);
  const src14 = read('POS/js/legacy-inline/inline-14.js');
  assert.match(src14, /sinTildes\(String\(product\.descripcion\|\|''\)\.toLowerCase\(\)\)\.includes\(search\)/);
  assert.match(src14, /String\(product\.barcode\|\|''\)\.toLowerCase\(\)\.includes\(search\)/);
});
