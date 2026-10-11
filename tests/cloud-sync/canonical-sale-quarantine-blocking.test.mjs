// CANON (Auditor condition 1): with a sale quarantined after a definitive 409,
// other financial commands fail closed with a clear code and lose nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
test('quarantined sale blocks payment, expense and close without losing any record',async t=>{
 const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql']});
 f.env.DB=tursoSqlite(f.database).adapter;
 const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(n=>[n,readFileSync('POS/js/sync/'+n+'.js','utf8')]);
 const d=await device(f,{token:'q-a',deviceId:'q-a',scripts:[...scripts,['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;}},onFetch:async(url)=>{
  if(url.endsWith('/commands/sale.create'))return Response.json({error:'product_not_found'},{status:409});
 }});
 await d.api.openCash({session_id:'q-session',opening_cents:107250});
 const outbox=d.context.NuevoAmanecerCanonicalSaleOutbox;
 await outbox.enqueue(d.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-085',payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]}));
 const out=await outbox.sync();
 assert.equal(out.status,'BLOCKED_PENDING_REJECTED');
 assert.equal(out.reason,'product_not_found');
 const queue=JSON.stringify(outbox.snapshot());
 const journal=JSON.stringify(d.api.pendingSnapshot());
 assert.equal(d.api.pendingSnapshot().last_error,'product_not_found');
 const before={sales:f.sql('SELECT COUNT(*) n FROM sales').n,events:f.sql('SELECT COUNT(*) n FROM canonical_financial_events').n};
 const credit=d.api.snapshot().credits.find(x=>x.current_balance_cents>=100);
 assert.ok(credit);
 await assert.rejects(d.api.createPayment({credit_id:credit.credit_id,amount_cents:100,payment_method:'efectivo'}),/CANONICAL_FINANCIAL_PENDING/);
 await assert.rejects(d.api.createExpense({amount_cents:100,description:'Synthetic expense',category:'otros',payment_method:'efectivo'}),/CANONICAL_FINANCIAL_PENDING/);
 d.el('cajContado').value='1100';
 assert.equal(await d.context.cerrarCaja(),false);
 assert.match(d.el('cajCloseStatus').textContent,/sale\.create.*409.*product_not_found/);
 assert.equal(JSON.stringify(outbox.snapshot()),queue,'queue intact');
 assert.equal(JSON.stringify(d.api.pendingSnapshot()),journal,'journal evidence intact');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,before.sales);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_financial_events').n,before.events);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
