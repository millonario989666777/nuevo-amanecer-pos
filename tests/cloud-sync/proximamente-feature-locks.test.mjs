import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { activeCanon } from './canon-browser-harness.mjs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const addedIds = ['venta-exitosa-comprobante', 'clonar-venta', 'nota-credito-parcial-compras', 'clientes-dias-credito', 'credito-cuotas', 'reparto-abono-multiples-deudas'];

test('real Worker authenticates then returns feature_locked for every locked registry id without writes', async t => {
  const f = await activeCanon(t, { migrations: ['0024_pos_roles_owner_pin.sql'] });
  f.addDevice('feature-owner', 'writer', 'active', 'feature-owner-token');
  f.addDevice('feature-employee', 'writer', 'active', 'feature-employee-token');
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('session:feature-employee','empleado','test','2026-10-15T00:00:00Z')");
  const context = vm.createContext({});
  vm.runInContext(readFileSync('POS/js/modules/proximamente-registry.js', 'utf8'), context);
  const ids = context.NA_PROXIMAMENTE_REGISTRY.map(f => f.id).filter(id => PERMISSIONS.featureLocked(id));
  for (const id of addedIds) assert.ok(ids.includes(id), id);
  const before = f.database.prepare('SELECT * FROM canonical_control').all();
  for (const id of [...ids, 'unknown-feature']) {
    for (const method of ['GET', 'POST']) {
      const response = await f.fetch('http://localhost/features/' + id, { method, headers: { authorization: 'Bearer feature-owner-token' } });
      assert.equal(response.status, 403, id);
      assert.equal((await response.json()).error, 'feature_locked', id);
    }
  }
  for (const method of ['GET', 'POST']) {
    const denied = await f.fetch('http://localhost/features/asistencia-empleados', { method, headers: { authorization: 'Bearer feature-employee-token' } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'forbidden_role');
  }
  assert.equal(PERMISSIONS.routeRoles('/features/asistencia-empleados', 'GET').includes('empleado'), false, 'role restriction is independent of the lock');
  const missing = await f.fetch('http://localhost/features/' + addedIds[0]);
  assert.equal(missing.status, 401);
  assert.deepEqual(f.database.prepare('SELECT * FROM canonical_control').all(), before);
});

test('rotacion-abc is unlocked on client and server; owner-only feature route, no writes', async t => {
  assert.equal(PERMISSIONS.FEATURE_LOCKS['rotacion-abc'], false);
  assert.equal(PERMISSIONS.featureLocked('rotacion-abc'), false);
  const f = await activeCanon(t, { migrations: ['0024_pos_roles_owner_pin.sql'] });
  f.addDevice('unlock-owner', 'writer', 'active', 'unlock-owner-token');
  f.addDevice('unlock-employee', 'writer', 'active', 'unlock-employee-token');
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('session:unlock-employee','empleado','test','2026-10-15T00:00:00Z')");
  const before = f.database.prepare('SELECT * FROM canonical_control').all();
  for (const method of ['GET', 'POST']) {
    const owner = await f.fetch('http://localhost/features/rotacion-abc', { method, headers: { authorization: 'Bearer unlock-owner-token' } });
    assert.equal(owner.status, 404);
    assert.notEqual((await owner.json()).error, 'feature_locked');
    const employee = await f.fetch('http://localhost/features/rotacion-abc', { method, headers: { authorization: 'Bearer unlock-employee-token' } });
    assert.equal(employee.status, 403);
    assert.equal((await employee.json()).error, 'forbidden_role');
  }
  assert.deepEqual(f.database.prepare('SELECT * FROM canonical_control').all(), before);
});

test('clientes-filtro-deuda is unlocked on client and server (no feature_locked, no writes)', async t => {
  assert.equal(PERMISSIONS.FEATURE_LOCKS['clientes-filtro-deuda'], false);
  assert.equal(PERMISSIONS.featureLocked('clientes-filtro-deuda'), false);
  const f = await activeCanon(t, { migrations: ['0024_pos_roles_owner_pin.sql'] });
  f.addDevice('filter-owner', 'writer', 'active', 'filter-owner-token');
  const before = f.database.prepare('SELECT * FROM canonical_control').all();
  for (const method of ['GET', 'POST']) {
    const response = await f.fetch('http://localhost/features/clientes-filtro-deuda', { method, headers: { authorization: 'Bearer filter-owner-token' } });
    const body = await response.json();
    assert.notEqual(body.error, 'feature_locked');
    assert.equal(response.status, 404);
  }
  assert.deepEqual(f.database.prepare('SELECT * FROM canonical_control').all(), before);
});
