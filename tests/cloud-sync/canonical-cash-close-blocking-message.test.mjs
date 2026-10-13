// CANON H1 (preview #518): the text the cashier sees on a blocked close must
// name the blocking sale, its reason, how many wait behind it, and warn not to
// charge again, on both branches (journal present / journal empty).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(n=>[n,readFileSync('POS/js/sync/'+n+'.js','utf8')]);
async function setup(t,onFetch){
 const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql']});
 f.env.DB=tursoSqlite(f.database).adapter;
 const d=await device(f,{token:'h1',deviceId:'h1',scripts:[...scripts,['bridge',bridge]],globals:{cajRender(){},_naAuthorize(){return true;}},onFetch});
 await d.api.openCash({session_id:'h1-session',opening_cents:107250});
 d.el('cajContado').value='1100';
 return {f,d,outbox:d.context.NuevoAmanecerCanonicalSaleOutbox,build:x=>d.context.NuevoAmanecerCanonicalSaleIntent.build(x)};
}
test('journal branch: 409 quarantine message shows sale_id, reason, queue size and no-recharge warning',async t=>{
 const {f,d,outbox,build}=await setup(t,async url=>{if(url.endsWith('/commands/sale.create'))return Response.json({error:'product_not_found'},{status:409});});
 await outbox.enqueue(build({sale_id:'V-085',payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]}));
 await outbox.enqueue(build({sale_id:'V-086',payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]}));
 const head=outbox.snapshot().intents[0].sale_id;
 assert.equal(await d.context.cerrarCaja(),false);
 const text=d.el('cajCloseStatus').textContent;
 assert.match(text,/el producto no existe/);
 assert.ok(text.includes('Venta pendiente: '+head),text);
 assert.match(text,/ y 1 más/);
 assert.match(text,/No la cobres de nuevo/);
 assert.equal(outbox.snapshot().intents.length+outbox.quarantine().entries.length,2,'both sales kept');
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
test('empty-journal branch: pre-POST credit failure shows sale_id, reason and no-recharge warning',async t=>{
 const {f,d,outbox,build}=await setup(t);
 await outbox.enqueue(build({sale_id:'V-087',payment_method:'credito',customer_id:'cliente-solo-local',credit_due:'2026-11-30',items:[{product_id:'00000',quantity:1,precio:2}]}));
 const head=outbox.snapshot().intents[0].sale_id;
 assert.equal(await d.context.cerrarCaja(),false);
 assert.equal(d.api.pendingSnapshot(),null,'no journal: failure happened before the POST');
 const text=d.el('cajCloseStatus').textContent;
 assert.ok(text.includes('Venta pendiente: '+head),text);
 assert.doesNotMatch(text,/INVALID_CANONICAL_CUSTOMER/);
 assert.match(text,/No la cobres de nuevo/);
 assert.equal(outbox.snapshot().intents.length+outbox.quarantine().entries.length,1,'sale kept');
 assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_closures').n,0);
});
