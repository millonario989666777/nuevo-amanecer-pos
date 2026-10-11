// CANON (owner incident, PR #518): a cash session opened on a previous day must
// be recoverable. Covers: server CLOSED with a stale local replica, yesterday's
// OPEN session with pending sales, a pending cash.close journal, and a
// quarantined sale (durable quarantine store model, PR C). "Yesterday" is real server data: opened_at is backdated in
// the in-memory test DB only (immutability trigger dropped and restored).
// The UI gates mirror inline-11.js:104 ("Caja de otro día") and
// inline-02.js:114 (_naSessionOpen, used by canonical-sale-integration.js:202).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(n=>[n,readFileSync('POS/js/sync/'+n+'.js','utf8')]);
const MIGRATIONS=['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql'];
const NO_UPDATE="CREATE TRIGGER cash_sessions_no_update BEFORE UPDATE ON canonical_cash_sessions BEGIN SELECT RAISE(ABORT,'immutable_financial_history'); END;";
// Same as POS/js/core/utils.js obtenerHoy.
function obtenerHoy(){const a=new Date();return new Date(a.getTime()-a.getTimezoneOffset()*60000).toISOString().split('T')[0];}
function yesterdayIso(){const y=new Date();y.setDate(y.getDate()-1);y.setHours(12,0,0,0);return y.toISOString();}
function backdate(f,sessionId){
 f.database.exec('DROP TRIGGER cash_sessions_no_update');
 f.database.prepare('UPDATE canonical_cash_sessions SET opened_at=? WHERE session_id=?').run(yesterdayIso(),sessionId);
 f.database.exec(NO_UPDATE);
}
function ui(d){
 const c=d.api.legacySnapshot().cashState,hoy=obtenerHoy();
 return {state:c,otroDia:!!(c.abierta&&!c.cerrada&&c.fechaApertura&&c.fechaApertura!==hoy),sessionOpen:!!(c.abierta&&!c.cerrada&&c.fechaApertura===hoy)};
}
function posts(d,command){return d.fetchLog.filter(x=>x.method==='POST'&&x.url.endsWith('/commands/'+command));}
const all=(f,q,...p)=>f.database.prepare(q).all(...p);
async function dev(f,token,onFetch,localStorage){
 const d=await device(f,{token,deviceId:localStorage?undefined:token,localStorage,scripts:[...scripts,['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;}},onFetch});
 d.context._naSessionOpen=()=>ui(d).sessionOpen;
 d.context.obtenerHoy=obtenerHoy;
 return {d,outbox:d.context.NuevoAmanecerCanonicalSaleOutbox,build:x=>d.context.NuevoAmanecerCanonicalSaleIntent.build(x)};
}
async function yesterdaySession(t,onFetch,sessionId='prev-session',extraMigrations=[]){
 const f=await activeCanon(t,{migrations:[...MIGRATIONS,...extraMigrations]});
 f.env.DB=tursoSqlite(f.database).adapter;
 const a=await dev(f,'prev-a',onFetch);
 await a.d.api.openCash({session_id:sessionId,opening_cents:107250});
 backdate(f,sessionId);
 await a.d.api.refresh();
 const u=ui(a.d);
 assert.equal(u.state.sessionId,sessionId);
 assert.equal(u.otroDia,true,'precondition: UI shows "Caja de otro día"');
 assert.equal(u.sessionOpen,false,'precondition: _naSessionOpen() false for yesterday');
 a.d.el('cajContado').value='1100';
 return {f,...a};
}
const cashSale=(id)=>({sale_id:id,payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]});
const creditSale=(id)=>({sale_id:id,payment_method:'credito',customer_id:'000C',credit_due:'2026-11-30',items:[{product_id:'00000',quantity:1,precio:3}]});

test('1. server CLOSED + stale replica of yesterday: refresh clears "otro día" without any cash.close POST',async t=>{
 const {f,d}=await yesterdaySession(t);
 const b=await dev(f,'prev-b');
 await b.d.api.closeCash({counted_cents:107250});
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 assert.equal(ui(d).otroDia,true,'stale replica still shows yesterday OPEN (owner symptom)');
 await d.api.refresh();
 const u=ui(d);
 assert.equal(u.state.cerrada,true);
 assert.equal(u.otroDia,false);
 assert.equal(u.state.sessionId,'prev-session');
 assert.equal(posts(d,'cash.close').length,0);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 assert.equal(f.sql("SELECT expected_cents n FROM canonical_cash_closures WHERE session_id='prev-session'").n,107250);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
});

test('1b. server CLOSED + stale replica: pressing "Cerrar caja" first adds no closure and leaves the UI cerrada',async t=>{
 const {f,d}=await yesterdaySession(t);
 const b=await dev(f,'prev-b');
 await b.d.api.closeCash({counted_cents:107250});
 const result=await d.context.cerrarCaja();
 const text=d.el('cajCloseStatus').textContent;
 assert.equal(result,true,'expected "ya estaba cerrada" outcome; got cajCloseStatus='+JSON.stringify(text));
 assert.ok(d.context.__toasts.some(([m])=>/ya estaba cerrada/.test(m)));
 // The stale replica produces ONE guarded POST that the Worker rejects by CAS
 // (409 stale_session); it is archived, never retried, never a 2nd closure.
 assert.ok(posts(d,'cash.close').length<=1);
 const archive=JSON.parse(d.localStorage.getItem('na_canonical_cash_close_rejections')||'[]');
 assert.equal(archive.length,posts(d,'cash.close').length);
 if(archive.length)assert.equal(archive[0].last_error,'stale_session');
 assert.equal(d.api.pendingSnapshot(),null);
 const c=all(f,'SELECT * FROM canonical_cash_closures');
 assert.equal(c.length,1);
 assert.equal(c[0].counted_cents,107250,'closure of device B unchanged');
 assert.equal(ui(d).otroDia,false);
 assert.equal(ui(d).state.cerrada,true);
});

test('2. yesterday OPEN + 2 pending sales: close drains same operation_ids, closes the SAME session, then today works',async t=>{
 let offline=true;
 const {f,d,outbox,build}=await yesterdaySession(t,async url=>{if(offline&&url.endsWith('/commands/sale.create'))throw Error('offline');});
 await outbox.enqueue(build(cashSale('V-085')));
 await outbox.enqueue(build(creditSale('V-086')));
 const queued=JSON.parse(JSON.stringify(outbox.snapshot().intents.map(x=>({sale_id:x.sale_id,operation_id:x.operation_id}))));
 assert.equal(queued.length,2);
 await outbox.sync();
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0,'precondition: nothing reached D1 while offline');
 offline=false;
 assert.equal(await d.context.cerrarCaja(),true,d.el('cajCloseStatus').textContent);
 assert.equal(outbox.snapshot().intents.length,0);
 for(const q of queued){
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',q.operation_id).n,1,q.sale_id);
  assert.equal(f.sql('SELECT sale_id s FROM sales WHERE operation_id=?',q.operation_id).s,q.sale_id);
 }
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,2);
 assert.equal(f.sql("SELECT total_cents n FROM sales WHERE sale_id='V-085'").n,200);
 assert.equal(f.sql("SELECT total_cents n FROM sales WHERE sale_id='V-086'").n,300);
 const sentOps=posts(d,'sale.create').map(p=>JSON.parse(p.body).operation_id);
 assert.deepEqual([...new Set(sentOps)].sort(),queued.map(q=>q.operation_id).sort(),'only the original operation_ids are POSTed');
 const closures=all(f,'SELECT * FROM canonical_cash_closures');
 assert.equal(closures.length,1);
 assert.equal(closures[0].session_id,'prev-session');
 assert.equal(closures[0].expected_cents,107250+200,'credit sale does not change expected cash');
 assert.equal(closures[0].counted_cents,110000);
 assert.equal(posts(d,'cash.close').length,1);
 await d.api.refresh();
 assert.equal(ui(d).otroDia,false);
 assert.equal(ui(d).state.cerrada,true);
 // Today: open a new session and sell.
 await d.api.openCash({session_id:'today-session',opening_cents:5000});
 assert.equal(ui(d).sessionOpen,true,'_naSessionOpen() true for today');
 const today=await outbox.enqueue(build(cashSale('V-087')));
 const r=await outbox.sync();
 assert.equal(r.status,'DRAINED',JSON.stringify(r));
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',today.operation_id).n,1);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,3);
 await d.api.refresh();
 assert.equal(d.api.snapshot().cashSessions.find(s=>s.session_id==='today-session').expected_cents,5000+200);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
});

for(const mode of ['lost-ack','503']){
 test(`3. yesterday OPEN + pending cash.close (${mode}): retry reuses the SAME close operation_id, 1 closure`,async t=>{
  let fail=true;
  const {f,d}=await yesterdaySession(t,async(url,o,run)=>{
   if(fail&&url.endsWith('/commands/cash.close')){fail=false;
    if(mode==='lost-ack'){await run();throw Error('lost ACK');}
    return Response.json({error:'financial_storage_error'},{status:503});}
  });
  assert.equal(await d.context.cerrarCaja(),false);
  const pending=d.api.pendingSnapshot();
  assert.equal(pending.command,'cash.close');
  assert.equal(pending.payload.session_id,'prev-session');
  const op=pending.payload.operation_id;
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,mode==='lost-ack'?1:0);
  d.el('cajContado').value='9999';
  assert.equal(await d.context.cerrarCaja(),true,d.el('cajCloseStatus').textContent);
  const ops=posts(d,'cash.close').map(p=>JSON.parse(p.body).operation_id);
  assert.equal(ops.length,2);
  assert.deepEqual(ops,[op,op]);
  const c=all(f,'SELECT * FROM canonical_cash_closures');
  assert.equal(c.length,1);
  assert.equal(c[0].session_id,'prev-session');
  assert.equal(c[0].close_operation_id,op);
  assert.equal(c[0].counted_cents,110000,'replay keeps the original counted amount');
  assert.equal(c[0].expected_cents,107250);
  assert.equal(d.api.pendingSnapshot(),null);
  await d.api.refresh();
  assert.equal(ui(d).otroDia,false);
 });
}

const plain=x=>JSON.parse(JSON.stringify(x));
const salesByOp=(f,op)=>f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?',op).n;
async function quarantined(t){
 const ctx=await yesterdaySession(t,async(url,o)=>{
  if(url.endsWith('/commands/sale.create')&&JSON.parse(o.body).sale_id==='V-085')return Response.json({error:'product_not_found'},{status:409});
 });
 const intent=plain(await ctx.outbox.enqueue(ctx.build(cashSale('V-085'))));
 await ctx.outbox.sync();
 return {...ctx,intent};
}
test('4a. yesterday OPEN + 409 product_not_found: sale moves to the quarantine store (kept), close blocked naming sale_id',async t=>{
 const {f,d,outbox,intent}=await quarantined(t);
 const q=plain(outbox.quarantine()).entries;
 assert.equal(q.length,1);
 assert.equal(q[0].status,'QUARANTINED');
 assert.equal(q[0].reason,'product_not_found');
 assert.equal(q[0].intent.sale_id,'V-085');
 assert.equal(q[0].intent.operation_id,intent.operation_id);
 assert.equal(q[0].intent.total_cents,200);
 assert.ok(q[0].journal&&q[0].journal.payload.operation_id===intent.operation_id,'journal copy kept');
 assert.equal(outbox.snapshot().intents.length,0,'FIFO freed');
 assert.equal(d.api.pendingSnapshot(),null,'journal freed after durable copy');
 assert.equal(await d.context.cerrarCaja(),false);
 const text=d.el('cajCloseStatus').textContent;
 assert.ok(text.includes('Venta bloqueante: V-085'),'cajCloseStatus='+JSON.stringify(text));
 assert.match(text,/product_not_found/);
 assert.match(text,/No la cobres de nuevo/);
 assert.equal(posts(d,'cash.close').length,0);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
 assert.equal(new Set(posts(d,'sale.create').map(p=>JSON.parse(p.body).operation_id)).size,1);
 assert.equal(outbox.quarantineRetryable('product_not_found'),true,'recorded: Reintentar offered for product_not_found');
});
test('4b. quarantine does not block new sales; Verificar -> Anular -> close SAME yesterday session -> open today -> sell today',async t=>{
 const {f,d,outbox,build,intent}=await quarantined(t);
 // A new sale is NOT blocked by the quarantined head (outbox level).
 const next=plain(await outbox.enqueue(build(cashSale('V-086'))));
 assert.notEqual(next.sale_id,'V-085');
 const r=plain(await outbox.sync());
 assert.equal(r.status,'DRAINED',JSON.stringify(r));
 assert.equal(salesByOp(f,next.operation_id),1);
 // Anular is impossible before a server verification.
 await assert.rejects(outbox.resolveQuarantined(intent.operation_id,'archive'),/QUARANTINE_VERIFY_FIRST/);
 const v=plain(await outbox.resolveQuarantined(intent.operation_id,'verify'));
 assert.equal(v.status,'NOT_REGISTERED');
 const a=plain(await outbox.resolveQuarantined(intent.operation_id,'archive'));
 assert.equal(a.status,'ARCHIVED_NO_CHARGE');
 const q=plain(outbox.quarantine()).entries;
 assert.equal(q.length,1,'record preserved, never deleted');
 assert.equal(q[0].status,'ARCHIVED_NO_CHARGE');
 assert.equal(q[0].intent.operation_id,intent.operation_id);
 assert.ok(q[0].verified_absent_at);
 assert.equal(salesByOp(f,intent.operation_id),0,'annulled sale never reaches D1');
 // Close yesterday's same session; the annulled sale adds nothing.
 assert.equal(await d.context.cerrarCaja(),true,d.el('cajCloseStatus').textContent);
 const c=all(f,'SELECT * FROM canonical_cash_closures');
 assert.equal(c.length,1);
 assert.equal(c[0].session_id,'prev-session');
 assert.equal(c[0].expected_cents,107250+200,'only V-086 cash');
 assert.equal(posts(d,'cash.close').length,1);
 await d.api.refresh();
 assert.equal(ui(d).otroDia,false);
 await d.api.openCash({session_id:'today-session',opening_cents:5000});
 assert.equal(ui(d).sessionOpen,true);
 const today=plain(await outbox.enqueue(build(cashSale('V-087'))));
 assert.equal((await outbox.sync()).status,'DRAINED');
 for(const op of [next.operation_id,today.operation_id])assert.equal(salesByOp(f,op),1);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,2);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE sale_id=?','V-085').n,0);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
});
async function drain(outbox,n=4){let r;for(let i=0;i<n;i++){r=plain(await outbox.sync());if(r.status==='DRAINED'||r.status==='EMPTY')break;}return r;}
test('4c. sale already in D1 (lost ACK, then operation_id_conflict): reconciled, never annulled, no duplicate',async t=>{
 let step=0;let f0;
 const ctx=await yesterdaySession(t,async(url,o,run)=>{
  if(!url.endsWith('/commands/sale.create'))return;
  step+=1;
  if(step===1){await run();throw Error('lost ACK');}
  if(step===2)return Response.json({error:'operation_id_conflict'},{status:409});
 });
 const {f,d,outbox,build}=ctx;f0=f;
 const intent=plain(await outbox.enqueue(build(cashSale('V-085'))));
 await drain(outbox);
 assert.equal(salesByOp(f,intent.operation_id),1);
 const q=plain(outbox.quarantine()).entries.filter(e=>e.status==='QUARANTINED');
 assert.equal(q.length,0,'auto-reconciled by remote proof (same sale_id+operation_id): never reaches the quarantine store');
 assert.equal(plain(outbox.quarantine()).entries.filter(e=>e.status==='QUARANTINED'||e.status==='ARCHIVED_NO_CHARGE').length,0);
 assert.equal(outbox.snapshot().intents.length,0);
 assert.equal(await d.context.cerrarCaja(),true,d.el('cajCloseStatus').textContent);
 assert.equal(salesByOp(f,intent.operation_id),1);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107250+200);
 void f0;
});
test('4c-bis. same operation_id already in D1 under ANOTHER sale_id: Verificar -> CONFIRMED_REMOTE(remote_sale_id), Anular refused, no duplicate',async t=>{
 let step=0,fx;
 const ctx=await yesterdaySession(t,async(url,o,run)=>{
  if(!url.endsWith('/commands/sale.create'))return;
  step+=1;
  if(step===1){const body=JSON.parse(o.body);body.sale_id='V-900';await fx.fetch(url,{...o,body:JSON.stringify(body)});throw Error('lost ACK');}
 });
 const {f,d,outbox,build}=ctx;fx=f;
 const intent=plain(await outbox.enqueue(build(cashSale('V-085'))));
 const r=await drain(outbox);
 assert.equal(salesByOp(f,intent.operation_id),1,'committed once under V-900');
 assert.equal(f.sql('SELECT sale_id s FROM sales WHERE operation_id=?',intent.operation_id).s,'V-900');
 const q=plain(outbox.quarantine()).entries;
 assert.equal(q.length,1,'quarantined: '+JSON.stringify(r));
 assert.equal(q[0].status,'QUARANTINED');
 assert.equal(q[0].reason,'operation_id_conflict');
 await assert.rejects(outbox.resolveQuarantined(intent.operation_id,'archive'),/QUARANTINE_CONFLICT_NEEDS_SERVER_CHECK|QUARANTINE_OPERATION_EXISTS_ON_SERVER/);
 const v=plain(await outbox.resolveQuarantined(intent.operation_id,'verify'));
 assert.equal(v.status,'CONFIRMED_REMOTE');
 assert.equal(v.remote_sale_id,'V-900');
 await assert.rejects(outbox.resolveQuarantined(intent.operation_id,'archive'),/QUARANTINE_ENTRY_NOT_FOUND/);
 const after=plain(outbox.quarantine()).entries;
 assert.equal(after.length,1);
 assert.equal(after[0].status,'CONFIRMED_REMOTE');
 assert.equal(after[0].remote_sale_id,'V-900');
 assert.equal(await d.context.cerrarCaja(),true,d.el('cajCloseStatus').textContent);
 assert.equal(salesByOp(f,intent.operation_id),1);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107250+200,'cash counted once');
});

// ---- Anular guards (audit d2b710b) ----
// Device A's replica hides customer 000C (pre-POST INVALID_CANONICAL_CUSTOMER ->
// quarantine entry WITHOUT journal) and optionally hides chosen sales rows
// (emulates a replica that cannot see a sale, e.g. one committed under another
// promotion: /read/canonical/sales filters by the ACTIVE promotion).
async function noJournalQuarantine(t,{failReads}={}){
 const hide={customer:true,ops:new Set(),reads:false};
 const ctx=await yesterdaySession(t,async(url,o,run)=>{
  if(hide.reads&&url.includes('/read/canonical/'))throw Error('offline read');
  const filter=hide.customer&&url.includes('/read/canonical/customers')?(j=>{j.items=j.items.filter(c=>c.customer_id!=='000C');}):
   url.includes('/read/canonical/sales?')&&hide.ops.size?(j=>{j.items=j.items.filter(s=>!hide.ops.has(s.operation_id));}):null;
  if(!filter)return;
  const r=await run(),j=await r.json();filter(j);return Response.json(j,{status:r.status});
 });
 await ctx.d.api.refresh();
 const intent=plain(await ctx.outbox.enqueue(ctx.build(creditSale('V-085'))));
 await drain(ctx.outbox,2);
 const q=plain(ctx.outbox.quarantine()).entries;
 assert.equal(q.length,1,'precondition: quarantined');
 assert.equal(q[0].reason,'INVALID_CANONICAL_CUSTOMER');
 assert.equal(q[0].journal,null,'precondition: entry has NO journal');
 assert.equal(posts(ctx.d,'sale.create').length,0,'precondition: never POSTed');
 const b=await dev(ctx.f,'prev-b');
 return {...ctx,intent,hide,b};
}
test('5a. entry WITHOUT journal, verified absent, then the operation_id appears in D1 (same sale_id): Anular refuses',async t=>{
 const {f,outbox,intent,b}=await noJournalQuarantine(t);
 assert.equal((await outbox.resolveQuarantined(intent.operation_id,'verify')).status,'NOT_REGISTERED');
 await b.d.api.createSale(intent);
 assert.equal(salesByOp(f,intent.operation_id),1);
 const a=plain(await outbox.resolveQuarantined(intent.operation_id,'archive').catch(e=>({error:e.message})));
 assert.notEqual(a.status,'ARCHIVED_NO_CHARGE',JSON.stringify(a));
 assert.equal(plain(outbox.quarantine()).entries[0].status==='ARCHIVED_NO_CHARGE',false);
});
test('5b. entry WITHOUT journal, op in D1 under ANOTHER sale_id: Anular refuses',async t=>{
 const {f,outbox,intent,b}=await noJournalQuarantine(t);
 assert.equal((await outbox.resolveQuarantined(intent.operation_id,'verify')).status,'NOT_REGISTERED');
 await b.d.api.createSale({...intent,sale_id:'V-901'});
 assert.equal(f.sql('SELECT sale_id s FROM sales WHERE operation_id=?',intent.operation_id).s,'V-901');
 await assert.rejects(outbox.resolveQuarantined(intent.operation_id,'archive'),/QUARANTINE_OPERATION_EXISTS_ON_SERVER|QUARANTINE_ANNUL_NEEDS_PROMOTION_PROOF/);
 assert.equal(plain(outbox.quarantine()).entries[0].status,'QUARANTINED');
});
test('5c. entry WITHOUT journal, verified absent, op later in D1 but the fresh read FAILS: Anular refuses (no stale proof)',async t=>{
 const {f,outbox,intent,b,hide}=await noJournalQuarantine(t);
 assert.equal((await outbox.resolveQuarantined(intent.operation_id,'verify')).status,'NOT_REGISTERED');
 await b.d.api.createSale(intent);
 hide.reads=true;
 await assert.rejects(outbox.resolveQuarantined(intent.operation_id,'archive'),/QUARANTINE_REMOTE_NOT_VERIFIED|QUARANTINE_ANNUL_NEEDS_PROMOTION_PROOF/);
 assert.equal(plain(outbox.quarantine()).entries[0].status,'QUARANTINED');
 assert.equal(salesByOp(f,intent.operation_id),1);
});
// Journaled entry (409 product_not_found mocked: nothing reached D1 from A).
async function journalQuarantine(t){
 const hide={ops:new Set(),reads:false};
 const ctx=await yesterdaySession(t,async(url,o,run)=>{
  if(hide.reads&&url.includes('/read/canonical/'))throw Error('offline read');
  if(url.endsWith('/commands/sale.create'))return Response.json({error:'product_not_found'},{status:409});
  if(url.includes('/read/canonical/sales?')&&hide.ops.size){const r=await run(),j=await r.json();j.items=j.items.filter(s=>!hide.ops.has(s.operation_id));return Response.json(j,{status:r.status});}
 });
 const intent=plain(await ctx.outbox.enqueue(ctx.build(cashSale('V-085'))));
 await ctx.outbox.sync();
 const q=plain(ctx.outbox.quarantine()).entries;
 assert.equal(q.length,1);assert.ok(q[0].journal,'precondition: entry has a journal');
 assert.equal(q[0].journal.binding.promotion_id,ctx.d.api.snapshot().promotion_id);
 return {...ctx,intent,hide,b:await dev(ctx.f,'prev-b')};
}
test('5d. journaled entry, verified absent, op later in D1 but the fresh read FAILS: Anular refuses (QUARANTINE_REMOTE_NOT_VERIFIED)',async t=>{
 const {f,outbox,intent,b,hide}=await journalQuarantine(t);
 assert.equal(outbox.quarantineAnnullable(plain(outbox.quarantine()).entries[0]),true);
 assert.equal((await outbox.resolveQuarantined(intent.operation_id,'verify')).status,'NOT_REGISTERED');
 await b.d.api.createSale(intent);
 hide.reads=true;
 await assert.rejects(outbox.resolveQuarantined(intent.operation_id,'archive'),/QUARANTINE_REMOTE_NOT_VERIFIED/);
 assert.equal(plain(outbox.quarantine()).entries[0].status,'QUARANTINED');
 assert.equal(salesByOp(f,intent.operation_id),1);
});
test('6. entry journaled under ANOTHER promotion, sale committed but invisible to the active replica: Anular refuses',async t=>{
 const {f,d,outbox,intent,b,hide}=await journalQuarantine(t);
 await b.d.api.createSale(intent);
 hide.ops.add(intent.operation_id); // the active promotion's replica does not list it
 const q=JSON.parse(d.localStorage.getItem(outbox.KEY+'_quarantine'));
 q.entries[0].journal.binding.promotion_id='a6-promotion-OLD';
 q.entries[0].journal.payload.promotion_id='a6-promotion-OLD';
 d.localStorage.setItem(outbox.KEY+'_quarantine',JSON.stringify(q));
 assert.equal(outbox.quarantineAnnullable(plain(outbox.quarantine()).entries[0]),false,'button hidden');
 const v=plain(await outbox.resolveQuarantined(intent.operation_id,'verify'));
 const a=plain(await outbox.resolveQuarantined(intent.operation_id,'archive').catch(e=>({error:e.message})));
 assert.equal(salesByOp(f,intent.operation_id),1,'sale IS in D1');
 assert.equal(a.error,'QUARANTINE_ANNUL_NEEDS_PROMOTION_PROOF','verify='+JSON.stringify(v)+' archive='+JSON.stringify(a));
 assert.equal(plain(outbox.quarantine()).entries[0].status,'QUARANTINED');
});
test('7. no-journal pre-POST credit failure (customer absent) -> customer created in CANON -> Reintentar -> 1 sale, same operation_id, entry resolved, close allowed',async t=>{
 const {f,d,outbox,build}=await yesterdaySession(t,undefined,'prev-session',['0017_canonical_live_customers.sql']);
 const intent=plain(await outbox.enqueue(build({...creditSale('V-085'),customer_id:'LIVE-CUST-NEW'})));
 await drain(outbox,2);
 let q=plain(outbox.quarantine()).entries;
 assert.equal(q.length,1);assert.equal(q[0].reason,'INVALID_CANONICAL_CUSTOMER');assert.equal(q[0].journal,null);
 assert.equal(posts(d,'sale.create').length,0);
 assert.equal(outbox.quarantineRetryable(q[0].reason),true,'Reintentar offered');
 assert.equal(outbox.quarantineAnnullable(q[0]),false,'Anular hidden (no journal)');
 assert.equal(await d.context.cerrarCaja(),false,'close blocked while unresolved');
 const b=await dev(f,'prev-b');
 const created=await b.d.api.createCustomer({customer_id:'LIVE-CUST-NEW',name:'Cliente nuevo',document:'99887766',phone:null,address:null,color:1});
 assert.equal(created.status,'created');
 assert.equal((await outbox.resolveQuarantined(intent.operation_id,'retry')).status,'REQUEUED');
 const r=await drain(outbox);
 assert.equal(r.status,'DRAINED',JSON.stringify(r));
 assert.equal(salesByOp(f,intent.operation_id),1);
 assert.equal(f.sql('SELECT sale_id s FROM sales WHERE operation_id=?',intent.operation_id).s,'V-085');
 assert.deepEqual([...new Set(posts(d,'sale.create').map(p=>JSON.parse(p.body).operation_id))],[intent.operation_id]);
 q=plain(outbox.quarantine()).entries;
 assert.equal(q.length,1,'record kept');
 assert.notEqual(q[0].status,'QUARANTINED');
 assert.equal(await d.context.cerrarCaja(),true,d.el('cajCloseStatus').textContent);
 const c=all(f,'SELECT * FROM canonical_cash_closures');
 assert.equal(c.length,1);assert.equal(c[0].session_id,'prev-session');
 assert.equal(c[0].expected_cents,107250,'credit sale adds no cash');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
});
