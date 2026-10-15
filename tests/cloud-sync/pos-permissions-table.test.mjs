import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS as p } from '../../tools/cloudflare-lab/src/pos-permissions.js';

test('role policy is deeply frozen and fails closed for unknown identities', () => {
  for (const id of Object.keys(p.SCREENS)) assert.equal(p.canAccessScreen('owner', id), true);
  for (const action of Object.keys(p.ACTIONS)) {
    assert.equal(p.canDo('owner', action), true);
    assert.equal(p.canDo('empleado', action), p.ACTIONS[action].includes('empleado'));
    assert.equal(p.canDo('unknown', action), false);
  }
  for (const id of ['pageGastos', 'pageConfig', 'ventas:reportes', 'unknown', 'toString']) assert.equal(p.canAccessScreen('empleado', id), false);
  for (const id of ['pagePOS', 'pageInventario', 'pageVentas', 'pageClientes', 'pageCaja']) assert.equal(p.canAccessScreen('empleado', id), true);
  assert.equal(p.canAccessScreen('owner', 'unknown'), true);
  assert.equal(p.canDo('owner', 'unknown'), true);
  assert.equal(p.canDo('empleado', 'unknown'), false);
  for (const id of Object.keys(p.SCREENS)) assert.equal(p.canAccessScreen('unknown', id), false);
  function frozen(value) {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) if (child && typeof child === 'object') frozen(child);
  }
  frozen(p);
  assert.deepEqual(p.routeRoles('/settings', 'GET'), ['owner', 'empleado']);
  assert.deepEqual(p.routeRoles('/settings', 'POST'), ['owner']);
  assert.deepEqual(p.routeRoles('/unknown', 'GET'), ['owner']);
});

test('sync entities and read routes distinguish operations from reports', () => {
  assert.equal(p.canDo('empleado', p.SYNC_ENTITIES.expenses), true);
  assert.equal(p.canDo('empleado', p.SYNC_ENTITIES.unknown), false);
  for (const path of ['/read/status','/read/sales','/read/sales/s1/items','/read/inventory-movements']) assert.deepEqual(p.routeRoles(path,'GET'),['owner']);
  for (const path of p.API_ROUTES.filter(r=>r.path.startsWith('/read/canonical/')).map(r=>r.path)) assert.deepEqual(p.routeRoles(path,'GET'),path === '/read/canonical/expenses' ? ['owner'] : ['owner','empleado']);
});

test('imports and canonical expense reports are owner-only', () => {
  assert.deepEqual(p.routeRoles('/commands/import.stage','POST'), ['owner']);
  assert.deepEqual(p.routeRoles('/read/canonical/expenses','GET'), ['owner']);
  assert.equal(p.API_ROUTES.find(r => r.path === '/read/canonical/expenses').action, 'reports.view');
});

test('expense revisions are owner-only on client actions and command routes',()=>{for(const action of ['expense.update','expense.void']){assert.equal(p.canDo('owner',action),true);assert.equal(p.canDo('empleado',action),false);assert.deepEqual(p.routeRoles('/commands/'+action,'POST'),['owner']);}});
