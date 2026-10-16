import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {activeCanon, device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const source = name => readFileSync('POS/js/' + name, 'utf8');
const saleScripts = ['canonical-sale-intent','canonical-sale-outbox','canonical-sale-projection','canonical-sale-integration','canonical-sale-view'];

async function fixture(t, options={}) {
  const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql','0024_pos_roles_owner_pin.sql']});
  const turso=tursoSqlite(f.database);
  f.env.DB=turso.adapter;
  f.env.nuevo_amanecer_lab={prepare(){throw Error('D1 must not be used');}};
  const tab=await device(f,{token:'sales-session',deviceId:'sales-device',...options,
    scripts:[['lexical-runtime',`let cart=[],productos=[],ventas=[],clientes=[],creditos=[],cajEstado={},cajMovs=[],posProc=false,posPayM='efectivo';`],
      ...saleScripts.map(name=>[name,source('sync/'+name+'.js')])],
    globals:{isModuleLocked:()=>false,_naSessionOpen:()=>true,_naPaymentState:()=>({valid:true}),
      _naTracksStock:()=>true,_naUnitsSold:i=>i.qty,_naUnitsPerQty:()=>1,posUpdateCart(){},posRender(){},...options.globals}
  });
  await tab.api.adjustInventory({product_id:'00001',movement_type:'ENTRADA',quantity:173,reason:'Synthetic test stock'});
  await tab.api.refresh();
  await tab.api.openCash({session_id:'cash-sale-root',opening_cents:0});
  await tab.api.refresh();
  const legacy=tab.api.legacySnapshot();
  tab.context.__legacy=legacy;
  vm.runInContext('productos=__legacy.products;ventas=__legacy.sales;clientes=__legacy.customers;',tab.context);
  // The real cart producer spreads the uiProduct, preserving its exact id.
  const add=()=>vm.runInContext("cart=[{...productos.find(p=>p.id==='00001'),qty:1,precio:2}];",tab.context);
  return {f,tab,turso,add};
}

function deferBackgroundSaleSync(tab){
  const deferred=[];
  const realSet=tab.context.setTimeout;
  tab.context.setTimeout=(fn,ms)=>ms===0?(deferred.push(fn),deferred.length):realSet(fn,ms);
  return deferred;
}

test('raw CANON product_id projects without PRODUCT_NOT_FOUND and respects stockless products',async t=>{
  const {tab}=await fixture(t);
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  const base=tab.api.snapshot();
  const view=tab.context.NuevoAmanecerCanonicalSaleProjection.project(base,{version:1,intents:[intent]});
  assert.equal(view.sales[0].conflict,false);
  assert.equal(view.products.find(p=>p.product_id==='00001').projected_stock,172);
  const stockless={...base,products:[{product_id:'00001',tracks_inventory:0,current_stock_quantity:0}]};
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleProjection.project(stockless,{version:1,intents:[intent]}).sales[0].conflict,false);
});

test('adapter → local durable commit → Turso sync → receipt → history, stock and cash exactly once',async t=>{
  const {f,tab,turso,add}=await fixture(t);
  deferBackgroundSaleSync(tab);
  add();
  assert.equal(tab.context.cart,undefined);
  const before=tab.fetchLog.length;
  const local=await vm.runInContext('confirmarVenta()',tab.context);
  assert.equal(local.status,'PENDING_SYNC');
  assert.equal(vm.runInContext('cart.length',tab.context),0,'clear lexical cart only after local durability');
  assert.equal(vm.runInContext('posProc',tab.context),false);
  assert.equal(tab.context.cart,undefined);
  assert.ok(tab.context.__closed.includes('mCobro'),'close lexical modal');
  assert.ok(tab.toasts.some(([m])=>/guardada/i.test(m)),'local committed toast (no success before the server)');
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,1);
  assert.equal(tab.fetchLog.slice(before).some(row=>new URL(row.url).pathname==='/commands/sale.create'),false,'local commit must not wait for network');
  assert.equal((await tab.context.NuevoAmanecerCanonicalSaleOutbox.sync()).status,'DRAINED');
  const post=tab.fetchLog.find(row=>new URL(row.url).pathname==='/commands/sale.create');
  assert.ok(post,'the queued sale must be sent');
  const payload=JSON.parse(post.body);
  assert.equal(payload.items[0].product_id,'00001');
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
  assert.equal(vm.runInContext('ventas[0].id',tab.context),'V-001','receipt-backed sale must be visible before full refresh');
  assert.equal(vm.runInContext('ventas[0].canonicalReceiptProjection',tab.context),true);
  await tab.api.refresh();
  assert.equal(tab.api.legacySnapshot().sales[0].id,'V-001');
  const replay=await f.fetch(post.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer sales-session'},body:post.body});
  assert.equal(replay.status,200);
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
  const second=await device(f,{token:'second-session',deviceId:'second-device'});
  assert.equal(second.api.legacySnapshot().sales[0].id,'V-001');
  const reload=await device(f,{token:'sales-session',localStorage:tab.localStorage});
  assert.equal(reload.api.legacySnapshot().sales[0].operation_id,payload.operation_id);
  assert.ok(turso.calls.some(call=>call.requests[0].type==='batch'));
});

test('online sale critical path commits locally first, then one POST reaches receipt before reconciliation GETs',async t=>{
  const {f,tab,add}=await fixture(t);
  deferBackgroundSaleSync(tab);
  const receipts=[];
  tab.context.addEventListener('na:canonical-sale-receipt',event=>{
    const journal=JSON.parse(tab.localStorage.getItem('na_canonical_sale_journal'));
    receipts.push({detail:event.detail,state:journal&&journal.state});
  });
  add();
  const start=tab.fetchLog.length;
  const local=await vm.runInContext('confirmarVenta()',tab.context);
  assert.equal(local.status,'PENDING_SYNC');
  assert.equal(tab.fetchLog.length,start,'cashier completion must perform zero network calls');
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,1);
  assert.equal((await tab.context.NuevoAmanecerCanonicalSaleOutbox.sync()).status,'DRAINED');
  const calls=tab.fetchLog.slice(start).map(row=>({method:row.method,path:new URL(row.url).pathname}));
  const postIndex=calls.findIndex(row=>row.method==='POST'&&row.path==='/commands/sale.create');
  assert.equal(postIndex,0,'background drain must POST before any reconciliation GET');
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].state,'CONFIRMED','sale receipt event is emitted only after durable journal confirmation');
  assert.equal(receipts[0].detail.payload.operation_id,receipts[0].detail.receipt.operation_id);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
  assert.equal(vm.runInContext('ventas.length',tab.context),1);
  assert.equal(vm.runInContext('ventas[0].id',tab.context),'V-001');
  assert.equal(vm.runInContext('ventas[0].estado',tab.context),'completada');
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
  assert.ok(calls.slice(1).every(row=>row.method==='GET'||row.method==='POST'),'any reconciliation work must occur only after the receipt POST');
});

test('post-sale ACTIVE refresh keeps previous history visible until the new complete snapshot arrives',async t=>{
  let holdSales=false, releaseSales, markSalesRequested;
  const salesGate=new Promise(resolve=>{releaseSales=resolve;});
  const salesRequested=new Promise(resolve=>{markSalesRequested=resolve;});
  const {tab,add}=await fixture(t,{onFetch:async(url,options,next)=>{
    if(holdSales&&new URL(url).pathname==='/read/canonical/sales'){
      markSalesRequested();
      await salesGate;
      return next();
    }
  }});

  const first=tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  await tab.api.createSale(first);
  await tab.api.refresh();
  assert.deepEqual(Array.from(vm.runInContext('ventas.map(v=>v.id)',tab.context)),['V-001']);

  holdSales=true;
  add();
  await vm.runInContext('confirmarVenta()',tab.context);
  await salesRequested;

  assert.equal(tab.api.sourceState().validation,'current','ACTIVE one-wave refresh keeps the last complete replica current until replacement is complete');
  assert.deepEqual(Array.from(tab.api.legacySnapshot().sales.map(v=>v.id)),['V-001'],'remote snapshot must remain the last complete history while one ACTIVE route is blocked');
  assert.deepEqual(Array.from(vm.runInContext('ventas.map(v=>v.id)',tab.context)),['V-001','V-002'],'receipt projection must append instantly without hiding prior history');

  releaseSales();
  await tab.api.refresh();
  assert.equal(tab.api.sourceState().validation,'current');
  assert.deepEqual(Array.from(vm.runInContext('ventas.map(v=>v.id)',tab.context)),['V-001','V-002']);
});

test('production simple sale commits auth, authority, stock and cash in one Turso pipeline',async t=>{
  const {f,tab,turso}=await fixture(t);
  f.env.RUNTIME_ENVIRONMENT='production';
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({
    sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]
  });

  const start=turso.calls.length;
  const receipt=await tab.api.createSale(intent);
  const calls=turso.calls.slice(start);
  assert.equal(receipt.status,'created');
  assert.deepEqual(calls.map(call=>call.requests?.[0]?.type),['batch'],
    'simple production sale must cross Worker→Turso only once');
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_write_guards').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n,0);
});

test('production one-trip sale replay returns the same durable receipt without double stock or cash',async t=>{
  const {f,tab}=await fixture(t);
  f.env.RUNTIME_ENVIRONMENT='production';
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({
    sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]
  });
  await tab.api.createSale(intent);
  const post=tab.fetchLog.find(row=>new URL(row.url).pathname==='/commands/sale.create');
  assert.ok(post);
  const replay=await f.fetch(post.url,{
    method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer sales-session'},
    body:post.body
  });
  assert.equal(replay.status,200);
  const body=await replay.json();
  assert.equal(body.status,'already_processed');
  assert.equal(body.sale_id,'V-001');
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
});

test('production one-trip sale rejects a revoked browser session before any business mutation',async t=>{
  const {f,tab}=await fixture(t);
  f.env.RUNTIME_ENVIRONMENT='production';
  f.exec("UPDATE auth_sessions SET status='revoked' WHERE session_id='sales-device'");
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({
    sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]
  });
  await assert.rejects(()=>tab.api.createSale(intent),/CANONICAL_FINANCIAL_REJECTED_403/);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,0);
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,173);
});

test('production one-trip sale preserves stock CAS when another tab holds a stale revision',async t=>{
  const {f,tab}=await fixture(t);
  f.env.RUNTIME_ENVIRONMENT='production';
  const stale=await device(f,{token:'stale-session',deviceId:'stale-device'});
  const make=saleId=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({
    sale_id:saleId,payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]
  });

  await tab.api.createSale(make('V-001'));
  await assert.rejects(()=>stale.api.createSale(make('V-002')),/CANONICAL_FINANCIAL_REJECTED_409/);
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
});

test('Turso sale validation uses four protocol trips cold and three warm including auth and atomic commit',async t=>{
  const {f,tab,turso}=await fixture(t);
  const make=saleId=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({
    sale_id:saleId,payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]
  });

  let start=turso.calls.length;
  await tab.api.createSale(make('V-001'));
  let calls=turso.calls.slice(start);
  assert.deepEqual(calls.map(call=>call.requests?.[0]?.type),['execute','execute','batch','batch'],
    'cold Turso sale must be auth + schema capability read + batched validation + atomic commit');
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);

  await tab.api.refresh();
  start=turso.calls.length;
  await tab.api.createSale(make('V-002'));
  calls=turso.calls.slice(start);
  assert.deepEqual(calls.map(call=>call.requests?.[0]?.type),['execute','batch','batch'],
    'warm Turso sale must be auth + batched validation + atomic commit');
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,171);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,2);
});

test('pending V-001 does not block V-002; both stay durable offline and drain in FIFO order',async t=>{
  const {tab,add}=await fixture(t);
  deferBackgroundSaleSync(tab);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  tab.context.navigator.onLine=false; add();
  await vm.runInContext('confirmarVenta()',tab.context);
  let pending=queue.snapshot().intents;
  assert.equal(pending.length,1);
  assert.equal(pending[0].sale_id,'V-001');

  add();await vm.runInContext('confirmarVenta()',tab.context);
  pending=queue.snapshot().intents;
  assert.deepEqual(Array.from(pending.map(intent=>intent.sale_id)),['V-001','V-002']);
  assert.equal(vm.runInContext('cart.length',tab.context),0,'second cart is durably committed locally too');

  tab.context.navigator.onLine=true;
  assert.equal((await queue.sync()).status,'DRAINED');
  assert.equal(queue.snapshot().intents.length,0);
  assert.deepEqual(Array.from(vm.runInContext('ventas.map(v=>v.id)',tab.context)),['V-001','V-002']);
});

test('lost ACK retains durable intent; exact retry confirms and never repeats stock/cash',async t=>{
  let lose=true;
  const {f,tab,add}=await fixture(t,{onFetch:async(url,options,next)=>{
    if(new URL(url).pathname==='/commands/sale.create'&&lose){lose=false;await next();throw Error('lost ACK');}
  }});
  deferBackgroundSaleSync(tab);
  add();
  await vm.runInContext('confirmarVenta()',tab.context);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  assert.equal(queue.snapshot().intents.length,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0,'local commit precedes network');
  assert.equal((await queue.sync()).status,'WAITING');
  assert.equal(queue.snapshot().intents.length,1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
  assert.equal((await queue.sync()).status,'DRAINED');
  assert.equal(queue.snapshot().intents.length,0);
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,172);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,1);
  await tab.api.refresh();
  assert.equal(tab.api.legacySnapshot().sales.length,1);
});

test('cash bridge current replica uses one POST and projects open state before reconciliation',async t=>{
  const {tab}=await fixture(t);
  await tab.api.closeCash({counted_cents:0});await tab.api.refresh();
  tab.context._naFindCashier=()=>({id:'cashier',nombre:'Caja'});
  tab.el('cajFondo').value='10';
  const real=tab.api;let release;const gate=new Promise(resolve=>{release=resolve;});
  tab.context.NuevoAmanecerCanonical={...real,refresh:async()=>{await gate;return real.refresh();}};
  vm.runInContext(source('sync/canonical-cash-bridge.js'),tab.context);
  const start=tab.fetchLog.length;
  assert.equal(await tab.context.abrirCaja(),true);
  const calls=tab.fetchLog.slice(start),postIndex=calls.findIndex(row=>new URL(row.url).pathname==='/commands/cash.open');
  assert.equal(postIndex,0,'cash.open happy path must POST directly without a redundant status GET');
  const projected=real.legacySnapshot().cashState;
  assert.equal(projected.abierta,true);
  assert.equal(projected.fondo,10);
  assert.equal(real.sourceState().validation,'current');
  release();await real.refresh();
});

test('enqueue reserves sale id inside shared lock even for two captures from the same stale snapshot',async t=>{
  const {tab}=await fixture(t);
  const make=()=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  const first=await tab.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(make());
  const second=await tab.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(make());
  assert.equal(first.sale_id,'V-001');assert.equal(second.sale_id,'V-002');
});

test('confirmed operation left in outbox by storage/ACK failure does not project stock twice',async t=>{
  const {tab}=await fixture(t);
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  await tab.api.createSale(intent);await tab.api.refresh();
  const view=tab.context.NuevoAmanecerCanonicalSaleProjection.project(tab.api.snapshot(),{version:1,intents:[intent]});
  assert.equal(view.sales.length,1);
  assert.equal(view.products.find(p=>p.product_id==='00001').projected_stock,undefined);
});

test('targeted test-intent rejection archives only demonstrably invalid selected V-001; preserves unrelated storage',async t=>{
  const {tab}=await fixture(t);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const make=(amount,product)=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:product,quantity:1,precio:amount}]});
  const invalid=make(2,'missing-product');await queue.enqueue(invalid);
  tab.localStorage.setItem('unrelated','must-survive');
  assert.equal(typeof queue.rejectInvalidTestIntent,'function');
  await queue.rejectInvalidTestIntent(invalid.operation_id);
  assert.equal(queue.snapshot().intents.length,0);
  assert.equal(tab.localStorage.getItem('unrelated'),'must-survive');
  const valid=make(3,'00001');await queue.enqueue(valid);
  await assert.rejects(queue.rejectInvalidTestIntent(valid.operation_id),/TEST_INTENT_NOT_PROVEN_INVALID/);
  assert.equal(queue.snapshot().intents.length,1);
});

test('cash UI releases on receipt even when the post-confirmation refresh is blocked',async t=>{
  const {tab}=await fixture(t);
  await tab.api.closeCash({counted_cents:0});await tab.api.refresh();
  const real=tab.api;let release;const gate=new Promise(resolve=>{release=resolve;});
  tab.context.NuevoAmanecerCanonical={...real,refresh:async()=>{await gate;return real.refresh();}};
  tab.context._naFindCashier=()=>({id:'cashier',nombre:'Caja'});
  tab.el('cajFondo').value='0';
  vm.runInContext(source('sync/canonical-cash-bridge.js'),tab.context);
  assert.equal(await tab.context.abrirCaja(),true);
  assert.ok(tab.context.__closed.includes('mApertura'));
  assert.ok(tab.toasts.some(([m])=>/Caja CANON abierta/.test(m)));
  release();await real.refresh();
});

test('cash close, ingreso, egreso and expense use lexical movement state and no redundant pre-command scans',async t=>{
  const {tab}=await fixture(t);
  vm.runInContext("let cajMovTipo='egr';",tab.context);
  vm.runInContext(source('sync/canonical-cash-bridge.js'),tab.context);
  async function check(command, action) {
    await tab.api.refresh();
    const start=tab.fetchLog.length;
    assert.equal(await action(),true);
    const calls=tab.fetchLog.slice(start),post=calls.findIndex(r=>new URL(r.url).pathname==='/commands/'+command);
    assert.ok(post>=0,command);
    const beforePost=calls.slice(0,post).map(r=>new URL(r.url).pathname);
    assert.deepEqual(beforePost,command==='expense.create'?['/read/canonical/status']:[],
      command+' must use the shortest authority-safe path before POST');
    await tab.api.refresh();
  }
  await tab.api.createAdjustment({amount_cents:1000,reason:'Synthetic fund'});
  tab.el('cajMovMonto').value='1';tab.el('cajMovDesc').value='Synthetic egress';tab.el('cajMovCat').value='Otro';
  await check('adjustment.create',()=>tab.context.guardarMovCaja());
  assert.equal(tab.api.snapshot().financialEvents.filter(event=>event.cash_delta_cents===-100).length,1);
  vm.runInContext("cajMovTipo='ing'",tab.context);
  await check('adjustment.create',()=>tab.context.guardarMovCaja());
  vm.runInContext(source('sync/canonical-expense-bridge.js'),tab.context);
  tab.context.obtenerHoy=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/Lima'});
  tab.el('gasDesc').value='Synthetic expense';tab.el('gasMonto').value='1';tab.el('gasCat').value='Otro';tab.el('gasMetodo').value='efectivo';tab.el('gasFecha').value=tab.context.obtenerHoy();
  await check('expense.create',()=>tab.context.guardarGasto());
  assert.ok(tab.context.__closed.includes('mGasto'));
  tab.el('cajContado').value='9';
  await check('cash.close',()=>tab.context.cerrarCaja());
});

test('cash lost ACK retry revalidates authority and replays the exact operation once',async t=>{
  let lose=false;
  const {tab}=await fixture(t,{onFetch:async(url,options,next)=>{
    if(new URL(url).pathname==='/commands/cash.open'&&lose){lose=false;await next();throw Error('lost cash ACK');}
  }});
  await tab.api.closeCash({counted_cents:0});await tab.api.refresh();
  lose=true;
  const before=tab.fetchLog.length;
  await assert.rejects(()=>tab.api.openCash({session_id:'cash-retry-1',opening_cents:100}),/CANONICAL_FINANCIAL_PENDING/);
  const first=tab.fetchLog.slice(before).map(r=>new URL(r.url).pathname);
  assert.equal(first[0],'/commands/cash.open','new cash.open must POST directly');
  const retryStart=tab.fetchLog.length;
  const receipt=await tab.api.retryPending();
  assert.equal(receipt.status,'already_processed');
  const retryCalls=tab.fetchLog.slice(retryStart).map(r=>new URL(r.url).pathname);
  assert.deepEqual(retryCalls.slice(0,2),['/read/canonical/status','/commands/cash.open'],
    'retry must revalidate remote authority before replaying the same operation');
  assert.equal(tab.api.legacySnapshot().cashState.abierta,true);
});

test('confirmed ID stays durably reserved after post-ACK refresh fails',async t=>{
  let block=false;
  const {tab,add}=await fixture(t,{onFetch:async(url)=>{
    if(block&&new URL(url).pathname.startsWith('/read/canonical/'))throw Error('temporary read failure');
  }});
  // Commit while the last visible snapshot still has zero sales.
  const make=()=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  const intent=await tab.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(make());
  await tab.api.createSale(intent);block=true;
  await tab.context.NuevoAmanecerCanonicalSaleOutbox.sync();
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
  const next=await tab.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(make());
  assert.equal(next.sale_id,'V-002');
});

test('started outbox automatically replays a lost ACK without another sale, reload or manual sync',async t=>{
  let lose=true;
  const {tab}=await fixture(t,{onFetch:async(url,options,next)=>{
    if(new URL(url).pathname==='/commands/sale.create'&&lose){lose=false;await next();throw Error('lost ACK');}
  }});
  const timers=[];
  const realSet=tab.context.setTimeout,realClear=tab.context.clearTimeout;
  tab.context.setTimeout=(fn,ms)=>ms<8000?(timers.push(fn),timers.length):realSet(fn,ms);
  tab.context.clearTimeout=id=>{if(typeof id!=='number')realClear(id);};
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  await tab.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(intent);
  await tab.context.NuevoAmanecerCanonicalSaleOutbox.start();
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,1);
  assert.equal(timers.length,1,'schedule a bounded retry');
  await timers.shift()();
  assert.equal(tab.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
});

test('upgrade: draining an old v1 envelope preserves its sale-number reservation',async t=>{
  const {tab}=await fixture(t);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  tab.localStorage.setItem(queue.KEY,JSON.stringify({version:1,intents:[intent]}));
  assert.equal((await queue.sync()).status,'DRAINED');
  assert.equal(queue.snapshot().last_sale_number,1);
});

test('legacy duplicate test intents are blocked before POST and can be selectively archived as a pair',async t=>{
  const {tab}=await fixture(t);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const make=amount=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:amount}]});
  const first=make(2),second=make(3);
  tab.localStorage.setItem(queue.KEY,JSON.stringify({version:1,intents:[first,second]}));
  const before=tab.fetchLog.length;
  assert.equal((await queue.sync()).status,'BLOCKED_DUPLICATE_SALE_ID');
  assert.equal(tab.fetchLog.slice(before).some(row=>row.method==='POST'),false);
  await queue.rejectInvalidTestIntent(first.operation_id);
  await queue.rejectInvalidTestIntent(second.operation_id);
  assert.equal(queue.snapshot().intents.length,0);
  assert.equal(JSON.parse(tab.localStorage.getItem(queue.KEY+'_rejected_tests')).length,2);
});

test('startup archives only the owner-identified duplicate V-001 test pair without sending a sale',async t=>{
  const {tab,f}=await fixture(t);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const make=amount=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:amount}]});
  const first=make(2),second=make(3);
  tab.localStorage.setItem(queue.KEY,JSON.stringify({version:1,intents:[first,second]}));
  tab.localStorage.setItem('unrelated','preserved');
  const before=tab.fetchLog.length;
  await queue.start();
  assert.equal(queue.snapshot().intents.length,0);
  assert.equal(queue.snapshot().last_sale_number,1);
  assert.equal(tab.fetchLog.slice(before).some(row=>row.method==='POST'),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM cash_movements').n,0);
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n,173);
  assert.equal(tab.localStorage.getItem('unrelated'),'preserved');
  assert.equal(JSON.parse(tab.localStorage.getItem(queue.KEY+'_rejected_tests')).length,2);
});

test('startup never archives a different duplicate amount pair or an unknown ACK',async t=>{
  const {tab}=await fixture(t);
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const make=amount=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:amount}]});
  tab.localStorage.setItem(queue.KEY,JSON.stringify({version:1,intents:[make(2),make(4)]}));
  await queue.start();
  assert.equal(queue.snapshot().intents.length,2);
  assert.equal(tab.localStorage.getItem(queue.KEY+'_rejected_tests'),null);
});

test('startup preserves the exact test pair when a committed sale has an unknown ACK',async t=>{
  let lose=true;
  const {tab,f}=await fixture(t,{onFetch:async(url,options,next)=>{
    if(new URL(url).pathname==='/commands/sale.create'&&lose){lose=false;await next();throw Error('lost ACK');}
  }});
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const make=amount=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:amount}]});
  const first=make(2),second=make(3);
  tab.localStorage.setItem(queue.KEY,JSON.stringify({version:1,intents:[first,second]}));
  await assert.rejects(tab.api.createSale(first),/CANONICAL_FINANCIAL_PENDING/);
  const before=JSON.stringify(queue.snapshot().intents);
  await queue.start();
  assert.equal(JSON.stringify(queue.snapshot().intents),before);
  assert.equal(tab.localStorage.getItem(queue.KEY+'_rejected_tests'),null);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
});

test('startup repair retries a transient authenticated read failure without sending either test intent',async t=>{
  let failNext=false;
  const {tab,f}=await fixture(t,{onFetch:async url=>{
    if(failNext&&new URL(url).pathname==='/read/canonical/status'){failNext=false;throw Error('transient read');}
  }});
  const queue=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const make=amount=>tab.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:amount}]});
  tab.localStorage.setItem(queue.KEY,JSON.stringify({version:1,intents:[make(2),make(3)]}));
  const timers=[],realSet=tab.context.setTimeout,realClear=tab.context.clearTimeout;
  tab.context.setTimeout=(fn,ms)=>ms<8000?(timers.push(fn),timers.length):realSet(fn,ms);
  tab.context.clearTimeout=id=>{if(typeof id!=='number')realClear(id);};
  failNext=true;await queue.start();
  assert.equal(queue.snapshot().intents.length,2);
  assert.equal(timers.length,1);
  await timers.shift()();
  assert.equal(queue.snapshot().intents.length,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
});
