// P1-4 / P1-5 (auditoría inventario/clientes): teléfono normalizado y único,
// DNI 8 / RUC 11, y la línea inicial viaja con el alta pendiente correcta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { tursoSqlite } from './turso-sqlite-protocol.mjs';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const MIG = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql', '0018_canonical_customer_credit_policy.sql', '0020_canonical_customer_contacts.sql'];
const LOCKS = { master: 'na_master_lock', readOnly: 'na_readonly', modules: { clientes: 'na_lock_clientes' } };
const SCRIPTS = [['canonical-customer-credit-policy-bridge.js', read('POS/js/sync/canonical-customer-credit-policy-bridge.js')],
  ['canonical-customer-bridge.js', read('POS/js/sync/canonical-customer-bridge.js')]];
const globals = { securityIsLocked() { return false; }, storage: { getItem() { return null; } }, LOCK_KEYS: LOCKS, cliRender() {}, posRender() {},
  updateDashboard() {}, _naF10AuthorizePermission() { return true; }, cajEstado: { cajeroId: null }, appConfig: {} };
const policyOf = (f, id) => f.sql('SELECT manual_limit_cents FROM canonical_customer_credit_policies WHERE customer_id=?', id)?.manual_limit_cents ?? null;
const byName = (f, name) => f.sql('SELECT customer_id,phone,document FROM canonical_live_customers WHERE name=?', name);
function fill(tab, v) { for (const id of ['cNombre', 'cDni', 'cTel', 'cDir', 'cLinea']) tab.el(id).value = v[id] ?? ''; }

async function lostAckTab(f) {
  let drop = true;
  return device(f, { token: 'cli-a', deviceId: 'cli-a', scripts: SCRIPTS, globals, onFetch: async (url, _o, real) => {
    if (drop && url.includes('/commands/customer.create')) { drop = false; await real(); throw new TypeError('Failed to fetch'); }
    return null;
  } });
}

test('R8: la línea del formulario NUEVO nunca se aplica al alta pendiente ANTERIOR y B no se pierde', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const a = await lostAckTab(f);
  const bridge = a.context.NuevoAmanecerCanonicalCustomerBridge;
  fill(a, { cNombre: 'Cliente A', cDni: '10000001', cLinea: '100' });
  assert.equal(await bridge.save(), false); // ACK perdido: A sí se creó en CANON
  fill(a, { cNombre: 'Cliente B', cDni: '20000002', cLinea: '500' });
  assert.equal(await bridge.save(), false, 'B todavía no se registró: se confirmó A');
  const A = byName(f, 'Cliente A');
  assert.ok(A, 'A confirmado');
  assert.equal(policyOf(f, A.customer_id), 10000, 'A recibe SU línea (S/100), no la de B');
  assert.equal(byName(f, 'Cliente B'), undefined);
  assert.equal(a.el('cNombre').value, 'Cliente B', 'los datos de B siguen en el formulario');
  assert.equal(a.el('cLinea').value, '500');
  assert.ok(a.toasts.some(([m]) => /Se confirmó el alta pendiente de «Cliente A»/.test(m)));
  assert.equal(await bridge.save(), true);
  const B = byName(f, 'Cliente B');
  assert.ok(B);
  assert.equal(policyOf(f, B.customer_id), 50000);
  assert.equal(policyOf(f, A.customer_id), 10000);
  assert.equal(a.localStorage.getItem('na_canonical_customer_create_line_v1'), null);
});

test('R8: con el formulario vacío o igual a A se confirma A con la línea de A', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const a = await lostAckTab(f);
  const bridge = a.context.NuevoAmanecerCanonicalCustomerBridge;
  fill(a, { cNombre: 'Cliente A', cDni: '10000001', cLinea: '100' });
  assert.equal(await bridge.save(), false);
  fill(a, {});
  assert.equal(await bridge.save(), true);
  assert.equal(policyOf(f, byName(f, 'Cliente A').customer_id), 10000);
});

test('R1/R12: customer.create normaliza a +51, rechaza teléfono duplicado (cualquier formato) y valida DNI/RUC', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const a = await device(f, { token: 'w1', deviceId: 'w1' });
  const r1 = await a.api.createCustomer({ name: 'Ana', document: '11111111', phone: '987 654 321' });
  assert.equal(r1.status, 'created');
  assert.equal(byName(f, 'Ana').phone, '+51987654321');
  await a.api.refresh();
  for (const phone of ['987654321', '+51 987 654 321', '0051987654321']) {
    await assert.rejects(a.api.createCustomer({ name: 'Ana duplicada', phone }), /REJECTED_409/);
    assert.equal(a.api.pendingSnapshot().last_error, 'customer_phone_conflict');
    assert.equal(await a.api.discardRejectedCustomer(), true);
  }
  // Imported customers with legacy formats also count.
  const imported = f.sql("SELECT customer_id,phone FROM customers WHERE phone IS NOT NULL AND trim(phone)<>'' LIMIT 1");
  if (imported && /^9\d{8}$/.test(String(imported.phone).replace(/\D/g, ''))) {
    await assert.rejects(a.api.createCustomer({ name: 'Copia importado', phone: '+51' + String(imported.phone).replace(/\D/g, '') }), /REJECTED_409/);
    assert.equal(await a.api.discardRejectedCustomer(), true);
  }
  for (const [input, code] of [[{ name: 'X', phone: 'abc' }, 'invalid_customer_phone'], [{ name: 'X', document: '12' }, 'invalid_customer_document'],
    [{ name: 'X', document: '1234567' }, 'invalid_customer_document'], [{ name: 'X', phone: '01 4567890' }, 'invalid_customer_phone']]) {
    await assert.rejects(a.api.createCustomer(input), /REJECTED_400/);
    assert.equal(a.api.pendingSnapshot().last_error, code);
    assert.equal(await a.api.discardRejectedCustomer(), true);
  }
  await a.api.refresh();
  assert.equal((await a.api.createCustomer({ name: 'Empresa SAC', document: '20123456789' })).status, 'created');
  const direct = await f.fetch('http://localhost/commands/customer.create', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer w1' },
    body: JSON.stringify({ operation_id: 'op-dup-phone', customer_id: 'C-dup', promotion_id: f.control().active_promotion_id, authority_epoch: f.control().authority_epoch,
      expected_control_revision: f.control().revision, client_contract: 'a6-gate-c-v1', created_at: new Date().toISOString(), name: 'Dup', phone: '987654321', color: 1 }) });
  const body = await direct.json();
  assert.equal(direct.status, 409); assert.equal(body.customer_name, 'Ana');
});

test('replay de un alta enviada al Worker anterior (teléfono sin normalizar) responde already_processed', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  await device(f, { token: 'w2', deviceId: 'w2' });
  const c = f.control();
  const req = { operation_id: 'op-raw-phone', customer_id: 'C-raw', promotion_id: c.active_promotion_id, authority_epoch: c.authority_epoch,
    expected_control_revision: c.revision, client_contract: 'a6-gate-c-v1', created_at: '2026-10-12T00:00:00.000Z', name: 'Raw', phone: '987 111 222', color: 2 };
  const post = () => f.fetch('http://localhost/commands/customer.create', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer w2' }, body: JSON.stringify(req) });
  assert.equal((await post()).status, 201);
  const again = await post();
  assert.equal(again.status, 200); assert.equal((await again.json()).status, 'already_processed');
});

test('R2: customer.contact.set no puede poner a B el WhatsApp de A', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const a = await device(f, { token: 'w3', deviceId: 'w3' });
  const A = await a.api.createCustomer({ name: 'A' }); await a.api.refresh();
  const B = await a.api.createCustomer({ name: 'B' }); await a.api.refresh();
  assert.equal((await a.api.setCustomerContact({ customer_id: A.customer_id, name: 'A', phone: '+51987654321' })).status, 'created');
  await a.api.refresh();
  await assert.rejects(a.api.setCustomerContact({ customer_id: B.customer_id, name: 'B', phone: '+51987654321' }), /REJECTED_409/);
  assert.equal(a.api.pendingSnapshot().last_error, 'customer_phone_conflict');
  assert.equal(await a.api.discardRejectedCustomerContact(), true);
  // A may re-save its own number (self excluded).
  await a.api.refresh();
  assert.equal((await a.api.setCustomerContact({ customer_id: A.customer_id, name: 'A2', phone: '+51987654321' })).status, 'created');
  // After A moves to another number, B can take the old one (effective phone).
  await a.api.refresh();
  await a.api.setCustomerContact({ customer_id: A.customer_id, name: 'A2', phone: '+51911111111' }); await a.api.refresh();
  assert.equal((await a.api.setCustomerContact({ customer_id: B.customer_id, name: 'B', phone: '+51987654321' })).status, 'created');
});

test('UI alta: DNI/RUC y teléfono duplicado se avisan antes de enviar (sin POST)', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const a = await device(f, { token: 'w4', deviceId: 'w4', scripts: SCRIPTS, globals });
  await a.api.createCustomer({ name: 'Rosa', phone: '+51 955 444 333' }); await a.api.refresh();
  const bridge = a.context.NuevoAmanecerCanonicalCustomerBridge;
  const posts = () => a.fetchLog.filter((x) => x.method === 'POST').length;
  const n = posts();
  fill(a, { cNombre: 'Pepe', cDni: '1234567' });
  assert.equal(await bridge.save(), false); assert.match(a.toasts.at(-1)[0], /DNI debe tener 8 dígitos y el RUC 11/);
  fill(a, { cNombre: 'Pepe', cTel: '955444333' });
  assert.equal(await bridge.save(), false); assert.match(a.toasts.at(-1)[0], /Ya existe «Rosa» con ese teléfono/);
  fill(a, { cNombre: 'Pepe', cTel: 'abc' });
  assert.equal(await bridge.save(), false); assert.match(a.toasts.at(-1)[0], /Teléfono inválido/);
  assert.equal(posts(), n);
  fill(a, { cNombre: 'Pepe', cDni: '44556677', cTel: '966 000 111' });
  assert.equal(await bridge.save(), true);
  assert.equal(byName(f, 'Pepe').phone, '+51966000111');
});

test('presupuesto Workers Free: customer.create y contact.set con chequeo de teléfono ≤12 subrequests (antes 9, +1 por teléfono)', async (t) => {
  const f = await activeCanon(t, { migrations: MIG });
  const turso = tursoSqlite(f.database);
  f.env.DB = turso.adapter;
  f.env.nuevo_amanecer_lab = { prepare() { throw Error('D1 must not be used'); } };
  await device(f, { token: 'bud', deviceId: 'bud' });
  const c = f.control();
  const common = { promotion_id: c.active_promotion_id, authority_epoch: c.authority_epoch, expected_control_revision: c.revision, client_contract: 'a6-gate-c-v1' };
  const post = async (cmd, body) => { const s = turso.calls.length; const r = await f.fetch('http://localhost/commands/' + cmd, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bud' }, body: JSON.stringify(body) }); return [r.status, turso.calls.length - s]; };
  const [s1, n1] = await post('customer.create', { ...common, operation_id: 'op-b1', customer_id: 'C-b1', created_at: '2026-10-12T00:00:00.000Z', name: 'Budget', phone: '977000111', document: '12345678', color: 0 });
  assert.equal(s1, 201); assert.ok(n1 <= 12, 'customer.create calls=' + n1);
  const [s2, n2] = await post('customer.contact.set', { ...common, operation_id: 'op-b2', customer_id: 'C-b1', created_at: '2026-10-12T00:00:01.000Z', name: 'Budget', phone: '+51977000222', expected_contact_revision: 0 });
  assert.equal(s2, 201); assert.ok(n2 <= 12, 'contact.set calls=' + n2);
  console.log(`customer.create turso_calls=${n1} contact.set turso_calls=${n2}`);
});
