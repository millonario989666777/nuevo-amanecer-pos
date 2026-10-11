// The "Ventas en revisión" block in Caja (owner condition 2, 2026-10-11) must
// survive every Caja redraw: legacy cajRender wipes #cajContent, and the block
// is the only place a quarantined sale stays visible once the cash is closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeCanon,device} from './canon-browser-harness.mjs';
import {tursoSqlite} from './turso-sqlite-protocol.mjs';
const bridge=readFileSync('POS/js/sync/canonical-cash-bridge.js','utf8');
const scripts=['canonical-sale-intent','canonical-sale-outbox'].map(n=>[n,readFileSync('POS/js/sync/'+n+'.js','utf8')]);

function miniDom(){
 const detached=new Map();
 const node=(tag,id='')=>({tagName:tag,id,children:[],parentNode:null,style:{},dataset:{},textContent:'',value:'',className:'',type:'',disabled:false,attrs:{},
  classList:{add(){},remove(){},contains(){return false;},toggle(){}},focus(){},removeAttribute(){},replaceChildren(){this.children=[];},querySelector(){return null;},
  setAttribute(k,v){this.attrs[k]=String(v);},
  get firstChild(){return this.children[0]||null;},
  appendChild(n){n.parentNode=this;this.children.push(n);return n;},
  insertBefore(n,ref){n.parentNode=this;const i=this.children.indexOf(ref);i<0?this.children.push(n):this.children.splice(i,0,n);return n;},
  removeChild(n){const i=this.children.indexOf(n);if(i>=0)this.children.splice(i,1);n.parentNode=null;return n;}});
 const caja=node('div','cajContent');
 const find=(n,id)=>{if(n.id===id)return n;for(const c of n.children){const hit=find(c,id);if(hit)return hit;}return null;};
 const text=n=>(n.textContent||'')+n.children.map(text).join(' ');
 const document={getElementById(id){const hit=find(caja,id);if(hit)return hit;if(!detached.has(id))detached.set(id,node('div',id));return detached.get(id);},
  querySelector(){return null;},querySelectorAll(){return [];},createElement:tag=>node(tag),addEventListener(){}};
 // Mirrors the legacy redraw: replaces everything inside #cajContent.
 const cajRender=function(){caja.children.forEach(c=>{c.parentNode=null;});caja.children=[node('div','cajSummary')];};
 return {document,caja,cajRender,text};
}

test('quarantined sale stays visible in Caja across repeated redraws, with verify/retry and no-recharge warning',async t=>{
 const f=await activeCanon(t,{migrations:['0014_canonical_live_products.sql','0015_canonical_inventory_adjust.sql','0016_canonical_generic_sale_lines.sql']});
 f.env.DB=tursoSqlite(f.database).adapter;
 const dom=miniDom();
 const d=await device(f,{token:'rp',deviceId:'rp',scripts:[...scripts,['bridge',bridge]],
  globals:{document:dom.document,cajRender:dom.cajRender,_naAuthorize(){return true;},confirm(){return true;}},
  onFetch:async url=>{if(url.endsWith('/commands/sale.create'))return Response.json({error:'product_not_found'},{status:409});}});
 await d.api.openCash({session_id:'rp-session',opening_cents:107250});
 const outbox=d.context.NuevoAmanecerCanonicalSaleOutbox;
 await outbox.enqueue(d.context.NuevoAmanecerCanonicalSaleIntent.build({sale_id:'V-085',payment_method:'efectivo',items:[{product_id:'00000',quantity:1,precio:2}]}));
 await outbox.sync();
 assert.equal(outbox.quarantine().entries[0].status,'QUARANTINED');
 d.context.dispatchEvent(new d.context.CustomEvent('na:canonical-sale-projection'));
 for(let i=0;i<3;i++){
  d.context.cajRender();
  const block=dom.document.getElementById('cajContentReview');
  assert.equal(block.parentNode,dom.caja,'redraw '+i+': block still inside Caja');
  const shown=dom.text(block);
  assert.match(shown,/V-085/); assert.match(shown,/product_not_found/); assert.match(shown,/No las cobres de nuevo/);
  const kinds=[];(function walk(n){if(n.attrs&&n.attrs['data-review'])kinds.push(n.attrs['data-review'].split(':')[0]);n.children.forEach(walk);})(block);
  assert.deepEqual(kinds.sort(),['retry','verify'],'annul only after verify proves absence');
  assert.equal(dom.caja.children.filter(c=>c.id==='cajContentReview').length,1,'never duplicated');
 }
 assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n,0);
 assert.equal(outbox.quarantine().entries.length,1,'record kept');
});
