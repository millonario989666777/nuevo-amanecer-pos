// Bot 6: pruebas extra locales (datos inventados). Reusa el arnés de pos-purchases.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon } from './canon-browser-harness.mjs';
const read = n => readFileSync(new URL('../../infra/database/migrations/' + n, import.meta.url), 'utf8');
const H = t => ({ authorization: 'Bearer ' + t, 'content-type': 'application/json' });
async function call(f, path, token, body) { const r = await f.fetch('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: H(token), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; }
async function setup(t) {
  const f = await activeCanon(t, { migrations: ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql'] });
  try { f.database.exec(read('0010_session_auth.sql').replace(/DROP INDEX[^;]*;/, '')); } catch {}
  f.database.exec(read('0024_pos_roles_owner_pin.sql')); f.database.exec(read('0025_pos_reviews_pin_failures.sql')); f.database.exec(read('0028_pos_purchases.sql'));
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '4821' })).status, 200);
  return f;
}
const ctl = f => { const c = f.control(); return { promotion_id: c.active_promotion_id, client_contract: 'a6-gate-c-v1', authority_epoch: c.authority_epoch, expected_control_revision: c.revision }; };
const stockOf = (f, id) => f.sql('SELECT current_stock_quantity q FROM products WHERE product_id=?', id).q;
const P = (f, op, lines) => ({ ...ctl(f), operation_id: op, created_at: '2026-10-13T15:00:00.000Z', supplier: 'Prov Inventado', document_ref: 'F9-1', lines });
const kardex = (f, op) => f.all("SELECT operation_id FROM canonical_inventory_operations WHERE operation_id LIKE ?", op + ':%').length;

test('B6-1 respuesta perdida + reintento identico: stock sube una vez, kardex 1 por linea', async t => {
  const f = await setup(t); const q0 = stockOf(f, '00003');
  const L = [{ line: 1, product_id: '00003', quantity: 4, unit_cost_cents: 300 }];
  assert.equal((await call(f, '/auth/purchases', 'owner-token', P(f, 'b6-1', L))).status, 201);
  const r = await call(f, '/auth/purchases', 'owner-token', P(f, 'b6-1', L));
  assert.equal(r.status, 200); assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 4)) < 1e-9); assert.equal(kardex(f, 'b6-1'), 1);
});
test('B6-2 dos compras seguidas con ids distintos: cada una suma una vez', async t => {
  const f = await setup(t); const q0 = stockOf(f, '00003');
  for (const [op, q] of [['b6-2a', 2], ['b6-2b', 3]]) for (let i = 0; i < 2; i++) await call(f, '/auth/purchases', 'owner-token', P(f, op, [{ line: 1, product_id: '00003', quantity: q, unit_cost_cents: 300 }]));
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 5)) < 1e-9); assert.equal(kardex(f, 'b6-2a') + kardex(f, 'b6-2b'), 2);
});
test('B6-3 compra a medias: "Terminar compra" con el mismo id y lineas guardadas suma solo lo que falta', async t => {
  const f = await setup(t); const q0 = stockOf(f, '00003');
  const L = [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 300 }, { line: 2, product_id: 'NO-EXISTE', quantity: 1, unit_cost_cents: 100 }];
  assert.equal((await call(f, '/auth/purchases', 'owner-token', P(f, 'b6-3', L))).status, 409);
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 2)) < 1e-9);
  // Terminar desde Historial: mismas lineas guardadas. El producto sigue sin existir -> queda atascada para siempre.
  const fin = await call(f, '/auth/purchases', 'owner-token', P(f, 'b6-3', L));
  assert.equal(fin.status, 409); assert.equal(fin.body.detail && fin.body.detail.error, 'product_not_found');
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 2)) < 1e-9, 'linea 1 no se duplica');
  assert.equal(kardex(f, 'b6-3'), 1);
  const st = await call(f, '/auth/purchases?id=b6-3', 'owner-token'); assert.equal(st.body.status, 'in_progress');
});

// Ítems 8/9 (lote 13-oct): Historial siempre trae las incompletas; «Cerrar como parcial» solo dueño con PIN + motivo.
async function setup29(t) { const f = await setup(t); f.database.exec(read('0029_pos_purchase_closures.sql')); return f; }
const CP = (f, tok, body) => call(f, '/auth/purchases/close-partial', tok, body);
test('B6-9 cerrar como parcial: conserva lo aplicado, no toca stock, idempotente; luego el mismo id da 409 closed', async t => {
  const f = await setup29(t); const q0 = stockOf(f, '00003');
  const L = [{ line: 1, product_id: '00003', quantity: 2, unit_cost_cents: 300 }, { line: 2, product_id: 'NO-EXISTE', quantity: 1, unit_cost_cents: 100 }];
  assert.equal((await call(f, '/auth/purchases', 'owner-token', P(f, 'b6-9', L))).status, 409);
  const k0 = kardex(f, 'b6-9');
  assert.equal((await CP(f, 'owner-token', { purchase_id: 'b6-9', reason: 'x', pin: '4821' })).status, 400, 'motivo obligatorio');
  assert.equal((await CP(f, 'owner-token', { purchase_id: 'b6-9', reason: 'Producto dado de baja', pin: '0000' })).body.error, 'owner_pin_invalid');
  const r = await CP(f, 'owner-token', { purchase_id: 'b6-9', reason: 'Producto dado de baja', pin: '4821' });
  assert.equal(r.status, 201); assert.deepEqual(r.body.applied_lines.map(l => l.line), [1]); assert.deepEqual(r.body.missing_lines.map(l => l.line), [2]);
  const again = await CP(f, 'owner-token', { purchase_id: 'b6-9', reason: 'Producto dado de baja', pin: '4821' });
  assert.equal(again.status, 200); assert.equal(again.body.idempotent, true);
  assert.ok(Math.abs(stockOf(f, '00003') - (q0 + 2)) < 1e-9); assert.equal(kardex(f, 'b6-9'), k0);
  const retry = await call(f, '/auth/purchases', 'owner-token', P(f, 'b6-9', L));
  assert.equal(retry.status, 409); assert.equal(retry.body.status, 'closed'); assert.equal(kardex(f, 'b6-9'), k0);
  const st = await call(f, '/auth/purchases?id=b6-9', 'owner-token'); assert.equal(st.body.status, 'closed_partial');
  const audit = f.sql('SELECT reason,principal_id FROM pos_purchase_closures WHERE purchase_id=?', 'b6-9'); assert.equal(audit.reason, 'Producto dado de baja');
});
test('B6-9 empleado: 403 owner_only', async t => {
  const f = await setup29(t);
  f.addDevice('emp-phone', 'writer', 'active', 'emp-token');
  f.database.prepare("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('emp-phone','empleado','owner-phone','2026-10-13T00:00:00Z'),('session:emp-phone','empleado','owner-phone','2026-10-13T00:00:00Z')").run();
  const e = await CP(f, 'emp-token', { purchase_id: 'x1', reason: 'Motivo', pin: '4821' }); assert.equal(e.status, 403, JSON.stringify(e.body)); assert.equal(e.body.error, 'owner_only');
});
test('B6-8 Historial incluye compras incompletas aunque haya más de 300 recientes', async t => {
  const f = await setup29(t);
  const L = [{ line: 1, product_id: 'NO-EXISTE', quantity: 1, unit_cost_cents: 100 }];
  await call(f, '/auth/purchases', 'owner-token', { ...P(f, 'b6-old', L), created_at: '2020-01-01T00:00:00.000Z' });
  f.database.exec('UPDATE pos_purchases SET created_at=\'2020-01-01T00:00:00.000Z\' WHERE purchase_id=\'b6-old\'');
  const ins = f.database.prepare("INSERT INTO pos_purchases(purchase_id,promotion_id,total_cost_cents,line_count,status,principal_id,created_at) VALUES(?,?,0,1,'aplicada','x',?)");
  const pr = f.control().active_promotion_id;
  for (let i = 0; i < 305; i++) ins.run('r' + i, pr, '2026-10-0' + (1 + i % 9) + 'T00:00:00Z');
  const list = await call(f, '/auth/purchases', 'owner-token');
  assert.ok(list.body.purchases.some(p => p.purchase_id === 'b6-old' && p.status === 'en_curso'));
});
