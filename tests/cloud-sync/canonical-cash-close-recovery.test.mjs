import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
async function fixture(t,options={}) {
 const f=await activeCanon(t);
 f.env.DB=tursoSqlite(f.database).adapter;
 const first=await device(f,{token:'close-a',deviceId:'close-a',scripts:[['cash-bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;},...options.globals},onFetch:options.onFetch});
 await first.api.openCash({session_id:'close-session',opening_cents:107250});
 await first.api.refresh();
 first.el('cajContado').value='1100';
 const second=await device(f,{token:'close-b',deviceId:'close-b'});
 return {f,first,second};
}
test('close reconciles a stale session and archives the rejected intent before exactly one closure',async t=>{
 const {f,first,second}=await fixture(t);
 await second.api.createAdjustment({amount_cents:100,reason:'Synthetic concurrent movement'});
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 const closed=f.sql('SELECT * FROM canonical_cash_closures');
 assert.equal(closed.expected_cents,107350);
 assert.equal(closed.counted_cents,110000);
 assert.equal(closed.difference_cents,2650);
 assert.equal(first.api.pendingSnapshot(),null);
 const archive=JSON.parse(first.localStorage.getItem('na_canonical_cash_close_rejections'));
 assert.equal(archive.length,1);
 assert.equal(archive[0].last_error,'stale_session');
});
test('an existing rejected closure survives reload and recovers using the same cash session',async t=>{
 const {f,first,second}=await fixture(t);
 await second.api.createAdjustment({amount_cents:100,reason:'Synthetic concurrent movement'});
 await assert.rejects(first.api.closeCash({counted_cents:110000}),/REJECTED_409/);
 const reloaded=await device(f,{token:'close-a',localStorage:first.localStorage,scripts:[['cash-bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;}}});
 reloaded.el('cajContado').value='1100';
 assert.equal(await reloaded.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 assert.equal(reloaded.api.pendingSnapshot(),null);
});
test('lost closure ACK replays the original operation without using a changed counted amount',async t=>{
 let lose=true;
 const {f,first}=await fixture(t,{onFetch:async(url,options,run)=>{
  if(url.endsWith('/commands/cash.close')&&lose){lose=false;await run();throw Error('lost ACK');}
 }});
 await assert.rejects(first.api.closeCash({counted_cents:110000}),/PENDING/);
 const operationId=first.api.pendingSnapshot().payload.operation_id;
 first.el('cajContado').value='9999';
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 assert.equal(f.sql('SELECT counted_cents n FROM canonical_cash_closures').n,110000);
 assert.equal(first.api.receiptSnapshot().operation_id,operationId);
});
test('foreign financial pending stays intact and prevents cash closure',async t=>{
 const {f,first}=await fixture(t,{onFetch:async(url,options,run)=>{
  if(url.endsWith('/commands/adjustment.create'))throw Error('transport unavailable');
 }});
 await assert.rejects(first.api.createAdjustment({amount_cents:100,reason:'Synthetic pending adjustment'}),/PENDING/);
 const before=JSON.stringify(first.api.pendingSnapshot());
 assert.equal(await first.context.cerrarCaja(),false);
 assert.equal(JSON.stringify(first.api.pendingSnapshot()),before);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
 assert.match(first.el('cajCloseStatus').textContent,/adjustment\.create/);
 assert.match(first.el('cajCloseStatus').textContent,/pendiente/i);
});
test('cash closure confirms an uncertain adjustment with its exact original operation before closing',async t=>{
 let unavailable=true;
 const {f,first}=await fixture(t,{onFetch:async(url)=>{
  if(url.endsWith('/commands/adjustment.create')&&unavailable)throw Error('temporary transport failure');
 }});
 await assert.rejects(first.api.createAdjustment({amount_cents:100,reason:'Synthetic pending adjustment'}),/PENDING/);
 const original=first.api.pendingSnapshot().payload;
 unavailable=false;
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107350);
 const adjustmentPosts=first.fetchLog.filter(x=>x.url.endsWith('/commands/adjustment.create'));
 assert.equal(adjustmentPosts.length,2);
 assert.deepEqual(JSON.parse(adjustmentPosts[1].body),JSON.parse(JSON.stringify(original)));
 assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='ADJUSTMENT'").n,1);
});
test('cash closure replays a lost adjustment ACK without duplicating its cash effect',async t=>{
 let lose=true;
 const {f,first}=await fixture(t,{onFetch:async(url,options,run)=>{
  if(url.endsWith('/commands/adjustment.create')&&lose){lose=false;await run();throw Error('lost ACK');}
 }});
 await assert.rejects(first.api.createAdjustment({amount_cents:100,reason:'Synthetic committed adjustment'}),/PENDING/);
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='ADJUSTMENT'").n,1);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107350);
});
test('a definitive foreign rejection remains durable and displays its real reason inside the close form',async t=>{
 const {f,first,second}=await fixture(t);
 await second.api.createAdjustment({amount_cents:100,reason:'Synthetic competing adjustment'});
 await assert.rejects(first.api.createAdjustment({amount_cents:200,reason:'Synthetic rejected adjustment'}),/REJECTED_409/);
 const before=JSON.stringify(first.api.pendingSnapshot());
 assert.equal(await first.context.cerrarCaja(),false);
 assert.equal(JSON.stringify(first.api.pendingSnapshot()),before);
 assert.match(first.el('cajCloseStatus').textContent,/adjustment\.create.*409.*stale_session/);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
test('a previously committed cash payment with lost ACK is counted only once before closure',async t=>{
 let lose=true;
 const {f,first}=await fixture(t,{onFetch:async(url,options,run)=>{
  if(url.endsWith('/commands/payment.create')&&lose){lose=false;await run();throw Error('lost payment ACK');}
 }});
 const credit=first.api.snapshot().credits.find(x=>x.current_balance_cents>=100);
 assert.ok(credit);
 await assert.rejects(first.api.createPayment({credit_id:credit.credit_id,amount_cents:100,payment_method:'efectivo'}),/PENDING/);
 const original=first.api.pendingSnapshot().payload;
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n,1);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107350);
 const posts=first.fetchLog.filter(x=>x.url.endsWith('/commands/payment.create'));
 assert.deepEqual(JSON.parse(posts[1].body),JSON.parse(JSON.stringify(original)));
});
test('an unresponsive pending movement times out without clearing it or closing the cash',async t=>{
 let hang=false;
 const {f,first}=await fixture(t,{globals:{setTimeout(fn,ms){return setTimeout(fn,Math.min(ms,100));}},onFetch:async(url)=>{
  if(url.endsWith('/commands/adjustment.create')&&hang)return new Promise(()=>{});
 }});
 hang=true;
 await assert.rejects(first.api.createAdjustment({amount_cents:100,reason:'Synthetic unresponsive movement'}),/PENDING/);
 const before=JSON.stringify(first.api.pendingSnapshot());
 assert.equal(await first.context.cerrarCaja(),false);
 assert.equal(JSON.stringify(first.api.pendingSnapshot()),before);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
 assert.match(first.el('cajCloseStatus').textContent,/adjustment\.create/);
});
test('cash remains open while unsynchronized sales cannot drain',async t=>{
 const {f,first}=await fixture(t,{globals:{NuevoAmanecerCanonicalSaleOutbox:{snapshot(){return {intents:[{operation_id:'unsent-sale'}]};},async sync(){return {status:'WAITING',remaining:1};}}}});
 assert.equal(await first.context.cerrarCaja(),false);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
test('a rejected old closure never closes a replacement session opened by another device',async t=>{
 const {f,first,second}=await fixture(t);
 await second.api.closeCash({counted_cents:107250});
 await second.api.openCash({session_id:'replacement-session',opening_cents:1000});
 await assert.rejects(first.api.closeCash({counted_cents:110000}),/REJECTED_409/);
 await first.api.refresh();
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
 assert.equal(f.sql("SELECT status FROM canonical_cash_state WHERE session_id='replacement-session'").status,'OPEN');
 assert.equal(first.api.pendingSnapshot(),null);
});
test('archive storage failure retains the rejected intent and leaves cash open',async t=>{
 const {f,first,second}=await fixture(t);
 await second.api.createAdjustment({amount_cents:100,reason:'Synthetic concurrent movement'});
 await assert.rejects(first.api.closeCash({counted_cents:110000}),/REJECTED_409/);
 const before=JSON.stringify(first.api.pendingSnapshot());
 const write=first.localStorage.setItem;
 first.localStorage.setItem=(key,value)=>{if(key==='na_canonical_cash_close_rejections')throw Error('quota exceeded');write(key,value);};
 assert.equal(await first.context.cerrarCaja(),false);
 assert.equal(JSON.stringify(first.api.pendingSnapshot()),before);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
test('an uncertain 503 never archives or replaces the pending close operation',async t=>{
 let unavailable=true;
 const {f,first}=await fixture(t,{onFetch:async(url)=>{
  if(url.endsWith('/commands/cash.close')&&unavailable)return Response.json({error:'financial_storage_error'},{status:503});
 }});
 await assert.rejects(first.api.closeCash({counted_cents:110000}),/REJECTED_503/);
 const before=JSON.stringify(first.api.pendingSnapshot());
 assert.equal(await first.context.cerrarCaja(),false);
 assert.equal(JSON.stringify(first.api.pendingSnapshot()),before);
 assert.equal(first.localStorage.getItem('na_canonical_cash_close_rejections'),null);
 unavailable=false;
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
});
test('cash closure holds the sale outbox store lock until acknowledgement, preventing a new stranded local sale',async t=>{
 let entered,release;
 const closing=new Promise(resolve=>{entered=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 const outboxSource=readFileSync('POS/js/sync/canonical-sale-outbox.js','utf8');
 const intentSource=readFileSync('POS/js/sync/canonical-sale-intent.js','utf8');
 const f=await activeCanon(t);
 f.env.DB=tursoSqlite(f.database).adapter;
 const locks=new Set();
 const first=await device(f,{token:'race-close',deviceId:'race-close',scripts:[['intent',intentSource],['outbox',outboxSource],['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;},navigator:{onLine:true,locks:{async request(name,options,fn){if(locks.has(name))return fn(null);locks.add(name);try{return await fn({name});}finally{locks.delete(name);}}}}},onFetch:async(url,options,run)=>{
  if(url.endsWith('/commands/cash.close')){entered();await gate;return run();}
 }});
 await first.api.openCash({session_id:'race-session',opening_cents:1000});
 first.el('cajContado').value='10';
 const promise=first.context.cerrarCaja();
 await closing;
 try {
  const intent=first.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-001',payment_method:'efectivo',items:[{product_id:'00001',quantity:1,precio:2}]});
  await assert.rejects(first.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(intent),/BUSY/);
 } finally {release();await promise;}
 assert.equal(first.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,1);
});
test('a real queued sale drains before closure and its cash appears in the final reconciliation',async t=>{
 const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql']});
 f.env.DB=tursoSqlite(f.database).adapter;
 const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(name=>[name,readFileSync('POS/js/sync/'+name+'.js','utf8')]);
 const first=await device(f,{token:'drain-close',deviceId:'drain-close',scripts:[...scripts,['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;}}});
 await first.api.openCash({session_id:'drain-session',opening_cents:107250});
 const intent=first.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-090',payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]});
 await first.context.NuevoAmanecerCanonicalSaleOutbox.enqueue(intent);
 first.el('cajContado').value='1100';
 assert.equal(await first.context.cerrarCaja(),true);
 assert.equal(first.context.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents.length,0);
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,1);
 assert.equal(f.sql('SELECT expected_cents n FROM canonical_cash_closures').n,107450);
 assert.equal(f.sql('SELECT difference_cents n FROM canonical_cash_closures').n,2550);
});
