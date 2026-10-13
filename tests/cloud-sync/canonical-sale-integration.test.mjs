import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../POS/js/sync/canonical-sale-integration.js', import.meta.url), 'utf8');
const intentSource = readFileSync(new URL('../../POS/js/sync/canonical-sale-intent.js', import.meta.url), 'utf8');
const outboxSource = readFileSync(new URL('../../POS/js/sync/canonical-sale-outbox.js', import.meta.url), 'utf8');
const projectionSource = readFileSync(new URL('../../POS/js/sync/canonical-sale-projection.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
const inline02 = readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8');
const inline03 = readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js', import.meta.url), 'utf8');

function harness({ enabled = true, method = 'efectivo', cart = [{ id: 7, qty: 2, precio: 4.25, unitsPerQty: 1 }], enqueueError = null, projectionError = false, syncConfirmed = false, lock = false, storageFailure = false, sessionOpen = true, stock = 10, paymentValid = true, verified = true, duplicateReference = false, validation = 'current', mode = 'ACTIVE', readOnly = false, pendingJournal = null, outboxPending = false } = {}) {
  const els = new Map();
  for (const id of ['mMontoRec','mDigitalRef','mMixedRef','mMixedCash','mMixedDigitalMethod','mMixedDigitalVerified','mDigitalVerified','mCreditoCliente','mCreditoVence','mVentaCliente','mCobro','mBtnConf','cartDrawer','cartBackdrop','btnDescInfo']) els.set(id,{value:'',checked:true,classList:{remove(){},add(){}}});
  els.get('mMontoRec').value = '99'; els.get('mDigitalRef').value='real-ref'; els.get('mMixedRef').value='mixed-ref'; els.get('mMixedCash').value='3.00'; els.get('mMixedDigitalMethod').value='plin'; els.get('mCreditoCliente').value='cust-9'; els.get('mCreditoVence').value='2026-11-03';
  const calls = { build:0, enqueue:0, project:0, legacy:0, save:0, sync:0, fetch:0, toast:[], close:0, timers:[] };
  let stored = null;
  let canonicalReceipt = null;
  const storage = new Map();
  const context = vm.createContext({ console, Date, Number, String, Object, Array, Math, JSON, Promise, Error, RegExp, Set, Map, crypto,
    navigator:{locks:{request:async(_name,_options,work)=>work({})}}, localStorage:{getItem:key=>storage.has(key)?storage.get(key):null,setItem:(key,value)=>{if(storageFailure)throw Error('storage');storage.set(key,value);}},
    CustomEvent: class { constructor(type,init){this.type=type;this.detail=init.detail;} }, dispatchEvent(){},
    document:{getElementById:id=>els.get(id)||null,querySelectorAll:()=>[],querySelector:()=>null},
    cart, productos:[{id:7,stock,precio:999}], ventas:duplicateReference?[{id:'V-004',paymentRef:method==='mixto'?'mixed-ref':'real-ref',anulada:false}]:[], clientes:[{id:'cust-9'}], creditos:[], cajMovs:[], inventoryMovements:[], posProc:false, posPayM:method, cajEstado:{abierta:true}, appConfig:{},
    NuevoAmanecerCanonical:{
      enabled:()=>enabled,
      sourceState:()=>({validation}),
      snapshot:()=>({products:[{id:'7',stock:10}],customers:[{id:'cust-9'}],credits:[],sales:[],mode,read_only:readOnly}),
      pendingSnapshot:()=>pendingJournal,
      receiptSnapshot:()=>canonicalReceipt
    },
    isModuleLocked:(name,options)=>lock,
    _naSessionOpen:()=>sessionOpen,_naTracksStock:()=>true,_naUnitsSold:item=>item.qty*item.unitsPerQty,_naUnitsPerQty:item=>item.unitsPerQty||1,
    _naPaymentState:()=>({valid:paymentValid,message:'payment invalid'}),_naDigitalSalePayment:()=>method==='mixto'||['yape','plin','transferencia'].includes(method),_naDigitalPaymentVerified:()=>verified,_naClean:x=>String(x||'').trim(),_naMixedPaymentData:()=>({cash:3,digital:5.5,digitalMethod:'plin',reference:'mixed-ref'}),
    _naSetPaymentHint(){},_naPaymentFocusTarget:()=>null,toast:(...x)=>calls.toast.push(x),posUpdateCart(){},posRender(){},cerrarModal(){calls.close++;},
    saveAllData(){calls.save++;},_naWasPersisted:()=>true,fetch(){calls.fetch++;throw Error('network forbidden');}
  });
  context.confirmarVenta=async()=>{calls.legacy++;};
  context.globalThis=context;
  vm.runInContext(intentSource,context);
  const intentApi=context.NuevoAmanecerCanonicalSaleIntent;
  context.NuevoAmanecerCanonicalSaleIntent={VERSION:intentApi.VERSION,build(input){calls.build++;if(!calls.input)calls.input=input;return intentApi.build(input);}};
  vm.runInContext(outboxSource,context);
  const outbox=context.NuevoAmanecerCanonicalSaleOutbox;
  context.NuevoAmanecerCanonicalSaleOutbox={
    VERSION:outbox.VERSION,
    async enqueue(intent){calls.enqueue++;if(enqueueError)throw enqueueError;stored=await outbox.enqueue(intent);return stored;},
    snapshot:()=>outboxPending?{version:1,intents:[{operation_id:'pending-op',sale_id:'V-999'}]}:outbox.snapshot(),
    async sync(){
      calls.sync++;
      if(syncConfirmed&&stored){
        canonicalReceipt={status:'created',operation_id:stored.operation_id,sale_id:stored.sale_id,idempotent:false};
        return {status:'DRAINED',processed:1,remaining:0};
      }
      return {status:'WAITING',processed:0,remaining:stored?1:0};
    }
  };
  vm.runInContext(projectionSource,context);
  const projector=context.NuevoAmanecerCanonicalSaleProjection;
  context.NuevoAmanecerCanonicalSaleProjection={VERSION:projector.VERSION,project(base,snapshot){calls.project++;if(projectionError)throw Error('projection');return projector.project(base,snapshot);}};
  context.setTimeout=(fn)=>{calls.timers.push(fn);return calls.timers.length;};
  vm.runInContext(source,context);
  return {context,calls,els,get stored(){return stored;}};
}

test('legacy mode delegates exactly once and does not enter canonical pipeline', async()=>{const h=harness({enabled:false});await h.context.confirmarVenta();assert.equal(h.calls.legacy,1);assert.equal(h.calls.build+h.calls.enqueue+h.calls.project,0);});
test('canonical sale commits locally without waiting for cloud readiness',async()=>{
  for(const options of [
    {validation:'validating'},
    {validation:'offline'},
    {validation:'stale'},
    {mode:'CANONICAL_READ_ONLY',readOnly:true},
    {pendingJournal:{state:'PENDING',command:'payment.create'}}
  ]){
    const h=harness(options);
    const result=await h.context.confirmarVenta();
    assert.equal(result.status,'PENDING_SYNC');
    assert.equal(h.calls.enqueue,1);
    assert.equal(h.context.cart.length,0);
    assert.ok(h.calls.close>0);
    assert.equal(h.calls.sync,0,'cashier flow must not wait for cloud sync');
    assert.equal(h.calls.timers.length,1);
  }
});
test('canonical cash captures effective cart economics and projects after one durable enqueue',async()=>{const h=harness();await h.context.confirmarVenta();assert.equal(h.calls.legacy,0);assert.equal(h.calls.enqueue,1);assert.equal(h.calls.project,1);assert.equal(h.calls.save,0);assert.equal(h.calls.sync,0);assert.equal(h.calls.timers.length,1);assert.equal(h.calls.fetch,0);assert.equal(h.calls.input.items[0].product_id,'7');assert.equal(h.calls.input.items[0].quantity,2);assert.equal(h.calls.input.items[0].precio,4.25);assert.equal(h.stored.items[0].unit_price_cents,425);assert.match(h.stored.sale_id,/^V-\d{3}$/);assert.equal(h.stored.sale_id,h.calls.input.sale_id);assert.equal(h.context.cart.length,0);const first=h.context.NuevoAmanecerCanonicalSaleIntegration.lastProjection();first.sales.length=0;assert.equal(h.context.NuevoAmanecerCanonicalSaleIntegration.lastProjection().sales.length,1);h.calls.timers.shift()();await Promise.resolve();assert.equal(h.calls.sync,1);});
test('online sale releases the UI before cloud confirmation and syncs in background',async()=>{
  const h=harness({syncConfirmed:true});
  const result=await h.context.confirmarVenta();
  assert.equal(result.status,'PENDING_SYNC');
  assert.equal(h.calls.enqueue,1);
  assert.equal(h.calls.sync,0);
  assert.equal(h.calls.project,1);
  assert.equal(h.context.cart.length,0);
  assert.ok(h.calls.close>0);
  assert.ok(h.calls.toast.some(([message,tone])=>/Venta V-001 registrada/.test(message)&&tone==='success'));
  assert.equal(h.calls.toast.some(([message])=>/espera el indicador verde/i.test(message)),false);
  assert.equal(h.calls.timers.length,1);
  h.calls.timers.shift()();
  await Promise.resolve();
  assert.equal(h.calls.sync,1);
});

test('mixed and credit payments retain their exact POS fields',async()=>{const mixed=harness({method:'mixto'});await mixed.context.confirmarVenta();assert.deepEqual(JSON.parse(JSON.stringify(mixed.calls.input.payment)),{cash_cents:300,digital_cents:550,digital_method:'plin',reference:'mixed-ref'});const credit=harness({method:'credito'});await credit.context.confirmarVenta();assert.equal(credit.calls.input.customer_id,'cust-9');assert.equal(credit.calls.input.credit_due,'2026-11-03');});
test('digital payment retains the POS reference and never uses it as operation identity',async()=>{for(const method of ['yape','plin','transferencia']){const h=harness({method});await h.context.confirmarVenta();assert.equal(h.stored.payment.reference,'real-ref');assert.notEqual(h.stored.operation_id,'real-ref');}});
test('pending local digital reference cannot be reused before cloud sync',async()=>{const h=harness({method:'yape'});await h.context.confirmarVenta();assert.equal(h.calls.enqueue,1);h.context.cart=[{id:7,qty:1,precio:4.25,unitsPerQty:1}];await h.context.confirmarVenta();assert.equal(h.calls.enqueue,1);assert.equal(h.context.cart.length,1);assert.match(h.calls.toast.at(-1)[0],/número de operación ya fue registrado/i);});
test('cash, stock, payment, digital verification, duplicate reference and lock validations block capture',async()=>{for(const options of [{sessionOpen:false},{stock:1},{paymentValid:false},{method:'yape',verified:false},{method:'yape',duplicateReference:true},{lock:true}]){const h=harness(options),initialLength=h.context.cart.length;await h.context.confirmarVenta();assert.equal(h.calls.enqueue,0);assert.equal(h.context.cart.length,initialLength);assert.equal(h.calls.close,0);}});
test('VARIOS enters canonical outbox while unsupported modes and storage failure remain fail-closed',async()=>{
  const generic=harness({cart:[{id:-101,qty:2,precio:3.5,unitsPerQty:1,ventaLibre:true,name:'Recarga libre',codigoIngresado:'REC-01',barcode:'REC-01',sku:'REC-01',canonicalGenericId:'GENERIC:test-varios-1'}]});
  await generic.context.confirmarVenta();
  assert.equal(generic.calls.enqueue,1);
  assert.equal(generic.calls.save,0);
  assert.equal(generic.context.cart.length,0);
  assert.equal(generic.stored.items[0].product_id,'GENERIC:test-varios-1');
  assert.deepEqual(JSON.parse(JSON.stringify(generic.stored.items[0].generic_line)),{name:'Recarga libre',code:'REC-01'});
  assert.equal(generic.context.NuevoAmanecerCanonicalSaleIntegration.lastProjection().sales[0].conflict,false);
  for(const item of [{ventaModo:'caja'},{unidadesSinStock:1}]){
    const h=harness({cart:[{id:7,qty:1,precio:4.25,unitsPerQty:1,...item}]});
    await h.context.confirmarVenta();
    assert.equal(h.calls.enqueue,0);
    assert.equal(h.context.cart.length,1);
  }
  const h=harness({storageFailure:true});
  await h.context.confirmarVenta();
  assert.equal(h.calls.enqueue,1);
  assert.equal(h.context.cart.length,1);
  assert.equal(h.calls.close,0);
  assert.equal(h.calls.project,0);
  assert.equal(h.calls.save,0);
});
test('projection failure preserves durable intent without blocking the next local sale',async()=>{const h=harness({projectionError:true});await h.context.confirmarVenta();assert.equal(h.calls.enqueue,1);assert.ok(h.stored);assert.equal(h.context.cart.length,0);assert.match(h.calls.toast.at(-1)[0],/guardada localmente/);h.context.cart=[{id:7,qty:2,precio:4.25,unitsPerQty:1}];await h.context.confirmarVenta();assert.equal(h.calls.enqueue,2);assert.equal(h.stored.sale_id,'V-002');assert.equal(h.context.cart.length,0);});
test('capture lock option skips only canonical blanket lock and still evaluates all POS locks',()=>{const lockLine=inline03.split('\n').find(line=>line.startsWith('isModuleLocked=function(moduleName,options)'));assert.ok(lockLine);const context=vm.createContext({NuevoAmanecerCanonical:{enabled:()=>true},securityIsLocked:()=>false,storage:{getItem:key=>key==='master'?'false':'false'},LOCK_KEYS:{master:'master',readOnly:'readonly',modules:{ventas:'ventas',productos:'productos'}}});vm.runInContext(lockLine,context);assert.equal(context.isModuleLocked('ventas'),true);assert.equal(context.isModuleLocked('ventas',{canonicalSaleCapture:true}),false);assert.equal(context.isModuleLocked('productos',{canonicalSaleCapture:true}),true);context.securityIsLocked=()=>true;assert.equal(context.isModuleLocked('ventas',{canonicalSaleCapture:true}),true);context.securityIsLocked=()=>false;context.storage.getItem=key=>key==='master'?'true':'false';assert.equal(context.isModuleLocked('ventas',{canonicalSaleCapture:true}),true);context.storage.getItem=key=>key==='readonly'?'true':'false';assert.equal(context.isModuleLocked('ventas',{canonicalSaleCapture:true}),true);context.storage.getItem=key=>key==='ventas'?'true':'false';assert.equal(context.isModuleLocked('ventas',{canonicalSaleCapture:true}),true);});
test('parsed script order places canonical dependencies before integration between inline 03 and 07',()=>{const scripts=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match=>match[1]);const pos=needle=>scripts.findIndex(src=>src.endsWith(needle));assert.ok(pos('js/legacy-inline/inline-03.js')<pos('js/sync/canonical-sale-integration.js'));assert.ok(pos('js/sync/canonical-sale-integration.js')<pos('js/legacy-inline/inline-07.js'));for(const dep of ['canonical-sale-intent.js','canonical-sale-outbox.js','canonical-sale-projection.js'])assert.ok(pos(dep)<pos('js/sync/canonical-sale-integration.js'));});
test('canonical non-credit sale keeps the selected optional POS customer', async()=>{const h=harness();h.els.get('mVentaCliente').value='cust-9';await h.context.confirmarVenta();assert.equal(h.calls.input.customer_id,'cust-9');});
test('canonical sale does not discard a selected customer that is missing from the current list', async()=>{const h=harness();h.els.get('mVentaCliente').value='cust-9';h.context.clientes=[];await h.context.confirmarVenta();assert.equal(h.calls.enqueue,0);assert.equal(h.context.cart.length,1);assert.match(h.calls.toast.at(-1)[0],/cliente seleccionado ya no está disponible/);});

test('canonical sale reports the exact browser lock reason instead of a generic block', async()=>{
  const cases=[
    [{securityLocked:true},/sesión de seguridad/i],
    [{masterLocked:true},/edición crítica/i],
    [{readOnlyLocked:true},/solo lectura/i],
    [{salesLocked:true},/Ventas y POS/i],
  ];
  for(const [flags,pattern] of cases){
    const h=harness();
    h.context.sessionStorage={
      getItem:key=>key==='na_security_locked'&&flags.securityLocked?'true':null
    };
    h.context.localStorage.getItem=key=>{
      if(key==='na_master_lock'&&flags.masterLocked)return 'true';
      if(key==='na_readonly'&&flags.readOnlyLocked)return 'true';
      if(key==='na_lock_ventas'&&flags.salesLocked)return 'true';
      return null;
    };
    h.context.isModuleLocked=()=>true;
    await h.context.confirmarVenta();
    assert.equal(h.calls.enqueue,0);
    assert.match(h.calls.toast.at(-1)[0],pattern);
  }
});

test('canonical sale lock diagnostics read the same effective lock state as isModuleLocked', async()=>{
  const h=harness();
  h.context.localStorage.getItem=()=>null;
  h.context.sessionStorage={getItem:()=>null};
  h.context.securityIsLocked=()=>false;
  h.context._naGetLocks=()=>({master:false,readOnly:true,modules:{ventas:false}});
  h.context.isModuleLocked=()=>true;
  await h.context.confirmarVenta();
  assert.equal(h.calls.enqueue,0);
  assert.match(h.calls.toast.at(-1)[0],/solo lectura/i);

  const h2=harness();
  h2.context.localStorage.getItem=()=>null;
  h2.context.sessionStorage={getItem:()=>null};
  h2.context.securityIsLocked=()=>true;
  h2.context._naGetLocks=()=>({master:false,readOnly:false,modules:{ventas:false}});
  h2.context.isModuleLocked=()=>true;
  await h2.context.confirmarVenta();
  assert.equal(h2.calls.enqueue,0);
  assert.match(h2.calls.toast.at(-1)[0],/sesión de seguridad/i);
});


test('CANON sale UI context skips only the technical blanket lock and still honors real POS locks',()=>{
  const lockLine=inline03.split('\n').find(line=>line.startsWith('isModuleLocked=function(moduleName,options)'));
  assert.ok(lockLine);
  const state={security:false,master:false,readonly:false,ventas:false};
  const context=vm.createContext({
    NuevoAmanecerCanonical:{enabled:()=>true},
    securityIsLocked:()=>state.security,
    storage:{getItem:key=>{
      if(key==='master') return state.master?'true':'false';
      if(key==='readonly') return state.readonly?'true':'false';
      if(key==='ventas') return state.ventas?'true':'false';
      return 'false';
    }},
    LOCK_KEYS:{master:'master',readOnly:'readonly',modules:{ventas:'ventas',productos:'productos'}}
  });
  vm.runInContext(lockLine,context);
  assert.equal(context.isModuleLocked('ventas'),true);
  assert.equal(context.isModuleLocked('ventas',{canonicalSaleUi:true}),false);
  assert.equal(context.isModuleLocked('productos',{canonicalSaleUi:true}),true);
  state.security=true; assert.equal(context.isModuleLocked('ventas',{canonicalSaleUi:true}),true);
  state.security=false; state.master=true; assert.equal(context.isModuleLocked('ventas',{canonicalSaleUi:true}),true);
  state.master=false; state.readonly=true; assert.equal(context.isModuleLocked('ventas',{canonicalSaleUi:true}),true);
  state.readonly=false; state.ventas=true; assert.equal(context.isModuleLocked('ventas',{canonicalSaleUi:true}),true);
});

test('only sale preparation routes use canonicalSaleUi while legacy financial writes remain blocked',()=>{
  assert.match(inline02,/function _naSaleUiLocked\(\).*canonicalSaleUi:true/);
  const posAddLine=inline02.split('\n').find(line=>line.startsWith('posAdd=function(id)'));
  assert.ok(posAddLine); assert.match(posAddLine,/_naSaleUiLocked\(\)/);
  const quickStart=inline02.indexOf('function _naOpenQuickPayment()');
  const quickEnd=inline02.indexOf('async function confirmarPagoRapido',quickStart);
  assert.ok(quickStart>=0&&quickEnd>quickStart);
  assert.match(inline02.slice(quickStart,quickEnd),/_naSaleUiLocked\(\)/);
  const openPayLine=inline02.split('\n').find(line=>line.startsWith('abrirCobro=function(tipo)'));
  assert.ok(openPayLine); assert.match(openPayLine,/_naSaleUiLocked\(\)/);

  const legacyConfirm=inline02.split('\n').find(line=>line.startsWith('confirmarVenta=async function()'));
  assert.ok(legacyConfirm);
  const legacyConfirmBlock=inline02.slice(inline02.indexOf('confirmarVenta=async function()'),inline02.indexOf('anularV=',inline02.indexOf('confirmarVenta=async function()')));
  assert.match(legacyConfirmBlock,/isModuleLocked\('ventas'\)/);
  assert.doesNotMatch(legacyConfirmBlock,/canonicalSaleUi:true/);

  const cancelBlock=inline02.slice(inline02.indexOf('anularV='),inline02.indexOf('anularV=')+500);
  assert.match(cancelBlock,/isModuleLocked\('ventas'\)/);
  assert.doesNotMatch(cancelBlock,/canonicalSaleUi:true/);
});


test('canonical stock validation aggregates repeated product lines once and preserves insufficient-stock rejection',async()=>{
  const exact=harness({stock:5,cart:[
    {id:7,qty:2,precio:4.25,unitsPerQty:1},
    {id:7,qty:3,precio:4.25,unitsPerQty:1}
  ]});
  await exact.context.confirmarVenta();
  assert.equal(exact.calls.toast.some(args=>/Stock insuficiente/.test(String(args[0]))),false);

  const insufficient=harness({stock:4,cart:[
    {id:7,qty:2,precio:4.25,unitsPerQty:1},
    {id:7,qty:3,precio:4.25,unitsPerQty:1}
  ]});
  await insufficient.context.confirmarVenta();
  assert.equal(insufficient.calls.enqueue,0);
  assert.equal(insufficient.context.cart.length,2);
  assert.match(insufficient.calls.toast.at(-1)[0],/Stock insuficiente/);
});

test('canonical stock validation indexes products and reserved units before validating the cart',()=>{
  assert.match(source,/var productsById = new Map\(\)/);
  assert.match(source,/var reservedByProduct = new Map\(\)/);
  assert.doesNotMatch(source,/cart\.filter\(function \(candidate\) \{ return String\(candidate\.id\) === String\(item\.id\); \}\)\.reduce/);
});


test('real browser global let state is used even when window properties do not exist', async()=>{
  const els=new Map([
    ['mMontoRec',{value:'2.00'}],
    ['mDigitalRef',{value:''}],
    ['mVentaCliente',{value:''}],
    ['mBtnConf',{disabled:false}],
    ['mCobro',{classList:{remove(){}}}],
    ['cartDrawer',{classList:{remove(){}}}],
    ['cartBackdrop',{classList:{remove(){}}}]
  ]);
  const calls={enqueue:0,legacy:0,close:0,toast:[]};
  const context=vm.createContext({
    console,Date,Number,String,Object,Array,Math,JSON,Promise,Error,RegExp,Set,Map,crypto,
    navigator:{onLine:true},
    localStorage:{getItem(){return null;},setItem(){}},
    sessionStorage:{getItem(){return null;}},
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init&&init.detail;}},
    dispatchEvent(){},
    document:{
      getElementById:id=>els.get(id)||null,
      querySelector:()=>null
    },
    NuevoAmanecerCanonical:{
      enabled:()=>true,
      sourceState:()=>({validation:'current'}),
      snapshot:()=>({products:[{id:'7'}],customers:[],credits:[],sales:[],mode:'ACTIVE',read_only:false}),
      pendingSnapshot:()=>null
    },
    NuevoAmanecerCanonicalSaleIntent:{
      build(input){
        return {
          version:1,
          operation_id:'op-lexical-1',
          sale_id:input.sale_id,
          created_at:input.created_at,
          payment_method:input.payment_method,
          items:input.items
        };
      }
    },
    NuevoAmanecerCanonicalSaleOutbox:{
      async enqueue(intent){calls.enqueue++;return intent;},
      snapshot(){return {version:1,intents:[]};}
    },
    NuevoAmanecerCanonicalSaleProjection:{
      project(){return {sales:[]};}
    },
    isModuleLocked:()=>false,
    _naSessionOpen:()=>true,
    _naTracksStock:()=>true,
    _naUnitsSold:item=>item.qty,
    _naUnitsPerQty:()=>1,
    _naPaymentState:()=>({valid:true,message:'ok'}),
    _naDigitalSalePayment:()=>false,
    _naDigitalPaymentVerified:()=>true,
    _naClean:value=>String(value||'').trim(),
    _naSetPaymentHint(){},
    _naPaymentFocusTarget:()=>null,
    toast:(...args)=>calls.toast.push(args),
    posUpdateCart(){},
    posRender(){},
    cerrarModal(){calls.close++;}
  });
  context.confirmarVenta=async()=>{calls.legacy++;};
  context.globalThis=context;
  vm.runInContext(`
    let cart=[{id:7,qty:1,precio:2,unitsPerQty:1}];
    let productos=[{id:7,stock:5,precio:2,name:'Producto'}];
    let ventas=[];
    let clientes=[];
    let posProc=false;
    let posPayM='efectivo';
  `,context);
  assert.equal(context.cart,undefined);
  assert.equal(context.posProc,undefined);
  vm.runInContext(source,context,{filename:'canonical-sale-integration.js'});
  await vm.runInContext('confirmarVenta()',context);
  assert.equal(calls.legacy,0);
  assert.equal(calls.enqueue,1);
  assert.equal(vm.runInContext('cart.length',context),0);
  assert.equal(vm.runInContext('posProc',context),false);
  assert.equal(context.cart,undefined);
  assert.equal(context.posProc,undefined);
});

test('canonical capture never gates on cloud freshness or awaits outbox sync',()=>{assert.doesNotMatch(source,/CANON está sincronizando/);assert.doesNotMatch(source,/await\s+outbox\.sync\s*\(/);assert.match(source,/syncOutboxInBackground\(outbox(?:, saleId)?\)/);});

test('canonical sale integration does not regress to window-only POS state access',()=>{
  assert.match(source,/function liveCart\(\)/);
  assert.match(source,/typeof cart !== 'undefined'/);
  assert.match(source,/typeof productos !== 'undefined'/);
  assert.match(source,/typeof ventas !== 'undefined'/);
  assert.match(source,/typeof clientes !== 'undefined'/);
  assert.match(source,/typeof posPayM !== 'undefined'/);
  assert.match(source,/typeof posProc !== 'undefined'/);
  assert.doesNotMatch(source,/var cart = Array\.isArray\(root\.cart\)/);
});
test('receipt uses committed product and cash snapshot; failed persistence never offers it',async()=>{
  for(const method of ['efectivo','yape','plin','transferencia','mixto','credito']){
    const h=harness({method});const receipts=[];
    h.context.NAReceiptShare={onSale:(sale,customer,extra)=>receipts.push({sale,customer,extra})};
    await h.context.confirmarVenta();
    assert.equal(receipts.length,1);assert.equal(receipts[0].sale.items[0].precio,4.25);assert.equal(receipts[0].sale.items[0].qty,2);assert.equal(h.context.cart.length,0);
    if(method==='efectivo'){assert.equal(receipts[0].sale.recibido,99);assert.equal(receipts[0].sale.vuelto,90.5);}
    assert.equal(receipts[0].extra.pendingSync,true);
  }
  const h=harness({storageFailure:true});let calls=0;h.context.NAReceiptShare={onSale:()=>calls++};await h.context.confirmarVenta();assert.equal(calls,0);
});

test('Bot 2 P4: venta guardada y el servidor responde 500: aviso ámbar «guardada, falta confirmar»',async()=>{
  const h=harness({syncConfirmed:true});
  await h.context.confirmarVenta();
  const ob=h.context.NuevoAmanecerCanonicalSaleOutbox;
  ob.sync=async()=>({status:'WAITING',processed:0,remaining:1,reason:'CANONICAL_FINANCIAL_REJECTED_500'});
  ob.snapshot=()=>({intents:[{sale_id:'V-001'}]});
  h.calls.timers.shift()();
  await new Promise(r=>setTimeout(r,10));
  assert.ok(h.calls.toast.some(([m,tone])=>/Venta V-001 guardada, falta confirmar con el servidor \(falla del servidor\)/.test(m)&&tone==='warning'));
});
