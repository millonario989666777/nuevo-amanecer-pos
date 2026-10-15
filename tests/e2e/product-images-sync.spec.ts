import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,readdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
test.use({serviceWorkers:'block'});
// Minimal ZIP fixture, generated locally with real image bytes and valid CRC32.
function zip(files:{name:string,data:Buffer}[]){const local:Buffer[]=[],central:Buffer[]=[];let offset=0;for(const {name,data} of files){const n=Buffer.from(name),packed=deflateRawSync(data),l=Buffer.alloc(30),c=Buffer.alloc(46);let crc=0xffffffff;for(const b of data){crc^=b;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(8,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(packed.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);local.push(l,n,packed);central.push(c,n);offset+=30+n.length+packed.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);}
async function seed(page:Page,codes:string[]){await page.waitForFunction('_naFreeSaleShortcutState.ready');await page.evaluate(codes=>{
 const w=window as any;w.eval(`productos=${JSON.stringify(codes.map((code,i)=>({id:99000+i,name:'Foto '+code,sku:code,barcode:code,codigosAlternativos:[],precio:2,costo:1,stock:20,stockMin:2,cat:'abarrotes',icon:'🧴',unidad:'unidad',venc:'',imagen:''})))};`);
 w.NuevoAmanecerCanonical={enabled:()=>true,sourceState:()=>({cache:{promotion_id:'sync-fixture'}})};w._naAuthorize=()=>true;w.securityIsLocked=()=>false;
 },codes);}
for(const kind of ['folder','zip'] as const)test(`${kind} import synchronizes thumbnails to a fresh device`,async({browser,baseURL})=>{
 const dir=await mkdtemp(join(tmpdir(),'na-image-folder-')),zipPath=dir+'.zip';
 const contexts=[];const store=new Map<string,any>();let version=0;
 try{
  const names=(await readdir('/workspace/imagenes')).filter(n=>/^sample_\d+_\d+\.jpg$/.test(n)).slice(0,4);expect(names.length).toBeGreaterThan(0);
  const files=[];for(const name of names){const code=name.match(/^sample_\d+_(\d+)\.jpg$/)![1],fixture=code+'.jpg';await copyFile(join('/workspace/imagenes',name),join(dir,fixture));files.push({name:fixture,data:await readFile(join(dir,fixture))});}await writeFile(zipPath,zip(files));const codes=files.map(f=>f.name.slice(0,-4));
  async function device(){const context=await browser.newContext({baseURL,serviceWorkers:'block'});contexts.push(context);const page=await context.newPage();await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.hostname==='127.0.0.1')return route.continue();if(url.hostname!=='permissions.test')return route.abort();
   let result:any={};if(url.pathname==='/auth/me')result={pos_role:'owner',owner_pin_set:true,roles_ready:true,device_id:'synthetic-images'};
   else if(url.pathname.startsWith('/auth/product-images')){
    if(route.request().method()==='POST'){const body=route.request().postDataJSON();expect(body.image).toMatch(/^data:image\/(webp|jpeg);base64,/);expect(Buffer.from(body.image.split(',')[1],'base64').length).toBeLessThanOrEqual(40000);expect(body.image.length).toBeLessThan(60000);const etag='e'+(++version);store.set(String(body.product_id),{...body,etag});result={status:'ok',etag};}
    else if(url.pathname.endsWith('/item'))result=store.get(url.searchParams.get('product_id')!);
    else result={status:'ok',version:String(version),images:[...store.values()].map(({image,...m})=>m)};
   }return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });await page.goto('/index.html');await page.evaluate(()=>{localStorage.setItem('na_cloud_sync_credentials',JSON.stringify({endpoint:'https://permissions.test',token:'synthetic'}));localStorage.setItem('na_pos_role_v1',JSON.stringify({role:'owner'}));});await page.reload();await page.waitForFunction(()=>{const r=(window as any).NA_ROLES;return r?.role==='owner'&&r.confirmed;});await seed(page,codes);await page.waitForFunction(()=>!!(window as any).NuevoAmanecerImageSync);return page;}
  const a=await device();await a.evaluate(()=>(window as any).NuevoAmanecerImageBatch.open());await expect(a.locator('#productImageBatchStatus')).toContainText('Selecciona');
  await a.locator(kind==='folder'?'#productImageBatchFolder':'#productImageBatchFiles').setInputFiles(kind==='folder'?dir:zipPath);
  await expect(a.locator('#productImageBatchStatus')).toContainText(`Vinculadas: ${files.length}`);await a.locator('#productImageBatchApply').click();await expect.poll(()=>store.size).toBe(files.length);await expect(a.locator('#productImageBatchStatus')).toContainText('0 con error');
  const b=await device();expect(await b.evaluate(async()=>{const r=indexedDB.open('nuevo-amanecer-product-images-remote-v1',1);return new Promise<number>(resolve=>{r.onsuccess=()=>{const db=r.result,q=db.transaction('images').objectStore('images').count();q.onsuccess=()=>{db.close();resolve(q.result)};};});})).toBe(0);
  await b.evaluate(async()=>{const w=window as any;await w.NuevoAmanecerImageSync.refresh(true);w.NA_MENU_NAVIGATION.navigate('pagePOS');w.posRender();});
  const card=b.locator('#pagePOS .p-img img').first();await expect(card).toBeVisible();await expect.poll(()=>card.evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  for(const img of [card]){await expect(img).toHaveAttribute('loading','lazy');await expect(img).toHaveAttribute('decoding','async');expect(await img.evaluate(el=>{const box=el.parentElement!.getBoundingClientRect();return Math.abs(Number(el.getAttribute('width'))-box.width)<2&&Math.abs(Number(el.getAttribute('height'))-box.height)<2;})).toBe(true);}
  await b.evaluate(()=>{const w=window as any;w.eval('cart=[{...productos[0],qty:1,cantidad:1}]');w.posUpdateCart();});const cart=b.locator('.cart-item img').first();await expect(cart).toHaveAttribute('width','30');await expect(cart).toHaveAttribute('height','30');await expect(cart).toHaveAttribute('loading','lazy');
  await card.evaluate((img:HTMLImageElement)=>{img.src='data:image/jpeg;base64,broken';});await expect(b.locator('#pagePOS .p-img').first()).toHaveText('🧴');
  await b.evaluate(()=>{const w=window as any;w.NA_MENU_NAVIGATION.navigate('pageInventario');w.invRender();});const inv=b.locator('#invBody img').first();await expect(inv).toBeVisible();await expect(inv).toHaveAttribute('width','44');await expect(inv).toHaveAttribute('height','44');await expect(inv).toHaveAttribute('loading','lazy');await expect(inv).toHaveAttribute('decoding','async');await inv.evaluate((img:HTMLImageElement)=>{img.src='data:image/jpeg;base64,broken';});await expect(b.locator('#invBody .prod-icon-sm').first()).toHaveText('🧴');
 }finally{for(const context of contexts)await context.close();await rm(dir,{recursive:true,force:true});await rm(zipPath,{force:true});}
});
