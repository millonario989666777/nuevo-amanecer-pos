// CAMBIO DE SERVIDOR DEL POS (rama feature/asistente-aislado, necesita visto bueno del jefe antes de desplegar):
// POST /commands/product.create pasa por ownerGate igual que product.update.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon } from '../cloud-sync/canon-browser-harness.mjs';

const MIG = ['0024_pos_roles_owner_pin.sql', '0025_pos_reviews_pin_failures.sql'];
async function setup(t) {
  const f = await activeCanon(t, { migrations: MIG });
  f.addDevice('dueno', 'writer', 'active', 'tok-dueno');
  f.addDevice('emp', 'writer', 'active', 'tok-emp');
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES('session:emp','empleado','Caja 2','session:dueno',?)", new Date().toISOString());
  const post = (tok, body, extra = {}) => f.fetch('http://localhost/commands/product.create', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  return { f, post };
}

test('product.create: aparato empleado sin aprobación del dueño → 403 owner_approval_required', async (t) => {
  const { post } = await setup(t);
  const r = await post('tok-emp', { operation_id: 'op-emp-1', product_id: 'NEW-1', name: 'Nuevo' });
  assert.equal(r.status, 403); assert.equal((await r.json()).error, 'owner_approval_required');
});

test('product.create: el dueño pasa la puerta; el empleado pasa solo con aprobación ligada a ESA operación', async (t) => {
  const { f, post } = await setup(t);
  const owner = await post('tok-dueno', { operation_id: 'op-own-1', product_id: 'NEW-2', name: 'Nuevo' });
  assert.notEqual((await owner.json()).error, 'owner_approval_required');
  const exp = new Date(Date.now() + 60000).toISOString();
  f.exec("INSERT INTO pos_owner_approvals(approval_id,device_id,action,operation_id,created_at,expires_at) VALUES('apr-1','session:emp','product.create','op-emp-2',?,?)", new Date().toISOString(), exp);
  const other = await post('tok-emp', { operation_id: 'op-emp-3', product_id: 'NEW-3', name: 'Nuevo' }, { 'x-owner-approval': 'apr-1' });
  assert.equal((await other.json()).error, 'owner_approval_required', 'aprobación de otra operación no sirve');
  const ok = await post('tok-emp', { operation_id: 'op-emp-2', product_id: 'NEW-4', name: 'Nuevo' }, { 'x-owner-approval': 'apr-1' });
  assert.notEqual((await ok.json()).error, 'owner_approval_required');
});

test('owner-approval acepta la acción product.create (necesaria para la tarjeta de producto nuevo del asistente)', async (t) => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync('tools/cloudflare-lab/src/pos-roles.js', 'utf8'), /APPROVAL_ACTIONS = new Set\(\[\.\.\.OWNER_COMMANDS, 'product\.create'/);
});
