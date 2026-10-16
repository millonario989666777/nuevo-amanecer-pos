import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const batchScript=readFileSync(new URL('../../POS/js/products/image-batch.js',import.meta.url),'utf8');
const syncScript=readFileSync(new URL('../../POS/js/products/image-sync.js',import.meta.url),'utf8');
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg2LIAAAIMAVUeX9q0AAAAAElFTkSuQmCC';
const catalog=[{id:'p1',name:'Ácido fólico 5 mg',sku:'001',barcode:'001',imagen:''},{id:'p2',name:'Jabón neutro',sku:'002',barcode:'002',imagen:''}];
const entry=(filename='acido folico 5 mg.png',codes=['unmatched'])=>({filename,codes,image});
const pure=()=>{const ctx={};vm.runInNewContext(batchScript,ctx);return ctx.NuevoAmanecerImageBatch;};

// Minimal DOM/IDB doubles exercise the real file, search and confirmation handlers.
class Node {
  constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.dataset={};this.style={};this.classList={add(){},remove(){},contains(){return true;}};this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  before(node){this.parent.children.push(node);}
  replaceChildren(...nodes){this.children=nodes;}
  addEventListener(name,fn){this.events[name]=fn;}
  setAttribute(name,value){this[name]=value;}
  querySelector(selector){return this.all().find(n=>selector==='.mbody'?n.className==='mbody':false);}
  all(){return [this,...this.children.flatMap(n=>n.all())];}
  async fire(name){return this.events[name]?.({target:this});}
}
async function fixture(entries=[entry()],initialCatalog=catalog,stored=[]){
  const head=new Node('head'),modal=new Node(),body=new Node();body.className='mbody';modal.id='productImageBatchModal';modal.append(body);
  for(const id of ['Files','Folder','Replace','Rows','Status','Storage','Apply','Upload','Undo','Export']){const n=new Node(['Files','Folder','Replace'].includes(id)?'input':'button');n.id='productImageBatch'+id;n.parent=body;body.append(n);}
  const events={},calls=[],doc={head,createElement:tag=>new Node(tag),addEventListener:(name,fn)=>{events[name]=fn;},getElementById:id=>[...head.all(),...modal.all()].find(n=>n.id===id),querySelector:()=>null,querySelectorAll:()=>modal.all().filter(n=>['button','input'].includes(n.tag))};
  const ctx={productos:structuredClone(initialCatalog),document:doc,NuevoAmanecerZipReader:{},NA_ROLES:{role:'owner',isOwner:()=>true},NA_PERMISSIONS:{canDo:(role,action)=>role==='owner'&&action==='product-images.write'},NuevoAmanecerCanonical:{enabled:()=>true,sourceState:()=>({cache:{promotion_id:'review-test'}})},NuevoAmanecerImageSync:{refresh:async()=>{},hasImage:()=>false,upload:async rows=>{calls.push(JSON.parse(JSON.stringify(rows)));return {ok:1,unchanged:0,failed:0,errors:[]};}},Image:class{constructor(){this.width=1;this.height=1;}set src(value){queueMicrotask(()=>this.onload());}},indexedDB:{open(){const request={result:{close(){},transaction(){return {objectStore(){return {get(){const r={result:{entries:stored}};queueMicrotask(()=>r.onsuccess());return r;}};}};}}};queueMicrotask(()=>request.onsuccess());return request;}},addEventListener:(name,fn)=>{events[name]=fn;}};
  vm.runInNewContext(batchScript,ctx);events.DOMContentLoaded();await ctx.NuevoAmanecerImageBatch.open();
  const files=doc.getElementById('productImageBatchFiles');files.files=[{name:'review.json',size:100,text:async()=>JSON.stringify({version:1,entries})}];await files.fire('change');
  const node=className=>modal.all().find(n=>n.className?.split(' ').includes(className));
  return {ctx,calls,doc,node,events,files,api:ctx.NuevoAmanecerImageBatch};
}

test('similitud pura: tildes, mayúsculas, espacios, signos, vacíos y simetría',()=>{
  const {nameSimilarity}=pure();
  assert.equal(nameSimilarity(' ÁCIDO_FÓLICO 5 mg ','acido folico 5 MG'),100);
  for(const [a,b] of [['jabón','jabon'],['leche entera','leche entera 1 l'],['abc','xyz']])assert.equal(nameSimilarity(a,b),nameSimilarity(b,a));
  assert.equal(nameSimilarity(null,''),0);assert.equal(nameSimilarity('','producto'),0);
  assert.equal(nameSimilarity('abc','xyz'),0);
});
test('70% se muestra; menos de 70% y empates quedan sin sugerencia',()=>{
  const api=pure(),candidate=entry('abcdefghij.png');
  assert.equal(api.nameSimilarity('abcdefghij','abcdefgxyz'),70);
  assert.equal(api._test.suggestion(candidate,[{id:'yes',name:'abcdefgxyz'}]).productId,'yes');
  assert.equal(api._test.suggestion(candidate,[{id:'no',name:'abcdefwxyz'}]),null);
  assert.equal(api._test.suggestion(entry(),[{id:'a',name:catalog[0].name},{id:'b',name:'acido folico 5 mg'}]),null);
});
test('un nombre idéntico solo sugiere, no empareja ni muta catálogo o entrada',()=>{
  const api=pure(),entries=[entry()],before=JSON.stringify({entries,catalog});
  const rows=api.plan(entries,catalog,[]),review=api._test.reviewRows(rows,catalog);
  assert.equal(rows[0].status,'missing');assert.equal(rows[0].productId,null);
  assert.equal(review[0].suggestion.productId,'p1');assert.equal(JSON.stringify({entries,catalog}),before);
});
test('código duplicado no elige el primer producto ni ofrece sugerencia',()=>{
  const api=pure(),products=[...catalog,{...catalog[0],id:'p3'}];
  const rows=api.plan([entry('acido folico 5 mg.png',['001'])],products,[]);
  assert.equal(rows[0].status,'ambiguous');assert.equal(rows[0].productId,null);assert.equal(rows[0].productName,'');
  assert.equal(api._test.reviewRows(rows,products)[0].suggestion,null);
});
test('preview no sube fotos; confirmar usa upload existente con ID y códigos vigentes',async()=>{
  const f=await fixture(),before=JSON.stringify(f.ctx.productos);
  assert.equal(f.calls.length,0);assert.equal(f.doc.getElementById('productImageBatchReview').hidden,false);
  await f.node('image-review-confirm').fire('click');
  assert.deepEqual(f.calls,[[{productId:'p1',codes:['001'],image}]]);
  assert.equal(f.doc.getElementById('productImageBatchReview').hidden,true);
  assert.equal(JSON.stringify(f.ctx.productos),before);
});
test('buscador normalizado selecciona sin guardar; cambio de búsqueda invalida selección',async()=>{
  const f=await fixture([entry('xyz.png')]);assert.equal(f.node('image-review-confirm'),undefined);
  const search=f.node('image-review-search'),save=f.node('image-review-save');search.value='JABON';await search.fire('input');
  await f.node('image-review-option').fire('click');assert.equal(save.disabled,false);assert.equal(f.calls.length,0);
  search.value='neutro';await search.fire('input');assert.equal(save.disabled,true);
  await f.node('image-review-option').fire('click');await save.fire('click');assert.equal(f.calls[0][0].productId,'p2');
});
test('duplicados requieren elegir ID y nunca habilitan confirmación sugerida',async()=>{
  const f=await fixture([entry('001.png',['001'])],[...catalog,{...catalog[0],id:'p3'}]);
  assert.equal(f.node('image-review-suggestion').textContent,'código duplicado: elegir producto');assert.equal(f.node('image-review-confirm'),undefined);
  const search=f.node('image-review-search');search.value='001';await search.fire('input');
  const options=f.node('image-review-results').children;assert.equal(options.length,2);
  await options[1].fire('click');assert.equal(f.calls.length,0);await f.node('image-review-save').fire('click');assert.equal(f.calls[0][0].productId,'p3');
});
test('permiso y rol fallan cerrados; un cambio de rol limpia la lista y bloquea el handler viejo',async()=>{
  for(const change of [ctx=>{ctx.NA_ROLES.role='empleado';},ctx=>{ctx.NA_ROLES.role='unknown';},ctx=>{ctx.NA_ROLES.isOwner=()=>false;},ctx=>{ctx.NA_PERMISSIONS.canDo=()=>false;},ctx=>{delete ctx.NA_ROLES;}]){
    const f=await fixture(),confirm=f.node('image-review-confirm');change(f.ctx);assert.equal(f.api._test.reviewAllowed(),false);
    f.events['na:role']();assert.equal(f.doc.getElementById('productImageBatchReview').hidden,true);
    await confirm.fire('click');assert.equal(f.calls.length,0);
  }
});
test('cambio de código o sesión bloquea una revisión obsoleta',async()=>{
  for(const change of [ctx=>{ctx.productos[0].barcode='changed';},ctx=>{ctx.NuevoAmanecerCanonical.sourceState=()=>({cache:{promotion_id:'other'}});}]){
    const f=await fixture();change(f.ctx);await f.node('image-review-confirm').fire('click');
    assert.equal(f.calls.length,0);assert.match(f.node('image-review-feedback').textContent,/cambió/);
  }
});
test('protege foto existente hasta marcar reemplazo y permite reintentar error de servidor',async()=>{
  const f=await fixture();f.ctx.NuevoAmanecerImageSync.hasImage=()=>true;
  await f.node('image-review-confirm').fire('click');assert.equal(f.calls.length,0);assert.match(f.node('image-review-feedback').textContent,/Reemplazar/);
  f.doc.getElementById('productImageBatchReplace').checked=true;
  const upload=f.ctx.NuevoAmanecerImageSync.upload;f.ctx.NuevoAmanecerImageSync.upload=async()=>({ok:0,unchanged:0,failed:1,errors:['SIN_SESION']});
  await f.node('image-review-confirm').fire('click');assert.equal(f.doc.getElementById('productImageBatchReview').hidden,false);assert.match(f.node('image-review-feedback').textContent,/Inicia sesión/);
  f.ctx.NuevoAmanecerImageSync.upload=upload;await f.node('image-review-confirm').fire('click');assert.equal(f.calls.length,1);
});
test('doble clic y dos fotos para el mismo destino no producen escrituras adicionales',async()=>{
  const f=await fixture([entry(),entry('acido folico 5 mg_1.png')]);let finish;
  f.ctx.NuevoAmanecerImageSync.upload=rows=>{f.calls.push(rows);return new Promise(resolve=>{finish=()=>resolve({ok:1,unchanged:0,failed:0,errors:[]});});};
  const confirm=f.node('image-review-confirm'),first=confirm.fire('click');await confirm.fire('click');assert.equal(f.calls.length,1);finish();await first;
  await f.node('image-review-confirm').fire('click');assert.equal(f.calls.length,1);assert.match(f.node('image-review-feedback').textContent,/Otra foto/);
});
test('sync guarda por ruta existente y no propaga la foto a otro producto con código duplicado',async()=>{
  const records=[],calls=[],products=[...catalog,{...catalog[0],id:'p3'}];
  const ctx={productos:products,setTimeout,NA_ROLES:{api:async(path,body)=>{calls.push({path,body});if(body){records.push({...body,etag:'e1'});return {status:'ok'};}if(path.includes('/item?'))return records[0];return {status:'ok',version:'v1',images:records.map(({image,...record})=>record)};}}};
  vm.runInNewContext(syncScript,ctx);const sync=ctx.NuevoAmanecerImageSync;sync._test.setThumbnail(x=>x);
  await sync.upload([{productId:'p3',codes:['001'],image}]);assert.equal(calls[0].path,'/auth/product-images');assert.equal(calls[0].body.product_id,'p3');
  assert.equal(sync.hasImage(products[0]),false);assert.equal(sync.source(products[0]),null);
  assert.equal(sync.hasImage(products[2]),true);sync.source(products[2]);await new Promise(resolve=>setImmediate(resolve));assert.equal(sync.source(products[2]),image);
});
test('foto confirmada por ID prevalece frente a la importación local anterior',async()=>{
  const old=image+'AAAA',f=await fixture([entry()],catalog,[{codes:['001'],targetId:'p1',image:old}]);
  assert.equal(f.api.source(f.ctx.productos[0]),old);
  f.ctx.NuevoAmanecerImageSync.hasImage=()=>true;f.ctx.NuevoAmanecerImageSync.source=()=>image;
  assert.equal(f.api.source(f.ctx.productos[0]),image);
});
