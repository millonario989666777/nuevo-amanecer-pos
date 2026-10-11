// CANON (Auditor condition 1): with a sale quarantined after a definitive 409,
// other financial commands fail closed with a clear code and lose nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
test('quarantined sale keeps payment and expense working, blocks only the close, and loses no record',async t=>{
 const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql']});
 f.env.DB=tursoSqlite(f.database).adapter;
 const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(n=>[n,readFileSync('POS/js/sync/'+n+'.js','utf8')]);
 const d=await device(f,{token:'q-a',deviceId:'q-a',scripts:[...scripts,['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;}},onFetch:async(url)=>{
  if(url.endsWith('/commands/sale.create'))return Response.json({error:'product_not_found'},{status:409});
 }});
 await d.api.openCash({session_id:'q-session',opening_cents:107250});
 const outbox=d.context.NuevoAmanecerCanonicalSaleOutbox;
 await outbox.enqueue(d.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-085',payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]}));
 const op=outbox.snapshot().intents[0].operation_id;
 const out=await outbox.sync();
 assert.equal(out.status,'EMPTY');
 // Owner 2026-10-11: a quarantined sale never blocks independent operations.
 const entry=outbox.quarantine().entries[0];
 assert.equal(entry.intent.operation_id,op); assert.equal(entry.reason,'product_not_found'); assert.equal(entry.journal.last_error,'product_not_found');
 assert.equal(d.api.pendingSnapshot(),null);
 const before={sales:f.sql('SELECT COUNT(*) n FROM sales').n};
 await d.api.refresh();
 const credit=d.api.snapshot().credits.find(x=>x.current_balance_cents>=100);
 assert.ok(credit);
 await d.api.createPayment({credit_id:credit.credit_id,amount_cents:100,payment_method:'efectivo'});
 await d.api.refresh();
 await d.api.createExpense({amount_cents:100,concept:'Synthetic expense',category:'otros',payment_method:'efectivo',expense_date:new Date().toISOString().slice(0,10)});
 d.el('cajContado').value='1100';
 assert.equal(await d.context.cerrarCaja(),false,'close of this cash waits for reconciliation');
 assert.ok(d.el('cajCloseStatus').textContent.includes('Venta bloqueante: '+entry.intent.sale_id));
 assert.equal(outbox.quarantine().entries.length,1,'record intact');
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,before.sales);
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
