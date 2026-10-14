import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { activeCanon } from './canon-browser-harness.mjs';
import lotCore from '../../POS/js/inventory/stock-lots.js';

const read=p=>readFileSync(p,'utf8');
function helper(){
  const src=read('POS/js/legacy-inline/inline-01.js');
  const start=src.indexOf('const NA_EXPIRY_SOON_DAYS');assert.ok(start>=0);
  const ctx={NA_STOCK_LOTS:lotCore,JSON};vm.createContext(ctx);
  vm.runInContext(src.slice(start)+';this.f=_naEffectiveExpiry;this.d=NA_EXPIRY_SOON_DAYS;',ctx);return ctx;
}
const lot=(id,date,q)=>({lot_id:id,lot_code:id,expiry_date:date,quantity:q,received_at:'2026-01-01T00:00:00.000Z'});

test('_naEffectiveExpiry: lote más próximo con saldo, ignora saldo 0, cae a venc, null sin vencimiento',()=>{
  const {f,d}=helper();assert.equal(d,30);
  assert.equal(f({venc:'2030-01-01',lots_json:JSON.stringify([lot('a','2026-12-01',2),lot('b','2026-11-01',0),lot('c','2027-01-01',1)])}),'2026-12-01');
  assert.equal(f({venc:'2030-01-01',lots_json:JSON.stringify([lot('b','2026-11-01',0)])}),null,'lotes agotados: sin vencimiento, no cae a venc');
  assert.equal(f({venc:'2030-01-01'}),'2030-01-01');
  assert.equal(f({}),null);assert.equal(f({lots_json:'{roto'}),null);
});

test('pestañas y contadores usan la clasificación única; límites y lotes agotados',()=>{
 const i9=read('POS/js/legacy-inline/inline-09.js'),i3=read('POS/js/legacy-inline/inline-03.js'),i1=read('POS/js/legacy-inline/inline-01.js');
 assert.match(i9,/_naExpiryBucket\(product\)==='soon'/);assert.match(i9,/_naExpiryBucket\(product\)==='expired'/);
 assert.match(i3,/_naExpiryBuckets\(\).soon.length/);assert.match(i3,/_naExpiryBuckets\(\).expired.length/);
 const ctx=helper();ctx._naTracksStock=p=>p.controlInventario!==false;ctx.diasHasta=date=>date===null?null:Number(date);
 assert.equal(vm.runInContext("_naExpiryBucket({venc:'0'})",ctx),'soon');
 assert.equal(vm.runInContext("_naExpiryBucket({venc:'30'})",ctx),'soon');
 assert.equal(vm.runInContext("_naExpiryBucket({venc:'31'})",ctx),'later');
 assert.equal(vm.runInContext("_naExpiryBucket({venc:'-1'})",ctx),'expired');
 assert.equal(vm.runInContext("_naExpiryBucket({})",ctx),'none');
 assert.equal(vm.runInContext("_naExpiryBucket({venc:'1',controlInventario:false})",ctx),'none');
 assert.match(i1,/_naExpiryBucket\(p\)==='soon'/);
 assert.match(read('POS/js/legacy-inline/inline-06.js'),/expiry=diasHasta\(_naEffectiveExpiry\(product\)\)/);
});
test('formulario: vencimiento siempre de solo lectura; stock editable y auditado por ledger al editar',()=>{
 const i8=read('POS/js/legacy-inline/inline-08.js');
 assert.match(i8,/abrirModalProd=function[^\n]*expiryField\.readOnly=true/);
 assert.match(i8,/editProd=function[^\n]*expiryField\.readOnly=true/);
 assert.match(i8,/stock.readOnly=false/);assert.doesNotMatch(i8,/stock.readOnly=!!product/);assert.match(i8,/_naEffectiveExpiry\(product\)/);
 assert.match(i8,/abrirMovInv\(id,'entrada'\)/);
 assert.doesNotMatch(read('POS/js/legacy-inline/inline-02.js'),/invEditId\?_naNumber\(editingPrevious\?\.stock\)/);
});

test('no queda ningún acceso a «Productos a vencer» ni al toggle duplicado',()=>{
  const files=[];const walk=d=>{for(const n of readdirSync(d)){const p=d+'/'+n;if(statSync(p).isDirectory())walk(p);else if(/\.(js|html|css|json|webmanifest)$/.test(n))files.push(p);}};walk('POS');
  for(const p of files){const s=read(p);assert.doesNotMatch(s,/Productos a vencer|na-lot-report|openReport|secExpiredLots/,p);}
  assert.match(read('POS/js/config/config-v9.js'),/allowExpiredLots/);
});

test('PIN de lotes vencidos usa NA_ROLES y expired_lot_sale',()=>{
  const ui=read('POS/js/inventory/stock-lots-ui.js');
  assert.match(ui,/approve\('expired_lot_sale'/);assert.match(ui,/NA_ROLES\.askPin/);assert.doesNotMatch(ui,/'discount'/);
  assert.match(read('tools/cloudflare-lab/src/pos-roles.js'),/APPROVAL_ACTIONS = new Set\(\[[^\]]*'expired_lot_sale'/);
});

test('plan(): rechaza 1e-10 y sin lotes con stock negativo da INSUFFICIENT_PROJECTED_STOCK',()=>{
  assert.throws(()=>lotCore.plan(5,[],1e-10,'2026-10-14',false),/INVALID_LOT_STOCK/);
  assert.throws(()=>lotCore.plan(-2,[],1,'2026-10-14',false),/INSUFFICIENT_PROJECTED_STOCK/);
  assert.throws(()=>lotCore.plan(1,[],2,'2026-10-14',false),/INSUFFICIENT_PROJECTED_STOCK/);
});

const migrations=['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql','0024_pos_roles_owner_pin.sql','0025_pos_reviews_pin_failures.sql','0026_pos_sale_annulments.sql','0028_pos_purchases.sql'];
const ctl=f=>{const c=f.control();return{promotion_id:c.active_promotion_id,authority_epoch:c.authority_epoch,expected_control_revision:c.revision,client_contract:'a6-gate-c-v1'};};
const call=async(f,path,b)=>{const r=await f.fetch('http://localhost'+path,{method:'POST',headers:{authorization:'Bearer owner-token','content-type':'application/json'},body:JSON.stringify(b)});return{status:r.status,body:await r.json()};};
const product=f=>f.sql("SELECT * FROM products WHERE product_id='00003'");
const move=(f,op,type,quantity,extra={})=>call(f,'/commands/inventory.adjust',{...ctl(f),operation_id:op,created_at:'2026-10-14T13:00:00.000Z',product_id:'00003',movement_type:type,quantity,expected_stock_revision:product(f).stock_revision,reason:'Prueba lotes',...extra});
async function setup(t){
  const f=await activeCanon(t,{migrations});f.database.exec(read('infra/database/migrations/0030_canonical_stock_lots.sql'));f.addDevice('owner','writer','active','owner-token');
  assert.equal((await call(f,'/auth/owner-pin',{new_pin:'4821'})).status,200);
  assert.equal((await move(f,'clear','SALIDA',product(f).current_stock_quantity)).status,201);
  assert.equal((await move(f,'in-exp','ENTRADA',2,{lots:[{lot_code:'old',expiry_date:'2026-10-01',quantity:2}]})).status,201);
  return f;
}

test('servidor: salida con vencidos exige aprobación expired_lot_sale válida',async t=>{
  const f=await setup(t);
  let r=await move(f,'out-1','SALIDA',1,{allow_expired_lots:true});assert.equal(r.status,403);assert.equal(r.body.error,'expired_lot_approval_required');
  r=await move(f,'out-1','SALIDA',1,{allow_expired_lots:true,expired_lot_approval:'nope'});assert.equal(r.status,403);
  const wrong=await call(f,'/auth/owner-approval',{pin:'4821',action:'discount'});assert.equal(wrong.status,201);
  r=await move(f,'out-1','SALIDA',1,{allow_expired_lots:true,expired_lot_approval:wrong.body.approval_id});assert.equal(r.status,403);
  const ok=await call(f,'/auth/owner-approval',{pin:'4821',action:'expired_lot_sale'});assert.equal(ok.status,201);
  r=await move(f,'out-1','SALIDA',1,{allow_expired_lots:true,expired_lot_approval:ok.body.approval_id});assert.equal(r.status,201,JSON.stringify(r));
  r=await move(f,'out-2','SALIDA',1,{allow_expired_lots:true,expired_lot_approval:ok.body.approval_id});assert.equal(r.status,403,'no reutilizable en otra operación');
  r=await move(f,'out-3','SALIDA',1,{expired_lot_approval:ok.body.approval_id});assert.equal(r.status,400);
});

test('LOT_STOCK_INCOHERENT: entrada permitida, salida bloqueada',async t=>{
  const f=await setup(t);
  f.database.exec("UPDATE canonical_stock_lots SET quantity=quantity+5 WHERE product_id='00003'");
  const out=await move(f,'out-x','SALIDA',1,{allow_expired_lots:true,expired_lot_approval:(await call(f,'/auth/owner-approval',{pin:'4821',action:'expired_lot_sale'})).body.approval_id});
  assert.equal(out.status,409);
  const entry=await move(f,'in-fix','ENTRADA',5);assert.equal(entry.status,201,JSON.stringify(entry));
});

test('pVenc de solo lectura no se guarda: legado conserva venc y CANON reenvía el valor del servidor',()=>{
  assert.match(read('POS/js/legacy-inline/inline-02.js'),/venc:controlInventario\?\(document\.getElementById\('pVenc'\)\.readOnly&&editingPrevious\?\(editingPrevious\.venc\|\|null\)/);
  const save=read('POS/js/sync/canonical-product-bridge.js');
  assert.match(save,/getElementById\('pVenc'\)\?\.readOnly\) input\.expiry_date = raw\.expiry_date \|\| null/);
});

test('autorización local resuelve true (no un objeto)',async()=>{
  const ui=read('POS/js/inventory/stock-lots-ui.js');
  assert.match(ui,/root\._naPinValid\(pin\)\?\{ok:true,value:true\}/);
  assert.match(read('POS/js/config/pos-roles-client.js'),/if \(r && r\.ok\) \{ done\(r\.value\); return; \}/);
});

function sale(f,op,createdAt,extra={}){return{...ctl(f),operation_id:op,sale_id:op,created_at:createdAt,payment_method:'yape',total_cents:1000,payment:{cash_cents:0,digital_cents:1000,credit_cents:0,reference:op},items:[{product_id:'00003',quantity:1,unit_price_cents:1000,line_total_cents:1000,expected_stock_revision:product(f).stock_revision,...extra}]};}
test('venta en línea con lotes vencidos: exige interruptor del servidor y aprobación expired_lot_sale',async t=>{
  const f=await setup(t),now=()=>new Date().toISOString();
  let r=await call(f,'/commands/sale.create',sale(f,'on-1',now(),{allow_expired_lots:true}));
  assert.equal(r.status,409);assert.equal(r.body.error,'expired_lots_not_allowed');
  assert.equal((await call(f,'/settings',{key:'pos.lots',value:{allowExpiredLots:true}})).status,200);
  r=await call(f,'/commands/sale.create',sale(f,'on-2',now(),{allow_expired_lots:true}));assert.equal(r.body.error,'expired_lot_approval_required');
  const wrong=(await call(f,'/auth/owner-approval',{pin:'4821',action:'discount'})).body.approval_id;
  r=await call(f,'/commands/sale.create',sale(f,'on-3',now(),{allow_expired_lots:true,expired_lot_approval:wrong}));assert.equal(r.body.error,'expired_lot_approval_required');
  const ok=(await call(f,'/auth/owner-approval',{pin:'4821',action:'expired_lot_sale'})).body.approval_id;
  r=await call(f,'/commands/sale.create',sale(f,'on-4',now(),{allow_expired_lots:true,expired_lot_approval:ok}));
  assert.equal(r.status,201,JSON.stringify(r));assert.notEqual(r.body.expired_lots_unconfirmed,true);
  assert.equal(product(f).current_stock_quantity,1);
});
test('venta tardía del outbox con lotes vencidos: se acepta (nunca cuarentena) y queda marcada para revisión',async t=>{
  const f=await setup(t),late=new Date(Date.now()-60*60*1000).toISOString();
  const r=await call(f,'/commands/sale.create',sale(f,'late-1',late));
  assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.body.expired_lots_unconfirmed,true);
  const body2=sale(f,'late-2',late,{allow_expired_lots:true}),r2=await call(f,'/commands/sale.create',body2);
  assert.equal(r2.status,201,JSON.stringify(r2));assert.equal(r2.body.expired_lots_unconfirmed,true,'el consentimiento del cliente no basta');assert.equal(f.sql("SELECT expired_confirmed FROM canonical_stock_lot_effects WHERE operation_id='late-2'").expired_confirmed,0);
  const replay=await call(f,'/commands/sale.create',body2);assert.equal(replay.status,200);assert.equal(replay.body.expired_lots_unconfirmed,true,'replay conserva la marca');
  const outbox=read('POS/js/sync/canonical-sale-outbox.js');
  assert.match(outbox,/RETRYABLE\.push\([^)]*'expired_lots_not_allowed', 'expired_lot_approval_required'/);
});

test('servidor: salida manual de producto sin lotes no usa plan() y registra efecto sin lote',async t=>{
  const f=await activeCanon(t,{migrations});f.database.exec(read('infra/database/migrations/0030_canonical_stock_lots.sql'));f.addDevice('owner','writer','active','owner-token');
  const r=await move(f,'nolot-out','SALIDA',1);assert.equal(r.status,201,JSON.stringify(r));
  assert.deepEqual(f.all("SELECT lot_id,quantity FROM canonical_stock_lot_effects WHERE operation_id='nolot-out'").map(x=>[x.lot_id,x.quantity]),[['',-1]]);
  assert.match(read('tools/cloudflare-lab/src/a6-inventory.js'),/movement_type==='SALIDA'&&!rows\.length\)allocations=\[\{lot_id:'',quantity:body\.quantity\}\]/);
});

const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
test('created_at retrasado no oculta un lote que ya venció según la fecha del servidor',async t=>{
  const f=await activeCanon(t,{migrations});f.database.exec(read('infra/database/migrations/0030_canonical_stock_lots.sql'));f.addDevice('owner','writer','active','owner-token');
  assert.equal((await move(f,'clear','SALIDA',product(f).current_stock_quantity)).status,201);
  assert.equal((await move(f,'in-y','ENTRADA',2,{lots:[{lot_code:'ayer',expiry_date:day(-2),quantity:2}]})).status,201);
  const backdated=new Date(Date.now()-5*86400000).toISOString();
  const r=await call(f,'/commands/sale.create',sale(f,'back-1',backdated));
  assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.body.expired_lots_unconfirmed,true);
  assert.match(read('tools/cloudflare-lab/src/a6-commerce.js'),/lotsCore\.businessDate\(new Date\(\)\.toISOString\(\)\),true\)/);
});
test('created_at futuro (reloj adelantado) nunca se rechaza por la hora: normal 201; con vencidos sin aprobación 409 reintentable',async t=>{
  const f=await activeCanon(t,{migrations});f.database.exec(read('infra/database/migrations/0030_canonical_stock_lots.sql'));f.addDevice('owner','writer','active','owner-token');
  assert.equal((await call(f,'/auth/owner-pin',{new_pin:'4821'})).status,200);
  assert.equal((await move(f,'clear','SALIDA',product(f).current_stock_quantity)).status,201);
  assert.equal((await move(f,'in-ok','ENTRADA',1,{lots:[{lot_code:'bueno',expiry_date:day(200),quantity:1}]})).status,201);
  const future=new Date(Date.now()+3*3600000).toISOString();
  const futBody=sale(f,'fut-ok',future);let r=await call(f,'/commands/sale.create',futBody);assert.equal(r.status,201,JSON.stringify(r));
  const again=await call(f,'/commands/sale.create',futBody);assert.equal(again.status,200,'reenvío idéntico: idempotente, sin conflicto');assert.equal(again.body.sale_id,'fut-ok');assert.notEqual(r.body.expired_lots_unconfirmed,true);
  // Diferido: la hora efectiva no se reescribe (sale.created_at = reloj del aparato); la hora del servidor ya queda en sales.received_at.
  const row=f.sql("SELECT created_at,received_at FROM sales WHERE sale_id='fut-ok'");
  assert.equal(row.created_at,future);assert.ok(Math.abs(Date.parse(row.received_at)-Date.now())<60000,'received_at es hora del servidor');
  assert.equal((await move(f,'in-exp','ENTRADA',2,{lots:[{lot_code:'viejo',expiry_date:day(-3),quantity:2}]})).status,201);
  r=await call(f,'/commands/sale.create',sale(f,'fut-exp',future,{allow_expired_lots:true}));
  assert.equal(r.status,409);assert.equal(r.body.error,'expired_lots_not_allowed');
  assert.doesNotMatch(read('tools/cloudflare-lab/src/a6-commerce.js'),/invalid_created_at' \}, 400\)/);
  assert.match(read('POS/js/sync/canonical-sale-outbox.js'),/RETRYABLE\.push\([^)]*'expired_lots_not_allowed'/);
});
test('más de 1 día de atraso se marca para revisión aunque traiga aprobación válida',async t=>{
  const f=await setup(t);assert.equal((await call(f,'/settings',{key:'pos.lots',value:{allowExpiredLots:true}})).status,200);
  const ok=(await call(f,'/auth/owner-approval',{pin:'4821',action:'expired_lot_sale'})).body.approval_id;
  const r=await call(f,'/commands/sale.create',sale(f,'old-1',new Date(Date.now()-2*86400000).toISOString(),{allow_expired_lots:true,expired_lot_approval:ok}));
  assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.body.expired_lots_unconfirmed,true);
});
test('textos de rechazo no invitan a reintentar; interruptor se guarda en servidor con error visible',()=>{
  const outbox=read('POS/js/sync/canonical-sale-outbox.js');
  assert.doesNotMatch(outbox,/Reintentar en unos minutos/);
  assert.match(outbox,/expired_lots_not_allowed: '[^']*activarlo[^']*'/);assert.match(outbox,/expired_lot_approval_required: '[^']*aprobación del dueño o supervisor[^']*'/);
  const v9=read('POS/js/config/config-v9.js');
  assert.match(v9,/case 'expiredLots':[^\n]*\n\s*autosave\(true, function \(\) \{[^}]*el\.checked = prevExpired/);
  assert.match(v9,/'todos los aparatos'\)/);assert.match(v9,/solo el dueño puede cambiar este ajuste/);
});
test('sin conexión la venta con lotes vencidos sigue bloqueada (el PIN necesita el servidor)',()=>{
  const ui=read('POS/js/inventory/stock-lots-ui.js');
  assert.match(ui,/var local=!canonical\(\)\?\.enabled\(\)&&/);
  assert.match(ui,/remote\.approve\('expired_lot_sale'/);
});
test('sin internet el diálogo de PIN dice que hace falta conexión',()=>{assert.match(read('POS/js/inventory/stock-lots-ui.js'),/onLine===false\)notice\('Sin internet/);});
test('operación rechazada en línea por vencidos sigue exigiendo PIN al reintentar tarde; con aprobación válida 201',async t=>{
  const f=await setup(t);
  let r=await call(f,'/commands/sale.create',sale(f,'rt-1',new Date().toISOString(),{allow_expired_lots:true}));
  assert.equal(r.status,409);assert.equal(r.body.error,'expired_lots_not_allowed');
  const tenMinAgo=new Date(Date.now()-10*60000).toISOString();
  r=await call(f,'/commands/sale.create',sale(f,'rt-1',tenMinAgo,{allow_expired_lots:true}));
  assert.equal(r.status,409,'reintento tardío sin aprobación sigue bloqueado');
  assert.equal((await call(f,'/settings',{key:'pos.lots',value:{allowExpiredLots:true}})).status,200);
  r=await call(f,'/commands/sale.create',sale(f,'rt-1',tenMinAgo,{allow_expired_lots:true}));
  assert.equal(r.status,409);assert.equal(r.body.error,'expired_lot_approval_required');
  const ok=(await call(f,'/auth/owner-approval',{pin:'4821',action:'expired_lot_sale'})).body.approval_id;
  r=await call(f,'/commands/sale.create',sale(f,'rt-1',tenMinAgo,{allow_expired_lots:true,expired_lot_approval:ok}));
  assert.equal(r.status,201,JSON.stringify(r));assert.notEqual(r.body.expired_lots_unconfirmed,true);
  // la marca no sirve como aprobación de nada
  const marker=f.sql("SELECT action,used_at FROM pos_owner_approvals WHERE action='expired_lot_required'");
  assert.equal(marker.action,'expired_lot_required');assert.ok(marker.used_at);
});
test('Reintentar en revisión por vencidos pide el PIN del dueño y reenvía con la aprobación',()=>{
  const outbox=read('POS/js/sync/canonical-sale-outbox.js'),bridge=read('POS/js/sync/canonical-cash-bridge.js');
  assert.match(outbox,/fail\('QUARANTINE_EXPIRED_NEEDS_PIN'\)/);assert.match(outbox,/line\.expired_lot_approval = approvalId/);
  assert.match(bridge,/NA_ROLES\.approve\('expired_lot_sale'[\s\S]{0,400}expiredLotApproval: expiredApproval/);
});
