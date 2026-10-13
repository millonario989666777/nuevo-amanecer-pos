// Etapa 2 (ítem 11): compra con proveedor y costo. Solo fixtures locales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon } from './canon-browser-harness.mjs';

const read = n => readFileSync(new URL('../../infra/database/migrations/' + n, import.meta.url), 'utf8');
const H = token => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
async function call(f, path, token, body, extra = {}) {
  const r = await f.fetch('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? H(token) : { 'content-type': 'application/json' }), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
async function setup(t, { annul = true } = {}) {
  const f = await activeCanon(t, { migrations: ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql'] });
  try { f.database.exec(read('0010_session_auth.sql').replace(/DROP INDEX[^;]*;/, '')); } catch {}
  f.database.exec(read('0024_pos_roles_owner_pin.sql'));
  f.database.exec(read('0025_pos_reviews_pin_failures.sql'));
  if (annul) f.database.exec(read('0028_pos_purchases.sql'));
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '4821' })).status, 200);
  return f;
}
const ctl = f => { const c = f.control(); return { promotion_id: c.active_promotion_id, client_contract: 'a6-gate-c-v1', authority_epoch: c.authority_epoch, expected_control_revision: c.revision }; };
async function openCash(f) {
  const r = await call(f, '/commands/cash.open', 'owner-token', { ...ctl(f), operation_id: 'open-1', created_at: '2026-10-12T15:00:00.000Z', session_id: 'sess-1', opening_cents: 1000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
async function sell(f, id, method = 'efectivo') {
  const s = f.sql('SELECT stock_revision r FROM products WHERE product_id=?', '00003');
  const pay = method === 'efectivo' ? { cash_cents: 500, digital_cents: 0, credit_cents: 0, digital_method: null, reference: '' }
    : { cash_cents: 0, digital_cents: 500, credit_cents: 0, digital_method: 'yape', reference: 'Y-' + id };
  const r = await call(f, '/commands/sale.create', 'owner-token', { ...ctl(f), operation_id: 'op-' + id, sale_id: id, created_at: '2026-10-12T15:10:00.000Z',
    payment_method: method, total_cents: 500, payment: pay, items: [{ product_id: '00003', quantity: 0.1, unit_price_cents: 5000, line_total_cents: 500, expected_stock_revision: s.r }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
async function approval(f, op) {
}
const stockOf = (f, id) => f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?', id).q;
const purchase = (f, op, lines, extra = {}) => ({ ...ctl(f), operation_id: op, created_at: '2026-10-12T17:00:00.000Z', supplier: 'Distribuidora Sol', document_ref: 'F001-123', lines, ...extra });
const two = () => { return [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 350 }, { line: 2, product_id: '00003', quantity: 1, unit_cost_cents: 350 }]; };

test('one call records supplier, cost and lines, and adds stock once; retry is idempotent', async t => {
  const f = await setup(t);
  const q0 = stockOf(f, '00003');
  const r = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-1', two()));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.total_cost_cents, 1050);
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 3)) < 1e-9);
  const again = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-1', two()));
  assert.deepEqual([again.status, again.body.idempotent], [200, true]);
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 3)) < 1e-9);
  const list = await call(f, '/auth/purchases', 'owner-token');
  assert.equal(list.body.purchases[0].supplier, 'Distribuidora Sol');
  assert.equal(list.body.purchases[0].status, 'aplicada');
  assert.equal(list.body.purchases[0].lines.length, 2);
});

test('lines already applied by the old per-line path are skipped (same operation ids)', async t => {
  const f = await setup(t);
  const s = f.sql('SELECT stock_revision r FROM products WHERE product_id=?', '00003');
  const old = await call(f, '/commands/inventory.adjust', 'owner-token', { ...ctl(f), operation_id: 'buy-2:1', created_at: '2026-10-12T17:00:00.000Z',
    product_id: '00003', movement_type: 'ENTRADA', quantity: 2, expected_stock_revision: s.r, reason: 'Compra OCR buy-2, línea 1: +2' });
  assert.ok([200, 201].includes(old.status), JSON.stringify(old.body));
  const q1 = stockOf(f, '00003');
  const r = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-2', two()));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.skipped.map(x => x.line), [1]);
  assert.ok(Math.abs(stockOf(f, '00003') - (q1 + 1)) < 1e-9);
});

test('employee needs owner approval; bad input 400; unknown product 409 without partial claim loss; no schema 503', async t => {
  const f = await setup(t);
  const code = await call(f, '/auth/pairing-code', 'owner-token', { label: 'Caja 2', pin: '4821' });
  const paired = await call(f, '/auth/pair', null, { code: code.body.code });
  assert.equal(paired.status, 201, JSON.stringify([code, paired]));
  const empToken = paired.body.session_token;
  const emp = await call(f, '/auth/purchases', empToken, purchase(f, 'buy-3', two()));
  assert.deepEqual([emp.status, emp.body.error], [403, 'owner_approval_required']);
  assert.equal((await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-4', []))).status, 400);
  assert.equal((await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-4', [{ line: 1, product_id: '00003', quantity: -1 }]))).status, 400);
  assert.equal((await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-4', two(), { total_cents: 5 }))).status, 400);
  const bad = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-5', [{ line: 1, product_id: 'NOPE', quantity: 1 }]));
  assert.deepEqual([bad.status, bad.body.error], [409, 'purchase_line_failed']);
  const g = await setup(t, { annul: false });
  assert.equal((await call(g, '/auth/purchases', 'owner-token', purchase(g, 'buy-6', two()))).status, 503);
});

test('Bot 6 caso A: id ya aplicado + otra compra con el mismo id -> 409 purchase_payload_mismatch, no suma nada; GET ?id= dice applied', async t => {
  const f = await setup(t);
  const q0 = stockOf(f, '00003');
  assert.equal((await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-a', two()))).status, 201);
  const st = await call(f, '/auth/purchases?id=buy-a', 'owner-token');
  assert.deepEqual([st.status, st.body.status], [200, 'applied']);
  assert.equal((await call(f, '/auth/purchases?id=buy-zz', 'owner-token')).body.status, 'not_found');
  const other = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-a', [{ line: 1, product_id: '00003', quantity: 5, unit_cost_cents: 300 }], { document_ref: 'F001-999' }));
  assert.deepEqual([other.status, other.body.error, other.body.status], [409, 'purchase_payload_mismatch', 'applied']);
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 3)) < 1e-9, 'stock unchanged by the mismatched retry');
});

test('Bot 6 caso B: compra a medias + línea editada con el mismo id -> 409, nada aplicado; las líneas guardadas no cambian', async t => {
  const f = await setup(t);
  const bad = [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 350 }, { line: 2, product_id: 'NO-EXISTE', quantity: 1, unit_cost_cents: 100 }];
  const first = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-b', bad));
  assert.equal(first.status, 409);
  const q1 = stockOf(f, '00003');
  const edited = [{ line: 1, product_id: '00003', quantity: 7, unit_cost_cents: 350 }, { line: 2, product_id: 'NO-EXISTE', quantity: 1, unit_cost_cents: 100 }];
  const r = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-b', edited));
  assert.deepEqual([r.status, r.body.error, r.body.status], [409, 'purchase_payload_mismatch', 'in_progress']);
  assert.ok(Math.abs(stockOf(f, '00003') - q1) < 1e-9, 'nothing applied');
  const lines = f.all('SELECT quantity FROM pos_purchase_lines WHERE purchase_id=? ORDER BY line_number', 'buy-b').map(x => x.quantity);
  assert.deepEqual(lines, [2, 1]);
  const same = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-b', bad));
  assert.equal(same.status, 409); assert.equal(same.body.error, 'purchase_line_failed', 'identical retry still allowed');
});

test('Bot 6 (b) servidor: el estado de una compra a medias dice qué líneas ya sumaron stock', async t => {
  const f = await setup(t);
  const bad = [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 350 }, { line: 2, product_id: 'NO-EXISTE', quantity: 1, unit_cost_cents: 100 }];
  assert.equal((await call(f, '/auth/purchases', 'owner-token', purchase(f, 'buy-p', bad))).status, 409);
  const st = await call(f, '/auth/purchases?id=buy-p', 'owner-token');
  assert.equal(st.body.status, 'in_progress');
  assert.deepEqual(st.body.lines.map(l => [l.line_number, l.product_id, l.applied]), [[1, '00003', true], [2, 'NO-EXISTE', false]]);
});
