// Editar DNI/RUC y dirección (CANON): customer.contact.set + migración 0023.
// Real path: canonical-client -> Worker -> SQLite (D1 contract) -> read -> UI adapter. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon, device } from './canon-browser-harness.mjs';

const BASE = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql', '0018_canonical_customer_credit_policy.sql', '0020_canonical_customer_contacts.sql'];
const ALL = [...BASE, '0023_canonical_customer_identity.sql'];
const IMPORTED = '000C';
const cust = (tab, id) => tab.api.snapshot().customers.find((c) => c.customer_id === id);
const count = (f, table) => f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

async function setup(t, migrations = ALL) {
  const f = await activeCanon(t, { migrations });
  const a = await device(f, { deviceId: 'device-a', token: 'device-a-token' });
  const ana = await a.api.createCustomer({ name: 'Ana Live', document: '11111111', phone: '987 654 321' });
  await a.api.refresh();
  return { f, a, anaId: ana.customer_id };
}

test('DNI/RUC + address edit: CAS revision, survives refresh and a second device, no financial change', async (t) => {
  const { f, a } = await setup(t);
  const before = { ...f.counts() };
  const r = await a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Cliente sintético', phone: null, document: '20123456789', address: '  Jr. Los Pinos   123, Puerto Sungaro ' });
  assert.equal(r.contact_revision, 1);
  await a.api.refresh();
  assert.equal(cust(a, IMPORTED).document, '20123456789');
  assert.equal(cust(a, IMPORTED).address, 'Jr. Los Pinos 123, Puerto Sungaro');
  assert.equal(cust(a, IMPORTED).contact_revision, 1);
  const legacy = a.api.legacySnapshot().clientes || a.api.legacySnapshot().customers;
  const row = legacy.find((c) => c.id === IMPORTED);
  assert.equal(row.dni, '20123456789');
  assert.equal(row.dir, 'Jr. Los Pinos 123, Puerto Sungaro');

  const b = await device(f, { deviceId: 'device-b', token: 'device-b-token' });
  assert.equal(cust(b, IMPORTED).document, '20123456789');

  // Name-only edit (old clients / unchanged identity) keeps the identity.
  await a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Cliente Renombrado', phone: null });
  await a.api.refresh();
  assert.equal(cust(a, IMPORTED).document, '20123456789');
  assert.equal(cust(a, IMPORTED).name, 'Cliente Renombrado');

  // Stale CAS from device B (still at revision 1).
  await assert.rejects(b.api.setCustomerContact({ customer_id: IMPORTED, name: 'Stale', phone: null, document: '12345678', address: null }), /REJECTED_409/);
  assert.equal(b.api.pendingSnapshot().last_error, 'stale_contact');
  assert.equal(await b.api.discardRejectedCustomerContact(), true);

  // Clearing: null document/address.
  await a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Cliente Renombrado', phone: null, document: null, address: null });
  await a.api.refresh();
  assert.equal(cust(a, IMPORTED).document, null);
  assert.equal(cust(a, IMPORTED).address, null);
  assert.equal(count(f, 'canonical_customer_identities'), 2);
  const after = f.counts();
  for (const key of Object.keys(before)) if (!/customer/.test(key)) assert.equal(after[key], before[key], key);
});

test('validation: DNI 8 / RUC 11 digits, client and Worker', async (t) => {
  const { f, a } = await setup(t);
  for (const document of ['1234567', '123456789', '1234567890', '12345678A', '123456789012']) {
    await assert.rejects(a.api.setCustomerContact({ customer_id: IMPORTED, name: 'X', phone: null, document, address: null }), /INVALID_CANONICAL_CUSTOMER_IDENTITY/);
  }
  assert.equal(a.api.pendingSnapshot(), null);
  const c = f.control();
  const body = { operation_id: 'op-raw-1', promotion_id: c.active_promotion_id, customer_id: IMPORTED, authority_epoch: c.authority_epoch, expected_control_revision: c.revision,
    client_contract: 'a6-gate-c-v1', created_at: new Date().toISOString(), name: 'X', phone: null, expected_contact_revision: 0 };
  const post = (extra) => f.fetch('http://localhost/commands/customer.contact.set', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer device-a-token' }, body: JSON.stringify({ ...body, ...extra }) });
  for (const extra of [{ document: '123' , address: null }, { document: '12345678' }, { address: 'Solo dirección' }, { document: '12345678', address: '' }]) {
    const res = await post(extra);
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.equal((await res.json()).error, 'invalid_customer_identity');
  }
  assert.equal(count(f, 'canonical_customer_contacts'), 0);
});

test('duplicate DNI/RUC is rejected naming the other customer (live, imported-edited, and on customer.create)', async (t) => {
  const { f, a, anaId } = await setup(t);
  await assert.rejects(a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Cliente sintético', phone: null, document: '11111111', address: null }), /REJECTED_409/);
  const pending = a.api.pendingSnapshot();
  assert.equal(pending.last_error, 'customer_document_conflict');
  assert.equal(pending.last_conflict.customer_id, anaId);
  assert.equal(pending.last_conflict.customer_name, 'Ana Live');
  assert.equal(await a.api.discardRejectedCustomerContact(), true);
  assert.equal(count(f, 'canonical_customer_contacts'), 0, 'nothing written');

  // The imported customer takes a RUC; Ana (live) cannot take it, and the message names the edited name.
  await a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Bodega Sungaro', phone: null, document: '20111111111', address: null });
  await a.api.refresh();
  await assert.rejects(a.api.setCustomerContact({ customer_id: anaId, name: 'Ana Live', phone: '+51987654321', document: '20111111111', address: null }), /REJECTED_409/);
  assert.equal(a.api.pendingSnapshot().last_conflict.customer_name, 'Bodega Sungaro');
  await a.api.discardRejectedCustomerContact();
  // Re-saving the same document on its own owner is not a conflict.
  await a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Bodega Sungaro', phone: null, document: '20111111111', address: 'Av. Principal s/n' });
  await a.api.refresh();
  // A new customer cannot take a document assigned by an edit.
  await assert.rejects(a.api.createCustomer({ name: 'Copia', document: '20111111111' }), /REJECTED_409/);
  assert.equal(a.api.pendingSnapshot().last_error, 'customer_document_conflict');
  await a.api.discardRejectedCustomer();
  // DB guard (race): a direct insert bypassing the Worker check is refused too.
  const contact = f.database.prepare('SELECT * FROM canonical_customer_contacts ORDER BY revision DESC LIMIT 1').get();
  assert.throws(() => f.database.prepare(`INSERT INTO canonical_customer_identities(operation_id,promotion_id,customer_id,revision,document,address,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run('nope', contact.promotion_id, anaId, 1, '20111111111', null, contact.created_at), /stale_contact|customer_document_conflict|FOREIGN/);
  assert.throws(() => f.database.exec("UPDATE canonical_customer_identities SET address='x'"), /immutable_customer_identity/);
  assert.throws(() => f.database.exec('DELETE FROM canonical_customer_identities'), /immutable_customer_identity/);
});

test('lost ACK replays the same identity operation once', async (t) => {
  const f = await activeCanon(t, { migrations: ALL });
  let lose = true;
  const a = await device(f, { deviceId: 'device-a', token: 'device-a-token', onFetch: async (url, options, next) => { if (url.endsWith('/commands/customer.contact.set') && lose) { lose = false; await next(); throw new Error('RESPONSE_LOST'); } } });
  await assert.rejects(a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Cliente sintético', phone: null, document: '12345678', address: 'Calle 1' }), /CANONICAL_FINANCIAL_PENDING/);
  const replay = await a.api.retryPending();
  assert.equal(replay.status, 'already_processed');
  assert.equal(count(f, 'canonical_customer_identities'), 1);
  assert.equal(count(f, 'canonical_customer_contacts'), 1);
});

test('without migration 0023: name/WhatsApp edits still work; identity edit is refused and discardable', async (t) => {
  const { f, a } = await setup(t, BASE);
  await a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Solo Nombre', phone: null });
  await a.api.refresh();
  await assert.rejects(a.api.setCustomerContact({ customer_id: IMPORTED, name: 'Solo Nombre', phone: null, document: '12345678', address: null }), /REJECTED_503/);
  assert.equal(a.api.pendingSnapshot().last_error, 'customer_identity_schema_not_ready');
  assert.equal(await a.api.discardRejectedCustomerContact(), true);
  assert.equal(count(f, 'canonical_customer_contacts'), 1);
});
