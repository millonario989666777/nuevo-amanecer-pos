import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync('POS/js/sync/canonical-client.js','utf8');
const adapterSource=readFileSync('POS/js/adapters/canonical-ui-adapter.js','utf8');
const expenseBridgeSource=readFileSync('POS/js/sync/canonical-expense-bridge.js','utf8');
const indexSource=readFileSync('POS/index.html','utf8');
const swSource=readFileSync('POS/sw.js','utf8');

test('canonical client maps every operational entity through fallback reads and bulk snapshot',()=>{
  const compact=source.replace(/\s+/g,'');
  for(const pair of [
    "['cash-sessions','cashSessions']",
    "['financial-events','financialEvents']",
    "['expenses','expenses']",
    "['sales','sales']",
    "['sale-items','saleItems']",
    "['inventory-movements','inventoryMovements']",
    "['cash-movements','cashMovements']"
  ]) assert.ok(compact.includes(pair),pair);
  assert.match(source,/var waveEntries = coreEntries\.filter\(function \(entry\) \{ return !accountsRead \|\| entry !== accountsEntry; \}\)\.concat\(activeEntries\)/,'ACTIVE fallback wave covers every collection (credit-accounts may already be in flight)');
  assert.match(source,/Promise\.all\(waveEntries\.map\(readEntry\)\)/,'ACTIVE fallback must keep one complete parallel read wave');
  assert.match(source,/endpoint \+ '\/read\/canonical\/snapshot'/,'bulk path must use the canonical snapshot endpoint');
  for(const marker of [
    'next.cashSessions = snap.cash_sessions',
    'next.financialEvents = snap.financial_events',
    'next.expenses = snap.expenses',
    'next.sales = snap.sales',
    'next.saleItems = snap.sale_items',
    'next.inventoryMovements = snap.inventory_movements',
    'next.cashMovements = snap.cash_movements'
  ]) assert.ok(source.includes(marker),marker);
});

test('operational arrays survive replica cache round-trips without becoming required for old caches',()=>{
  for(const marker of ['replica.sales == null','replica.sale_items == null','replica.inventory_movements == null','replica.cash_movements == null']) assert.ok(source.includes(marker),marker);
  for(const marker of ['sales: copy(value.sales || [])','sale_items: copy(value.saleItems || [])','inventory_movements: copy(value.inventoryMovements || [])','cash_movements: copy(value.cashMovements || [])']) assert.ok(source.includes(marker),marker);
  for(const marker of ['sales: copy(replica.sales || [])','saleItems: copy(replica.sale_items || [])','inventoryMovements: copy(replica.inventory_movements || [])','cashMovements: copy(replica.cash_movements || [])']) assert.ok(source.includes(marker),marker);
});

test('staged refresh preserves same-authority operational history instead of publishing an empty sales window',()=>{
  assert.match(source,/function operationalBootstrapSeed\(current, expected\)/);
  assert.match(source,/current\.promotion_id !== expected\.promotion_id/);
  assert.match(source,/current\.authority_epoch !== expected\.authority_epoch/);
  assert.match(source,/current\.revision !== expected\.revision/);
  assert.match(source,/sales: copy\(current\.sales \|\| \[\]\)/);
  assert.match(source,/next\.sales = operationalSeed\.sales/);
  assert.match(source,/next\.cashMovements = operationalSeed\.cashMovements/);
  assert.doesNotMatch(source,/next\.sales = \[\]; next\.saleItems = \[\]; next\.inventoryMovements = \[\];/);
  assert.match(source,/next\.read_only = true; next\.mode = 'CANONICAL_READ_ONLY'/,'bootstrap must remain fail-closed while old operational history is displayed');
});

test('operational history remains a read concern and adds no new commands',()=>{
  const commands=source.match(/var COMMANDS = \[([^\]]+)\]/)?.[1]||'';
  assert.doesNotMatch(commands,/sales\.read|cash\.read|inventory\.read/);
  assert.doesNotMatch(source,/createOperational|writeSaleHistory|writeCashHistory/);
});


test('operational adapter preserves sale totals, mixed payment parts and exact cash session linkage',()=>{
  const context={globalThis:{}};
  vm.runInNewContext(adapterSource,context,{filename:'canonical-ui-adapter.js'});
  const adapter=context.globalThis.NuevoAmanecerCanonicalUIAdapter;
  const out=adapter.snapshot({
    authority:'canonical',promotion_id:'p',authority_epoch:1,revision:1,financial_revision:1,mode:'ACTIVE',read_only:false,
    products:[{product_id:'prod-1',name:'Producto',category:'a',icon:'📦',cost_cents:200,price_cents:500,current_stock_quantity:5,stock_revision:1,stock_min_quantity:1,tracks_inventory:1}],
    customers:[{customer_id:'cli-1',name:'Cliente',document:'70000001',total_purchases_cents:1000}],
    creditAccounts:[],credits:[],payments:[],
    sales:[{sale_id:'sale-1',operation_id:'op-1',payment_method:'mixto',total_cents:1000,payment_reference:'REF',created_at:'2026-09-27T17:00:00.000Z',customer_id:'cli-1'}],
    saleItems:[{sale_id:'sale-1',line_number:1,operation_id:'op-1',product_id:'prod-1',quantity:2,unit_price_cents:500,line_total_cents:1000,created_at:'2026-09-27T17:00:00.000Z'}],
    inventoryMovements:[{movement_id:'inv-1',operation_id:'op-1',sale_id:'sale-1',line_number:1,product_id:'prod-1',quantity:-2,created_at:'2026-09-27T17:00:00.000Z'}],
    cashMovements:[{movement_id:'cash-1',operation_id:'op-1',sale_id:'sale-1',payment_method:'mixto',amount_cents:1000,cash_cents:400,digital_cents:600,credit_cents:0,digital_method:'transferencia',reference:'REF',created_at:'2026-09-27T17:00:00.000Z',session_id:'sess-1'}],
    cashSessions:[{session_id:'sess-1',opening_cents:10000,opened_at:'2026-09-27T16:00:00.000Z',status:'OPEN',expected_cents:10600,revision:2}],
    financialEvents:[{event_id:'pay-1',operation_id:'pay-1',event_type:'PAYMENT',session_id:'sess-1',credit_id:'cr-1',credit_delta_cents:-200,cash_delta_cents:200,payment_method:'efectivo',created_at:'2026-09-27T17:05:00.000Z'}]
  });
  assert.equal(out.sales[0].items.reduce((n,item)=>n+item.qty*item.precio,0),10);
  assert.deepEqual(JSON.parse(JSON.stringify(out.sales[0].paymentBreakdown)),{efectivo:4,digital:6,digitalMethod:'transferencia',reference:'REF'});
  assert.equal(out.sales[0].canonicalReadOnly,true);
  assert.equal(out.cashState.sessionId,'sess-1');
  assert.equal(out.cashState.esperado,106);
  assert.equal(out.cashMovements.find(x=>x.ventaId==='sale-1').sessionId,'sess-1');
  assert.equal(out.cashMovements.find(x=>x.creditoId==='cr-1').efectivo,2);
  assert.equal(out.inventoryMovements[0].delta,-2);
});


test('canonical client treats expenses as a durable command and replicated operational entity',()=>{
  assert.match(source,/['"]expense\.create['"]/);
  assert.match(source,/\['expenses'\s*,\s*'expenses'\]/);
  assert.match(source,/expenses:\s*copy\(value\.expenses \|\| \[\]\)/);
  assert.match(source,/expenses:\s*copy\(replica\.expenses \|\| \[\]\)/);
  assert.match(source,/function makeExpensePayload\(input\)/);
  assert.match(source,/function createExpense\(input\)/);
  assert.match(source,/createExpense:\s*createExpense/);
  assert.match(source,/record\.command === 'expense\.create'/);
});

test('expense bridge writes only through canonical createExpense and keeps legacy storage out of CANON path',()=>{
  assert.match(expenseBridgeSource,/api\(\)\.createExpense\(input\)/);
  assert.match(expenseBridgeSource,/date === today\(\)/);
  assert.match(expenseBridgeSource,/input\.session_id = cash\.sessionId/);
  assert.doesNotMatch(expenseBridgeSource,/saveAllData\s*\(/);
  assert.doesNotMatch(expenseBridgeSource,/gastos\.(?:push|unshift)\s*\(/);
  const cash=indexSource.indexOf('js/sync/canonical-cash-bridge.js');
  const expense=indexSource.indexOf('js/sync/canonical-expense-bridge.js');
  assert.ok(cash>=0 && expense>cash,'expense bridge must wrap the final cash/legacy handlers');
  assert.match(swSource,/\.\/js\/sync\/canonical-expense-bridge\.js/);
});

test('expense bridge attaches only todays open CANON session and redirects Caja gasto to the same modal',async()=>{
  const fields={
    gasDesc:{value:'Compra bolsas'},
    gasMonto:{value:'12.50'},
    gasMetodo:{value:'efectivo'},
    gasFecha:{value:'2026-09-27'},
    gasCat:{value:'Operativo'},
    gasNota:{value:'turno'},
    mGasto:{classList:{add(){},remove(){}}},
  };
  const button={disabled:false,textContent:'💾 Registrar'};
  const calls=[];
  const context={
    document:{
      getElementById(id){return fields[id]||null;},
      querySelector(selector){return selector==='#mGasto .mbtn-ok'?button:null;}
    },
    NuevoAmanecerCanonical:{
      enabled(){return true;},
      async refresh(){calls.push(['refresh']);},
      legacySnapshot(){return {cashState:{abierta:true,sessionId:'sess-1'}};},
      async createExpense(input){calls.push(['expense',JSON.parse(JSON.stringify(input))]);return {session_id:input.session_id||null};}
    },
    _naF10AuthorizePermission(){return true;},
    obtenerHoy(){return '2026-09-27';},
    cerrarModal(id){calls.push(['close',id]);},
    gasRender(){calls.push(['gasRender']);},
    cajRender(){calls.push(['cajRender']);},
    updateDashboard(){calls.push(['dashboard']);},
    toast(message,tone){calls.push(['toast',message,tone]);},
    abrirModalGasto(){calls.push(['legacy-open']);},
    guardarGasto(){calls.push(['legacy-save']);},
    abrirMovCaja(type){calls.push(['legacy-cash',type]);},
    Object,Promise,Number,String,Date,JSON
  };
  context.globalThis=context;
  vm.runInNewContext(expenseBridgeSource,context,{filename:'canonical-expense-bridge.js'});

  context.abrirMovCaja('gas');
  assert.equal(calls.some(x=>x[0]==='legacy-cash'),false);
  fields.gasDesc.value='Compra bolsas';
  fields.gasMonto.value='12.50';
  fields.gasMetodo.value='efectivo';
  fields.gasFecha.value='2026-09-27';
  fields.gasCat.value='Operativo';
  fields.gasNota.value='turno';
  await context.guardarGasto();
  const first=calls.find(x=>x[0]==='expense')[1];
  assert.equal(first.amount_cents,1250);
  assert.equal(first.session_id,'sess-1');
  assert.equal(first.expense_date,'2026-09-27');
  assert.equal(first.category,'Operativo');

  fields.gasFecha.value='2026-09-26';
  calls.length=0;
  await context.guardarGasto();
  const backdated=calls.find(x=>x[0]==='expense')[1];
  assert.equal(Object.prototype.hasOwnProperty.call(backdated,'session_id'),false);
  context.NA_ROLES={role:'empleado',deviceId:'employee'};
  context.NuevoAmanecerCanonical.legacySnapshot=()=>({cashState:{abierta:true,sessionId:'own',openedByDeviceId:'employee'}});
  fields.gasMetodo.value='efectivo';
  calls.length=0;
  assert.equal(await context.guardarGasto(),true);
  assert.equal(calls.find(x=>x[0]==='expense')[1].session_id,'own');
  context.NuevoAmanecerCanonical.legacySnapshot=()=>({cashState:{abierta:true,sessionId:'other',openedByDeviceId:'owner'}});
  calls.length=0;
  assert.equal(await context.guardarGasto(),false);
  assert.equal(calls.some(x=>x[0]==='expense'),false);

});

test('adapter projects canonical expenses to Gastos and only session expenses to Caja',()=>{
  const context={globalThis:{}};
  vm.runInNewContext(adapterSource,context,{filename:'canonical-ui-adapter.js'});
  const adapter=context.globalThis.NuevoAmanecerCanonicalUIAdapter;
  const out=adapter.snapshot({
    authority:'canonical',promotion_id:'p',authority_epoch:1,revision:1,financial_revision:3,mode:'ACTIVE',read_only:false,
    products:[],customers:[],creditAccounts:[],credits:[],payments:[],sales:[],saleItems:[],inventoryMovements:[],cashMovements:[],financialEvents:[],
    cashSessions:[{session_id:'s1',opening_cents:10000,opened_at:'2026-09-27T15:00:00.000Z',status:'OPEN',expected_cents:8750,revision:2}],
    expenses:[
      {expense_id:'e1',operation_id:'op1',session_id:'s1',amount_cents:1250,cash_delta_cents:-1250,concept:'Bolsas',category:'Operativo',payment_method:'efectivo',expense_date:'2026-09-27',note:'',created_at:'2026-09-27T16:00:00.000Z'},
      {expense_id:'e2',operation_id:'op2',session_id:null,amount_cents:500,cash_delta_cents:0,concept:'Internet',category:'Servicios',payment_method:'transferencia',expense_date:'2026-09-26',note:'mes',created_at:'2026-09-27T16:05:00.000Z'}
    ]
  });
  assert.equal(out.expenses.length,2);
  assert.equal(out.expenses[0].monto,12.5);
  assert.equal(out.expenses[0].canonicalReadOnly,true);
  const gas=out.cashMovements.filter(x=>x.tipo==='gas');
  assert.equal(gas.length,1);
  assert.equal(gas[0].expenseId,'e1');
  assert.equal(gas[0].efectivo,12.5);
  assert.equal(out.cashState.esperado,87.5);
});


test('rejected payment journal cleanup is narrow and never clears uncertain transport failures',()=>{
  const start=source.indexOf('async function discardRejectedPayment()');
  const end=source.indexOf('async function discardRejectedProduct()',start);
  assert.ok(start>=0&&end>start,'discardRejectedPayment must exist before product cleanup');
  const block=source.slice(start,end);
  assert.match(block,/\['payment\.create','payment\.batch'\]\.includes\(record\.command\)/);
  assert.match(block,/\!\[400,409\]\.includes\(record\.last_status\) \|\| !record\.last_error/);
  assert.match(block,/localStorage\.removeItem\(JOURNAL\)/);
  assert.doesNotMatch(block,/500|503|CANONICAL_FINANCIAL_PENDING/,'uncertain/server failures must never be auto-discarded');
  assert.match(source,/discardRejectedPayment:\s*discardRejectedPayment/);
});

test('payment batch lean path uses one batch transport for one-to-twenty debts and keeps retries authority-checked',()=>{
  const start=source.indexOf('async function createPaymentBatch(inputs)');
  const end=source.indexOf('function createProduct(input)',start);
  assert.ok(start>=0&&end>start,'createPaymentBatch must exist before command wrappers');
  const block=source.slice(start,end);
  assert.doesNotMatch(block,/inputs\.length === 1/,'one debt must not detour through the heavier generic payment.create endpoint');
  assert.doesNotMatch(block,/await createPayment\(/,'Cobro múltiple always uses the specialized payment.batch transport');
  assert.match(block,/return withWriterLock\(async function \(\)/);
  assert.match(block,/assertAction\('payment\.create'\)/);
  assert.match(block,/seen\.has\(creditId\)/);
  assert.match(block,/makeFinancialPayload\('payment\.create', input\)/,'each debt remains a payment.create child');
  assert.match(block,/var CHUNK = 20/);
  assert.match(block,/command: 'payment\.batch'/);
  assert.match(block,/route: '\/commands\/payment\.batch'/);
  assert.match(block,/Object\.assign\(commonPayload\(\), \{ payments: payments \}\)/);
  assert.match(block,/durableJournal\(record\)/);
  assert.match(block,/sendPending\(record, true\)/,'new atomically validated batch must skip the redundant status GET');
  assert.match(block,/sendPending\(retryRecord, false\)/,'retry must still verify remote authority');
  assert.doesNotMatch(block,/route: '\/commands\/payment\.create'/);
  assert.doesNotMatch(block,/\brefresh\s*\(/,'batch fast path must not perform full replica refreshes between payments');
  assert.match(source,/record\.command === 'payment\.batch'/);
  assert.match(source,/createPaymentBatch:\s*createPaymentBatch/);
});


test('cash commands project only durable receipts and skip redundant status on the new happy path',()=>{
  const projectionStart=source.indexOf('function projectConfirmedCashReceipt(record, result)');
  const sendStart=source.indexOf('async function sendPending(record, skipStatus)');
  assert.ok(projectionStart>=0&&sendStart>projectionStart);
  const projection=source.slice(projectionStart,sendStart);
  assert.match(projection,/\['cash\.open', 'cash\.close', 'adjustment\.create'\]\.includes\(record\.command\)/);
  assert.match(projection,/payload\.operation_id !== result\.operation_id/);
  assert.match(projection,/result\.session_revision !== payload\.expected_session_revision \+ 1/);
  assert.match(projection,/eventExists/);
  assert.match(projection,/notifyReplicaUpdate\(\)/);
  assert.match(source,/var cashProjected = projectConfirmedCashReceipt\(record, result\)/);
  assert.match(source,/\['payment\.create','cash\.open','cash\.close','adjustment\.create'\]\.includes\(command\)/);
  assert.match(source,/sendPending\(record, skipRedundantStatus\)/);
  assert.match(source,/retryPending[\s\S]*sendPending\(record\)/,
    'retry path must keep the default remote status verification');
});
