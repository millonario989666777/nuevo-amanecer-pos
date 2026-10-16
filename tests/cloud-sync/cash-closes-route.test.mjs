import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon } from './canon-browser-harness.mjs';
import { cashClosesRoute } from '../../tools/cloudflare-lab/src/pos-cash-closes.js';

const path = '/auth/cash-closes?desde=2026-10-01&hasta=2026-10-16';
async function call(f, url = path, token = 'owner-token', method = 'GET', body) {
  const r = await f.fetch('http://localhost' + url, { method,
    headers: token ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function setup(t, cashier = true) {
  const f = await activeCanon(t, { migrations: ['0024_pos_roles_owner_pin.sql', ...(cashier ? ['0031_canonical_cash_session_cashier.sql'] : [])] });
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  f.addDevice('employee-phone', 'writer', 'active', 'employee-token');
  f.database.prepare("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES(?,'empleado','Cajera prueba','owner-phone','2026-10-01')")
    .run(f.device('employee-phone').device_id);
  f.closeAt = async (at, work) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
    try { return await work(); } finally { t.mock.timers.reset(); }
  };
  return f;
}
function common(f, operation_id, created_at) {
  const c = f.control();
  return { operation_id, created_at, promotion_id: c.active_promotion_id, authority_epoch: c.authority_epoch,
    expected_control_revision: c.revision, client_contract: 'a6-gate-c-v1' };
}
async function session(f, id, at, { open = false, counted = 950 } = {}) {
  const opened = await call(f, '/commands/cash.open', 'employee-token', 'POST', {
    ...common(f, id + '-open', '2026-09-30T15:00:00.000Z'), session_id: id, opening_cents: 1000 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  if (!open) {
    const closed = await f.closeAt(at, () => call(f, '/commands/cash.close', 'owner-token', 'POST', {
      ...common(f, id + '-close', at), session_id: id, expected_session_revision: 0, counted_cents: counted }));
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
  }
}

test('cash-close report requires authentication and owner role, including the generic route gate', async t => {
  const f = await setup(t);
  await session(f, 'private', '2026-10-16T18:00:00.000Z');
  for (const token of [null, 'invalid-token']) {
    const r = await call(f, path, token);
    assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'unauthorized' });
  }
  for (const url of [path, '/auth/cash-closes']) {
    const r = await call(f, url, 'employee-token');
    assert.equal(r.status, 403); assert.deepEqual(r.body, { error: 'forbidden_role' });
  }
  const direct = await cashClosesRoute(new Request('http://localhost' + path), {
    DB: { prepare() { throw new Error('employee must be rejected before reading report state'); } }
  }, { posRole: 'empleado', principalId: 'employee' }, (body, status) => ({ body, status }));
  assert.deepEqual(direct, { status: 403, body: { error: 'forbidden_role' } });
});

test('owner gets only CLOSED sessions within inclusive Lima days, newest first, with exact report fields', async t => {
  const f = await setup(t);
  await session(f, 'before', '2026-10-01T04:59:59.999Z');
  await session(f, 'first', '2026-10-01T05:00:00Z');
  await session(f, 'middle', '2026-10-10T18:00:00.000Z');
  await session(f, 'last', '2026-10-17T04:59:59.999Z');
  await session(f, 'after', '2026-10-17T05:00:00.000Z');
  await session(f, 'open', null, { open: true });
  const r = await call(f);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.range, { desde: '2026-10-01', hasta: '2026-10-16' });
  assert.deepEqual(r.body.cash_closes.map(s => s.session_id), ['last', 'middle', 'first']);
  assert.deepEqual(r.body.cash_closes[0], { session_id: 'last', status: 'CLOSED',
    opened_at: '2026-09-30T15:00:00.000Z', closed_at: '2026-10-17T04:59:59.999Z',
    opening_cents: 1000, expected_cents: 1000, counted_cents: 950, difference_cents: -50,
    opened_by_name: 'Cajera prueba', closed_by_name: 'Dueño' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const oneDay = await call(f, '/auth/cash-closes?desde=2026-10-16&hasta=2026-10-16');
  assert.deepEqual(oneDay.body.cash_closes.map(s => s.session_id), ['last']);
  const empty = await call(f, '/auth/cash-closes?desde=2026-10-18&hasta=2026-10-18');
  assert.deepEqual(empty.body.cash_closes, []);
  // The operational read must retain all existing fields and remain available to employees.
  const operational = await call(f, '/read/canonical/cash-sessions', 'employee-token');
  assert.equal(operational.status, 200, JSON.stringify(operational.body));
  assert.equal(operational.body.items.length, 6);
  assert.ok(operational.body.items.some(s => s.session_id === 'open' && s.status === 'OPEN'));
  const row = operational.body.items.find(s => s.session_id === 'last');
  assert.equal(row.opened_by_user_id, f.device('employee-phone').device_id);
  assert.equal(row.opened_by_name, 'Cajera prueba');
  assert.equal(row.closed_by_name, 'Dueño');
  assert.equal(row.opened_by_device_id, f.device('employee-phone').device_id);
});

test('missing, malformed, nonexistent, reversed and over-366-day ranges return invalid_range', async t => {
  const f = await setup(t);
  for (const query of ['', 'desde=2026-10-01', 'hasta=2026-10-16', 'desde=&hasta=2026-10-16',
    'desde=2026-02-30&hasta=2026-10-16', 'desde=2025-02-29&hasta=2026-10-16',
    'desde=2026-1-01&hasta=2026-10-16', 'desde=invalid&hasta=2026-10-16',
    'desde=2026-10-17&hasta=2026-10-16', 'desde=2024-01-01&hasta=2025-01-01']) {
    const r = await call(f, '/auth/cash-closes?' + query);
    assert.equal(r.status, 400, query); assert.deepEqual(r.body, { error: 'invalid_range' });
  }
  assert.equal((await call(f, '/auth/cash-closes?desde=2024-01-01&hasta=2024-12-31')).status, 200);
  assert.equal((await call(f, '/auth/cash-closes?desde=2024-02-29&hasta=2024-02-29')).status, 200);
});

test('GET only; schema gaps return not ready and old cashier columns yield null names', async t => {
  const f = await setup(t, false);
  await session(f, 'old', '2026-10-16T18:00:00.000Z');
  const old = await call(f);
  assert.equal(old.status, 200);
  assert.equal(old.body.cash_closes[0].opened_by_name, null);
  assert.equal(old.body.cash_closes[0].closed_by_name, null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await call(f, path, 'owner-token', method);
    assert.equal(r.status, 405); assert.deepEqual(r.body, { error: 'method_not_allowed' });
    assert.equal(r.headers.get('allow'), 'GET, OPTIONS');
  }
  f.database.exec('DROP VIEW canonical_cash_state');
  const missing = await call(f);
  assert.equal(missing.status, 200); assert.deepEqual(missing.body, { cash_closes: [], ready: false });
  assert.equal((await call(f, path, 'employee-token')).status, 403);
});

test('missing dependencies of the cash-state view return not ready', async t => {
  const f = await setup(t);
  f.database.exec('DROP TABLE canonical_expenses');
  const r = await call(f);
  assert.equal(r.status, 200); assert.deepEqual(r.body, { cash_closes: [], ready: false });
});
