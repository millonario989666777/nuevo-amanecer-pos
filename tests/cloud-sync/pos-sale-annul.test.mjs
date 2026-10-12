// Etapa 2 (G, punto 4): anular venta CANON en el servidor. Solo fixtures locales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon } from './canon-browser-harness.mjs';

const read = n => readFileSync(new URL('../../infra/database/migrations/' + n, import.meta.url), 'utf8');
const H = token => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
async function call(f, path, token, body, extra = {}) {
  const r = await f.fetch('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { ...H(token), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
async function setup(t, { annul = true } = {}) {
  const f = await activeCanon(t, { migrations: ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql'] });
  try { f.database.exec(read('0010_session_auth.sql').replace(/DROP INDEX[^;]*;/, '')); } catch {}
  f.database.exec(read('0024_pos_roles_owner_pin.sql'));
  f.database.exec(read('0025_pos_reviews_pin_failures.sql'));
  if (annul) f.database.exec(read('0026_pos_sale_annulments.sql'));
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
  const r = await call(f, '/auth/owner-approval', 'owner-token', { pin: '4821', action: 'sale.annul', operation_id: op });
  assert.equal(r.status, 201); return r.body.approval_id;
}
const body = (f, op, saleId) => ({ ...ctl(f), operation_id: op, sale_id: saleId, created_at: '2026-10-12T16:00:00.000Z', reason: 'Cliente devolvió el producto' });
const stock = f => f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?', '00003').q;
const cash = f => f.sql("SELECT expected_cents e FROM canonical_cash_state WHERE session_id='sess-1'").e;

test('annul needs owner PIN approval, even on the owner device', async t => {
  const f = await setup(t); await openCash(f); await sell(f, 'sale-a');
  const r = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-1', 'sale-a'));
  assert.deepEqual([r.status, r.body.error], [403, 'owner_approval_required']);
  assert.equal(f.sql('SELECT COUNT(*) n FROM pos_sale_annulments').n, 0);
});

test('cash sale: stock and cash return exactly once; retry is idempotent; another operation is refused', async t => {
  const f = await setup(t); await openCash(f); await sell(f, 'sale-a');
  const q0 = stock(f), c0 = cash(f);
  const apr = await approval(f, 'annul-1');
  const r = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-1', 'sale-a'), { 'x-owner-approval': apr });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.cash_refund_cents, 500);
  assert.ok(Math.abs(stock(f) - (q0 + 0.1)) < 1e-9);
  assert.equal(cash(f), c0 - 500);
  const again = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-1', 'sale-a'), { 'x-owner-approval': apr });
  assert.deepEqual([again.status, again.body.idempotent], [200, true]);
  assert.ok(Math.abs(stock(f) - (q0 + 0.1)) < 1e-9, 'stock returns once');
  assert.equal(cash(f), c0 - 500, 'cash returns once');
  const apr2 = await approval(f, 'annul-2');
  const other = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-2', 'sale-a'), { 'x-owner-approval': apr2 });
  assert.deepEqual([other.status, other.body.error], [409, 'already_annulled']);
  assert.ok(Math.abs(stock(f) - (q0 + 0.1)) < 1e-9);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE sale_id=?', 'sale-a').n, 1, 'sale is never deleted');
  const list = await call(f, '/commands/sale.annul', 'owner-token');
  assert.deepEqual(list.body.annulments.map(a => [a.sale_id, a.status]), [['sale-a', 'anulada']]);
});

test('digital sale returns stock, no cash; approval is bound to the operation', async t => {
  const f = await setup(t); await openCash(f); await sell(f, 'sale-d', 'yape');
  const c0 = cash(f), q0 = stock(f);
  const wrong = await approval(f, 'other-op');
  const denied = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-d', 'sale-d'), { 'x-owner-approval': wrong });
  assert.equal(denied.status, 403);
  const apr = await approval(f, 'annul-d');
  const r = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-d', 'sale-d'), { 'x-owner-approval': apr });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.cash_refund_cents, r.body.digital_to_refund_cents], [0, 500]);
  assert.equal(cash(f), c0);
  assert.ok(Math.abs(stock(f) - (q0 + 0.1)) < 1e-9);
});

test('without migration 0026 the server refuses cleanly and changes nothing', async t => {
  const f = await setup(t, { annul: false }); await openCash(f); await sell(f, 'sale-a');
  const q0 = stock(f);
  const apr = await approval(f, 'annul-1');
  const r = await call(f, '/commands/sale.annul', 'owner-token', body(f, 'annul-1', 'sale-a'), { 'x-owner-approval': apr });
  assert.deepEqual([r.status, r.body.error], [503, 'annul_schema_not_ready']);
  assert.equal(stock(f), q0);
});
