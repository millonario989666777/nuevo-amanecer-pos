import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('POS/js/products/image-batch.js','utf8');
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT3sAAAAASUVORK5CYII=';
function api(){const ctx={};vm.runInNewContext(source,ctx);return ctx.NuevoAmanecerImageBatch;}
const p={id:'p1',name:'Producto',sku:'04692485',barcode:'01',codigosAlternativos:['12345'],stock:20,precio:2};
test('match exacto por SKU, principal y alternativo conserva ceros; no usa nombre',()=>{
 const a=api();for(const code of ['04692485','01','12345'])assert.equal(a.plan([{codes:[code],image}], [p],[])[0].status,'ready');
 assert.equal(a.plan([{codes:['4692485'],name:p.name,image}],[p],[])[0].status,'missing');
});
test('rechaza códigos numéricos, SVG, URLs y lotes fuera del límite',()=>{
 const a=api();for(const bad of [1,null,''])assert.throws(()=>a.plan([{codes:[bad],image}],[p],[]));
 for(const bad of ['https://site/image.jpg','data:image/svg+xml;base64,AAAA','data:image/png;base64,AAAA'])assert.throws(()=>a.plan([{codes:['01'],image:bad}],[p],[]));
 assert.throws(()=>a.plan(Array(501).fill({codes:['01'],image}),[p],[]));
});
test('ambigüedad entre productos o entre entradas no aplica fotos',()=>{
 const a=api();assert.equal(a.plan([{codes:['01'],image}],[p,{...p,id:'p2'}],[])[0].status,'ambiguous');
 const rows=a.plan([{codes:['01'],image},{codes:['12345'],image}],[p],[]);assert.ok(rows.every(r=>r.status==='duplicate'));
});
test('protege imagen existente y reconoce reimportación sin duplicar',()=>{
 const a=api(),entries=[{codes:['01'],image}];assert.equal(a.plan(entries,[{...p,imagen:image}],[])[0].status,'existing');
 assert.equal(a.plan(entries,[p],entries)[0].status,'unchanged');
 assert.equal(a.plan(entries,[{...p,imagen:image}],[],true)[0].status,'ready');
});
test('el catálogo visual no muta stock, precio, códigos ni imagen del producto',()=>{
 const a=api(),before=JSON.stringify(p);a.plan([{codes:['01'],image}],[p],[]);assert.equal(JSON.stringify(p),before);
});
test('asset resolver fails closed after a product-code collision',()=>{
 const a=api();assert.equal(a.resolve(p,[{codes:['01'],image}],[p]),image);
 assert.equal(a.resolve(p,[{codes:['01'],image}],[p,{...p,id:'p2'}]),null);
 assert.equal(a.resolve({...p,id:'new'},[{codes:['01'],image,targetId:'p1'}],[{...p,id:'new'}]),null);
 assert.equal(a.resolve({...p,sku:'changed',barcode:'',codigosAlternativos:[]},[{codes:['01'],image}],[p]),null);
});
test('CANON, tarjetas, inventario y shell offline integran el mismo módulo',()=>{
 const html=fs.readFileSync('POS/index.html','utf8'),sw=fs.readFileSync('POS/sw.js','utf8');
 assert.match(html,/js\/products\/image-batch\.js/);assert.match(html,/id="productImageBatchFiles"/);
 assert.match(sw,/\.\/js\/products\/image-batch\.js/);
 assert.match(fs.readFileSync('POS/js/legacy-inline/inline-13.js','utf8'),/NuevoAmanecerImageBatch/);
 assert.match(fs.readFileSync('POS/js/legacy-inline/inline-01.js','utf8'),/safeImage=.*_naProductImageSource\(p\)/);
});

test('photo lookups read small authority metadata without copying the full canonical snapshot',()=>{
 let metadataReads=0,snapshotReads=0;
 const ctx={productos:[],NuevoAmanecerCanonical:{enabled:()=>true,sourceState:()=>{metadataReads++;return {cache:{promotion_id:'photos'}};},snapshot:()=>{snapshotReads++;throw Error('Full snapshot must not be copied for a photo');}}};
 vm.runInNewContext(source,ctx);
 for(let i=0;i<500;i++)assert.equal(ctx.NuevoAmanecerImageBatch.source(p),null);
 assert.equal(snapshotReads,0);assert.ok(metadataReads>=500);
});
test('missing canonical metadata never falls back to a stale full snapshot',()=>{
 let snapshots=0;const ctx={NuevoAmanecerCanonical:{enabled:()=>true,sourceState:()=>({cache:null}),snapshot:()=>{snapshots++;return {promotion_id:'old'};}}};
 vm.runInNewContext(source,ctx);assert.equal(ctx.NuevoAmanecerImageBatch.source(p),null);assert.equal(snapshots,0);
});

async function hydrated(catalog,entries){
 const node={style:{},classList:{add(){}},textContent:''};
 const ctx={productos:catalog,document:{addEventListener(){},getElementById(){return node;}},indexedDB:{open(){
  const request={result:{close(){},transaction(){return {objectStore(){return {get(){const r={result:{entries}};queueMicrotask(()=>r.onsuccess());return r;}};}};}}};
  queueMicrotask(()=>request.onsuccess());return request;
 }}};
 vm.runInNewContext(source,ctx);await ctx.NuevoAmanecerImageBatch.open();return ctx;
}
test('render-local photo index is equivalent to fail-closed independent resolution',async()=>{
 const catalog=[p,{...p,id:'p2',sku:'two',barcode:'02',codigosAlternativos:['shared']},{...p,id:'p3',sku:'three',barcode:'03',codigosAlternativos:['shared']}];
 for(const entries of [[{codes:['12345'],image,targetId:'p1'}],[{codes:['shared'],image}],[{codes:['01'],image},{codes:['12345'],image}],[{codes:['01'],image,targetId:'wrong'}],[{codes:['01','02'],image}],[]]){
  const ctx=await hydrated(catalog,entries),api=ctx.NuevoAmanecerImageBatch;
  const expected=catalog.map(x=>api.resolve(x,entries,catalog));
  assert.deepEqual(Array.from(api.withSources(()=>catalog.map(x=>api.source(x)))),expected);
 }
});
test('photo index is rebuilt after in-place code edits and cleared after render errors',async()=>{
 const catalog=[{...p}, {...p,id:'p2',sku:'other',barcode:'02',codigosAlternativos:[]}],entries=[{codes:['01'],image}],ctx=await hydrated(catalog,entries),api=ctx.NuevoAmanecerImageBatch;
 assert.equal(api.withSources(()=>api.source(catalog[0])),image);
 catalog[1].barcode='01';assert.equal(api.withSources(()=>api.source(catalog[0])),null);
 catalog[1].barcode='02';assert.throws(()=>api.withSources(()=>{assert.equal(api.source(catalog[0]),image);throw Error('render failed');}));
 catalog[1].barcode='01';assert.equal(api.withSources(()=>api.source(catalog[0])),null);
});
test('408 render photo lookups read catalog codes linearly',async()=>{
 let reads=0;const catalog=Array.from({length:408},(_,i)=>({id:i,barcode:'b'+i,get sku(){reads++;return 's'+i;}}));
 const entries=catalog.map(x=>({codes:[x.sku],image})),ctx=await hydrated(catalog,entries);reads=0;
 ctx.NuevoAmanecerImageBatch.withSources(()=>{for(const x of catalog)assert.equal(ctx.NuevoAmanecerImageBatch.source(x),image);});
 assert.ok(reads<=catalog.length*3,`catalog reads ${reads} must be bounded`);
});

test('filename mapping keeps zeros and exact suffix codes; summary includes unmatched filenames',()=>{
 const a=api(),catalog=[p,{...p,id:'suffix',sku:'01_1',barcode:''}];
 for(const [name,code] of [['folder/04692485.jpg','04692485'],['01_1.jpg','01_1'],['04692485_1.jpg','04692485'],['04692485-1.png','04692485'],['04692485 (1).webp','04692485']])assert.equal(a._test.filenameCode(name,catalog),code);
 const rows=a.plan([{codes:['01'],image},{codes:['missing'],image,filename:'missing.jpg'}],[{...p,imagen:image}],[]),report=a._test.summary(rows);
 assert.equal(report.linked,1);assert.equal(report.existing,1);assert.equal(report.missing,1);assert.deepEqual(Array.from(report.unmatched),['missing.jpg']);
 assert.equal(a._test.summary([{status:'ambiguous'},{status:'duplicate'}]).ambiguous,2);
 assert.equal(a._test.summary(Array.from({length:55},()=>({status:'missing',entry:{filename:'x'}}))).unmatched.length,50);
});
