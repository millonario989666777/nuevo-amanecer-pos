// CANON quarantine store (owner 2026-10-11): a rejected/undeliverable sale is
// copied durably, leaves the FIFO, frees the journal so the POS keeps working,
// and only cash-bearing entries block the close. Nothing is ever deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(n=>[n,readFileSync('POS/js/sync/'+n+'.js','utf8')]);
const QKEY='na_canonical_sale_outbox_v1_quarantine';
async function setup(t,onFetch){
 const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql']});
 f.env.DB=tursoSqlite(f.database).adapter;
 const d=await device(f,{token:'qs',deviceId:'qs',scripts:[...scripts,['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;},confirm(){return true;}},onFetch});
 await d.api.openCash({session_id:'qs-session',opening_cents:107250});
 d.el('cajContado').value='1072.50';
 const outbox=d.context.NuevoAmanecerCanonicalSaleOutbox;
 return {f,d,outbox,build:x=>d.context.NuevoAmanecerCanonicalSaleIntent.build(x)};
}
const cash=id=>({sale_id:id,payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]});
const credit=(id,customer)=>({sale_id:id,payment_method:'credito',customer_id:customer,credit_due:'2026-11-30',items:[{product_id:'00000',quantity:1,precio:2}]});

test('409 cash sale: copied to quarantine, FIFO keeps draining, POS keeps working, close blocked with sale_id',async t=>{
 let reject=true;
 const {f,d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create')&&reject){reject=false;return Response.json({error:'product_not_found'},{status:409});}});
 await outbox.enqueue(build(cash('V-085'))); await outbox.enqueue(build(cash('V-086')));
 const [bad,good]=outbox.snapshot().intents;
 const out=await outbox.sync();
 assert.equal(out.status,'DRAINED');
 assert.equal(outbox.snapshot().intents.length,0);
 const q=outbox.quarantine().entries;
 assert.equal(q.length,1); assert.equal(q[0].status,'QUARANTINED');
 assert.deepEqual(q[0].intent,bad,'full intent preserved with same ids');
 assert.equal(q[0].journal.last_error,'product_not_found');
 assert.equal(d.api.pendingSnapshot(),null,'journal freed');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',good.operation_id).n,1);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',bad.operation_id).n,0);
 await d.api.refresh();
 const credits=d.api.snapshot().credits.find(x=>x.current_balance_cents>=100);
 await d.api.createPayment({credit_id:credits.credit_id,amount_cents:100,payment_method:'efectivo'});
 assert.equal(await d.context.cerrarCaja(),false);
 const text=d.el('cajCloseStatus').textContent;
 assert.ok(text.includes('Venta pendiente: '+bad.sale_id),text);
 assert.match(text,/No la cobres de nuevo/);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});

test('retry resends the same operation_id once and then the cash close succeeds with one sale',async t=>{
 let reject=true;
 const {f,d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create')&&reject){reject=false;return Response.json({error:'product_not_found'},{status:409});}});
 await outbox.enqueue(build(cash('V-085')));
 const [sale]=outbox.snapshot().intents;
 await outbox.sync();
 await outbox.resolveQuarantined(sale.operation_id,'retry');
 assert.equal((await outbox.sync()).status,'DRAINED');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',sale.operation_id).n,1);
 assert.equal(outbox.quarantine().entries[0].status,'REQUEUED');
 d.el('cajContado').value='1074.50';
 assert.equal(await d.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107450);
});

test('credit sale with a customer missing on the server never blocks the queue; close waits for reconciliation; never annullable without journal; record kept',async t=>{
 const {f,d,outbox,build}=await setup(t);
 await outbox.enqueue(build(credit('V-087','cliente-solo-local'))); await outbox.enqueue(build(cash('V-088')));
 const [bad,good]=outbox.snapshot().intents;
 assert.equal((await outbox.sync()).status,'DRAINED');
 const q=outbox.quarantine().entries;
 assert.equal(q[0].intent.operation_id,bad.operation_id); assert.equal(q[0].reason,'INVALID_CANONICAL_CUSTOMER');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',good.operation_id).n,1);
 d.el('cajContado').value='1074.50';
 assert.equal(await d.context.cerrarCaja(),false,'any unreconciled sale blocks this close');
 assert.ok(d.el('cajCloseStatus').textContent.includes('Venta pendiente: '+bad.sale_id));
 assert.equal((await outbox.resolveQuarantined(bad.operation_id,'verify')).status,'NOT_REGISTERED');
 await assert.rejects(outbox.resolveQuarantined(bad.operation_id,'archive'),/QUARANTINE_ANNUL_NEEDS_PROMOTION_PROOF/,'no journal: absence cannot be proven, no annul');
 assert.equal(outbox.quarantineAnnullable(outbox.quarantine().entries[0]),false);
 assert.equal(await d.context.cerrarCaja(),false,'still waits for reconciliation');
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0,'amounts untouched');
 assert.equal(outbox.quarantine().entries[0].status,'QUARANTINED','record kept');
});

test('annul needs verify proving absence first, never applies to conflicts, and keeps the record',async t=>{
 const {f,d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create'))return Response.json({error:'product_not_found'},{status:409});});
 await outbox.enqueue(build(cash('V-089')));
 const [sale]=outbox.snapshot().intents;
 await outbox.sync();
 await assert.rejects(outbox.resolveQuarantined(sale.operation_id,'archive'),/QUARANTINE_VERIFY_FIRST/);
 await outbox.resolveQuarantined(sale.operation_id,'verify');
 const done=await outbox.resolveQuarantined(sale.operation_id,'archive');
 assert.equal(done.status,'ARCHIVED_NO_CHARGE');
 assert.equal(outbox.quarantine().entries.length,1,'never deleted');
 assert.equal(await d.context.cerrarCaja(),true);
 const raw=JSON.parse(d.localStorage.getItem(QKEY));
 raw.entries.push({...raw.entries[0],intent:{...raw.entries[0].intent,operation_id:'op-conflict',sale_id:'V-090'},reason:'operation_id_conflict',status:'QUARANTINED'});
 d.localStorage.setItem(QKEY,JSON.stringify(raw));
 await assert.rejects(outbox.resolveQuarantined('op-conflict','archive'),/QUARANTINE_CONFLICT_NEEDS_SERVER_CHECK/);
 await assert.rejects(outbox.resolveQuarantined('op-conflict','retry'),/QUARANTINE_RETRY_NOT_SAFE/);
});

test('crash after the quarantine copy finishes the move on next sync without a second POST',async t=>{
 let posts=0;
 const {d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create')){posts++;return Response.json({error:'product_not_found'},{status:409});}});
 await outbox.enqueue(build(cash('V-091')));
 const [sale]=outbox.snapshot().intents;
 d.localStorage.setItem(QKEY,JSON.stringify({version:1,entries:[{intent:sale,reason:'product_not_found',status:'QUARANTINED',journal:null,quarantined_at:'x'}]}));
 assert.equal((await outbox.sync()).status,'EMPTY');
 assert.equal(posts,0);
 assert.equal(outbox.quarantine().entries.length,1);
});

// TEST OBSOLETE (old design kept cash/unknown 409 in the main queue, which froze
// every later sale). New invariant: definitive cash/unknown rejections move to the
// durable review list, cash ones are never annullable, and close stays blocked.
for (const [status,error] of [[409,'cash_session_closed'],[409,'cash_session_required'],[409,'some_unknown_reason']]) {
 test(`cash/unknown ${status} ${error}: sales go to the durable review list, never annullable when cash, close blocked`,async t=>{
  const {f,d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create'))return Response.json({error},{status});});
  for (const id of ['V-085','V-086','V-087']) await outbox.enqueue(build(cash(id)));
  const before=outbox.snapshot().intents.map(x=>x.operation_id);
  await outbox.sync(); await outbox.sync();
  assert.equal(outbox.snapshot().intents.length,0);
  assert.deepEqual([...outbox.quarantine().entries.map(x=>x.intent.operation_id)],[...before]);
  assert.ok(outbox.quarantine().entries.every(x=>x.reason===error));
  if (error.startsWith('cash_session')) {
   assert.equal(outbox.quarantineAnnullable(outbox.quarantine().entries[0]),false);
   await assert.rejects(outbox.resolveQuarantined(before[0],'archive'),/QUARANTINE_CHARGED_SALE_NOT_ANNULLABLE/);
   assert.equal(outbox.quarantineRebindsOnRetry(outbox.quarantine().entries[0].reason),true);
  }
  d.el('cajContado').value='1074.50';
  assert.equal(await d.context.cerrarCaja(),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
 });
}
for (const [status,error] of [[401,'unauthorized'],[403,'session_revoked'],[403,'read_only_session'],[409,'canonical_not_active'],[409,'stale_authority']]) {
 test(`system ${status} ${error}: nothing goes to quarantine, the whole queue stays, close blocked`,async t=>{
  const {f,d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create'))return Response.json({error},{status});});
  for (const id of ['V-085','V-086','V-087']) await outbox.enqueue(build(cash(id)));
  const before=outbox.snapshot().intents.map(x=>x.operation_id);
  await outbox.sync(); await outbox.sync();
  assert.deepEqual(outbox.snapshot().intents.map(x=>x.operation_id),before);
  assert.equal(outbox.quarantine().entries.length,0);
  assert.equal(await d.context.cerrarCaja(),false);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
 });
}

test('operation_id_conflict for a sale the server already has settles once by remote proof, never duplicated',async t=>{
 let reject=true;
 const {f,d,outbox,build}=await setup(t,async (url,options,run)=>{if(url.endsWith('/commands/sale.create')&&reject){reject=false;await run();return Response.json({error:'operation_id_conflict'},{status:409});}});
 await outbox.enqueue(build(cash('V-092')));
 const [sale]=outbox.snapshot().intents;
 const out=await outbox.sync();
 assert.equal(out.status,'DRAINED');
 assert.equal(outbox.quarantine().entries.length,0,'proven on server: nothing to review');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',sale.operation_id).n,1);
 d.el('cajContado').value='1074.50';
 assert.equal(await d.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',sale.operation_id).n,1,'never duplicated');
});
