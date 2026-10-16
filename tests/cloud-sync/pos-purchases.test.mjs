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

test('cost redaction is pure, fails closed and preserves owner bytes', async () => {
  const { redactPurchasesForRole } = await import('../../tools/cloudflare-lab/src/pos-purchases.js');
  const row = { supplier: 'Sol', total_cost_cents: 300, document_ref: 'F1', lines: [{ quantity: 3, unit_cost_cents: 100, lots: [] }] };
  for (const payload of [{ purchases: [row], truncated: false }, { purchase: row, lines: row.lines, status: 'in_progress' }]) {
    const before = JSON.stringify(payload);
    assert.equal(redactPurchasesForRole(payload, 'owner'), payload);
    assert.equal(JSON.stringify(redactPurchasesForRole(payload, 'owner')), before);
    for (const role of ['empleado', undefined, 'unknown']) {
      const out = redactPurchasesForRole(payload, role), p = out.purchase || out.purchases[0];
      assert.equal('supplier' in p, false); assert.equal('total_cost_cents' in p, false);
      for (const l of [...p.lines, ...(out.lines || [])]) assert.equal('unit_cost_cents' in l, false);
    }
    assert.equal(JSON.stringify(payload), before);
  }
});

test('employee GET hides costs; resume ignores supplier/cost changes but rejects purchase changes', async t => {
  const f = await setup(t);
  f.database.exec(read('0030_canonical_stock_lots.sql'));
  f.addDevice('emp-phone', 'writer', 'active', 'emp-token');
  f.database.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('emp-phone','empleado','owner-phone','2026-10-13'),('session:emp-phone','empleado','owner-phone','2026-10-13')");
  const lines = [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 350, lots: [{ lot_code: 'A', expiry_date: '2027-01-01', quantity: 2 }] }, { line: 7, product_id: 'NOPE', quantity: 1, unit_cost_cents: 120 }];
  assert.equal((await call(f, '/auth/purchases', 'owner-token', purchase(f, 'hidden-1', lines))).status, 409);
  for (const path of ['/auth/purchases', '/auth/purchases?id=hidden-1']) {
    const r = await call(f, path, 'emp-token');
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.body), /"supplier"|"total_cost_cents"|"unit_cost_cents"/);
    const owner = await call(f, path, 'owner-token');
    assert.match(JSON.stringify(owner.body), /"supplier":"Distribuidora Sol"/);
    assert.match(JSON.stringify(owner.body), /"unit_cost_cents":350/);
  }
  const body = purchase(f, 'hidden-1', lines.map(({ unit_cost_cents, ...l }) => l));
  delete body.supplier;
  const ap = await call(f, '/auth/owner-approval', 'emp-token', { pin: '4821', action: 'inventory.adjust', operation_id: 'hidden-1' });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const headers = { 'x-owner-approval': ap.body.approval_id };
  const q = stockOf(f, '00003');
  const resumed = await call(f, '/auth/purchases', 'emp-token', body, headers);
  assert.equal(resumed.status, 409, JSON.stringify(resumed));
  assert.equal(resumed.body.error, 'purchase_line_failed', JSON.stringify(resumed));
  assert.equal(resumed.body.detail.error, 'product_not_found');
  for (const extra of [{ supplier: 'Otro' }, { lines: [{ ...body.lines[0], unit_cost_cents: null }, body.lines[1]] }]) {
    const r = await call(f, '/auth/purchases', 'emp-token', { ...body, ...extra }, headers);
    assert.deepEqual(r, resumed);
  }
  for (const extra of [
    { document_ref: 'F001-999' },
    { lines: [{ ...body.lines[0], quantity: 3 }, body.lines[1]] },
    { lines: [{ ...body.lines[0], product_id: 'NOPE' }, body.lines[1]] },
    { lines: [...body.lines, { line: 8, product_id: '00003', quantity: 1, unit_cost_cents: 500 }] },
    { lines: [{ ...body.lines[0], lots: [{ ...body.lines[0].lots[0], lot_code: 'B' }] }, body.lines[1]] }
  ]) {
    const r = await call(f, '/auth/purchases', 'emp-token', { ...body, ...extra }, headers);
    assert.deepEqual([r.status, r.body.error, r.body.status], [409, 'purchase_payload_mismatch', 'in_progress'], JSON.stringify(r));
  }
  assert.equal(stockOf(f, '00003'), q);
  const ownerMissing = await call(f, '/auth/purchases', 'owner-token', body);
  assert.equal(ownerMissing.body.error, 'purchase_payload_mismatch');
});

test('employee retries an in-progress purchase with correct, wrong or null costs/supplier return identical responses', async t => {
  const f = await setup(t);
  f.addDevice('emp-phone', 'writer', 'active', 'emp-token');
  f.database.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('emp-phone','empleado','owner-phone','2026-10-13'),('session:emp-phone','empleado','owner-phone','2026-10-13')");
  const lines = [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 350 }, { line: 7, product_id: 'NOPE', quantity: 1, unit_cost_cents: 120 }, { line: 9, product_id: 'NOPE', quantity: 1, unit_cost_cents: null }];
  const body = purchase(f, 'hidden-retries', lines);
  const first = await call(f, '/auth/purchases', 'owner-token', body);
  assert.deepEqual([first.status, first.body.error], [409, 'purchase_line_failed']);
  const state = await call(f, '/auth/purchases?id=hidden-retries', 'owner-token');
  assert.equal(state.body.status, 'in_progress');
  assert.deepEqual(state.body.lines.map(l => l.unit_cost_cents), [350, 120, null]);
  const q = stockOf(f, '00003');
  const ap = await call(f, '/auth/owner-approval', 'emp-token', { pin: '4821', action: 'inventory.adjust', operation_id: body.operation_id });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const headers = { 'x-owner-approval': ap.body.approval_id };
  const correct = await call(f, '/auth/purchases', 'emp-token', body, headers);
  const wrong = await call(f, '/auth/purchases', 'emp-token', { ...body, supplier: 'Otro', lines: lines.map(l => ({ ...l, unit_cost_cents: 999 })) }, headers);
  const nulled = await call(f, '/auth/purchases', 'emp-token', { ...body, supplier: null, lines: lines.map(l => ({ ...l, unit_cost_cents: null })) }, headers);
  assert.deepEqual([correct.status, correct.body.error, correct.body.detail.error], [409, 'purchase_line_failed', 'product_not_found']);
  assert.deepEqual(wrong, correct);
  assert.deepEqual(nulled, correct);
  assert.equal(stockOf(f, '00003'), q);
  assert.deepEqual(await call(f, '/auth/purchases?id=hidden-retries', 'owner-token'), state);
});

test('employee first-time POST preserves the submitted cost when there is no saved claim', async t => {
  const f = await setup(t);
  f.addDevice('emp-phone', 'writer', 'active', 'emp-token');
  f.database.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('emp-phone','empleado','owner-phone','2026-10-13'),('session:emp-phone','empleado','owner-phone','2026-10-13')");
  const body = purchase(f, 'emp-new-cost', [{ line: 7, product_id: '00003', quantity: 2, unit_cost_cents: 275 }]);
  assert.equal((await call(f, '/auth/purchases?id=emp-new-cost', 'owner-token')).body.status, 'not_found');
  const ap = await call(f, '/auth/owner-approval', 'emp-token', { pin: '4821', action: 'inventory.adjust', operation_id: body.operation_id });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const created = await call(f, '/auth/purchases', 'emp-token', body, { 'x-owner-approval': ap.body.approval_id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const saved = await call(f, '/auth/purchases?id=emp-new-cost', 'owner-token');
  assert.deepEqual([saved.status, saved.body.status], [200, 'applied']);
  assert.equal(saved.body.lines[0].unit_cost_cents, 275);
  assert.equal(saved.body.purchase.total_cost_cents, 550);
});

test('employee POST 201 response omits supplier and total; owner response keeps them', async t => {
  const f = await setup(t);
  f.addDevice('emp-phone', 'writer', 'active', 'emp-token');
  f.database.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('emp-phone','empleado','owner-phone','2026-10-13'),('session:emp-phone','empleado','owner-phone','2026-10-13')");
  const ap = await call(f, '/auth/owner-approval', 'emp-token', { pin: '4821', action: 'inventory.adjust', operation_id: 'emp-buy-1' });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const e = await call(f, '/auth/purchases', 'emp-token', purchase(f, 'emp-buy-1', two()), { 'x-owner-approval': ap.body.approval_id });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal('supplier' in e.body, false); assert.equal('total_cost_cents' in e.body, false);
  const o = await call(f, '/auth/purchases', 'owner-token', purchase(f, 'own-buy-1', two()));
  assert.equal(o.status, 201); assert.equal(o.body.supplier, 'Distribuidora Sol'); assert.equal(o.body.total_cost_cents, 1050);
  const list = await call(f, '/auth/purchases', 'owner-token');
  const mine = list.body.purchases.find(p => p.purchase_id === 'emp-buy-1');
  assert.deepEqual([mine.supplier, mine.total_cost_cents, mine.lines[0].unit_cost_cents], ['Distribuidora Sol', 1050, 350]);
});
