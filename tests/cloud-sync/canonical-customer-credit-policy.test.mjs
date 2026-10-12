import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const migration=readFileSync('infra/database/migrations/0018_canonical_customer_credit_policy.sql','utf8');
const bridge=readFileSync('POS/js/sync/canonical-customer-credit-policy-bridge.js','utf8');
const inline04=readFileSync('POS/js/legacy-inline/inline-04.js','utf8');
const index=readFileSync('POS/index.html','utf8');
const sw=readFileSync('POS/sw.js','utf8');

const MIGRATIONS=[
  '0014_canonical_live_products.sql',
  '0015_canonical_inventory_adjust.sql',
  '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql',
  '0018_canonical_customer_credit_policy.sql',
];

async function policyTab(f,options={}){
  const opts={
    token:options.token||'device-a-token',
    localStorage:options.localStorage,
    scripts:[['canonical-customer-credit-policy-bridge.js',bridge]],
    globals:{
      cliRender(){},abrirEvaluacionCredito(){},cerrarModal(){},
      _naAudit(){},
      ...(options.globals||{})
    },
    onFetch:options.onFetch,
  };
  if(Object.prototype.hasOwnProperty.call(options,'deviceId'))opts.deviceId=options.deviceId;
  else if(!options.localStorage)opts.deviceId='device-a';
  return device(f,opts);
}

test('0018 defines immutable journal + CAS current policy tied to customer registry',()=>{
  for(const marker of [
    'canonical_customer_credit_policy_operations',
    'canonical_customer_credit_policies',
    "command='customer.credit-policy.set'",
    'expected_policy_revision',
    'manual_limit_cents',
    'administrator_name',
    'FOREIGN KEY(promotion_id,customer_id) REFERENCES canonical_customer_registry',
    'immutable_customer_credit_policy_operation',
    'immutable_customer_credit_policy_delete'
  ]) assert.ok(migration.includes(marker),marker);
});

test('manual policy persists, survives F5/second device, then automatic restore advances revision',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  const tab=await policyTab(f);
  const customer=tab.api.snapshot().customers[0];
  assert.ok(customer?.customer_id);

  const first=await tab.api.setCustomerCreditPolicy({
    customer_id:customer.customer_id,
    mode:'MANUAL',
    manual_limit_cents:125000,
    reason:'Excepción aprobada por historial comercial',
    administrator_id:'admin-1',
    administrator_name:'Administrador'
  });
  assert.equal(first.status,'created');
  assert.equal(first.policy_revision,1);
  await tab.api.refresh();

  const local=tab.api.legacySnapshot().customers.find(c=>String(c.id)===String(customer.customer_id));
  assert.equal(local.lineaCreditoManualActiva,true);
  assert.equal(local.lineaCreditoManual,1250);
  assert.equal(local.lineaCreditoPolicyRevision,1);

  const reloaded=await policyTab(f,{localStorage:tab.localStorage});
  assert.equal(reloaded.api.legacySnapshot().customers.find(c=>String(c.id)===String(customer.customer_id)).lineaCreditoManual,1250);

  const other=await policyTab(f,{token:'device-b-token',deviceId:'device-b'});
  const otherCustomer=other.api.legacySnapshot().customers.find(c=>String(c.id)===String(customer.customer_id));
  assert.equal(otherCustomer.lineaCreditoManual,1250);
  assert.equal(otherCustomer.lineaCreditoPolicyRevision,1);

  const restored=await other.api.setCustomerCreditPolicy({
    customer_id:customer.customer_id,
    mode:'AUTOMATIC',
    manual_limit_cents:null,
    expected_policy_revision:1,
    reason:'Restaurar cálculo automático solicitado',
    administrator_id:'admin-2',
    administrator_name:'Administrador 2'
  });
  assert.equal(restored.policy_revision,2);
  await other.api.refresh();
  const restoredCustomer=other.api.legacySnapshot().customers.find(c=>String(c.id)===String(customer.customer_id));
  assert.notEqual(restoredCustomer.lineaCreditoManualActiva,true);
  assert.equal(restoredCustomer.lineaCreditoPolicyRevision,2);
});

test('policy uses optimistic CAS so stale second writer cannot overwrite newer policy',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  const a=await policyTab(f);
  const b=await policyTab(f,{token:'device-b-token',deviceId:'device-b'});
  const id=a.api.snapshot().customers[0].customer_id;

  await a.api.setCustomerCreditPolicy({
    customer_id:id,mode:'MANUAL',manual_limit_cents:10000,expected_policy_revision:0,
    reason:'Primera política manual válida',administrator_id:'a',administrator_name:'Admin A'
  });

  await assert.rejects(
    b.api.setCustomerCreditPolicy({
      customer_id:id,mode:'MANUAL',manual_limit_cents:20000,expected_policy_revision:0,
      reason:'Intento obsoleto desde segundo navegador',administrator_id:'b',administrator_name:'Admin B'
    }),
    /CANONICAL_FINANCIAL_REJECTED_409/
  );
  assert.equal(b.api.pendingSnapshot().last_error,'stale_policy');
  const row=f.sql('SELECT mode,manual_limit_cents,revision FROM canonical_customer_credit_policies WHERE customer_id=?',id);
  assert.equal(row.mode,'MANUAL');
  assert.equal(row.manual_limit_cents,10000);
  assert.equal(row.revision,1);
});

test('CANON UI bridge owns manual/automatic policy writes and never calls legacy persistence',()=>{
  assert.match(bridge,/setCustomerCreditPolicy/);
  assert.match(bridge,/saveManual/);
  assert.match(bridge,/restoreAutomatic/);
  assert.doesNotMatch(bridge,/saveAllData\s*\(/);
  assert.match(inline04,/NuevoAmanecerCanonicalCustomerCreditPolicyBridge/);
  assert.match(index,/js\/sync\/canonical-customer-credit-policy-bridge\.js/);
  assert.match(sw,/\.\/js\/sync\/canonical-customer-credit-policy-bridge\.js/);
});

test('CANON authority never falls back to legacy saveAllData when the credit-policy bridge is unavailable',()=>{
  const manual=inline04.slice(
    inline04.indexOf('async function guardarLineaCreditoManual'),
    inline04.indexOf('async function restaurarLineaCreditoAutomatica')
  );
  const automatic=inline04.slice(
    inline04.indexOf('async function restaurarLineaCreditoAutomatica'),
    inline04.indexOf('function _naCreditModalSummaryHtml')
  );
  assert.match(inline04,/function _naCanonicalCreditPolicyAuthority\(\)/);
  assert.match(manual,/_naCanonicalCreditPolicyAuthority\(\)/);
  assert.match(automatic,/_naCanonicalCreditPolicyAuthority\(\)/);
  assert.match(manual,/canonicalPolicyBridge\.saveManual/);
  assert.match(automatic,/canonicalPolicyBridge\.restoreAutomatic/);
  assert.doesNotMatch(manual,/canonicalPolicyBridge\.enabled/);
  assert.doesNotMatch(automatic,/canonicalPolicyBridge\.enabled/);
  assert.match(manual,/integración CANON no disponible/);
  assert.match(automatic,/integración CANON no disponible/);
});


test('lost ACK retries the same policy operation and never advances revision twice',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  let dropAck=true;
  const tab=await policyTab(f,{
    async onFetch(url,options,forward){
      if(url.endsWith('/commands/customer.credit-policy.set')&&dropAck){
        dropAck=false;
        await forward();
        throw new TypeError('network lost after commit');
      }
      return null;
    }
  });
  const id=tab.api.snapshot().customers[0].customer_id;
  const policyBridge=tab.context.NuevoAmanecerCanonicalCustomerCreditPolicyBridge;
  assert.equal(await policyBridge.saveManual({
    customer_id:id,manual_limit_cents:10000,
    reason:'Excepción manual con ACK perdido',
    administrator_id:'admin-a',administrator_name:'Admin A'
  }),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_credit_policy_operations').n,1);
  let current=f.sql('SELECT mode,manual_limit_cents,revision FROM canonical_customer_credit_policies WHERE customer_id=?',id);
  assert.equal(current.mode,'MANUAL');
  assert.equal(current.manual_limit_cents,10000);
  assert.equal(current.revision,1);
  const pending=tab.api.pendingSnapshot();
  assert.equal(pending.command,'customer.credit-policy.set');

  assert.equal(await policyBridge.saveManual({
    customer_id:id,manual_limit_cents:20000,
    reason:'Estos valores no deben crear otra operación',
    administrator_id:'admin-a',administrator_name:'Admin A'
  }),true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_credit_policy_operations').n,1);
  current=f.sql('SELECT mode,manual_limit_cents,revision FROM canonical_customer_credit_policies WHERE customer_id=?',id);
  assert.equal(current.manual_limit_cents,10000);
  assert.equal(current.revision,1);
  assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(tab.api.receiptSnapshot().status,'already_processed');
});


test('credit policy auto-resolves a recoverable foreign sale pending instead of blocking the user',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  let dropSaleAck=true;
  const tab=await policyTab(f,{
    async onFetch(url,options,forward){
      if(url.endsWith('/commands/sale.create')&&dropSaleAck){
        dropSaleAck=false;
        await forward();
        throw new TypeError('sale ACK lost after Turso commit');
      }
      return null;
    }
  });

  const product=tab.api.snapshot().products[0];
  const customer=tab.api.snapshot().customers[0];
  assert.ok(product?.product_id);
  assert.ok(customer?.customer_id);

  await assert.rejects(
    tab.api.createSale({
      items:[{product_id:product.product_id,quantity:1}],
      payment_method:'yape',
      reference:'AUTO-RESOLVE-SALE-PENDING'
    }),
    /CANONICAL_FINANCIAL_PENDING/
  );
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1,'Turso already committed the sale once');
  assert.equal(tab.api.pendingSnapshot().command,'sale.create');

  const policyBridge=tab.context.NuevoAmanecerCanonicalCustomerCreditPolicyBridge;
  assert.equal(await policyBridge.saveManual({
    customer_id:customer.customer_id,
    manual_limit_cents:5000,
    reason:'Ajuste administrativo después de recuperar venta pendiente',
    administrator_id:'admin-a',
    administrator_name:'Admin A'
  }),true);

  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1,'auto-replay must not duplicate the sale');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_credit_policy_operations').n,1);
  assert.equal(f.sql('SELECT manual_limit_cents FROM canonical_customer_credit_policies WHERE customer_id=?',customer.customer_id).manual_limit_cents,5000);
  assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(tab.api.receiptSnapshot().command,'customer.credit-policy.set');
});

test('pre-0018 customer reads remain compatible and policy command fails closed',async t=>{
  const f=await activeCanon(t,{migrations:[
    '0014_canonical_live_products.sql',
    '0015_canonical_inventory_adjust.sql',
    '0016_canonical_generic_sale_lines.sql',
    '0017_canonical_live_customers.sql',
  ]});
  const tab=await policyTab(f);
  const id=tab.api.snapshot().customers[0].customer_id;
  assert.ok(id);
  assert.equal(tab.api.legacySnapshot().customers.some(c=>String(c.id)===String(id)),true);
  await assert.rejects(
    tab.api.setCustomerCreditPolicy({
      customer_id:id,mode:'MANUAL',manual_limit_cents:5000,expected_policy_revision:0,
      reason:'Intento antes de aplicar migración 0018',
      administrator_id:'admin-a',administrator_name:'Admin A'
    }),
    /CANONICAL_FINANCIAL_REJECTED_503/
  );
  assert.equal(tab.api.pendingSnapshot().last_error,'customer_credit_policy_schema_not_ready');
  await tab.api.refresh();
  assert.equal(tab.api.legacySnapshot().customers.some(c=>String(c.id)===String(id)),true);
});


test('P1-5: owner credit-line change requires a free-text reason and the master PIN (when configured)',()=>{
  const manual=inline04.slice(
    inline04.indexOf('async function guardarLineaCreditoManual'),
    inline04.indexOf('async function restaurarLineaCreditoAutomatica')
  );
  const automatic=inline04.slice(
    inline04.indexOf('async function restaurarLineaCreditoAutomatica'),
    inline04.indexOf('function _naCreditModalSummaryHtml')
  );
  const open=inline04.slice(
    inline04.indexOf('function abrirLineaCreditoManual'),
    inline04.indexOf('function actualizarAdvertenciaLineaManual')
  );

  // The reason field is injected by JS: the shared LAB/CANON modal markup is unchanged.
  assert.doesNotMatch(index,/id="lineaManualMotivo"/);
  assert.match(open,/_naEnsureManualLineReasonField\(\)/);
  assert.match(manual,/const reason=_naManualLineReason\(\)/);
  assert.match(manual,/reason\.length<8\|\|reason\.length>500/);
  assert.match(manual,/_naAuthorizeManualLine\(e\.client\.nombre\)/);
  assert.doesNotMatch(manual,/reason='Ajuste manual del propietario'/);
  assert.ok(manual.indexOf('_naAuthorizeManualLine')<manual.indexOf('saveManual('),'PIN before the CANON write');
  assert.match(automatic,/_naAuthorizeManualLine\(e\.client\.nombre\)/);
  assert.match(automatic,/'Restauración automática del propietario'/);
  assert.match(inline04,/function _naAuthorizeManualLine\(clientName\)\{\s*if\(typeof _naSecurity==='undefined'\|\|!_naSecurity\?\.pinEnabled\)return true;/);
  assert.match(index,/Aplicar línea/);
  assert.match(inline04,/Se aplicará como línea manual/);
  assert.match(inline04,/Línea manual activa/);
  assert.match(inline04,/Las excepciones manuales requieren PIN, motivo y auditoría/);
});

test('confirmed policy renders immediately without traversing the full CANON replica',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  const tab=await policyTab(f);
  const id=tab.api.snapshot().customers[0].customer_id;
  tab.context.clientes=tab.api.legacySnapshot().customers;
  const policyBridge=tab.context.NuevoAmanecerCanonicalCustomerCreditPolicyBridge;
  const start=tab.fetchLog.length;

  assert.equal(await policyBridge.saveManual({
    customer_id:id,
    manual_limit_cents:280000,
    reason:'Ajuste manual del propietario',
    administrator_id:null,
    administrator_name:'Propietario'
  }),true);

  const calls=tab.fetchLog.slice(start).map(row=>({method:row.method,path:new URL(row.url).pathname}));
  assert.deepEqual(calls,[{method:'POST',path:'/commands/customer.credit-policy.set'}],
    'confirmed policy must not trigger status or full-replica GETs');

  const local=tab.context.clientes.find(c=>String(c.id)===String(id));
  assert.equal(local.lineaCreditoManualActiva,true);
  assert.equal(local.lineaCreditoManual,2800);
  assert.equal(local.lineaCreditoPolicyRevision,1);

  const canonical=tab.api.legacySnapshot().customers.find(c=>String(c.id)===String(id));
  assert.equal(canonical.lineaCreditoManualActiva,true);
  assert.equal(canonical.lineaCreditoManual,2800);
  assert.equal(canonical.lineaCreditoPolicyRevision,1);
  assert.equal(tab.api.sourceState().validation,'current');
  assert.equal(f.sql('SELECT manual_limit_cents FROM canonical_customer_credit_policies WHERE customer_id=?',id).manual_limit_cents,280000);
});
test('normal credit-policy write reuses the already-current CANON snapshot instead of preloading the full replica',()=>{
  assert.match(bridge,/function currentCanonicalSnapshot\(\)/);
  assert.match(bridge,/assertAction\('customer\.credit-policy\.set'\)/);
  const commit=bridge.slice(bridge.indexOf('async function commit'),bridge.indexOf('// Called by guardarLineaCreditoManual'));
  assert.match(commit,/resolvedForeign\?await refreshCanonical\(\):currentCanonicalSnapshot\(\)/);
  assert.match(bridge,/function reconcileCanonicalInBackground\(customerId\)/);
  assert.match(bridge,/canonicalReceiptAlreadyProjected\(customerId,receipt\)/);
  assert.doesNotMatch(bridge,/async function afterCommit/);
});


test('new credit-policy command sends POST first with no redundant canonical status GET',async t=>{
  const f=await activeCanon(t,{migrations:MIGRATIONS});
  const tab=await policyTab(f);
  const id=tab.api.snapshot().customers[0].customer_id;
  const start=tab.fetchLog.length;

  const receipt=await tab.api.setCustomerCreditPolicy({
    customer_id:id,
    mode:'MANUAL',
    manual_limit_cents:5000,
    reason:'Ajuste directo del propietario',
    administrator_id:null,
    administrator_name:'Propietario'
  });

  assert.equal(receipt.status,'created');
  const calls=tab.fetchLog.slice(start).map(row=>({method:row.method,path:new URL(row.url).pathname}));
  assert.deepEqual(calls,[{method:'POST',path:'/commands/customer.credit-policy.set'}]);
});


test('manual credit-line amount clears only an initial zero on focus',()=>{
  const match=index.match(/<input[^>]*id="lineaManualMonto"[^>]*>/);
  assert.ok(match,'missing lineaManualMonto input');
  const input=match[0];
  assert.match(input,/inputmode="decimal"/);
  assert.match(input,/onfocus="if\(Number\(this\.value\)===0\)this\.value=''"/);
  assert.match(input,/oninput="actualizarAdvertenciaLineaManual\(\)"/);
});
