// P1-1 (auditoría inventario/clientes): editar productos en CANON con
// product.update (revisiones append-only + CAS + códigos únicos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { tursoSqlite } from './turso-sqlite-protocol.mjs';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const BASE = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql', '0018_canonical_customer_credit_policy.sql', '0020_canonical_customer_contacts.sql'];
const MIGRATIONS = [...BASE, '0022_canonical_product_revisions.sql'];
const BRIDGE = ['canonical-product-bridge.js', read('POS/js/sync/canonical-product-bridge.js')];
const product = (id, extra = {}) => ({ product_id: id, name: 'Prod ' + id, sku: id + '-SKU', barcode: id + '-BAR', alternate_codes: [], category: 'test',
  brand: 'T', description: null, icon: '📦', image: null, unit: 'unidad', purchase_unit: 'unidad', purchase_factor: 1, cost_cents: 100,
  price_cents: 250, box_price_cents: 2400, units_per_box: 12, initial_stock_quantity: 10, stock_min_quantity: 0, expiry_date: null,
  includes_igv: true, tax_type: 'gravado', complementary_tax: '', tracks_inventory: true, ...extra });
const edit = (raw, extra = {}) => ({ product_id: raw.product_id, name: raw.name, sku: raw.sku, barcode: raw.barcode,
  alternate_codes: [...new Set(JSON.parse(raw.alternate_codes_json || '[]').concat(raw.legacy_alternate_code || []))].filter((c) => c !== raw.sku && c !== raw.barcode), category: raw.category, brand: raw.brand, description: raw.description,
  icon: raw.icon, cost_cents: raw.cost_cents ?? 0, price_cents: raw.price_cents, box_price_cents: raw.box_price_cents ?? null,
  units_per_box: raw.box_price_cents == null ? null : raw.units_per_box, stock_min_quantity: raw.stock_min_quantity ?? 0, expiry_date: raw.expiry_date ?? null, ...extra });
const find = (tab, id) => tab.api.snapshot().products.find((p) => p.product_id === id);

function fillForm(tab, legacy) {
  const set = (id, v) => { tab.el(id).value = v == null ? '' : String(v); };
  set('pNombre', legacy.name); set('pDescripcion', legacy.descripcion); set('pSku', legacy.sku); set('pBarcode', legacy.barcode);
  set('pMarca', legacy.marca); set('pUnidad', legacy.unidad); set('pUnidadCompra', legacy.unidadCompra); set('pFactorCompra', legacy.factorCompra);
  set('pCosto', legacy.costo); set('pPrecio', legacy.precio); set('pStock', legacy.stock); set('pStockMin', legacy.stockMin);
  set('pVenc', legacy.venc); set('pIcon', legacy.icon); set('pPrecioCaja', legacy.precioCaja); set('pUnidCaja', legacy.unidCaja);
  set('pCat', legacy.cat); set('pTipoImpuesto', legacy.tipoImpuesto || 'gravado'); set('pImpuestoComplementario', legacy.impuestoComplementario);
  tab.el('pIncluyeIGV').checked = legacy.incluyeIGV !== false; tab.el('pControlInventario').checked = legacy.controlInventario !== false;
}
async function editTab(f, id, extra = {}) {
  const globals = { invEditId: id, imagenProducto: null, readAltBarcodes: () => [], invRender() {}, posRender() {}, updateDashboard() {}, ...extra };
  const tab = await device(f, { token: 'edit-token-' + Math.random(), deviceId: 'edit-' + Math.random().toString(36).slice(2), scripts: [BRIDGE], globals });
  return tab;
}

test('product.update edita precio, costo, códigos, mayorista y stock mínimo de un producto LIVE e IMPORTADO sin tocar stock', async (t) => {
  const f = await activeCanon(t, { migrations: MIGRATIONS });
  const a = await device(f, { token: 'pu-a', deviceId: 'pu-a' });
  assert.equal((await a.api.createProduct(product('P-LIVE'))).status, 'created');
  await a.api.refresh();
  const live = find(a, 'P-LIVE');
  assert.equal(live.metadata_revision, 0);
  const before = a.api.snapshot().financial_revision ?? null;
  const r = await a.api.updateProduct(edit(live, { price_cents: 300, cost_cents: 120, barcode: 'NEW-BAR', box_price_cents: 3000, units_per_box: 12, stock_min_quantity: 3 }));
  assert.equal(r.status, 'created'); assert.equal(r.metadata_revision, 1);
  await a.api.refresh();
  const after = find(a, 'P-LIVE');
  assert.equal(after.price_cents, 300); assert.equal(after.cost_cents, 120); assert.equal(after.barcode, 'NEW-BAR');
  assert.equal(after.box_price_cents, 3000); assert.equal(after.stock_min_quantity, 3); assert.equal(after.metadata_revision, 1);
  assert.equal(after.current_stock_quantity, 10, 'stock no cambia');
  if (before !== null) assert.notEqual(a.api.snapshot().financial_revision, before);
  const lp = a.api.legacySnapshot().products.find((p) => String(p.id) === 'P-LIVE');
  assert.equal(lp.precio, 3); assert.equal(lp.metadataRevision, 1);
  // Base row is untouched (immutability triggers stay intact).
  assert.equal(f.sql("SELECT price_cents FROM canonical_live_products WHERE product_id='P-LIVE'").price_cents, 250);
  // Imported product.
  const imp = a.api.snapshot().products.find((p) => p.provenance === 'IMPORT');
  const ri = await a.api.updateProduct(edit(imp, { price_cents: imp.price_cents + 50 }));
  assert.equal(ri.status, 'created');
  await a.api.refresh();
  assert.equal(find(a, imp.product_id).price_cents, imp.price_cents + 50);
  assert.equal(f.sql('SELECT price_cents FROM products WHERE product_id=?', imp.product_id).price_cents, imp.price_cents);
  // Sales keep working against the edited product and stock still moves.
  const sale = await a.api.createSale({ items: [{ product_id: 'P-LIVE', quantity: 2 }], payment_method: 'efectivo' });
  assert.ok(['created', 'already_processed'].includes(sale.status) || sale.sale_id);
  await a.api.refresh();
  assert.equal(find(a, 'P-LIVE').current_stock_quantity, 8);
  assert.equal(find(a, 'P-LIVE').price_cents, 300);
});

test('product.update: CAS stale_product, replay idempotente, códigos únicos con nombre del dueño', async (t) => {
  const f = await activeCanon(t, { migrations: MIGRATIONS });
  const a = await device(f, { token: 'pu-b', deviceId: 'pu-b' });
  await a.api.createProduct(product('P-1')); await a.api.refresh();
  await a.api.createProduct(product('P-2')); await a.api.refresh();
  const p1 = find(a, 'P-1');
  await a.api.updateProduct(edit(p1, { price_cents: 260 })); await a.api.refresh();
  // Stale CAS: same expected revision again.
  await assert.rejects(a.api.updateProduct(edit(p1, { price_cents: 270, expected_metadata_revision: 0 })), /REJECTED_409/);
  assert.equal(a.api.pendingSnapshot().last_error, 'stale_product');
  assert.equal(await a.api.discardRejectedProduct(), true);
  // Code taken by P-2 (barcode) -> 409 product_code_conflict naming P-2.
  await a.api.refresh();
  await assert.rejects(a.api.updateProduct(edit(find(a, 'P-1'), { barcode: 'p-2-bar' })), /REJECTED_409/);
  assert.equal(a.api.pendingSnapshot().last_error, 'product_code_conflict');
  assert.equal(await a.api.discardRejectedProduct(), true);
  const owner = await (await f.fetch('http://localhost/commands/product.update', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pu-b' },
    body: JSON.stringify({ ...edit(find(a, 'P-1'), { barcode: 'P-2-BAR' }), operation_id: 'op-dup-code', promotion_id: f.control().active_promotion_id,
      authority_epoch: f.control().authority_epoch, expected_control_revision: f.control().revision, client_contract: 'a6-gate-c-v1',
      created_at: new Date().toISOString(), expected_metadata_revision: 1 }) })).json();
  assert.equal(owner.error, 'product_code_conflict'); assert.equal(owner.product_id, 'P-2'); assert.equal(owner.product_name, 'Prod P-2');
  // Freed code: P-1 moves its SKU; P-2 may then take the old SKU of P-1 via update.
  await a.api.refresh();
  await a.api.updateProduct(edit(find(a, 'P-1'), { sku: 'P-1-NEW' })); await a.api.refresh();
  const r = await a.api.updateProduct(edit(find(a, 'P-2'), { alternate_codes: ['P-1-SKU'] }));
  assert.equal(r.status, 'created');
  // A new product cannot take a code an edited product now carries.
  await a.api.refresh();
  await assert.rejects(a.api.createProduct(product('P-3', { sku: 'p-1-new', barcode: 'P3-BAR' })), /REJECTED_409/);
  assert.equal(a.api.pendingSnapshot().last_error, 'product_code_conflict');
  assert.equal(await a.api.discardRejectedProduct(), true);
  // Replay of the same durable record answers already_processed.
  await a.api.refresh();
  const raw = { ...edit(find(a, 'P-2'), { price_cents: 999 }), operation_id: 'op-replay', promotion_id: f.control().active_promotion_id,
    authority_epoch: f.control().authority_epoch, expected_control_revision: f.control().revision, client_contract: 'a6-gate-c-v1',
    created_at: '2026-10-12T01:00:00.000Z', expected_metadata_revision: 1 };
  const post = () => f.fetch('http://localhost/commands/product.update', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pu-b' }, body: JSON.stringify(raw) });
  const first = await post(); assert.equal(first.status, 201);
  const second = await post(); assert.equal(second.status, 200); assert.equal((await second.json()).status, 'already_processed');
  assert.throws(() => f.database.exec("UPDATE canonical_product_revisions SET price_cents=1"), /immutable_product_revision/);
  assert.throws(() => f.database.exec("DELETE FROM canonical_product_revisions"), /immutable_product_revision/);
});

test('R3 regresión: el formulario de edición guarda el precio nuevo a través del bridge', async (t) => {
  const f = await activeCanon(t, { migrations: MIGRATIONS });
  const seed = await device(f, { token: 'seed', deviceId: 'seed' });
  await seed.api.createProduct(product('P-EDIT'));
  const tab = await editTab(f, 'P-EDIT');
  const legacy = tab.api.legacySnapshot().products.find((p) => String(p.id) === 'P-EDIT');
  fillForm(tab, legacy);
  tab.el('pPrecio').value = '3.00'; tab.el('pCosto').value = '1.20'; tab.el('pStockMin').value = '4';
  const ok = await tab.context.NuevoAmanecerCanonicalProductBridge.save();
  assert.equal(ok, true, JSON.stringify(tab.toasts));
  assert.equal(find(tab, 'P-EDIT').price_cents, 300);
  assert.equal(find(tab, 'P-EDIT').cost_cents, 120);
  assert.equal(find(tab, 'P-EDIT').stock_min_quantity, 4);
  assert.equal(find(tab, 'P-EDIT').sku, 'P-EDIT-SKU');
  assert.equal(tab.api.pendingSnapshot(), null);
  assert.ok(tab.toasts.some(([m]) => /Producto actualizado/.test(m)));
});

test('edición: cambios no editables (stock) se avisan claro y no envían nada; código ajeno nombra al producto', async (t) => {
  const f = await activeCanon(t, { migrations: MIGRATIONS });
  const seed = await device(f, { token: 'seed2', deviceId: 'seed2' });
  await seed.api.createProduct(product('P-A')); await seed.api.refresh();
  await seed.api.createProduct(product('P-B', { name: 'Galleta B' }));
  const tab = await editTab(f, 'P-A');
  const legacy = tab.api.legacySnapshot().products.find((p) => String(p.id) === 'P-A');
  fillForm(tab, legacy);
  tab.el('pStock').value = '99';
  const posts = () => tab.fetchLog.filter((x) => x.method === 'POST').length;
  const n = posts();
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(), false);
  assert.match(tab.toasts.at(-1)[0], /stock \(usa Entrada\/Salida/);
  fillForm(tab, legacy);
  tab.el('pBarcode').value = 'p-b-bar';
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(), false);
  assert.match(tab.toasts.at(-1)[0], /ya pertenece a «Galleta B»/);
  assert.equal(posts(), n, 'no POST when blocked locally');
});

test('sin migración 0022 la edición se rechaza con mensaje claro y sin dejar operaciones pendientes', async (t) => {
  const f = await activeCanon(t, { migrations: BASE });
  const seed = await device(f, { token: 'seed3', deviceId: 'seed3' });
  await seed.api.createProduct(product('P-OLD'));
  const tab = await editTab(f, 'P-OLD');
  fillForm(tab, tab.api.legacySnapshot().products.find((p) => String(p.id) === 'P-OLD'));
  assert.equal(await tab.context.NuevoAmanecerCanonicalProductBridge.save(), false);
  assert.match(tab.toasts.at(-1)[0], /aún no está activa en el servidor/);
  assert.equal(tab.api.pendingSnapshot(), null);
  assert.equal(find(tab, 'P-OLD').metadata_revision, undefined, 'read shape unchanged without the migration');
});

async function tursoTab(t, migrations, name) {
  const f = await activeCanon(t, { migrations });
  const turso = tursoSqlite(f.database);
  f.env.DB = turso.adapter;
  f.env.nuevo_amanecer_lab = { prepare() { throw Error('D1 must not be used'); } };
  const perRequest = [];
  const a = await device(f, { token: name, deviceId: name, onFetch: async (url, _opt, real) => {
    const before = turso.calls.length; const res = await real(); perRequest.push([new URL(url).pathname, turso.calls.length - before]); return res;
  } });
  return { f, turso, a, perRequest };
}

test('presupuesto Workers Free: product.update en Turso usa ≤6 subrequests y la lectura no suma sentencias', async (t) => {
  const { f, turso, a, perRequest } = await tursoTab(t, MIGRATIONS, 'budget-pu');
  await a.api.createProduct(product('P-BUD')); await a.api.refresh();
  const c = f.control();
  const body = { ...edit(find(a, 'P-BUD'), { price_cents: 333 }), operation_id: 'op-budget', promotion_id: c.active_promotion_id,
    authority_epoch: c.authority_epoch, expected_control_revision: c.revision, client_contract: 'a6-gate-c-v1',
    created_at: '2026-10-12T01:00:00.000Z', expected_metadata_revision: 0 };
  const start = turso.calls.length;
  const t0 = performance.now();
  const res = await f.fetch('http://localhost/commands/product.update', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer budget-pu' }, body: JSON.stringify(body) });
  const ms = performance.now() - t0;
  assert.equal(res.status, 201);
  const calls = turso.calls.length - start;
  // session auth + preflight + replay probe + product/codes + insert. Workers Free allows 50.
  assert.ok(calls <= 6, 'product.update Turso calls=' + calls);
  console.log(`product.update turso_calls=${calls} wall_ms_including_sqlite=${ms.toFixed(1)}`);
  await a.api.refresh();
  assert.equal(find(a, 'P-BUD').price_cents, 333);
  void perRequest;
  const sequential = async (fx, turso, token) => {
    const out = {};
    for (const route of ['status', 'products', 'customers', 'snapshot']) {
      const before = turso.calls.length;
      const r = await fx.fetch('http://localhost/read/canonical/' + route + (route === 'products' ? '?limit=250' : ''), { headers: { authorization: 'Bearer ' + token } });
      assert.equal(r.status, 200, route);
      out[route] = turso.calls.length - before;
    }
    return out;
  };
  const withRevisions = await sequential(f, turso, 'budget-pu');
  assert.ok(Object.values(withRevisions).every((n) => n <= 50), JSON.stringify(withRevisions));
  // Same read plan without the migration: the overlay adds zero statements per request.
  const old = await tursoTab(t, BASE, 'budget-old');
  await old.a.api.createProduct(product('P-BUD'));
  const withoutRevisions = await sequential(old.f, old.turso, 'budget-old');
  console.log('read turso calls with 0022', JSON.stringify(withRevisions), 'without', JSON.stringify(withoutRevisions));
  assert.deepEqual(withRevisions, withoutRevisions);
});
