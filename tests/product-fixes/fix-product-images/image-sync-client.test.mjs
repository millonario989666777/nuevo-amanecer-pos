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
test('thumbnail searches sizes and qualities, with JPEG only when WebP unsupported',async()=>{
 for(const fallback of [false,true]){
  const calls=[];const canvas={getContext:()=>({drawImage(){}}),toDataURL:(type,quality)=>{calls.push([canvas.width,type,quality]);if(fallback&&type==='image/webp')return 'data:image/png;base64,AAAA';return 'data:'+type+';base64,'+'A'.repeat(canvas.width===320&&quality===.7?52000:54000);}};
  class Image {constructor(){this.width=640;this.height=480;}set src(x){this.onload();}}
  const context=vm.createContext({setTimeout:()=>0,Image,document:{readyState:'loading',addEventListener(){},createElement:()=>canvas}});vm.runInContext(script,context);
  const result=await context.NuevoAmanecerImageSync.thumbnail('raw');assert.ok(result.startsWith('data:image/'+(fallback?'jpeg':'webp')));assert.ok(result.split(',')[1].length*3/4<=40000);assert.ok(result.length<60000);
  assert.deepEqual(calls.slice(fallback?1:0),[.8,.7,.6,.5].map(q=>[384,fallback?'image/jpeg':'image/webp',q]).concat([[320,fallback?'image/jpeg':'image/webp',.8],[320,fallback?'image/jpeg':'image/webp',.7]]));
  canvas.toDataURL=type=>'data:'+type+';base64,'+'A'.repeat(canvas.width===256?52000:54000);assert.ok((await context.NuevoAmanecerImageSync.thumbnail('raw')).length<60000);assert.equal(canvas.width,256);
  canvas.toDataURL=type=>'data:'+type+';base64,'+'A'.repeat(54000);await assert.rejects(context.NuevoAmanecerImageSync.thumbnail('raw'),/Miniatura demasiado grande/);
  assert.deepEqual(Array.from(context.NuevoAmanecerImageSync._test.THUMBNAIL_SIZES),[384,320,256]);
 }
});
test('client always fetches images by product_id, never by code',async()=>{const f=fixture();await f.sync.refresh(true);f.sync.source({id:'nope',sku:'001'});f.sync.source({id:'p1'});await tick();assert.ok(f.calls.some(c=>c.path.includes('/item?product_id=')));assert.ok(f.calls.every(c=>!/[?&]code=/.test(c.path)));assert.ok(!/[?&]code=/.test(script));});
