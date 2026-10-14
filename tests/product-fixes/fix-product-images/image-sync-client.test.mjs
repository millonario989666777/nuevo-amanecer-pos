import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script=readFileSync(new URL('../../../POS/js/products/image-sync.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,10));
function fixture(){let running=0,max=0;const records=new Map([['p1',{product_id:'p1',codes:['001'],etag:'e1',image:'image1'}]]),calls=[];const context=vm.createContext({setTimeout,clearTimeout,NA_ROLES:{async api(path,body){calls.push({path,body});if(body){running++;max=Math.max(max,running);await tick();running--;if(body.product_id==='bad')throw Error('failed item');return {status:body.product_id==='same'?'unchanged':'ok'};}if(path.includes('/item?')){await tick();return records.get(new URL('http://x'+path).searchParams.get('product_id'));}return {status:'ok',version:'v1',images:[...records.values()].map(({image,...m})=>m)};}}});vm.runInContext(script,context);return {sync:context.NuevoAmanecerImageSync,records,calls,max:()=>max};}
test('loads without DOM or IDB; lazy fetching deduplicates and matches identity or unique codes',async()=>{const f=fixture();await f.sync.refresh(true);assert.equal(f.sync.source({id:'p1'}),null);assert.equal(f.sync.source({sku:'001'}),null);await tick();assert.equal(f.sync.source({id:'p1'}),'image1');assert.equal(f.sync.source({id:'other',barcode:' 001 '}),'image1');assert.equal(f.calls.filter(c=>c.path.includes('/item?')).length,1);f.records.set('p2',{product_id:'p2',codes:['001'],etag:'e2',image:'image2'});await f.sync.refresh(true);assert.equal(f.sync.source({id:'unknown',sku:'001'}),null);f.records.get('p1').etag='updated';await f.sync.refresh(true);assert.equal(f.sync.source({id:'p1'}),null);await tick();assert.equal(f.sync.source({id:'p1'}),'image1');});
test('uploads thumbnail sequentially, counts errors, reports progress and refreshes',async()=>{const f=fixture();f.sync._test.setThumbnail(image=>'thumb:'+image);const progress=[];const result=await f.sync.upload(['ok','same','bad'].map(productId=>({productId,codes:['001'],image:'raw'})),{onProgress:(x,n)=>progress.push([x,n])});assert.equal(f.max(),1);assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:1,unchanged:1,failed:1,errors:['failed item']});assert.deepEqual(progress,[[1,3],[2,3],[3,3]]);assert.ok(f.calls.filter(c=>c.body).every(c=>c.body.image==='thumb:raw'));assert.ok(f.calls.at(-1).path.startsWith('/auth/product-images?since='));});
test('no session refresh is silent and upload counts per-item failures',async()=>{const context=vm.createContext({setTimeout,clearTimeout});vm.runInContext(script,context);const s=context.NuevoAmanecerImageSync;s._test.setThumbnail(x=>x);await s.refresh(true);const r=await s.upload([{productId:'p',codes:['0'],image:'raw'}]);assert.equal(r.failed,1);assert.equal(r.errors[0],'SIN_SESION');assert.equal(s.source({id:'p'}),null);});

test('remove posts the exact delete shape and refreshes',async()=>{
 const f=fixture();await f.sync.remove('p1');
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{product_id:'p1',delete:true});
 assert.ok(f.calls.at(-1).path.startsWith('/auth/product-images?'));
});
test('thumbnail falls back to 240px and rejects oversized output',async()=>{
 for(const finalLength of [50000,60001]){
  const calls=[],draws=[];
  const canvas={getContext:()=>({drawImage:(...args)=>draws.push(args.slice(3))}),toDataURL:(type,quality)=>{calls.push([canvas.width,canvas.height,quality]);return 'x'.repeat(calls.length<3?60001:finalLength);}};
  class Image {constructor(){this.width=640;this.height=480;}set src(x){this.onload();}}
  const context=vm.createContext({setTimeout:()=>0,Image,document:{readyState:'loading',addEventListener(){},createElement:()=>canvas}});
  vm.runInContext(script,context);
  const result=context.NuevoAmanecerImageSync.thumbnail('raw');
  if(finalLength>60000)await assert.rejects(result,/Miniatura demasiado grande/);else assert.equal((await result).length,50000);
  assert.deepEqual(calls,[[320,240,.72],[320,240,.5],[240,180,.6]]);
  assert.deepEqual(draws,[[320,240],[240,180]]);
 }
});
test('client always fetches images by product_id, never by code',async()=>{const f=fixture();await f.sync.refresh(true);f.sync.source({id:'nope',sku:'001'});f.sync.source({id:'p1'});await tick();assert.ok(f.calls.some(c=>c.path.includes('/item?product_id=')));assert.ok(f.calls.every(c=>!/[?&]code=/.test(c.path)));assert.ok(!/[?&]code=/.test(script));});
