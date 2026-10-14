import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { tursoSqlite } from './turso-sqlite-protocol.mjs';
import { lotsReady, rememberLotSchema } from '../../tools/cloudflare-lab/src/stock-lots.js';

const migration='infra/database/migrations/0030_canonical_stock_lots.sql';
const migrations=['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql','0024_pos_roles_owner_pin.sql','0025_pos_reviews_pin_failures.sql','0026_pos_sale_annulments.sql','0028_pos_purchases.sql'];
const ctl=f=>{const c=f.control();return{promotion_id:c.active_promotion_id,authority_epoch:c.authority_epoch,expected_control_revision:c.revision,client_contract:'a6-gate-c-v1'};};
const call=async(f,path,b,extra={})=>{const r=await f.fetch('http://localhost'+path,{method:b?'POST':'GET',headers:{authorization:'Bearer owner-token','content-type':'application/json',...extra},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json()};};
async function setup(t){
  assert.ok(existsSync(migration),'migración aditiva disponible');
  const f=await activeCanon(t,{migrations});f.database.exec(readFileSync(migration,'utf8'));f.addDevice('owner','writer','active','owner-token');
  assert.equal((await call(f,'/auth/owner-pin',{new_pin:'4821'})).status,200);
  return f;
}
const product=f=>f.sql("SELECT * FROM products WHERE product_id='00003'");
const lots=f=>f.all("SELECT * FROM canonical_stock_lots WHERE product_id='00003' ORDER BY lot_id");
async function entry(f,op,rows,quantity){const r=await call(f,'/commands/inventory.adjust',{...ctl(f),operation_id:op,created_at:'2026-10-14T13:00:00.000Z',product_id:'00003',movement_type:'ENTRADA',quantity,expected_stock_revision:product(f).stock_revision,reason:'Ingreso prueba',lots:rows});assert.equal(r.status,201,JSON.stringify(r));return r;}
const receipt=(code,date,quantity)=>({lot_code:code,expiry_date:date,quantity});
test('schema completo 0001..0030 se aplica en SQLite local vacío y foreign keys siguen válidas',()=>{
  const db=new DatabaseSync(':memory:');
  try{db.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync('infra/database/migrations').filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort())db.exec(readFileSync('infra/database/migrations/'+name,'utf8'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='canonical_stock_lots'").get().n,1);
  }finally{db.close();}
});
function sale(f,op,quantity,extra={}){return{...ctl(f),operation_id:op,sale_id:op,created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',total_cents:Math.round(quantity*1000),payment:{cash_cents:0,digital_cents:Math.round(quantity*1000),credit_cents:0,reference:op},items:[{product_id:'00003',quantity,unit_price_cents:1000,line_total_cents:Math.round(quantity*1000),expected_stock_revision:product(f).stock_revision,...extra}]};}

test('migración 0030 solo crea tablas/índices, reaplica sin perder datos; ingreso y replay/conflicto atómicos',async t=>{
  const f=await setup(t),sql=readFileSync(migration,'utf8');
  assert.doesNotMatch(sql.replace(/--[^\n]*/g,''),/\b(DROP|DELETE|UPDATE|INSERT|REPLACE|TRIGGER)\b/i);
  const before=product(f).current_stock_quantity;
  const rows=[receipt('B','2026-12-01',2),receipt('A','2026-11-01',1)];
  await entry(f,'in-1',rows,4);
  assert.equal(product(f).current_stock_quantity,before+4);assert.equal(lots(f).length,2);
  const original=f.sql("SELECT expected_stock_revision FROM canonical_inventory_operations WHERE operation_id='in-1'");
  const retry={...ctl(f),operation_id:'in-1',created_at:'2026-10-14T13:00:00.000Z',product_id:'00003',movement_type:'ENTRADA',quantity:4,expected_stock_revision:original.expected_stock_revision,reason:'Ingreso prueba',lots:rows};
  assert.equal((await call(f,'/commands/inventory.adjust',retry)).status,200);
  assert.equal((await call(f,'/commands/inventory.adjust',{...retry,lots:[receipt('changed','2026-11-01',1)]})).status,409);
  f.database.exec(sql);assert.equal(lots(f).length,2);assert.equal(product(f).current_stock_quantity,before+4);
});
test('venta FEFO persistida; anulación devuelve exactamente lotes originales una vez',async t=>{
  const f=await setup(t);await entry(f,'in-2',[receipt('late','2026-12-01',2),receipt('early','2026-11-01',2)],4);
  const body=sale(f,'sell-2',3);assert.equal((await call(f,'/commands/sale.create',body)).status,201);
  const quantities=()=>lots(f).map(l=>[l.lot_code,l.quantity]);
  assert.deepEqual(quantities(),[['late',1],['early',0]]);
  assert.equal((await call(f,'/commands/sale.create',body)).status,200);assert.deepEqual(quantities(),[['late',1],['early',0]]);
  const annul={...ctl(f),operation_id:'ann-2',sale_id:'sell-2',created_at:'2026-10-14T15:00:00.000Z',reason:'Prueba devolución'};
  const approval=await call(f,'/auth/owner-approval',{pin:'4821',action:'sale.annul',operation_id:'ann-2'});assert.equal(approval.status,201);
  const headers={'x-owner-approval':approval.body.approval_id};
  const out=await call(f,'/commands/sale.annul',annul,headers);assert.equal(out.status,201,JSON.stringify(out));
  assert.deepEqual(quantities(),[['late',2],['early',2]]);
  assert.equal((await call(f,'/commands/sale.annul',annul,headers)).status,200);assert.deepEqual(quantities(),[['late',2],['early',2]]);
});
test('venta sólo con vencidos sin consentimiento se registra y audita; replay conserva flag',async t=>{
  const f=await setup(t);assert.equal((await call(f,'/commands/inventory.adjust',{...ctl(f),operation_id:'clear-unbatched',created_at:'2026-10-14T13:00:00.000Z',product_id:'00003',movement_type:'SALIDA',quantity:product(f).current_stock_quantity,expected_stock_revision:product(f).stock_revision,reason:'Consumir saldo inicial sin lote'})).status,201);
  await entry(f,'in-3',[receipt('expired','2026-10-13',2)],2);
  const body=sale(f,'sell-3',2),out=await call(f,'/commands/sale.create',body);
  assert.equal(out.status,201,JSON.stringify(out));assert.equal(out.body.status,'created');
  assert.equal(out.body.expired_lots_unconfirmed,true);assert.equal(product(f).current_stock_quantity,0);assert.equal(lots(f)[0].quantity,0);
  const effects=f.all("SELECT quantity,expired_confirmed FROM canonical_stock_lot_effects WHERE operation_id='sell-3'");
  assert.deepEqual(effects.map(e=>[e.quantity,e.expired_confirmed]),[[-2,0]]);
  const replay=await call(f,'/commands/sale.create',body);assert.equal(replay.status,200);assert.equal(replay.body.expired_lots_unconfirmed,true);
  assert.equal(f.sql("SELECT COUNT(*) n FROM sales WHERE sale_id='sell-3'").n,1);
  await entry(f,'in-3-confirmed',[receipt('expired-confirmed','2026-10-13',2)],2);
  const confirmed=await call(f,'/commands/sale.create',sale(f,'sell-3-confirmed',2,{allow_expired_lots:true}));
  assert.equal(confirmed.status,201);assert.equal(confirmed.body.expired_lots_unconfirmed,undefined);
  assert.equal(f.sql("SELECT expired_confirmed FROM canonical_stock_lot_effects WHERE operation_id='sell-3-confirmed'").expired_confirmed,1);
});
test('compra guarda sus lotes, termina con mismo contenido y rechaza cambios de lote',async t=>{
  const f=await setup(t);const b={...ctl(f),operation_id:'purchase-lots',created_at:'2026-10-14T13:00:00.000Z',lines:[{line:1,product_id:'00003',quantity:2,unit_cost_cents:100,lots:[receipt('P','2026-11-01',2)]}]};
  let r=await call(f,'/auth/purchases',b);assert.equal(r.status,201,JSON.stringify(r));assert.equal(lots(f)[0].quantity,2);
  assert.equal((await call(f,'/auth/purchases',b)).status,200);
  b.lines[0].lots[0].lot_code='changed';assert.equal((await call(f,'/auth/purchases',b)).status,409);assert.equal(lots(f)[0].quantity,2);
});
test('dos compras simultáneas con mismo id y lotes distintos no separan recibo de efecto de stock',async t=>{
  const f=await setup(t),base={...ctl(f),operation_id:'purchase-race',created_at:'2026-10-14T13:00:00.000Z'};
  let readers=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  f.env.DB={prepare(sql){const statement=f.binding.prepare(sql);if(sql==='SELECT * FROM pos_purchases WHERE purchase_id=?1'){const first=statement.first;statement.first=async function(){const row=await first.call(this);if(!row&&readers<2){readers++;if(readers===2)release();await barrier;}return row;};}return statement;},batch:f.binding.batch.bind(f.binding)};
  const purchase=code=>({...base,lines:[{line:1,product_id:'00003',quantity:2,unit_cost_cents:100,lots:[receipt(code,'2026-11-01',2)]}]});
  const replies=await Promise.all([call(f,'/auth/purchases',purchase('A')),call(f,'/auth/purchases',purchase('B'))]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[201,409]);assert.equal(replies.find(r=>r.status===409).body.error,'purchase_payload_mismatch');
  const stored=JSON.parse(f.sql("SELECT lots_json FROM pos_purchase_line_lots WHERE purchase_id='purchase-race'").lots_json);
  assert.equal(lots(f)[0].lot_code,stored[0].lot_code);assert.equal(lots(f).length,1);
});
test('lectura/reload y outbox perdido ACK preservan lotes y confirmación; replay no duplica',async t=>{
  const f=await setup(t);await entry(f,'in-4',[receipt('L','2026-11-01',2)],2);
  const scripts=['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')]);
  let lost=true;const tab=await device(f,{token:'owner-token',scripts,onFetch:async(url,rest)=>{if(new URL(url).pathname==='/commands/sale.create'&&lost){lost=false;await f.fetch(url,rest);throw new Error('lost ACK');}}});
  assert.equal(tab.api.snapshot().products.find(p=>p.product_id==='00003').lots[0].quantity,2);
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({operation_id:'offline-lots',sale_id:'offline-lots',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:1,unit_price_cents:1000,allow_expired_lots:true}]});
  const outbox=tab.context.NuevoAmanecerCanonicalSaleOutbox;await outbox.enqueue(intent);await outbox.sync();
  assert.equal(outbox.snapshot().intents.length,1);assert.equal(lots(f)[0].quantity,1);
  const reload=await device(f,{token:'owner-token',scripts,localStorage:tab.localStorage});
  assert.equal(reload.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents[0].items[0].allow_expired_lots,true);
  await reload.context.NuevoAmanecerCanonicalSaleOutbox.sync();assert.equal(lots(f)[0].quantity,1);assert.equal(reload.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
});
test('ruta rápida Turso aplica lotes, audita vencidos sin consentimiento y autentica',async t=>{
  const f=await setup(t);await entry(f,'fast-in',[receipt('expired','2026-10-13',3),receipt('valid','2026-11-01',2)],5);
  const transport=tursoSqlite(f.database);f.env.DB=transport.adapter;f.env.RUNTIME_ENVIRONMENT='production';f.env.CANONICAL_RUNTIME_ENABLED='enabled';
  const body=sale(f,'fast-sell',2);let out=await call(f,'/commands/sale.create',body);assert.equal(out.status,201,JSON.stringify(out));
  assert.equal(lots(f).find(l=>l.lot_code==='valid').quantity,0);
  out=await call(f,'/commands/sale.create',body);assert.equal(out.status,200,JSON.stringify(out));assert.equal(out.body.idempotent,true);
  const expired=sale(f,'fast-expired',2);
  out=await call(f,'/commands/sale.create',expired,{authorization:'Bearer wrong-token'});assert.equal(out.status,401);
  out=await call(f,'/commands/sale.create',expired);assert.equal(out.status,201,JSON.stringify(out));assert.equal(out.body.expired_lots_unconfirmed,true);
  const audit=f.all("SELECT expired_confirmed FROM canonical_stock_lot_effects WHERE operation_id='fast-expired' AND lot_id<>''");assert.ok(audit.length);assert.ok(audit.every(e=>e.expired_confirmed===0));
  out=await call(f,'/commands/sale.create',expired);assert.equal(out.status,200);assert.equal(out.body.expired_lots_unconfirmed,true);
  assert.equal(lots(f).find(l=>l.lot_code==='expired').quantity,2.125);
});
test('fallo dentro del batch y CAS obsoleto no dejan venta, lote ni stock parciales',async t=>{
  const f=await setup(t);await entry(f,'atomic-in',[receipt('A','2026-11-01',2)],2);
  const before=product(f),beforeLots=lots(f),body=sale(f,'atomic-sale',1);
  f.failBatchAt(12);const failed=await call(f,'/commands/sale.create',body);assert.equal(failed.status,409);f.failBatchAt(null);
  assert.deepEqual(product(f),before);assert.deepEqual(lots(f),beforeLots);assert.equal(f.sql("SELECT COUNT(*) n FROM sales WHERE sale_id='atomic-sale'").n,0);
  await entry(f,'competing-in',[],1);
  const stale=await call(f,'/commands/sale.create',body);assert.equal(stale.status,409);assert.equal(stale.body.error,'stale_stock');assert.deepEqual(lots(f),beforeLots);
});
test('SALIDA manual respeta lotes y vencidos; retorno público de lotes está prohibido',async t=>{
  const f=await setup(t);await entry(f,'manual-in',[receipt('A','2026-10-13',2)],2);
  const b={...ctl(f),operation_id:'manual-out',created_at:'2026-10-14T13:00:00.000Z',product_id:'00003',movement_type:'SALIDA',quantity:2,expected_stock_revision:product(f).stock_revision,reason:'Salida prueba'};
  assert.equal((await call(f,'/commands/inventory.adjust',b)).body.error,'expired_lots_confirmation_required');
  b.allow_expired_lots=true;assert.equal((await call(f,'/commands/inventory.adjust',b)).body.error,'expired_lot_approval_required');
  const approval=await call(f,'/auth/owner-approval',{pin:'4821',action:'expired_lot_sale'});assert.equal(approval.status,201);b.expired_lot_approval=approval.body.approval_id;assert.equal((await call(f,'/commands/inventory.adjust',b)).status,201);assert.equal(lots(f)[0].quantity,1.125);
  const forged={...b,operation_id:'forged-return',movement_type:'ENTRADA',return_sale_operation:'fake',quantity:1};delete forged.allow_expired_lots;delete forged.expired_lot_approval;
  assert.equal((await call(f,'/commands/inventory.adjust',forged)).status,400);
});
test('venta offline cobrada se sincroniza aunque el lote venza antes del envío, sin cuarentena',async t=>{
  const f=await setup(t);assert.equal((await call(f,'/commands/inventory.adjust',{...ctl(f),operation_id:'clear-unbatched',created_at:'2026-10-14T13:00:00.000Z',product_id:'00003',movement_type:'SALIDA',quantity:product(f).current_stock_quantity,expected_stock_revision:product(f).stock_revision,reason:'Consumir saldo inicial sin lote'})).status,201);
  await entry(f,'offline-in',[receipt('later-expired','2026-11-01',3)],3);
  const scripts=['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')]);
  const tab=await device(f,{token:'owner-token',scripts});
  const builder=tab.context.NuevoAmanecerCanonicalSaleIntent,outbox=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  await outbox.enqueue(builder.build({operation_id:'offline-expired',sale_id:'offline-expired',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:2,unit_price_cents:1000}]}));
  f.exec("UPDATE canonical_stock_lots SET expiry_date='2026-10-13' WHERE product_id='00003'");
  await outbox.sync();assert.equal(outbox.snapshot().intents.length,0);assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(outbox.quarantine().entries.length,0);assert.equal(tab.api.receiptSnapshot().expired_lots_unconfirmed,true);
  assert.equal(f.sql("SELECT expired_confirmed FROM canonical_stock_lot_effects WHERE operation_id='offline-expired'").expired_confirmed,0);
  assert.equal(lots(f)[0].quantity,1);assert.equal(f.sql("SELECT COUNT(*) n FROM sales WHERE sale_id='offline-expired'").n,1);
});
test('SALIDA no consume lote reservado por una venta pendiente cobrada localmente',async t=>{
  const f=await setup(t);await entry(f,'reserved-in',[receipt('ok','2026-11-01',1),receipt('expired','2026-10-13',4)],5);
  const scripts=['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')]);
  const tab=await device(f,{token:'owner-token',scripts});
  await tab.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(tab.context.NuevoAmanecerCanonicalSaleIntent.build({operation_id:'reserved-sale',sale_id:'reserved-sale',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:1,unit_price_cents:1000}]}));
  await assert.rejects(tab.api.adjustInventory({product_id:'00003',movement_type:'SALIDA',quantity:1,reason:'Salida no debe consumir reserva'}),/LOT_STOCK_RESERVED_BY_PENDING_SALE/);
  assert.equal(lots(f).find(l=>l.lot_code==='ok').quantity,1);
});
test('sale.create items null devuelve 400, no TypeError ni efectos',async t=>{
  const f=await setup(t),bad=sale(f,'invalid-null',1);bad.items=[null];
  const out=await call(f,'/commands/sale.create',bad);assert.equal(out.status,400);assert.equal(out.body.error,'invalid_item');
});
test('ACK proyecta lote y revisión para otra venta pendiente antes de refresh, sin doble reserva',async t=>{
  const f=await setup(t);await entry(f,'project-in',[receipt('ok','2026-11-01',3)],3);
  const scripts=['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')]);
  const tab=await device(f,{token:'owner-token',scripts});
  const builder=tab.context.NuevoAmanecerCanonicalSaleIntent,outbox=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const intent=builder.build({operation_id:'project-sale',sale_id:'project-sale',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:1,unit_price_cents:1000}]});
  await outbox.enqueue(intent);const ack=await tab.api.createSale(intent);
  assert.equal(ack.lot_allocations[0].quantity,1);
  const base=tab.api.snapshot(),p=base.products.find(p=>p.product_id==='00003');assert.equal(p.lots[0].quantity,2);
  const projected=tab.context.NuevoAmanecerCanonicalSaleProjection.project(base,outbox.snapshot());
  assert.equal(projected.products.find(p=>p.product_id==='00003').lots[0].quantity,2);
  await outbox.sync();assert.equal(lots(f)[0].quantity,2);
});
test('venta por peso con lote reserva cantidades físicas decimales; SALIDA no invade su reserva',async t=>{
  const f=await setup(t);await entry(f,'decimal-in',[receipt('weight','2026-11-01',2.5)],2.5);
  const scripts=['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')]);
  const tab=await device(f,{token:'owner-token',scripts}),outbox=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  const intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({operation_id:'decimal-sale',sale_id:'decimal-sale',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:0.5,unit_price_cents:1000}]});
  await outbox.enqueue(intent);
  await assert.rejects(tab.api.adjustInventory({product_id:'00003',movement_type:'SALIDA',quantity:1,reason:'Reserva decimal'}),/LOT_STOCK_RESERVED_BY_PENDING_SALE/);
  await outbox.sync();assert.equal(outbox.snapshot().intents.length,0);assert.equal(lots(f)[0].quantity,2);
});
test('reporte comparte la vista de receipts tras ACK perdido/replay sin refresco remoto',async t=>{
  const f=await setup(t);await entry(f,'report-ack-in',[receipt('L','2026-11-01',2)],2);
  const scripts=[['test-dom',`const originalCreate=document.createElement;document.createElement=function(tag){const n=originalCreate(tag);n.appendChild=n.append;return n;};const originalGet=document.getElementById;document.getElementById=function(id){const n=originalGet(id);n.appendChild=n.append;return n;};`],...['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js','sync/canonical-sale-view.js','inventory/stock-lots-ui.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')])];
  let lost=true,blockProducts=false;
  const tab=await device(f,{token:'owner-token',scripts,onFetch:async(url,rest)=>{const path=new URL(url).pathname;if(path==='/read/canonical/products'&&blockProducts)return Response.json({error:'offline-read'},{status:503});if(path==='/commands/sale.create'&&lost){lost=false;blockProducts=true;await f.fetch(url,rest);throw Error('lost ACK');}}});
  const outbox=tab.context.NuevoAmanecerCanonicalSaleOutbox,intent=tab.context.NuevoAmanecerCanonicalSaleIntent.build({operation_id:'report-ack-sale',sale_id:'report-ack-sale',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:1,unit_price_cents:1000}]});
  await outbox.enqueue(intent);await outbox.sync();
  const ack=await tab.api.retryPending();assert.equal(ack.status,'already_processed');
  await outbox.sync();
  assert.equal(tab.context.NA_STOCK_LOTS_UI.currentProducts().find(p=>p.product_id==='00003').lots[0].quantity,1);
  assert.equal(lots(f)[0].quantity,1);
});

test('lotsReady cachea false 60 s, detecta migración después del TTL y conserva true',async t=>{
  let tables=0,reads=0,now=1000;
  t.mock.method(Date,'now',()=>now);
  const db={prepare(){return{async first(){reads++;return{n:tables};}};}};
  rememberLotSchema(db,new Set());assert.equal(await lotsReady(db),false);
  assert.equal(await lotsReady(db),false);assert.equal(reads,0);
  tables=2;now+=59999;assert.equal(await lotsReady(db),false);assert.equal(reads,0);
  now++;assert.equal(await lotsReady(db),true);assert.equal(reads,1);
  now+=60001;rememberLotSchema(db,new Set());assert.equal(await lotsReady(db),true);assert.equal(reads,1);
});

test('commerceCapabilities cachea ausencias y vuelve a consultar tras 60 s con Worker vivo',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=await activeCanon(t);f.addDevice('owner','writer','active','owner-token');
  const base=f.binding;let reads=0;
  f.env.DB={prepare(sql){const statement=base.prepare(sql);if(sql.includes('AS lot_tables')){const first=statement.first;statement.first=async function(){reads++;return first.call(this);};}return statement;},batch:base.batch.bind(base)};
  assert.equal((await call(f,'/commands/sale.create',sale(f,'before-lots-migration',0.125))).status,201);
  assert.equal((await call(f,'/commands/sale.create',sale(f,'before-lots-migration-2',0.125))).status,201);
  assert.equal(reads,1);assert.equal(await lotsReady(f.env.DB),false);
  for(const name of migrations)f.database.exec(readFileSync('infra/database/migrations/'+name,'utf8'));
  f.database.exec(readFileSync(migration,'utf8'));now+=60001;
  await entry(f,'after-live-migration',[receipt('new-schema','2026-11-01',2)],2);
  const out=await call(f,'/commands/sale.create',sale(f,'after-lots-migration',1));
  assert.equal(out.status,201,JSON.stringify(out));assert.equal(reads,2);
  assert.equal(lots(f)[0].quantity,1);
  assert.equal(f.sql("SELECT quantity FROM canonical_stock_lot_effects WHERE operation_id='after-lots-migration' AND lot_id<>''").quantity,-1);
});

for(const fast of [false,true])test(`CAS de lote obsoleto devuelve stale_stock y reintenta sin efectos parciales (${fast?'Turso rápido':'normal'})`,async t=>{
  const f=await setup(t);await entry(f,'lot-cas-in',[receipt('CAS','2026-11-01',2)],2);
  if(fast){f.env.DB=tursoSqlite(f.database).adapter;f.env.RUNTIME_ENVIRONMENT='production';f.env.CANONICAL_RUNTIME_ENABLED='enabled';}
  const base=f.env.DB||f.binding,sqlByStatement=new WeakMap();let raced=false;
  f.env.DB={...(fast?{_pipeline:base._pipeline.bind(base)}:{}),prepare(sql){const statement=base.prepare(sql);sqlByStatement.set(statement,sql);const bind=statement.bind;statement.bind=function(...values){const bound=bind.apply(this,values);sqlByStatement.set(bound,sql);return bound;};return statement;},async batch(statements){
    if(!raced&&statements.some(s=>sqlByStatement.get(s)?.includes('INSERT INTO sales'))){
      raced=true;f.exec("UPDATE canonical_stock_lots SET quantity=1.5 WHERE product_id='00003'");
    }
    return base.batch(statements);
  }};
  const before=product(f),body=sale(f,'lot-cas-sale',1),out=await call(f,'/commands/sale.create',body);
  assert.ok(raced);assert.equal(out.status,409,JSON.stringify(out));assert.equal(out.body.error,'stale_stock');assert.equal(out.body.product_id,'00003');
  assert.deepEqual(product(f),before);assert.equal(lots(f)[0].quantity,1.5);
  for(const table of ['sales','sale_items','cash_movements','canonical_stock_lot_effects'])assert.equal(f.sql(`SELECT COUNT(*) n FROM ${table} WHERE operation_id='lot-cas-sale'`).n,0,table);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_write_guards').n,0);assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n,0);
  const retry=await call(f,'/commands/sale.create',body);assert.equal(retry.status,201,JSON.stringify(retry));
  assert.equal(lots(f)[0].quantity,0.5);assert.equal(product(f).current_stock_quantity,before.current_stock_quantity-1);
  assert.equal(f.sql("SELECT COUNT(*) n FROM sales WHERE operation_id='lot-cas-sale'").n,1);
});

test('cuarentena de servidor anterior por vencidos permite reintentar la misma venta sin inventar consentimiento',async t=>{
  const f=await setup(t);await entry(f,'legacy-expired-in',[receipt('expired','2026-10-13',3)],3);
  const scripts=['inventory/stock-lots.js','sync/canonical-sale-intent.js','sync/canonical-sale-projection.js','sync/canonical-sale-outbox.js'].map(p=>[p,readFileSync('POS/js/'+p,'utf8')]);
  let oldServer=true;
  const tab=await device(f,{token:'owner-token',scripts,onFetch:async(url)=>{
    if(new URL(url).pathname==='/commands/sale.create'&&oldServer)return Response.json({error:'expired_lots_confirmation_required'},{status:409});
  }});
  const outbox=tab.context.NuevoAmanecerCanonicalSaleOutbox;
  await outbox.enqueue(tab.context.NuevoAmanecerCanonicalSaleIntent.build({operation_id:'legacy-expired-sale',sale_id:'legacy-expired-sale',created_at:'2026-10-14T14:00:00.000Z',payment_method:'yape',items:[{product_id:'00003',quantity:2,unit_price_cents:1000}]}));
  await outbox.sync();assert.equal(outbox.quarantine().entries[0].reason,'expired_lots_confirmation_required');
  assert.equal(outbox.quarantineRetryable('expired_lots_confirmation_required'),true);
  assert.match(outbox.reasonText('expired_lots_confirmation_required'),/sin volver a cobrar/);
  oldServer=false;await outbox.resolveQuarantined('legacy-expired-sale','retry');
  assert.equal(outbox.snapshot().intents[0].items[0].allow_expired_lots,undefined);
  await outbox.sync();assert.equal(outbox.snapshot().intents.length,0);
  assert.equal(f.sql("SELECT COUNT(*) n FROM sales WHERE operation_id='legacy-expired-sale'").n,1);
  const audit=f.all("SELECT expired_confirmed FROM canonical_stock_lot_effects WHERE operation_id='legacy-expired-sale' AND lot_id<>''");
  assert.ok(audit.length);assert.ok(audit.every(e=>e.expired_confirmed===0));
});

test('una lectura negativa atrasada no degrada lotsReady true concurrente',async()=>{
  const pending=[];
  const db={prepare(){return{first(){return new Promise(resolve=>pending.push(resolve));}};}};
  const old=lotsReady(db),fresh=lotsReady(db);
  pending[1]({n:2});assert.equal(await fresh,true);
  pending[0]({n:0});assert.equal(await old,true);
  assert.equal(await lotsReady(db),true);assert.equal(pending.length,2);
});
test('ingreso con códigos duplicados es rechazado por servidor sin cambiar stock ni lotes',async t=>{
  const f=await setup(t),before=product(f);
  const out=await call(f,'/commands/inventory.adjust',{...ctl(f),operation_id:'duplicate-codes',created_at:'2026-10-14T13:00:00Z',product_id:'00003',movement_type:'ENTRADA',quantity:2,expected_stock_revision:before.stock_revision,reason:'Ingreso duplicado',lots:[receipt('A','2026-11-01',1),receipt(' A ','2026-12-01',1)]});
  assert.equal(out.status,400);assert.equal(out.body.error,'invalid_inventory_lots');
  assert.deepEqual(product(f),before);assert.equal(lots(f).length,0);
});
test('cliente inventory.adjust rechaza ingresos vencidos o con código ya registrado antes de enviar',async t=>{
  const f=await setup(t);await entry(f,'client-entry-existing',[receipt('EXISTE','2099-11-01',1)],1);
  const tab=await device(f,{token:'owner-token',scripts:[['lots-core',readFileSync('POS/js/inventory/stock-lots.js','utf8')]]});
  for(const row of [receipt('EXISTE','2099-11-01',1),receipt('NUEVO','2000-01-01',1)]){
    const start=tab.fetchLog.length;
    await assert.rejects(tab.api.adjustInventory({product_id:'00003',movement_type:'ENTRADA',quantity:1,reason:'Ingreso inválido cliente',lots:[row]}),row.lot_code==='EXISTE'?/DUPLICATE_LOT_CODE/:/EXPIRED_LOT_RECEIPT/);
    assert.equal(tab.fetchLog.slice(start).filter(r=>new URL(r.url).pathname==='/commands/inventory.adjust').length,0);
  }
  assert.equal(lots(f).length,1);
});
