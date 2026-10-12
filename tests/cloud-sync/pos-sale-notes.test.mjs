// Etapa 2 (ítem 10): nota de venta en el servidor. Solo fixtures locales.
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
  if (annul) f.database.exec(read('0027_pos_sale_notes.sql'));
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
const money = f => f.sql("SELECT total_cents t FROM sales WHERE sale_id='sale-a'").t;

test('note is stored apart, is idempotent, can be edited and never changes the amount', async t => {
  const f = await setup(t); await openCash(f); await sell(f, 'sale-a');
  const c0 = f.sql("SELECT expected_cents e FROM canonical_cash_state WHERE session_id='sess-1'").e;
  let r = await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'sale-a', note: '  Entregar  mañana ' });
  assert.deepEqual([r.status, r.body.note], [200, 'Entregar mañana']);
  r = await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'sale-a', note: 'Entregar mañana' });
  assert.equal(r.status, 200);
  r = await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'sale-a', note: 'Paga el lunes' });
  assert.equal(r.status, 200);
  assert.equal(f.sql('SELECT COUNT(*) n FROM pos_sale_notes').n, 1);
  r = await call(f, '/auth/sale-notes', 'owner-token');
  assert.deepEqual(r.body.notes.map(n => [n.sale_id, n.note]), [['sale-a', 'Paga el lunes']]);
  assert.equal(money(f), 500);
  assert.equal(f.sql("SELECT expected_cents e FROM canonical_cash_state WHERE session_id='sess-1'").e, c0);
});

test('unknown sale is 404 (client keeps it queued), bad input is 400, missing schema is 503', async t => {
  const f = await setup(t);
  assert.equal((await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'nope', note: 'x' })).status, 404);
  assert.equal((await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'nope', note: '' })).status, 400);
  assert.equal((await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'nope', note: 'x', total_cents: 1 })).status, 400);
  assert.equal((await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'nope', note: 'x'.repeat(301) })).status, 400);
  const g = await setup(t, { annul: false });
  assert.equal((await call(g, '/auth/sale-notes', 'owner-token', { sale_id: 'nope', note: 'x' })).status, 503);
  assert.deepEqual((await call(g, '/auth/sale-notes', 'owner-token')).body, { notes: [], ready: false });
  assert.equal((await call(g, '/auth/sale-notes', 'bad-token')).status, 401);
});

test('payment comment uses pay:<operation_id>; record-meta names who attended (device label, no row = Dueño)', async t => {
  const f = await setup(t); await openCash(f); await sell(f, 'sale-a');
  const credit = f.sql("SELECT credit_id, revision FROM canonical_credit_balances WHERE current_balance_cents>=100 LIMIT 1");
  const r0 = await call(f, '/commands/payment.create', 'owner-token', { ...ctl(f), operation_id: 'pay-op-1', created_at: '2026-10-12T16:00:00.000Z',
    credit_id: credit.credit_id, expected_credit_revision: credit.revision, amount_cents: 100, payment_method: 'yape', reference: 'Y-77' });
  assert.ok([200, 201].includes(r0.status), JSON.stringify(r0.body));
  assert.equal((await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'pay:pay-op-1', note: 'Pagó su hija' })).status, 200);
  assert.equal((await call(f, '/auth/sale-notes', 'owner-token', { sale_id: 'pay:nope', note: 'x' })).status, 404);
  let m = await call(f, '/auth/record-meta', 'owner-token');
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.sales.find(s => s.sale_id === 'sale-a').cashier, 'Dueño');
  assert.deepEqual(m.body.payments.find(p => p.operation_id === 'pay-op-1').cashier, 'Dueño');
  const dev = f.sql("SELECT device_id d FROM sales WHERE sale_id='sale-a'").d;
  f.database.prepare("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES(?,'owner','Rosa','t','2026-10-12')").run(dev);
  m = await call(f, '/auth/record-meta', 'owner-token');
  assert.equal(m.body.sales.find(s => s.sale_id === 'sale-a').cashier, 'Rosa');
  assert.equal((await call(f, '/auth/record-meta', 'bad-token')).status, 401);
});
