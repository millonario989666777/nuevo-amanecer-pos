import test from 'node:test';
import assert from 'node:assert/strict';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';

const MIGRATIONS=[
  '0014_canonical_live_products.sql',
  '0015_canonical_inventory_adjust.sql',
  '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql',
  '0018_canonical_customer_credit_policy.sql',
  '0024_pos_roles_owner_pin.sql', // roles ride in the auth read (no extra trip)
];

test('Turso credit-policy happy path is one browser POST and two Worker-to-Turso trips',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  const turso=tursoSqlite(f.database);
  f.env.DB=turso.adapter;
  f.env.nuevo_amanecer_lab={prepare(){throw Error('D1 must not be used');}};

  const tab=await device(f,{token:'policy-fast-token',deviceId:'policy-fast-device'});
  const id=tab.api.snapshot().customers[0].customer_id;
  const tursoStart=turso.calls.length;
  const browserStart=tab.fetchLog.length;

  const receipt=await tab.api.setCustomerCreditPolicy({
    customer_id:id,
    mode:'MANUAL',
    manual_limit_cents:5000,
    reason:'Ajuste directo del propietario',
    administrator_id:null,
    administrator_name:'Propietario'
  });

  assert.equal(receipt.status,'created');
  assert.equal(receipt.policy_revision,1);

  const browserCalls=tab.fetchLog.slice(browserStart).map(row=>({
    method:row.method,
    path:new URL(row.url).pathname
  }));
  assert.deepEqual(browserCalls,[{method:'POST',path:'/commands/customer.credit-policy.set'}],
    'the visible critical path must be one POST with no status GET');

  const calls=turso.calls.slice(tursoStart);
  assert.deepEqual(calls.map(call=>call.requests?.[0]?.type),['execute','batch'],
    'happy path must be session auth + one atomic credit-policy batch');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_credit_policy_operations').n,1);
  const row=f.sql('SELECT mode,manual_limit_cents,revision FROM canonical_customer_credit_policies WHERE customer_id=?',id);
  assert.equal(row.mode,'MANUAL');
  assert.equal(row.manual_limit_cents,5000);
  assert.equal(row.revision,1);
  assert.equal(tab.api.sourceState().validation,'current');
  assert.equal(tab.api.legacySnapshot().customers.find(c=>String(c.id)===String(id)).lineaCreditoManual,50);

  const secondBrowserStart=tab.fetchLog.length;
  const secondTursoStart=turso.calls.length;
  const second=await tab.api.setCustomerCreditPolicy({
    customer_id:id,
    mode:'MANUAL',
    manual_limit_cents:7000,
    reason:'Segundo ajuste directo del propietario',
    administrator_id:null,
    administrator_name:'Propietario'
  });
  assert.equal(second.policy_revision,2);
  assert.deepEqual(tab.fetchLog.slice(secondBrowserStart).map(row=>({
    method:row.method,path:new URL(row.url).pathname
  })),[{method:'POST',path:'/commands/customer.credit-policy.set'}],
    'second write must not require a full refresh to learn revision 1');
  assert.deepEqual(turso.calls.slice(secondTursoStart).map(call=>call.requests?.[0]?.type),['execute','batch']);
  const row2=f.sql('SELECT manual_limit_cents,revision FROM canonical_customer_credit_policies WHERE customer_id=?',id);
  assert.equal(row2.manual_limit_cents,7000);
  assert.equal(row2.revision,2);
  assert.equal(tab.api.legacySnapshot().customers.find(c=>String(c.id)===String(id)).lineaCreditoManual,70);
});

test('Turso credit-policy stale revision remains fail-closed after the fast path',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  const turso=tursoSqlite(f.database);
  f.env.DB=turso.adapter;
  f.env.nuevo_amanecer_lab={prepare(){throw Error('D1 must not be used');}};

  const a=await device(f,{token:'policy-a-token',deviceId:'policy-a'});
  const b=await device(f,{token:'policy-b-token',deviceId:'policy-b'});
  const id=a.api.snapshot().customers[0].customer_id;

  await a.api.setCustomerCreditPolicy({
    customer_id:id,mode:'MANUAL',manual_limit_cents:10000,expected_policy_revision:0,
    reason:'Primera política manual válida',administrator_id:null,administrator_name:'Propietario'
  });

  await assert.rejects(
    b.api.setCustomerCreditPolicy({
      customer_id:id,mode:'MANUAL',manual_limit_cents:20000,expected_policy_revision:0,
      reason:'Intento obsoleto desde otro navegador',administrator_id:null,administrator_name:'Propietario'
    }),
    /CANONICAL_FINANCIAL_REJECTED_409/
  );
  assert.equal(b.api.pendingSnapshot().last_error,'stale_policy');
  const row=f.sql('SELECT manual_limit_cents,revision FROM canonical_customer_credit_policies WHERE customer_id=?',id);
  assert.equal(row.manual_limit_cents,10000);
  assert.equal(row.revision,1);
});
