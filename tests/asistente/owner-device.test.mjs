// Registro del aparato dueño (detrás de ASSISTANT_OWNER_BOOTSTRAP=1). Base real del laboratorio y Worker real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon } from '../cloud-sync/canon-browser-harness.mjs';

const MIG = ['0024_pos_roles_owner_pin.sql', '0025_pos_reviews_pin_failures.sql'];
const PIN = '4821', B = '/auth/assistant/owner-device';
async function setup(t, { log = true, flag = '1', owner = true } = {}) {
  const f = await activeCanon(t, { migrations: log ? [...MIG, '0035_pos_owner_device_log.sql'] : MIG });
  Object.assign(f.env, { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', ASSISTANT_DEMO: '1', ASSISTANT_OWNER_BOOTSTRAP: flag });
  for (const d of ['dueno', 'nuevo', 'otro', 'emp']) f.addDevice(d, 'writer', 'active', 'tok-' + d);
  const at = new Date().toISOString();
  if (owner) f.exec("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES('session:dueno','owner','Dueño','test',?)", at);
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES('session:emp','empleado','Caja 2','test',?)", at);
  const call = async (tok, path, body, extra = {}, method = 'POST') => { const r = await f.fetch('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', ...extra }, body: method === 'GET' ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.ok((await call(owner ? 'tok-dueno' : 'tok-nuevo', '/auth/owner-pin', { new_pin: PIN })).status < 300);
  const approval = async (tok, op) => (await call(tok, '/auth/owner-approval', { pin: PIN, action: 'assistant.owner_device', operation_id: op })).body.approval_id;
  const role = (dev) => f.all('SELECT pos_role FROM pos_device_roles WHERE device_id=?', 'session:' + dev)[0]?.pos_role || null;
  const logs = () => f.all('SELECT event,device_id,actor_device_id FROM pos_owner_device_log ORDER BY created_at');
  return { f, call, approval, role, logs };
}

test('sin bandera ASSISTANT_OWNER_BOOTSTRAP: 404 y nada cambia', async (t) => {
  const { call, role } = await setup(t, { flag: '' });
  assert.equal((await call('tok-nuevo', B + '/register', { pin: PIN })).status, 404);
  assert.equal(role('nuevo'), null);
});

test('sin la bitácora (migración 0035 no aplicada): falla cerrado 503, no registra', async (t) => {
  const { call, role } = await setup(t, { log: false, owner: false });
  const r = await call('tok-nuevo', B + '/register', { pin: PIN });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'owner_device_log_missing'); assert.equal(role('nuevo'), null);
});

test('primer dueño: botón + PIN con 0 dueños -> owner, anotado; sin PIN no', async (t) => {
  const { call, role, logs } = await setup(t, { owner: false });
  assert.equal((await call('tok-nuevo', B + '/register', {})).status, 403);
  const r = await call('tok-nuevo', B + '/register', { pin: PIN, pos_role: 'owner' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.via, 'first_owner'); assert.equal(role('nuevo'), 'owner');
  assert.deepEqual(logs().map((l) => l.event), ['register_first']);
  // el segundo teléfono ya no es «primer dueño»: queda esperando aprobación
  const r2 = await call('tok-otro', B + '/register', { pin: PIN });
  assert.equal(r2.status, 202); assert.equal(r2.body.status, 'esperando_aprobacion'); assert.equal(role('otro'), null);
});

test('un aparato empleado nunca se registra como dueño (409, sin gastar intentos de PIN)', async (t) => {
  const { f, call, role } = await setup(t);
  // El gate de rutas ya lo corta (403 forbidden_role); si llegara a la ruta, 409 employee_device_cannot_register. Nunca 200.
  for (let i = 0; i < 7; i++) { const r = await call('tok-emp', B + '/register', { pin: i % 2 ? PIN : '0000' }); assert.ok(['forbidden_role', 'employee_device_cannot_register'].includes(r.body.error), JSON.stringify(r.body)); }
  assert.equal(role('emp'), 'empleado');
  assert.equal(f.all("SELECT COUNT(*) AS n FROM pos_pin_failures WHERE device_id='session:emp'")[0]?.n ?? 0, 0);
});

test('límite de PIN por aparato: 5 fallos bloquean ESE aparato 15 min ("Demasiados intentos"), el otro sigue', async (t) => {
  const { call, role } = await setup(t);
  let last; for (let i = 0; i < 6; i++) last = await call('tok-nuevo', B + '/register', { pin: '0000' });
  assert.equal(last.status, 429); assert.match(last.body.message, /Demasiados intentos\. Espera 15 min\./);
  assert.equal((await call('tok-nuevo', B + '/register', { pin: PIN })).status, 429, 'bloqueado incluso con el PIN correcto');
  assert.equal(role('nuevo'), null);
  assert.equal((await call('tok-otro', B + '/register', { pin: PIN })).status, 202);
});

test('aprobar un pendiente pide aprobación ESTRICTA del dueño (un PIN suelto no basta; un uso; ligada a la operación)', async (t) => {
  const { call, approval, role, logs } = await setup(t);
  assert.equal((await call('tok-nuevo', B + '/register', { pin: PIN, label: 'Celular de María' })).status, 202);
  const list = await call('tok-dueno', B, null, {}, 'GET');
  assert.deepEqual(list.body.pending.map((p) => p.label), ['Celular de María']);
  assert.equal((await call('tok-emp', B, null, {}, 'GET')).status, 403, 'empleado no ve la lista');
  // PIN en el cuerpo no basta
  assert.equal((await call('tok-dueno', B + '/approve', { device_id: 'session:nuevo', operation_id: 'op-a', pin: PIN })).body.error, 'owner_approval_required');
  // aprobación de otra operación no vale
  const otra = await approval('tok-dueno', 'op-otra');
  assert.equal((await call('tok-dueno', B + '/approve', { device_id: 'session:nuevo', operation_id: 'op-a' }, { 'x-owner-approval': otra })).status, 403);
  // aprobación hecha en el aparato del empleado no vale
  const deEmp = await approval('tok-emp', 'op-a');
  const rE = await call('tok-emp', B + '/approve', { device_id: 'session:nuevo', operation_id: 'op-a' }, { 'x-owner-approval': deEmp }); assert.equal(rE.status, 403); assert.equal(role('nuevo'), null);
  const ok = await approval('tok-dueno', 'op-a');
  const r = await call('tok-dueno', B + '/approve', { device_id: 'session:nuevo', operation_id: 'op-a' }, { 'x-owner-approval': ok });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(role('nuevo'), 'owner');
  // reutilizar la misma aprobación: no
  assert.equal((await call('tok-otro', B + '/register', { pin: PIN })).status, 202);
  assert.equal((await call('tok-dueno', B + '/approve', { device_id: 'session:otro', operation_id: 'op-a' }, { 'x-owner-approval': ok })).status, 403);
  assert.deepEqual(logs().map((l) => l.event), ['request', 'approve', 'request']);
});

test('rechazar un pendiente (approve con decision reject): no queda dueño y se anota; decisión rara 400', async (t) => {
  const { call, approval, role, logs } = await setup(t);
  await call('tok-nuevo', B + '/register', { pin: PIN });
  const r = await call('tok-dueno', B + '/approve', { device_id: 'session:nuevo', operation_id: 'op-r', decision: 'reject' }, { 'x-owner-approval': await approval('tok-dueno', 'op-r') });
  assert.equal(r.status, 200); assert.equal(role('nuevo'), null);
  assert.equal((await call('tok-dueno', B, null, {}, 'GET')).body.pending.length, 0);
  assert.deepEqual(logs().map((l) => l.event), ['request', 'reject']);
  await call('tok-otro', B + '/register', { pin: PIN });
  assert.equal((await call('tok-dueno', B + '/approve', { device_id: 'session:otro', operation_id: 'op-w', decision: 'si' })).status, 400);
});

test('quitar el ÚLTIMO aparato dueño: 409 last_owner (sin gastar la aprobación); con dos dueños sí, y el quitado pierde el asistente', async (t) => {
  const { call, approval, role } = await setup(t);
  const a1 = await approval('tok-dueno', 'op-q');
  const last = await call('tok-dueno', B + '/revoke', { device_id: 'session:dueno', operation_id: 'op-q' }, { 'x-owner-approval': a1 });
  assert.equal(last.status, 409); assert.equal(last.body.code, 'last_owner'); assert.equal(role('dueno'), 'owner');
  // segundo dueño aprobado
  await call('tok-nuevo', B + '/register', { pin: PIN });
  assert.equal((await call('tok-dueno', B + '/approve', { device_id: 'session:nuevo', operation_id: 'op-n' }, { 'x-owner-approval': await approval('tok-dueno', 'op-n') })).status, 200);
  assert.equal((await call('tok-nuevo', '/auth/assistant/chat', { ping: true })).status, 200);
  // sin aprobación: no
  assert.equal((await call('tok-dueno', B + '/revoke', { device_id: 'session:nuevo', operation_id: 'op-z' })).status, 403);
  // la aprobación op-q no se gastó con el 409: sirve para su operación
  const ok = await call('tok-dueno', B + '/revoke', { device_id: 'session:nuevo', operation_id: 'op-q' }, { 'x-owner-approval': a1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(role('nuevo'), 'empleado');
  assert.equal((await call('tok-nuevo', '/auth/assistant/chat', { ping: true })).status, 403, 'ya no es dueño: asistente apagado');
  // y ahora el que queda es el último
  assert.equal((await call('tok-dueno', B + '/revoke', { device_id: 'session:dueno', operation_id: 'op-y' }, { 'x-owner-approval': await approval('tok-dueno', 'op-y') })).body.code, 'last_owner');
});

test('ping de un aparato sin fila de rol: 403 con reason sin_rol (para mostrar el registro); empleado sin reason', async (t) => {
  const { call } = await setup(t);
  const r = await call('tok-nuevo', '/auth/assistant/chat', { ping: true });
  assert.equal(r.status, 403); assert.equal(r.body.reason, 'sin_rol');
  const e = await call('tok-emp', '/auth/assistant/chat', { ping: true });
  assert.equal(e.status, 403); assert.equal(e.body.error, 'assistant_off'); assert.equal(e.body.reason, undefined);
});
