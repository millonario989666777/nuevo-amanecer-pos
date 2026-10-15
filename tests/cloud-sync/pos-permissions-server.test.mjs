import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { employeeCashExpenseAllowed } from '../../tools/cloudflare-lab/src/a6-expenses.js';
import { a6Fixture } from './a6-fixture.mjs';
const read = name => readFileSync(new URL('../../infra/database/migrations/' + name, import.meta.url), 'utf8');
async function call(f, path, token, body, method = 'POST') {
  return f.fetch('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) });
}
test('paired employees cannot invoke owner actions; owner expense and settings remain usable', async t => {
  const f = await a6Fixture(t);
  await f.freeze(); await f.promote();
  f.database.exec('DROP TRIGGER canonical_control_no_legacy');
  f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1,minimum_client_contract='a6-gate-c-v1' WHERE id=1");
  for (const name of ['0008_canonical_commerce.sql', '0009_canonical_financial.sql', '0010_session_auth.sql', '0011_canonical_session_runtime.sql', '0012_credit_accounts_v2.sql', '0013_canonical_expenses.sql', '0024_pos_roles_owner_pin.sql']) f.database.exec(read(name).replace(/DROP INDEX[^;]*;/, ''));
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  const code = await (await call(f, '/auth/pairing-code', 'owner-token', { label: 'Employee' })).json();
  const paired = await (await call(f, '/auth/pair', '', { code: code.code })).json();
  assert.ok(paired.session_token);
  const c = f.control();
  const expense = { operation_id: 'permission-expense-op', expense_id: 'permission-expense', promotion_id: c.active_promotion_id, client_contract: 'a6-gate-c-v1', authority_epoch: c.authority_epoch, expected_control_revision: c.revision, created_at: '2026-09-27T17:00:00.000Z', amount_cents: 2500, concept: 'Útiles', category: 'Limpieza', payment_method: 'efectivo', expense_date: '2026-09-26', note: 'Synthetic' };
  for (const [path, body, method] of [['/commands/expense.create', expense], ['/settings', { key: 'test', value: 1 }], ['/auth/product-images', {}], ['/auth/devices', {}], ['/auth/pairing-code', {}]]) {
    const response = await call(f, path, paired.session_token, body, method);
    assert.equal(response.status, 403, path);
    if (path === '/commands/expense.create') assert.deepEqual(await response.json(), { error: 'forbidden_role', action: 'expense.create' });
  }
  for (const path of ['/read/status','/read/sales','/read/sales/s1/items','/read/inventory-movements']) {
    assert.equal((await call(f,path,paired.session_token,null,'GET')).status,403,path);
  }
  assert.equal((await call(f,'/read/canonical/status',paired.session_token,null,'GET')).status,200);
  const open = { operation_id:'employee-open', session_id:'employee-shift', promotion_id:c.active_promotion_id, client_contract:'a6-gate-c-v1', authority_epoch:c.authority_epoch, expected_control_revision:c.revision, created_at:expense.created_at, opening_cents:10000 };
  assert.equal((await call(f,'/commands/cash.open',paired.session_token,open)).status,201);
  const own = { ...expense, operation_id:'employee-expense-op', expense_id:'employee-expense', session_id:open.session_id, expected_session_revision:0 };
  for (const changes of [{session_id:'someone-else'}, {payment_method:'yape'}]) assert.equal((await call(f,'/commands/expense.create',paired.session_token,{...own,...changes})).status,403);
  assert.equal((await call(f,'/commands/expense.create','owner-token',own)).status,201);
  const next = {...own,operation_id:'employee-own-op',expense_id:'employee-own',expected_session_revision:1};
  assert.equal((await call(f,'/commands/expense.create',paired.session_token,next)).status,201);
  assert.equal(f.sql("SELECT expected_cents FROM canonical_cash_state WHERE session_id='employee-shift'").expected_cents,5000);
  assert.equal((await call(f, '/commands/expense.create', 'owner-token', expense)).status, 201);
  assert.equal((await call(f, '/settings', 'owner-token', { key: 'test', value: 1 })).status, 200);
});

async function roleFixture(t) {
  const f = await a6Fixture(t);
  for (const name of ['0010_session_auth.sql','0024_pos_roles_owner_pin.sql']) f.database.exec(read(name));
  f.addDevice('role-owner','writer','active','role-owner-token');
  const code=await (await call(f,'/auth/pairing-code','role-owner-token',{})).json();
  const employee=await (await call(f,'/auth/pair','',{code:code.code})).json();
  return { f, token:employee.session_token };
}
test('sync rejects forbidden entities permanently and still accepts the next allowed operation', async t => {
  const { f,token }=await roleFixture(t);
  async function sync(entity,payload={}) {
    const text=JSON.stringify(payload),operation_id='sync-'+entity;
    const response=await call(f,'/sync/operations',token,{operation_id,device_sequence:1,entity_type:entity,entity_id:'entity',payload:text,payload_hash:createHash('sha256').update(text).digest('hex'),created_at:'2026-09-27T17:00:00Z'});
    return {response,operation_id};
  }
  for (const entity of ['unknown','toString','expenses','cash_movements']) {
    const {response,operation_id}=await sync(entity);
    assert.equal(response.status,403);
    assert.deepEqual(await response.json(),{error:'forbidden_role',operation_id,entity_type:entity});
  }
  assert.equal((await sync('sales')).response.status,201);
  assert.equal(f.sql("SELECT COUNT(*) AS n FROM sync_operations WHERE operation_id LIKE 'sync-%'").n,1);
});

test('sync expense shift predicate rejects closed, foreign and non-cash shifts', async () => {
  const auth={principalId:'employee'};
  const body={session_id:'own',payment_method:'efectivo',amount_cents:500};
  function db(open,device) { return {prepare(sql) {
    assert.match(sql,/s.status='OPEN'/); assert.match(sql,/o.device_id=\?2/);
    return {bind(sid,principal) {return {async first() {return open && sid==='own' && principal===device ? {session_id:sid} : null;}};}};
  }}; }
  assert.equal(await employeeCashExpenseAllowed(db(true,'employee'),body,auth),true);
  assert.equal(await employeeCashExpenseAllowed(db(false,'employee'),body,auth),false);
  assert.equal(await employeeCashExpenseAllowed(db(true,'owner'),body,auth),false);
  assert.equal(await employeeCashExpenseAllowed(db(true,'employee'),{...body,payment_method:'yape'},auth),false);
});

test('authenticated unknown routes fail closed; expense without session is unauthorized', async t => {
  const {f,token}=await roleFixture(t);
  const response=await call(f,'/auth/unlisted-route',token,null,'GET');
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'forbidden_role'});
  assert.equal((await call(f,'/commands/expense.create','',{})).status,401);
  assert.equal((await call(f,'/commands/expense.create','',null,'GET')).status,401);
  // GET settings must not inherit the POST settings.set owner gate.
  assert.equal((await call(f,'/settings',token,null,'GET')).status,200);
});

test('employee completes canonical sale, credit collection, cash and sync pull', async t => {
  const {activeCanon,device}=await import('./canon-browser-harness.mjs');
  const f=await activeCanon(t,{migrations:['0024_pos_roles_owner_pin.sql']});
  const tab=await device(f,{token:'employee-flow-token',deviceId:'employee-flow'});
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,created_by,created_at) VALUES('session:employee-flow','empleado','test','2026-10-14T00:00:00Z')");
  await tab.api.refresh();
  assert.equal((await tab.api.openCash({session_id:'employee-flow-shift',opening_cents:1000})).status,'created');
  await tab.api.refresh();
  assert.equal((await tab.api.createSale({items:[{product_id:'00003',quantity:1}],payment_method:'credito',customer_id:'000C',credit_due:'2099-12-31'})).status,'created');
  await tab.api.refresh();
  const credit=tab.api.snapshot().credits.find(c=>c.provenance==='LIVE');
  assert.ok(credit);
  assert.equal((await tab.api.createPayment({credit_id:credit.credit_id,amount_cents:100,payment_method:'efectivo'})).status,'created');
  await tab.api.refresh();
  assert.equal((await tab.api.closeCash({counted_cents:1100})).status,'created');
  await tab.api.refresh();
  assert.equal((await call(f,'/auth/dni-lookup','employee-flow-token',{dni:'12345678'})).status,200);
  assert.equal((await call(f,'/sync/operations/missing','employee-flow-token',null,'GET')).status,404);
});
