import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../POS/js/modules/client-credit-accounts-v2.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../../POS/css/client-credit-accounts-v2.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../../POS/index.html',import.meta.url),'utf8');
const integration=readFileSync(new URL('../../POS/js/sync/canonical-sale-integration.js',import.meta.url),'utf8');
const intent=readFileSync(new URL('../../POS/js/sync/canonical-sale-intent.js',import.meta.url),'utf8');
const canonicalClient=readFileSync(new URL('../../POS/js/sync/canonical-client.js',import.meta.url),'utf8');

function context(instrumentBatch = false) {
  const dueMap=new Map([['2026-09-20',-6],['2026-09-26',0],['2026-10-01',5],['2026-11-01',36]]);
  const listeners=new Map();
  const document={
    body:{appendChild(){}},
    getElementById(){return null;},
    querySelector(){return null;},
    querySelectorAll(){return[];},
    createElement(){return {className:'',hidden:true,dataset:{},style:{},setAttribute(){},appendChild(){},append(){},querySelector(){return null;},classList:{add(){},remove(){},toggle(){},contains(){return false;}}};}
  };
  const ctx={
    console:{info(){},warn(){},error(){}},
    Date,Number,String,Object,Array,Set,Map,Math,JSON,RegExp,Error,Promise,crypto,
    setTimeout(fn){if(typeof fn==='function')fn();return 1;},clearTimeout(){},
    requestAnimationFrame(fn){if(typeof fn==='function')fn();return 1;},
    MutationObserver:undefined,
    document,
    clientes:[],
    creditos:[],
    cart:[],
    posPayM:'credito',
    diasHasta(value){return dueMap.has(value)?dueMap.get(value):null;},
    _naSyncCreditStatus(cr){return cr.status||cr.estado||'vigente';},
    _naCreditOutstanding(cr){return Math.max(0,Number(cr.monto||0)-Number(cr.pagado||0));},
    _naEvaluateClientCredit(id){
      const common={exists:true,enabled:true,eligible:true,assignedLine:800,automaticLine:800,available:500,manualActive:false,history:{punctual:0,late:0,completed:0,partial:0,overdueActive:0,behavior:'sin_historial'}};
      if(String(id)==='stable')return {...common,history:{...common.history,punctual:4,completed:2,behavior:'puntual'}};
      if(String(id)==='regular')return {...common,history:{...common.history,punctual:3,late:1,completed:1,behavior:'irregular'}};
      if(String(id)==='danger')return {...common,history:{...common.history,punctual:1,late:3,overdueActive:1,behavior:'impuntual'}};
      if(String(id)==='ineligible')return {...common,eligible:false,assignedLine:0,automaticLine:0,available:0};
      return common;
    },
    _naEsc(value){return String(value);},
    fmt(value){return 'S/ '+Number(value).toFixed(2);},
    addEventListener(name,fn){const rows=listeners.get(name)||[];rows.push(fn);listeners.set(name,rows);},
    dispatchEvent(event){(listeners.get(event.type)||[]).forEach(fn=>fn(event));return true;},
    CustomEvent:class CustomEvent{constructor(type,init){this.type=type;this.detail=init&&init.detail;}},
    matchMedia(){return{matches:false};}
  };
  ctx.window=ctx; ctx.globalThis=ctx;
  vm.createContext(ctx);
  const evaluated = instrumentBatch ? source.replace('})(window);', 'root.__batchTest={confirm:labBatchShowConfirmed,state:labClientScreenState};})(window);') : source;
  vm.runInContext(evaluated,ctx,{filename:'client-credit-accounts-v2.js'});
  return ctx;
}
function credit(id,clientId='stable',amount=100,paid=0,extra={}){
  return {id,cliId:clientId,clienteId:clientId,monto:amount,pagado:paid,status:paid>=amount?'cancelado':'vigente',vence:'2026-10-01',fecha:'2026-09-26',
    ventaId:'V-'+id,tipo:'venta_credito',desc:'Crédito '+id,pagos:[],items:[{nombre:'Producto '+id,cantidad:1,precioUnitario:amount,subtotal:amount}],...extra};
}

test('legacy credits default to Créditos pequeños and amount never chooses category',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  assert.equal(api.accountMeta(credit('1','stable',500,0)).categoryId,'small');
  assert.equal(api.accountMeta(credit('2','stable',5,0)).categoryId,'small');
  assert.equal(api.accountMeta(credit('3','stable',5000,0)).categoryName,'Créditos pequeños');
});


test('durable payment receipt updates saldo and payment history immediately without mutating creditos',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  ctx.clientes=[{id:'stable',nombre:'Cliente'}];
  ctx.creditos=[credit('CR:001','stable',7,0)];
  const before=JSON.stringify(ctx.creditos);
  const detail={
    version:1,
    command:'payment.create',
    payload:{
      operation_id:'PAY-INSTANT-1',
      credit_id:'CR:001',
      amount_cents:250,
      payment_method:'yape',
      reference:'YAPE-FAST-1',
      created_at:'2026-10-01T01:02:03.000Z'
    },
    receipt:{
      status:'created',
      operation_id:'PAY-INSTANT-1',
      credit_id:'CR:001',
      current_balance_cents:450,
      credit_revision:2
    }
  };
  ctx.dispatchEvent({type:'na:canonical-payment-receipt',detail});
  let projected=api.creditsForCategory('stable','small')[0];
  assert.equal(projected.saldo,4.5);
  assert.equal(projected.pagado,2.5);
  assert.equal(projected.pagos.length,1);
  assert.equal(projected.pagos[0].pagoId,'PAY-INSTANT-1');
  assert.equal(projected.pagos[0].monto,2.5);
  assert.equal(projected.pagos[0].metodo,'yape');
  assert.equal(projected.pagos[0].numeroOperacion,'YAPE-FAST-1');
  assert.equal(projected.pagos[0].timestamp,'2026-10-01T01:02:03.000Z');
  assert.equal(JSON.stringify(ctx.creditos),before,'post-receipt projection must not mutate authoritative legacy arrays');

  ctx.dispatchEvent({type:'na:canonical-payment-receipt',detail});
  projected=api.creditsForCategory('stable','small')[0];
  assert.equal(projected.pagos.filter(p=>p.pagoId==='PAY-INSTANT-1').length,1,'receipt replay must stay visually idempotent');

  ctx.creditos=[credit('CR:001','stable',7,2.5,{saldo:4.5,pagos:[{
    id:'PAY-INSTANT-1',pagoId:'PAY-INSTANT-1',monto:2.5,montoPagado:2.5,
    fecha:'2026-10-01',timestamp:'2026-10-01T01:02:03.000Z',canonicalDateKnown:true,
    metodo:'yape',numeroOperacion:'YAPE-FAST-1'
  }]})];
  ctx.dispatchEvent({type:'na:canonical-updated',detail:{validation:'current'}});
  projected=api.creditsForCategory('stable','small')[0];
  assert.equal(projected.saldo,4.5);
  assert.equal(projected.pagos.filter(p=>p.pagoId==='PAY-INSTANT-1').length,1);
  assert.equal(projected.pagos[0].canonicalReceiptProjection,undefined,'authoritative reconciliation replaces the temporary overlay');
});

test('manual categories are reusable; accumulated groups visually and separate remains individual',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  const client={id:'stable',nombre:'Misael Quijano',creditCategories:[
    {id:'food',name:'Abarrotes',mode:'accumulated'},
    {id:'tech',name:'Tecnología',mode:'separate'}
  ]};
  ctx.clientes=[client];
  ctx.creditos=[
    credit('a','stable',10,0,{creditAccount:{categoryId:'food',categoryName:'Abarrotes',mode:'accumulated'}}),
    credit('b','stable',20,0,{creditAccount:{categoryId:'food',categoryName:'Abarrotes',mode:'accumulated'}}),
    credit('c','stable',900,0,{creditAccount:{categoryId:'tech',categoryName:'Tecnología',mode:'separate'}})
  ];
  assert.deepEqual(Array.from(api.categoriesForClient(client),x=>x.id),['small','food','tech']);
  assert.equal(api.creditsForCategory('stable','food').length,2);
  assert.equal(api.categorySummary(client,{id:'food',name:'Abarrotes',mode:'accumulated'}).pending,30);
  assert.equal(api.creditsForCategory('stable','tech')[0].id,'c');
  assert.equal(ctx.creditos.length,3,'visual grouping must not fuse ledger credits');
});

test('persisted 11 installments stay individual and compute paid/pending progress without second payment engine',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  const dates=['2026-10-01','2026-11-01','2026-12-01','2027-01-01','2027-02-01','2027-03-01','2027-04-01','2027-05-01','2027-06-01','2027-07-01','2027-08-01'];
  const cr=credit('11','stable',4125,750,{
    creditAccount:{categoryId:'tech',categoryName:'Tecnología',mode:'separate'},
    installments:dates.map((due,index)=>({number:index+1,due,amount:375})),
    pagos:[{id:'p1',pagoId:'p1',monto:375,fecha:'2026-09-26',timestamp:'2026-09-26T10:30:00.000Z'},{id:'p2',pagoId:'p2',monto:375,fecha:'2026-09-26',timestamp:'2026-09-26T11:00:00.000Z'}]
  });
  const before=JSON.stringify(cr),summary=api.installments(cr);
  assert.equal(summary.plan.length,11);
  assert.equal(summary.paidCount,2);
  assert.equal(summary.pendingCount,9);
  assert.equal(summary.plan[0].paidAt,'2026-09-26T10:30:00.000Z');
  assert.equal(summary.plan[1].paidAt,'2026-09-26T11:00:00.000Z');
  assert.equal(summary.plan.at(-1).due,'2027-08-01');
  assert.equal(JSON.stringify(cr),before,'presentation must not mutate credit ledger');
});

test('installment states distinguish paid, overdue, today, next and pending',()=>{
  const api=context().NA_CLIENT_CREDIT_ACCOUNTS_V2;
  assert.equal(api.installmentVisualState({number:1,due:'2026-09-20',paid:true},2,'2026-09-26').key,'paid');
  assert.equal(api.installmentVisualState({number:2,due:'2026-09-20',paid:false},2,'2026-09-26').key,'overdue');
  assert.equal(api.installmentVisualState({number:3,due:'2026-09-26',paid:false},3,'2026-09-26').key,'today');
  assert.equal(api.installmentVisualState({number:4,due:'2026-10-01',paid:false},4,'2026-09-26').key,'next');
  assert.equal(api.installmentVisualState({number:5,due:'2026-11-01',paid:false},4,'2026-09-26').key,'pending');
});

test('classification reuses the existing evaluator with the approved semantic precedence',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  for(const id of ['stable','regular','danger','ineligible','new'])ctx.clientes.push({id,nombre:id});
  assert.equal(api.classifyClient(ctx.clientes[0]).label,'ESTABLE');
  assert.equal(api.classifyClient(ctx.clientes[1]).label,'REGULAR');
  assert.equal(api.classifyClient(ctx.clientes[2]).label,'PELIGRO');
  assert.equal(api.classifyClient(ctx.clientes[3]).label,'SIN REQUISITOS');
  assert.equal(api.classifyClient(ctx.clientes[4]).label,'NUEVO');
  assert.equal(api.classifyClient(ctx.clientes[0]).tone,'green');
  assert.equal(api.classifyClient(ctx.clientes[1]).tone,'amber');
  assert.equal(api.classifyClient(ctx.clientes[2]).tone,'red');
  assert.equal(api.classifyClient(ctx.clientes[4]).tone,'slate');
});

test('batch payment allocation uses the selected debts oldest-first without mutating the ledger',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  const credits=[
    credit('4867','stable',185,0,{fecha:'2026-09-15'}),
    credit('4868','stable',10,2,{fecha:'2026-09-15'}),
    credit('4902','stable',10,0,{fecha:'2026-09-18'})
  ];
  const before=JSON.stringify(credits);
  const partial=api.batchAllocationPlan(credits,19000);
  assert.equal(partial.valid,true);
  assert.equal(partial.selected_cents,20300);
  assert.deepEqual(Array.from(partial.allocations,x=>[x.credit_id,x.amount_cents]),[
    ['4867',18500],
    ['4868',500]
  ]);
  assert.equal(partial.unallocated_cents,0);

  const all=api.batchAllocationPlan(credits,20300);
  assert.equal(all.valid,true);
  assert.deepEqual(Array.from(all.allocations,x=>[x.credit_id,x.amount_cents]),[
    ['4867',18500],
    ['4868',800],
    ['4902',1000]
  ]);

  const tooMuch=api.batchAllocationPlan(credits,20400);
  assert.equal(tooMuch.valid,false);
  assert.equal(tooMuch.unallocated_cents,100);
  assert.equal(JSON.stringify(credits),before,'allocation preview must not mutate balances');
});

test('batch selection total helper sums only selected outstanding amounts',()=>{
  const ctx=context(),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  const rows=[
    credit('a','stable',25.50,10.70),
    credit('b','stable',8,0),
    credit('c','stable',16.50,0)
  ];
  assert.equal(api.batchSelectedTotalCents(rows),3930);
  assert.equal(api.batchSelectedTotalCents([]),0);
});

test('category view exposes select-all, automatic allocation and one final batch payment action',()=>{
  const category=source.slice(source.indexOf('function labCategoryHtml'),source.indexOf('function labCleanInstallmentProductName'));
  assert.match(source,/Cobro múltiple/);
  assert.match(source,/Monto total que está abonando/);
  assert.match(source,/Seleccionar todo/);
  assert.match(source,/Aplicar automáticamente/);
  assert.match(source,/naCanonBatchToggleAll/);
  assert.match(source,/naCanonBatchAutoSelect/);
  assert.match(source,/naCanonBatchSelectionChanged/);
  assert.match(source,/naCanonBatchAmountChanged/);
  assert.match(source,/labBatchSetAutoAmountFromSelection/);
  assert.match(source,/dataset\.naBatchAmountMode = 'manual'/);
  assert.match(source,/naCanonSubmitBatchPayment/);
  assert.match(source,/confirmBatch\(/);
  assert.match(category,/labBatchPanelHtml\(summary\)/);
  assert.match(category,/labBatchRow\(cr, row\)/);
  assert.match(source,/onchange="naCanonBatchSelectionChanged\(\)"/);
  assert.match(source,/oninput="naCanonBatchAmountChanged\(\)"/);
  assert.match(css,/CANON BATCH CREDIT PAYMENTS 001/);
  assert.match(css,/\.na-v2-batch-check:checked\+\.na-v2-batch-check-ui/);
  assert.match(css,/#pageClientes \.na-v2-batch-method-row \[hidden\]\{\s*display:none!important;/);
  assert.match(css,/@media\(max-width:430px\)[\s\S]*\.na-v2-batch-method-row\{grid-template-columns:1fr\}/);
});

test('batch submit has an in-flight guard and preserves durable Pagado projection until reconciliation',()=>{
  const submit=source.slice(source.indexOf('root.naCanonSubmitBatchPayment = async function'),source.indexOf('function labPurchaseRow'));
  const preview=source.slice(source.indexOf('function labBatchUpdatePreview'),source.indexOf('root.naCanonBatchPaymentChanged'));
  assert.match(source,/var labBatchSubmitInFlight = false;/);
  assert.match(source,/var labBatchAwaitingReconcile = false;/);
  assert.match(submit,/if \(labBatchSubmitInFlight\) return false;/);
  assert.match(submit,/labBatchSubmitInFlight = true;/);
  assert.match(submit,/labBatchShowConfirmed\(result, state\)/);
  assert.match(submit,/if \(!confirmedVisual\) labBatchUpdatePreview\(\)/,
    'stale preview must not overwrite Pagado after receipt');
  assert.doesNotMatch(submit,/labRenderRoute\('replace'\)/,
    'must not immediately rerender stale canonical data after receipt');
  assert.match(preview,/submit\.disabled = labBatchSubmitInFlight \|\| !\(plan\.valid && referenceOk\)/);
  assert.match(preview,/labBatchSubmitInFlight\s*\? 'Procesando…'/);
});

test('durable batch receipt paints Pagado immediately and reconciliation later replaces the temporary projection',()=>{
  const confirmed=source.slice(source.indexOf('function labBatchShowConfirmed'),source.indexOf('root.naCanonSubmitBatchPayment'));
  assert.match(confirmed,/Pagado ✓/);
  assert.match(confirmed,/✓ Pagado/);
  assert.match(confirmed,/labBatchAwaitingReconcile = true/);
  assert.match(confirmed,/labMoney\(currentSummary\.pending\)/);
  assert.match(source,/labBatchAwaitingReconcile \|\| labPaymentReceiptOverlays\.size/);
  assert.match(source,/labBatchAwaitingReconcile = false;\s*labRenderRoute\('replace'\)/);
  assert.match(css,/\.na-v2-batch-row-paid/);
  assert.match(css,/\.na-v2-batch-pay\.na-v2-batch-confirmed/);
  assert.match(css,/background:#16a34a/);
});

test('small-credit purchase detail exposes the existing payment flow when balance is pending',()=>{
  const purchase=source.slice(source.indexOf('function labPurchaseHtml'),source.indexOf('function labPendingInstallmentsHtml'));
  assert.match(purchase,/labCreditPending\(cr\) > 0\.001/);
  assert.match(purchase,/!labIsCanceled\(cr\)/);
  assert.match(purchase,/class="na-v2-pay"/);
  assert.match(purchase,/abrirPago\(/);
  assert.match(purchase,/Registrar pago/);
});

test('CANON UI keeps financial authority in existing evaluation/payment/FIFO/cash paths',()=>{
  const classification=source.slice(source.indexOf('function labClassifyClient'),source.indexOf('function labProductSummary'));
  assert.match(source,/_naEvaluateClientCredit/);
  assert.doesNotMatch(classification,/score\s*=|assignedLine\s*=|automaticLine\s*=/);
  assert.match(source,/abrirPago\(/);
  assert.doesNotMatch(source,/cajMovs\.push|_naAllocateCreditPayment\s*=|saveAllData|confirmarPago\s*=/);
  assert.match(source,/NuevoAmanecerCanonical\.createCreditAccount/);
  assert.match(integration,/NA_CLIENT_CREDIT_ACCOUNTS_V2\.saleDraft/);
});

test('names are uppercase only in presentation and original stored values remain untouched',()=>{
  assert.match(source,/String\(client && client\.nombre \|\| 'Cliente'\)\.toUpperCase\(\)/);
  assert.match(source,/\.c-name'\)\.forEach[\s\S]*toUpperCase/);
  assert.doesNotMatch(source,/client\.nombre\s*=\s*.*toUpperCase|c\.nombre\s*=\s*.*toUpperCase/);
});

test('top Menu resets client subnavigation while internal back moves one level only',()=>{
  assert.match(source,/back\.addEventListener\('click',naResetClientNavigationForMenu,true\)/);
  const back=source.slice(source.indexOf('window.naCanonClientBack = function'),source.indexOf('window.naCanonOpenCreditCategory'));
  assert.match(back,/route === 'purchase' \|\| labClientScreenState\.route === 'credit'/);
  assert.match(back,/route === 'creditHistory'/);
  assert.doesNotMatch(back,/goMenu\(|goPage\(/);
  assert.match(html,/id="backBtn" onclick="goMenu\(\)">← Menú<\/button>/);
});

test('client loader replaces only the list during canonical connection and respects reduced motion',()=>{
  assert.match(source,/logo\.textContent='🌅'/);
  assert.match(source,/title\.textContent='Cargando clientes…'/);
  assert.match(source,/copy\.textContent='Obteniendo datos, por favor espera\.'/);
  assert.match(source,/state\.source==='none' && \(state\.validation==='pending' \|\| state\.validation==='validating'\)/);
  assert.match(css,/#pageClientes\.na-client-loading-active #cliList\{\s*display:none!important/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)[\s\S]*na-client-loading-ring[\s\S]*animation:none!important/);
});

test('approved visual palette, sky/cloud motion and responsive guards are present',()=>{
  for(const risk of ['green','amber','red','slate']) assert.match(css,new RegExp('\\.na-v2-risk-'+risk+'\\{'));
  assert.doesNotMatch(css,/\.na-v2-risk-(blue|teal)\{/);
  assert.match(css,/@keyframes na-v2-clouds-near/);
  assert.match(css,/@keyframes na-v2-clouds-far/);
  assert.match(css,/width:min\(100%,760px\)/);
  assert.match(css,/overflow-wrap:anywhere/);
  assert.match(css,/@media\(max-width:430px\)/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/min-width:0/);
});

test('sale intent derives exact installment cents from dates and keeps category independent of amount',()=>{
  assert.match(intent,/baseAmount = Math\.floor\(total \/ input\.installment_dates\.length\)/);
  assert.match(intent,/remainder = total - baseAmount \* input\.installment_dates\.length/);
  assert.match(intent,/credit_account/);
  assert.doesNotMatch(intent,/total[^\n]{0,80}(category|account_id)|amount[^\n]{0,80}(category|account_id)/i);
});

test('production shell includes V2 module and stylesheet without LAB runtime indicators',()=>{
  assert.match(html,/css\/client-credit-accounts-v2\.css/);
  assert.match(html,/js\/modules\/client-credit-accounts-v2\.js/);
  assert.doesNotMatch(source,/LAB\s*·\s*CONECTANDO|NO PRODUCCIÓN|naLabBadge|__NA_LAB__/);
});


test('native Clientes renderer owns the visible list and keeps legacy panels out of the primary route',()=>{
  assert.match(source,/function naRenderClientList\(rows, list\)/);
  assert.match(source,/dataset\.naV2Native = 'true'/);
  assert.match(source,/na-v2-client-list-card/);
  assert.match(source,/root\.naCanonOpenClientAccount\(client\.id\)/);
  assert.match(css,/CLIENTES V2 NATIVE LIST/);
  assert.match(css,/na-client-refresh-out/);
  assert.match(css,/prefers-reduced-motion:reduce/);
});


test('client refresh motion matches the approved LAB contract',()=>{
  assert.ok(source.includes("}, 850);"),'CANON must keep the approved 850ms coordinated refresh');
  assert.ok(!source.includes("}, 180);"),'the simplified 180ms refresh must not return');
  assert.ok(css.includes('opacity 1300ms cubic-bezier(.22,1,.36,1)'));
  assert.ok(css.includes('transform 1400ms cubic-bezier(.22,1,.36,1)'));
  assert.ok(css.includes('opacity:.82'));
  assert.ok(css.includes('translateY(-6px) scale(.998)'));
  assert.ok(css.includes('translateY(7px) scale(.998)'));
  assert.ok(css.includes('transition-duration:900ms,950ms'));
  assert.ok(css.includes('#pageClientes .stats-strip'));
  assert.ok(css.includes('prefers-reduced-motion:reduce'));
});


test('cached CANON clients remain visible while remote validation finishes',()=>{
  assert.match(source,/state\.source==='none' && \(state\.validation==='pending' \|\| state\.validation==='validating'\)/);
  assert.doesNotMatch(source,/loading=state\.validation==='pending' \|\| state\.validation==='validating'/);
  assert.match(canonicalClient,/publishReplica\(cached, 'cache'\);[\s\S]{0,400}var validating = refresh\(\);[\s\S]{0,200}notifyReplicaUpdate\(\);/);
  assert.match(canonicalClient,/replicaState\.validation = 'current';\s*notifyReplicaUpdate\(\);/);
  assert.match(canonicalClient,/replicaState\.validation = 'remote-older';\s*notifyReplicaUpdate\(\);/);
});


function motionContext(){
  const timers=[];
  const rafs=[];
  const classes=new Set(['active']);
  const classLog=[];
  const drawLog=[];
  const lookup={};

  function classList(){
    return {
      add(...names){for(const name of names){classes.add(name);classLog.push('add:'+name);}},
      remove(...names){for(const name of names){classes.delete(name);classLog.push('remove:'+name);}},
      contains(name){return classes.has(name);},
      toggle(name,force){
        if(force===true){classes.add(name);return true;}
        if(force===false){classes.delete(name);return false;}
        if(classes.has(name)){classes.delete(name);return false;}
        classes.add(name);return true;
      }
    };
  }
  function element(){
    return {
      className:'',hidden:false,dataset:{},style:{},textContent:'',
      classList:classList(),setAttribute(){},append(){},appendChild(){},
      replaceChildren(){drawLog.push('draw');},querySelector(){return null;},
      querySelectorAll(){return[];},addEventListener(){},
    };
  }

  const page=element();
  page.classList=classList();
  const list=element();
  lookup.pageClientes=page;
  lookup.cliList=list;

  const document={
    body:{appendChild(){}},
    getElementById(id){return lookup[id]||null;},
    querySelector(){return null;},
    querySelectorAll(){return[];},
    createElement(){return element();},
    createDocumentFragment(){return {appendChild(){}};}
  };

  const ctx={
    console:{info(){},warn(){},error(){}},
    Date,Number,String,Object,Array,Set,Map,Math,JSON,RegExp,Error,Promise,crypto,
    document,clientes:[],creditos:[],cart:[],posPayM:'credito',
    setTimeout(fn,ms){const item={fn,ms,cancelled:false};timers.push(item);return item;},
    clearTimeout(id){if(id&&typeof id==='object')id.cancelled=true;},
    requestAnimationFrame(fn){rafs.push(fn);return rafs.length;},
    MutationObserver:undefined,
    matchMedia(){return{matches:false};},
    addEventListener(){},
    _naEsc(value){return String(value);},
    fmt(value){return 'S/ '+Number(value||0).toFixed(2);},
    _naEvaluateClientCredit(){return{exists:true,enabled:true,eligible:true,assignedLine:0,automaticLine:0,available:0,manualActive:false,history:{punctual:0,late:0,completed:0,partial:0,overdueActive:0,behavior:'sin_historial'}};},
    _naCreditOutstanding(){return 0;},
    _naSyncCreditStatus(){return'vigente';},
    diasHasta(){return 1;}
  };
  ctx.window=ctx;ctx.globalThis=ctx;
  vm.createContext(ctx);
  vm.runInContext(source,ctx,{filename:'client-credit-accounts-v2.js'});

  return {
    ctx,page,list,classes,classLog,drawLog,timers,rafs,
    runTimer(){
      const item=timers.shift();
      assert.ok(item,'expected timer');
      if(!item.cancelled)item.fn();
      return item;
    },
    runRaf(){
      const queue=rafs.splice(0,rafs.length);
      assert.ok(queue.length,'expected RAF callback');
      queue.forEach(fn=>fn());
    }
  };
}

test('runtime client motion performs exit, DOM swap, entry and settle in order',()=>{
  const m=motionContext();
  const api=m.ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;

  api.renderClientList([],m.list);
  assert.equal(m.drawLog.length,1,'first paint must render immediately');
  assert.ok(m.classes.has('na-client-refresh-in'),'first paint starts in entry state');
  m.runRaf();
  assert.ok(m.classes.has('na-client-refresh-in'),'entry survives first frame');
  m.runRaf();
  assert.ok(!m.classes.has('na-client-refresh-in'),'entry settles after second frame');

  m.drawLog.length=0;
  api.renderClientList([],m.list);
  assert.ok(m.classes.has('na-client-refresh-out'),'refresh starts with exit state');
  assert.equal(m.drawLog.length,0,'DOM must not swap before exit window');
  const timer=m.runTimer();
  assert.equal(timer.ms,850,'approved LAB coordination window must be preserved');
  assert.equal(m.drawLog.length,1,'DOM swaps after exit window');
  assert.ok(!m.classes.has('na-client-refresh-out'),'exit state is removed after DOM swap');
  assert.ok(m.classes.has('na-client-refresh-in'),'new DOM is prepared in entry state');
  m.runRaf();
  assert.ok(m.classes.has('na-client-refresh-in'),'entry state must paint for one frame');
  m.runRaf();
  assert.ok(!m.classes.has('na-client-refresh-in'),'new DOM settles to rest after second frame');
});

test('stale client motion callbacks cannot cancel a newer refresh',()=>{
  const m=motionContext();
  const api=m.ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  api.renderClientList([],m.list);
  m.runRaf();m.runRaf();

  api.renderClientList([],m.list);
  const stale=m.timers[0];
  api.renderClientList([],m.list);
  assert.equal(stale.cancelled,true,'new refresh cancels previous timer');
  stale.fn();
  assert.equal(m.drawLog.length,1,'stale callback must not draw after epoch changed');
});


test('financial workspace swipe follows the approved LAB visual contract',()=>{
  assert.match(source,/touchstart/);
  assert.match(source,/touchmove/);
  assert.match(source,/touchend/);
  assert.match(source,/touchcancel/);
  assert.match(source,/screen\.scrollTop > 0/);
  assert.match(source,/NA_CLIENT_INTERACTIVE_SELECTOR/);
  assert.match(source,/distance >= threshold/);
  assert.match(source,/velocity >= \.85/);
  assert.match(source,/naClientSettleWorkspaceBack/);
  assert.match(source,/naClientDismissWorkspace/);
  assert.match(css,/--na-client-workspace-drag-y/);
  assert.match(css,/--na-client-workspace-panel-opacity/);
  assert.match(css,/--na-client-workspace-backdrop-alpha/);
  assert.match(css,/transform:translate3d\(0,var\(--na-client-workspace-drag-y\),0\)/);
  assert.match(css,/na-client-workspace-settling/);
});

test('financial panel is hidden only after visual close and subviews slide directionally',()=>{
  const close=source.slice(source.indexOf('function labCloseScreen'),source.indexOf('function labResetClientNavigationForMenu'));
  assert.doesNotMatch(close,/screen\.hidden\s*=\s*true/);
  assert.match(close,/naClientDismissWorkspace/);
  const finish=source.slice(source.indexOf('function naClientFinishWorkspaceClose'),source.indexOf('function naClientDismissWorkspace'));
  assert.match(finish,/screen\.hidden\s*=\s*true/);
  assert.match(source,/labRenderRoute\('forward'\)/);
  assert.match(source,/labRenderRoute\('back'\)/);
  assert.match(css,/na-client-view-exit-forward/);
  assert.match(css,/na-client-view-exit-back/);
  assert.match(css,/na-client-view-enter-forward/);
  assert.match(css,/na-client-view-enter-back/);
  assert.doesNotMatch(css,/#pageClientes\.na-client-detail-open #cliList\{visibility:hidden\}/);
});


test('credit dialogs suspend the financial workspace and restore its route on close',()=>{
  const ctx=context();
  const tokens=new Set();
  const screen={hidden:false,scrollTop:123,innerHTML:'current credit line',inert:false,
    classList:{toggle(name,on){if(on)tokens.add(name);else tokens.delete(name);},contains(name){return tokens.has(name);}}};
  const page={querySelector(){return screen;},classList:{contains(){return true;}}};
  const ids=['mEvaluacionCredito','mLineaCreditoManual','mCred','mPagoCred','mCreditoDetalle'];
  const modals=new Map(ids.map(id=>[id,{open:false,classList:{contains(name){return name==='open' && modals.get(id).open;}}}]));
  const callbacks=[];
  ctx.MutationObserver=class {constructor(fn){this.fn=fn;}observe(node,options){assert.deepEqual(Array.from(options.attributeFilter),['class']);callbacks.push(this.fn);}};
  ctx.document.getElementById=id=>id==='pageClientes'?page:(modals.get(id)||null);
  ctx.dispatchEvent({type:'load'});
  const notify=()=>callbacks.forEach(fn=>fn());
  modals.get('mEvaluacionCredito').open=true;notify();
  assert.equal(screen.inert,true,'underlying menu must not accept input');
  assert.equal(tokens.has('na-client-workspace-suspended'),true,'underlying menu must be hidden');
  modals.get('mEvaluacionCredito').open=false;modals.get('mLineaCreditoManual').open=true;notify();
  assert.equal(screen.inert,true,'evaluation-to-manual transition must stay suspended');
  modals.get('mLineaCreditoManual').open=false;notify();
  assert.equal(screen.inert,false);
  assert.equal(tokens.has('na-client-workspace-suspended'),false);
  assert.equal(screen.hidden,false);
  assert.equal(screen.scrollTop,123);
  assert.equal(screen.innerHTML,'current credit line');
  const observations=callbacks.length;
  ctx.dispatchEvent({type:'pageshow'});
  assert.equal(callbacks.length,observations,'runtime rebind must not duplicate observers');
  for(const id of ids){modals.get(id).open=true;notify();assert.equal(screen.inert,true,id);modals.get(id).open=false;notify();assert.equal(screen.inert,false,id);}
  screen.hidden=true;modals.get('mEvaluacionCredito').open=true;notify();modals.get('mEvaluacionCredito').open=false;notify();
  assert.equal(screen.hidden,true,'closing a dialog must never reopen a closed workspace');
});


for (const amountCents of [100,200,300]) test('batch confirmation projects once and classifies remaining balance: '+amountCents,()=>{
  const ctx=context(true),api=ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2;
  ctx.clientes=[{id:'stable',nombre:'Synthetic client'}];
  ctx.creditos=[credit('CR:001','stable',3,0),credit('CR:002','stable',657.70,0)];
  ctx.dispatchEvent({type:'na:canonical-payment-receipt',detail:{version:1,command:'payment.create',
    payload:{operation_id:'PAY-ONE',credit_id:'CR:001',amount_cents:amountCents,payment_method:'efectivo'},
    receipt:{operation_id:'PAY-ONE',credit_id:'CR:001',status:'created',current_balance_cents:300-amountCents}}});
  assert.equal(api.categorySummary(ctx.clientes[0],{id:'small'}).pending,660.70-amountCents/100);
  const balance={textContent:''},summary={textContent:''},status={textContent:''};
  const row={classList:{add(){}},getAttribute:()=> 'CR:001',querySelector:s=>s==='.na-v2-row-value'?{querySelector:()=>status}:null};
  const screen={querySelector:s=>s==='.na-v2-category-balance strong'?balance:s==='#naV2BatchSummary'?summary:null,querySelectorAll:()=>[row]};
  ctx.document.getElementById=id=>id==='pageClientes'?{querySelector:()=>screen}:null;
  Object.assign(ctx.__batchTest.state,{clientId:'stable',categoryId:'small'});
  ctx.__batchTest.confirm({completed:[{credit_id:'CR:001',amount_cents:amountCents}]},{});
  assert.equal(balance.textContent,'S/ '+(660.70-amountCents/100).toFixed(2));
  assert.equal(status.textContent,amountCents===300?'Pagado ✓':'Abono confirmado ✓');
});
