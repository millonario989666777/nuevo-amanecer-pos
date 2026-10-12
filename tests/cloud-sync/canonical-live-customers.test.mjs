import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const bridge=readFileSync('POS/js/sync/canonical-customer-bridge.js','utf8');
const client=readFileSync('POS/js/sync/canonical-client.js','utf8');
const inline02=readFileSync('POS/js/legacy-inline/inline-02.js','utf8');
const index=readFileSync('POS/index.html','utf8');
const sw=readFileSync('POS/sw.js','utf8');
const migration=readFileSync('infra/database/migrations/0017_canonical_live_customers.sql','utf8');
const scripts=[['canonical-customer-bridge.js',bridge]];
const LIVE_MIGRATIONS=[
  '0014_canonical_live_products.sql',
  '0015_canonical_inventory_adjust.sql',
  '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql',
];

function fillCustomer(tab,overrides={}){
  const values={
    cNombre:'Cliente LIVE E2E',
    cDni:'87654321',
    cTel:'987654321',
    cDir:'Jr. Prueba 123',
    ...overrides,
  };
  for(const [id,value] of Object.entries(values))tab.el(id).value=value;
}

async function customerTab(f,options={}){
  const globals={
    securityIsLocked(){return !!options.locked;},
    storage:{getItem(){return null;}},
    LOCK_KEYS:{master:'na_master_lock',readOnly:'na_readonly',modules:{clientes:'na_lock_clientes'}},
    cliRender(){},posRender(){},updateDashboard(){},
    ...(options.globals||{}),
  };
  const opts={
    token:options.token||'device-a-token',
    localStorage:options.localStorage,
    scripts,
    globals,
    onFetch:options.onFetch,
  };
  if(Object.prototype.hasOwnProperty.call(options,'deviceId'))opts.deviceId=options.deviceId;
  else if(!options.localStorage)opts.deviceId='device-a';
  return device(f,opts);
}

async function createSellableProduct(tab,id='LIVE-CUSTOMER-PROD'){
  const receipt=await tab.api.createProduct({
    product_id:id,name:'Producto para cliente LIVE',sku:id+'-SKU',barcode:id+'-BAR',
    alternate_codes:[],category:'test',brand:'Test',description:null,icon:'📦',image:null,
    unit:'unidad',purchase_unit:'unidad',purchase_factor:1,cost_cents:100,price_cents:250,
    box_price_cents:null,units_per_box:null,initial_stock_quantity:10,stock_min_quantity:0,
    expiry_date:null,includes_igv:true,tax_type:'gravado',complementary_tax:'',tracks_inventory:true
  });
  assert.equal(receipt.status,'created');
  await tab.api.refresh();
  return id;
}

test('customer.create persists, survives F5/second device and works in sale + credit account + credit sale',async(t)=>{
  const f=await activeCanon(t,{migrations:LIVE_MIGRATIONS});
  const tab=await customerTab(f);
  fillCustomer(tab);

  assert.equal(await tab.context.NuevoAmanecerCanonicalCustomerBridge.save(),true);
  const row=f.sql("SELECT * FROM canonical_live_customers WHERE document='87654321'");
  assert.ok(row?.customer_id);
  assert.equal(row.name,'Cliente LIVE E2E');
  assert.equal(row.phone,'+51987654321','P1-4: el teléfono se guarda normalizado a E.164');
  assert.equal(row.address,'Jr. Prueba 123');
  assert.equal(row.total_purchases_cents,0);
  assert.equal(f.sql('SELECT provenance FROM canonical_customer_registry WHERE customer_id=?',row.customer_id).provenance,'LIVE');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_operations WHERE customer_id=?',row.customer_id).n,1);
  assert.deepEqual(tab.context.__closed,['mCli']);

  const local=tab.api.snapshot().customers.find((c)=>c.customer_id===row.customer_id);
  assert.ok(local);
  assert.equal(local.provenance,'LIVE');
  assert.equal(local.document,'87654321');

  const reloaded=await customerTab(f,{localStorage:tab.localStorage});
  assert.ok(reloaded.api.snapshot().customers.some((c)=>c.customer_id===row.customer_id));

  const other=await customerTab(f,{token:'device-b-token',deviceId:'device-b'});
  assert.ok(other.api.snapshot().customers.some((c)=>c.customer_id===row.customer_id));

  const productId=await createSellableProduct(other);
  const account=await other.api.createCreditAccount({
    customer_id:row.customer_id,account_id:'technology',name:'Tecnología',mode:'separate'
  });
  assert.equal(account.status,'created');
  await other.api.refresh();

  const normalSale=await other.api.createSale({
    items:[{product_id:productId,quantity:1}],
    payment_method:'transferencia',
    reference:'LIVE-CUSTOMER-SALE-1',
    customer_id:row.customer_id,
  });
  assert.equal(normalSale.status,'created');
  await other.api.refresh();

  const creditSale=await other.api.createSale({
    items:[{product_id:productId,quantity:1}],
    payment_method:'credito',
    customer_id:row.customer_id,
    credit_due:'2099-12-31',
    credit_account:{account_id:'technology',name:'Tecnología',mode:'separate'},
  });
  assert.equal(creditSale.status,'created');
  await other.api.refresh();

  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_sale_context WHERE customer_id=?',row.customer_id).n,2);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_credit_accounts WHERE customer_id=?',row.customer_id).n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM live_credits WHERE customer_id=?',row.customer_id).n,1);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_credit_metadata WHERE customer_id=? AND account_id='technology'",row.customer_id).n,1);
});

test('customer.create rejects duplicate IMPORT/LIVE document and duplicate customer_id without partial rows',async(t)=>{
  const f=await activeCanon(t,{migrations:LIVE_MIGRATIONS});
  const tab=await customerTab(f);
  const imported=f.sql("SELECT customer_id,document FROM customers WHERE document IS NOT NULL AND trim(document)<>'' ORDER BY customer_id LIMIT 1");
  assert.ok(imported?.document);

  // P1-4: new documents must be DNI (8) or RUC (11) digits. The synthetic
  // imported document ('000C') is not, so it is rejected before the duplicate check.
  await assert.rejects(
    tab.api.createCustomer({name:'Duplicado IMPORT',document:imported.document,phone:null,address:null,color:1}),
    /^\d{8}$|^\d{11}$/.test(imported.document)?/CANONICAL_FINANCIAL_REJECTED_409/:/CANONICAL_FINANCIAL_REJECTED_400/
  );
  assert.equal(tab.api.pendingSnapshot().last_error,/^\d{8}$|^\d{11}$/.test(imported.document)?'customer_document_conflict':'invalid_customer_document');
  assert.equal(await tab.api.discardRejectedCustomer(),true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_customers').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_operations').n,0);

  const first=await tab.api.createCustomer({
    customer_id:'LIVE-CUST-UNIQUE',name:'Cliente único',document:'11223344',phone:null,address:null,color:2
  });
  assert.equal(first.status,'created');
  await tab.api.refresh();

  const second=await customerTab(f,{token:'device-b-token',deviceId:'device-b'});
  await assert.rejects(
    second.api.createCustomer({name:'Duplicado LIVE',document:'11223344',phone:null,address:null,color:3}),
    /CANONICAL_FINANCIAL_REJECTED_409/
  );
  assert.equal(second.api.pendingSnapshot().last_error,'customer_document_conflict');
  assert.equal(await second.api.discardRejectedCustomer(),true);

  await assert.rejects(
    second.api.createCustomer({customer_id:'LIVE-CUST-UNIQUE',name:'ID duplicado',document:'55667788',phone:null,address:null,color:4}),
    /CANONICAL_FINANCIAL_REJECTED_409/
  );
  assert.equal(second.api.pendingSnapshot().last_error,'customer_id_conflict');
  assert.equal(await second.api.discardRejectedCustomer(),true);

  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_customers').n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_customer_operations').n,1);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_customer_registry WHERE provenance='LIVE'").n,1);
});

test('lost ACK retries the same customer operation and never creates a duplicate',async(t)=>{
  const f=await activeCanon(t,{migrations:LIVE_MIGRATIONS});
  let drop=true;
  const tab=await customerTab(f,{
    async onFetch(url,_options,forward){
      if(url.endsWith('/commands/customer.create')&&drop){
        drop=false;
        await forward();
        throw new TypeError('lost ack after commit');
      }
      return null;
    }
  });
  fillCustomer(tab,{cDni:'22334455'});

  assert.equal(await tab.context.NuevoAmanecerCanonicalCustomerBridge.save(),false);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_live_customers WHERE document='22334455'").n,1);
  const pending=tab.api.pendingSnapshot();
  assert.equal(pending.command,'customer.create');
  const operation=pending.payload.operation_id;

  fillCustomer(tab,{cNombre:'NO CREAR SEGUNDO',cDni:'99999999'});
  // P1-5: the pending customer is confirmed, but the different form is kept
  // (not silently discarded) so the cashier can register it next.
  assert.equal(await tab.context.NuevoAmanecerCanonicalCustomerBridge.save(),false);
  assert.equal(tab.el('cNombre').value,'NO CREAR SEGUNDO');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_customers').n,1);
  assert.equal(f.sql('SELECT operation_id FROM canonical_customer_operations').operation_id,operation);
  assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(tab.api.receiptSnapshot().status,'already_processed');
});

test('committed customer + refresh failure is reported CONFIRMED and never as create failure',async(t)=>{
  const f=await activeCanon(t,{migrations:LIVE_MIGRATIONS});
  let failReads=false;
  const tab=await customerTab(f,{
    async onFetch(url){
      if(url.endsWith('/commands/customer.create')){failReads=true;return null;}
      if(failReads&&url.includes('/read/canonical/'))
        return new Response(JSON.stringify({error:'boom'}),{status:503});
      return null;
    }
  });
  fillCustomer(tab,{cDni:'33445566'});

  assert.equal(await tab.context.NuevoAmanecerCanonicalCustomerBridge.save(),true);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_live_customers WHERE document='33445566'").n,1);
  assert.ok(tab.toasts.some(([m])=>/CONFIRMADO/.test(m)&&/NO vuelvas a guardarlo/.test(m)));
  assert.equal(tab.toasts.some(([m])=>/No se registró el cliente/.test(m)),false);
});

test('double tap emits one customer.create and user lock emits none',async(t)=>{
  const f=await activeCanon(t,{migrations:LIVE_MIGRATIONS});
  const tab=await customerTab(f);
  fillCustomer(tab,{cDni:'44556677'});
  const api=tab.context.NuevoAmanecerCanonicalCustomerBridge;
  const [first,second]=await Promise.all([api.save(),api.save()]);
  assert.deepEqual([first,second],[true,false]);
  assert.equal(tab.fetchLog.filter((x)=>x.url.endsWith('/commands/customer.create')).length,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_customers').n,1);

  const locked=await customerTab(f,{token:'device-b-token',deviceId:'device-b',locked:true});
  fillCustomer(locked,{cDni:'55667799'});
  assert.equal(await locked.context.NuevoAmanecerCanonicalCustomerBridge.save(),false);
  assert.equal(locked.fetchLog.filter((x)=>x.url.endsWith('/commands/customer.create')).length,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_live_customers').n,1);
});

test('pre-0017 Worker keeps IMPORT reads/sales working and customer.create fails closed without SQL crash',async(t)=>{
  const f=await activeCanon(t,{migrations:[
    '0014_canonical_live_products.sql',
    '0015_canonical_inventory_adjust.sql',
    '0016_canonical_generic_sale_lines.sql',
  ]});
  const tab=await customerTab(f);
  const imported=tab.api.snapshot().customers.find((c)=>c.customer_id==='000C');
  assert.ok(imported);

  const productId=await createSellableProduct(tab,'PRE17-CUSTOMER-PROD');
  const sale=await tab.api.createSale({
    items:[{product_id:productId,quantity:1}],
    payment_method:'transferencia',
    reference:'PRE17-CUSTOMER-SALE',
    customer_id:imported.customer_id,
  });
  assert.equal(sale.status,'created');
  await tab.api.refresh();
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_sale_context WHERE customer_id='000C'").n,1);

  await assert.rejects(
    tab.api.createCustomer({name:'Schema not ready',document:'66778899',phone:null,address:null,color:1}),
    /CANONICAL_FINANCIAL_REJECTED_503/
  );
  assert.equal(tab.api.pendingSnapshot().last_error,'customer_schema_not_ready');
  assert.equal(tab.api.pendingSnapshot().last_status,503);
  assert.equal(f.sql("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='canonical_live_customers'").n,0);
});

test('0017 preserves pre-existing sale/credit/account rows and all customer FKs are valid after rebuild',async(t)=>{
  const f=await activeCanon(t,{migrations:[
    '0014_canonical_live_products.sql',
    '0015_canonical_inventory_adjust.sql',
    '0016_canonical_generic_sale_lines.sql',
  ]});
  const tab=await customerTab(f);
  const imported='000C';
  const productId=await createSellableProduct(tab,'MIGRATION-CUSTOMER-PROD');

  const account=await tab.api.createCreditAccount({
    customer_id:imported,account_id:'migration-account',name:'Migración',mode:'separate'
  });
  assert.equal(account.status,'created');
  await tab.api.refresh();

  const creditSale=await tab.api.createSale({
    items:[{product_id:productId,quantity:1}],
    payment_method:'credito',
    customer_id:imported,
    credit_due:'2099-12-31',
    credit_account:{account_id:'migration-account',name:'Migración',mode:'separate'},
  });
  assert.equal(creditSale.status,'created');
  await tab.api.refresh();

  const before={
    context:f.all('SELECT * FROM canonical_sale_context ORDER BY sale_id'),
    credits:f.all('SELECT * FROM live_credits ORDER BY credit_id'),
    accounts:f.all('SELECT * FROM canonical_credit_accounts ORDER BY customer_id,account_id'),
    metadata:f.all('SELECT * FROM canonical_credit_metadata ORDER BY credit_id'),
  };
  assert.ok(before.context.length>0);
  assert.ok(before.credits.length>0);
  assert.ok(before.accounts.length>0);
  assert.ok(before.metadata.length>0);

  f.database.exec(migration);

  assert.deepEqual(f.all('SELECT * FROM canonical_sale_context ORDER BY sale_id'),before.context);
  assert.deepEqual(f.all('SELECT * FROM live_credits ORDER BY credit_id'),before.credits);
  assert.deepEqual(f.all('SELECT * FROM canonical_credit_accounts ORDER BY customer_id,account_id'),before.accounts);
  assert.deepEqual(f.all('SELECT * FROM canonical_credit_metadata ORDER BY credit_id'),before.metadata);
  assert.equal(f.sql("SELECT provenance FROM canonical_customer_registry WHERE customer_id='000C'").provenance,'IMPORT');
  assert.deepEqual(f.all('PRAGMA foreign_key_check'),[]);

  const required=[
    'canonical_sale_context_authorized_insert','canonical_sale_context_no_update','canonical_sale_context_no_delete','sale_context_no_replace',
    'live_credits_no_import_collision','live_credits_authorized_insert','live_credits_no_update','live_credits_no_delete','live_credits_no_replace',
    'credit_accounts_authorized_insert','credit_accounts_no_update','credit_accounts_no_delete','credit_accounts_no_replace','credit_account_expense_operation_collision',
    'credit_metadata_live_guard','credit_metadata_import_guard','credit_metadata_no_update','credit_metadata_no_delete','credit_metadata_no_replace','credit_metadata_expense_operation_collision',
  ];
  const triggers=new Set(f.all(`SELECT name FROM sqlite_master WHERE type='trigger'
    AND tbl_name IN ('canonical_sale_context','live_credits','canonical_credit_accounts','canonical_credit_metadata')`).map((r)=>r.name));
  for(const name of required)assert.ok(triggers.has(name),'missing trigger '+name);
});

test('customer bridge/client/schema expose CANON path and never make legacy customer storage authoritative',()=>{
  assert.match(client,/['"]customer\.create['"]/);
  assert.match(client,/function createCustomer\(input\)/);
  assert.match(client,/discardRejectedCustomer/);
  assert.match(client,/createCustomer:\s*createCustomer/);
  assert.match(inline02,/NuevoAmanecerCanonicalCustomerBridge/);
  assert.match(inline02,/return await canonicalBridge\.save\(\)/);
  assert.match(index,/js\/sync\/canonical-customer-bridge\.js/);
  assert.match(sw,/\.\/js\/sync\/canonical-customer-bridge\.js/);
  assert.match(migration,/canonical_customer_operations/);
  assert.match(migration,/canonical_customer_registry/);
  assert.match(migration,/canonical_live_customers/);
  assert.doesNotMatch(bridge,/saveAllData\s*\(|clientes\s*\.push/);
  assert.doesNotMatch(bridge,/\bcliRender\s*=/);
});
