// Etapa 2 (G): roles por aparato + PIN del dueño en el servidor. Solo fixtures locales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a6Fixture } from './a6-fixture.mjs';
import { hashPin, PIN_ITERATIONS } from '../../tools/cloudflare-lab/src/pos-roles.js';

const read = n => readFileSync(new URL('../../infra/database/migrations/' + n, import.meta.url), 'utf8');
const roles = read('0024_pos_roles_owner_pin.sql');

async function setup(t, { migrate = true } = {}) {
  const f = await a6Fixture(t);
  f.database.exec(read('0010_session_auth.sql').replace(/DROP INDEX[^;]*;/, ''));
  if (migrate) f.database.exec(roles);
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  return f;
}
const H = token => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
async function call(f, path, token, body, method = body ? 'POST' : 'GET', extra = {}) {
  const r = await f.fetch('http://localhost' + path, { method, headers: { ...(token ? H(token) : { 'content-type': 'application/json' }), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
async function employee(f, pin) {
  const code = await call(f, '/auth/pairing-code', 'owner-token', { label: 'Caja 2', pin });
  assert.equal(code.status, 201);
  assert.match(code.body.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  const paired = await call(f, '/auth/pair', null, { code: code.body.code.toLowerCase() });
  assert.equal(paired.status, 201);
  const again = await call(f, '/auth/pair', null, { code: code.body.code });
  assert.equal(again.status, 401, 'pairing code is single use');
  return paired.body.session_token;
}

test('existing devices are owner; without migration everything keeps working as owner', async t => {
  const f = await setup(t, { migrate: false });
  const me = await call(f, '/auth/me', 'owner-token');
  assert.deepEqual([me.status, me.body.pos_role, me.body.roles_ready], [200, 'owner', false]);
  const g = await setup(t);
  const me2 = await call(g, '/auth/me', 'owner-token');
  assert.deepEqual([me2.body.pos_role, me2.body.owner_pin_set, me2.body.roles_ready], ['owner', false, true]);
});

test('owner sets PIN; stored only as salted PBKDF2; change needs current PIN; lockout after 5 failures', async t => {
  const f = await setup(t);
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '12' })).status, 400);
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '4821' })).status, 200);
  const row = f.sql('SELECT * FROM pos_owner_pin WHERE id=1');
  assert.equal(row.iterations, PIN_ITERATIONS);
  assert.ok(!JSON.stringify(row).includes('4821'));
  assert.equal(await hashPin('4821', row.salt_hex, row.iterations), row.hash_hex);
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '9999' })).status, 403);
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '9999', current_pin: '4821' })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await call(f, '/auth/owner-approval', 'owner-token', { pin: '0000', action: 'reset' })).status, 403);
  const locked = await call(f, '/auth/owner-approval', 'owner-token', { pin: '0000', action: 'reset' });
  assert.equal(locked.status, 429);
  assert.equal((await call(f, '/auth/owner-approval', 'owner-token', { pin: '9999', action: 'reset' })).status, 429, 'locked even with right PIN');
  f.exec("UPDATE pos_owner_pin SET locked_until='2000-01-01T00:00:00.000Z'");
  assert.equal((await call(f, '/auth/owner-approval', 'owner-token', { pin: '9999', action: 'reset' })).status, 201);
});

test('employee device: paired by code, cannot use owner endpoints or owner commands without PIN approval', async t => {
  const f = await setup(t);
  const emp = await employee(f);
  const me = await call(f, '/auth/me', emp);
  assert.equal(me.body.pos_role, 'empleado');
  assert.equal(me.body.label, 'Caja 2');
  for (const p of ['/auth/owner-pin', '/auth/pairing-code', '/auth/devices/revoke', '/settings'])
    assert.equal((await call(f, p, emp, { new_pin: '1111', key: 'x', value: 1 })).body.error, 'owner_only', p);
  assert.equal((await call(f, '/auth/devices', emp, {})).body.error, 'owner_only');
  for (const c of ['inventory.adjust', 'adjustment.create', 'compensation.create', 'product.update', 'customer.credit-policy.set']) {
    const r = await call(f, '/commands/' + c, emp, { operation_id: 'op-' + c });
    assert.deepEqual([r.status, r.body.error], [403, 'owner_approval_required'], c);
    const o = await call(f, '/commands/' + c, 'owner-token', { operation_id: 'op-' + c });
    assert.notEqual(o.body.error, 'owner_approval_required', c);
  }
  // Sin PIN configurado, el empleado queda bloqueado.
  assert.equal((await call(f, '/auth/owner-approval', emp, { pin: '1234', action: 'inventory.adjust', operation_id: 'op-1' })).body.error, 'owner_pin_not_set');
  await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '1234' });
  assert.equal((await call(f, '/auth/owner-approval', emp, { pin: '1234', action: 'inventory.adjust' })).body.error, 'operation_id_required');
  const ap = await call(f, '/auth/owner-approval', emp, { pin: '1234', action: 'inventory.adjust', operation_id: 'op-1' });
  assert.equal(ap.status, 201);
  const other = await call(f, '/commands/inventory.adjust', emp, { operation_id: 'op-2' }, 'POST', { 'x-owner-approval': ap.body.approval_id });
  assert.equal(other.body.error, 'owner_approval_required', 'approval bound to its operation');
  const wrongAction = await call(f, '/commands/product.update', emp, { operation_id: 'op-1' }, 'POST', { 'x-owner-approval': ap.body.approval_id });
  assert.equal(wrongAction.body.error, 'owner_approval_required', 'approval bound to its action');
  const ok = await call(f, '/commands/inventory.adjust', emp, { operation_id: 'op-1' }, 'POST', { 'x-owner-approval': ap.body.approval_id });
  assert.notEqual(ok.body.error, 'owner_approval_required');
  f.exec("UPDATE pos_owner_approvals SET expires_at='2000-01-01T00:00:00.000Z'");
  const expired = await call(f, '/commands/inventory.adjust', emp, { operation_id: 'op-1' }, 'POST', { 'x-owner-approval': ap.body.approval_id });
  assert.equal(expired.body.error, 'owner_approval_required');
  assert.ok(!JSON.stringify(f.database.prepare('SELECT * FROM pos_owner_approvals').all()).includes('1234'));
});

test('owner lists and revokes devices (PIN when set); settings revisioned; expired codes refused', async t => {
  const f = await setup(t);
  const emp = await employee(f);
  const list = await call(f, '/auth/devices', 'owner-token', {});
  const empRow = list.body.devices.find(d => d.pos_role === 'empleado');
  assert.ok(list.body.devices.find(d => d.current && d.pos_role === 'owner'));
  assert.equal((await call(f, '/auth/devices/revoke', 'owner-token', { device_id: 'session:owner-phone' })).status, 409);
  await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '5555' });
  assert.equal((await call(f, '/auth/devices/revoke', 'owner-token', { device_id: empRow.device_id, pin: '0000' })).status, 403);
  assert.equal((await call(f, '/auth/devices/revoke', 'owner-token', { device_id: empRow.device_id, pin: '5555' })).status, 200);
  assert.equal((await call(f, '/auth/me', emp)).status, 403);
  const s1 = await call(f, '/settings', 'owner-token', { key: 'negocio', value: { nombre: 'Tienda' } });
  assert.equal(s1.body.revision, 1);
  assert.equal((await call(f, '/settings', 'owner-token', { key: 'negocio', value: {}, expected_revision: 0 })).status, 409);
  assert.equal((await call(f, '/settings', 'owner-token', { key: 'negocio', value: { nombre: 'B' }, expected_revision: 1 })).body.revision, 2);
  assert.deepEqual((await call(f, '/settings', 'owner-token')).body.settings[0].value, { nombre: 'B' });
  const code = await call(f, '/auth/pairing-code', 'owner-token', { pin: '5555' });
  f.exec("UPDATE pos_pairing_codes SET expires_at='2000-01-01T00:00:00.000Z' WHERE used_at IS NULL");
  assert.equal((await call(f, '/auth/pair', null, { code: code.body.code })).status, 401);
  assert.equal((await call(f, '/auth/pair', null, { code: 'AAAAA-AAAAA' })).status, 401);
});

const reviews = read('0025_pos_reviews_pin_failures.sql');

test('0025: PIN failures lock only the failing device; global cap 20 in 15 min', async t => {
  const f = await setup(t);
  f.database.exec(reviews);
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '4821' })).status, 200);
  const emp = await employee(f, '4821');
  for (let i = 0; i < 4; i++) assert.equal((await call(f, '/auth/owner-approval', emp, { pin: '0000', action: 'discount' })).status, 403);
  assert.equal((await call(f, '/auth/owner-approval', emp, { pin: '0000', action: 'discount' })).status, 429);
  assert.equal((await call(f, '/auth/owner-approval', emp, { pin: '4821', action: 'discount' })).status, 429, 'employee device stays locked');
  assert.equal((await call(f, '/auth/owner-approval', 'owner-token', { pin: '4821', action: 'reset' })).status, 201, 'owner device is not locked by the employee');
  f.exec(`INSERT INTO pos_pin_failures(device_id,failed_count,window_start) VALUES('x1',10,'${new Date().toISOString()}'),('x2',10,'${new Date().toISOString()}')`);
  const g = await call(f, '/auth/owner-approval', 'owner-token', { pin: '4821', action: 'reset' });
  assert.deepEqual([g.status, g.body.scope], [429, 'global']);
});

test('0025: reviews list and owner resolution never edit the sale; rejection records shortage', async t => {
  const f = await setup(t);
  f.database.exec(reviews);
  assert.equal((await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '4821' })).status, 200);
  const emp = await employee(f, '4821');
  const { flagReview } = await import('../../tools/cloudflare-lab/src/pos-roles.js');
  const db = { prepare(sql) { return { sql, args: [], bind(...a) { this.args = a; return this; }, async run() { f.database.prepare(sql).run(...this.args); return {}; } }; } };
  assert.equal(await flagReview(db, { kind: 'discount', ref_id: 'S-1', device_id: 'session:x', amount_cents: 150, detail: { lineas: [] } }), true);
  assert.equal(await flagReview(db, { kind: 'discount', ref_id: 'S-1', device_id: 'session:x', amount_cents: 999 }), true, 'idempotent');
  const list = await call(f, '/auth/reviews', emp);
  assert.deepEqual([list.status, list.body.reviews.length, list.body.reviews[0].amount_cents], [200, 1, 150]);
  assert.equal((await call(f, '/auth/reviews/resolve', emp, { flag_id: 'discount:S-1', decision: 'rechazado' })).status, 403);
  const res = await call(f, '/auth/reviews/resolve', 'owner-token', { flag_id: 'discount:S-1', decision: 'rechazado' });
  assert.deepEqual([res.status, res.body.shortage_cents], [200, 150]);
  assert.equal((await call(f, '/auth/reviews', emp)).body.reviews.length, 0);
  assert.equal((await call(f, '/auth/reviews/resolve', 'owner-token', { flag_id: 'discount:S-1', decision: 'aprobado' })).body.idempotent, true);
});

test('worker wires review flags for employee sales and cash close without changing responses', () => {
  const w = readFileSync(new URL('../../tools/cloudflare-lab/src/worker.js', import.meta.url), 'utf8');
  assert.match(w, /await reviewSale\(request, env, auth, saleResponse, ctx\);\n\s+return saleResponse;/);
  assert.match(w, /if \(closeBody\) await reviewCashClose\(env, auth, financialResponse, closeBody\);\n\s+return financialResponse;/);
  assert.match(w, /if \(auth\.principalId\) \{ if \(auth\.posRole === 'empleado'\) await run\(\); return; \}/, 'owner sales add no round trip');
});
