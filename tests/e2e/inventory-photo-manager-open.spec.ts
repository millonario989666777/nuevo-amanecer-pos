import {test,expect,type Page} from '@playwright/test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
test.use({serviceWorkers:'block'});
// Minimal ZIP writer (deflate), same format CasaMarket exports.
function crc32(buf:Buffer){let c=~0;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function zip(files:{name:string,data:Buffer}[]){const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const f of files){const name=Buffer.from(f.name),comp=deflateRawSync(f.data),crc=crc32(f.data);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(comp.length,18);h.writeUInt32LE(f.data.length,22);h.writeUInt16LE(name.length,26);
  local.push(h,name,comp);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(comp.length,20);c.writeUInt32LE(f.data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
  central.push(c,name);offset+=30+name.length+comp.length;}
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,cd,end]);}
async function ownerInventory(page:Page){
 await page.route('**/*',route=>{const url=new URL(route.request().url());
  if(url.hostname==='permissions.test'){let body:any={};if(url.pathname==='/auth/me')body={pos_role:'owner',owner_pin_set:true,roles_ready:true,device_id:'owner-pc'};else if(url.pathname.startsWith('/auth/product-images'))body={status:'ok',version:'v',images:[],storage:{used:1000,cap:40000000}};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});}
  return url.hostname==='127.0.0.1'?route.continue():route.abort();});
 await page.goto('/index.html');
 await page.evaluate(()=>{localStorage.setItem('na_cloud_sync_credentials',JSON.stringify({endpoint:'https://permissions.test',token:'synthetic'}));localStorage.setItem('na_pos_role_v1',JSON.stringify({role:'owner'}));});
 await page.reload();
 await page.waitForFunction(()=>(window as any).NA_ROLES?.role==='owner'&&(window as any).NA_ROLES.confirmed);
 await page.waitForFunction('_naFreeSaleShortcutState.ready');
 await page.evaluate(()=>{const w=window as any;w.NuevoAmanecerCanonical={enabled:()=>true,sourceState:()=>({cache:{promotion_id:'photo-manager'}}),snapshot:()=>{throw Error('no snapshot')}};w.NA_MENU_NAVIGATION?.navigate?w.NA_MENU_NAVIGATION.navigate('pageInventario'):w.goPage('pageInventario');});
}
const topmost=(page:Page,sel:string)=>page.locator(sel).evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!hit&&(hit===el||el.contains(hit));});
for(const vp of [{width:390,height:844},{width:1024,height:463},{width:1024,height:768},{width:1366,height:768}])test(`owner opens Fotos from Más opciones and imports a ZIP at ${vp.width}x${vp.height}`,async({page})=>{
 await page.setViewportSize(vp);await ownerInventory(page);
 const dir=await mkdtemp(join(tmpdir(),'na-photo-manager-'));
 try{
  // Real clicks only, like the owner.
  const summary=page.locator('#pageInventario details.inv-secondary > summary');await expect(summary).toBeVisible();
  const titleBefore=await page.locator('#pageInventario .top-mod-title').boundingBox();
  await summary.click();
  const photos=page.locator('#invPhotosBtn');await expect(photos).toBeVisible();await expect(photos).toBeInViewport();
  expect(await topmost(page,'#invPhotosBtn'),'Cargar fotos is not covered by the sticky controls').toBe(true);
  // No ancestor clips the open menu.
  expect(await page.locator('#pageInventario .inv-secondary-menu').evaluate(menu=>{const r=menu.getBoundingClientRect();const clipped:string[]=[];for(let a=menu.parentElement;a&&a!==document.body;a=a.parentElement){const s=getComputedStyle(a);if(/(hidden|auto|scroll|clip)/.test(s.overflowX+s.overflowY)){const b=a.getBoundingClientRect();if(r.left<b.left-0.5||r.right>b.right+0.5||r.top<b.top-0.5||r.bottom>b.bottom+0.5)clipped.push(a.tagName+'.'+a.className);}}return clipped;})).toEqual([]);
  const m=await page.locator('#pageInventario .inv-secondary-menu').boundingBox();expect(m!.x).toBeGreaterThanOrEqual(0);expect(m!.x+m!.width).toBeLessThanOrEqual(vp.width);
  expect(await page.locator('#pageInventario .top-mod-title').boundingBox(),'opening the menu does not move the header').toEqual(titleBefore);
  await photos.click();
  const modal=page.locator('#productImageBatchModal'),dialog=modal.locator('.modal');
  await expect(modal).toHaveClass(/\bopen\b/);await expect(dialog).toBeVisible();await expect(dialog).toBeInViewport();
  await expect(page.locator('#pageInventario details.inv-secondary')).not.toHaveAttribute('open','');
  expect(await dialog.evaluate(d=>Number(getComputedStyle(d).opacity))).toBe(1);
  // ZIP flow through the real file input.
  const gen=await page.context().newPage();const codes=['04692485','01'];
  const datas:string[]=await gen.evaluate(n=>Array.from({length:n},(_,i)=>{const c=document.createElement('canvas');c.width=600;c.height=400;const x=c.getContext('2d')!;x.fillStyle=['#e11d48','#2563eb'][i];x.fillRect(0,0,600,400);return c.toDataURL('image/jpeg',.9);}),codes.length);await gen.close();
  await page.evaluate(()=>{(window as any).eval("productos=[{id:99001,name:'Producto A',sku:'04692485',barcode:'',codigosAlternativos:[],precio:2,costo:1,stock:20,stockMin:2,cat:'abarrotes',icon:'📦',unidad:'unidad',venc:''},{id:99002,name:'Producto B',sku:'01',barcode:'',codigosAlternativos:[],precio:2,costo:1,stock:20,stockMin:2,cat:'abarrotes',icon:'📦',unidad:'unidad',venc:''}]");});
  const zipPath=join(dir,'fotos.zip');await writeFile(zipPath,zip(codes.map((c,i)=>({name:c+'.jpg',data:Buffer.from(datas[i].split(',')[1],'base64')}))));
  const input=page.locator('#productImageBatchFiles');await expect(input).toBeEnabled();await input.setInputFiles(zipPath);
  await expect(page.locator('#productImageBatchStatus')).toContainText('Vinculadas: 2',{timeout:20000});
  await expect(page.locator('#productImageBatchRows tr')).toHaveCount(2);
  const apply=page.locator('#productImageBatchApply');await expect(apply).toBeVisible();await expect(apply).toBeInViewport();
  expect(await topmost(page,'#productImageBatchApply'),'Guardar fotos listas is reachable').toBe(true);
  // ✕ fully closes (no leftover .open), Escape too.
  await modal.locator('.btn-close-m').click();
  await expect(modal).not.toHaveClass(/\bopen\b/);await expect(modal).toBeHidden();
  expect(await page.evaluate(()=>{const e=document.elementFromPoint(innerWidth/2,innerHeight/2);return !!e&&!e.closest('.modal-overlay');}),'no dark overlay left after ✕').toBe(true);
  await summary.click();await photos.click();await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');await expect(modal).not.toHaveClass(/\bopen\b/);await expect(modal).toBeHidden();
  // Page is not left dimmed: the topmost element at the center is page content.
  expect(await page.evaluate(()=>{const e=document.elementFromPoint(innerWidth/2,innerHeight/2);return !!e&&!e.closest('.modal-overlay');})).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('menu closes when clicking elsewhere',async({page})=>{
 await page.setViewportSize({width:1024,height:768});await ownerInventory(page);
 const details=page.locator('#pageInventario details.inv-secondary');await details.locator('summary').click();await expect(details).toHaveAttribute('open','');
 await page.locator('#pageInventario .top-mod-title').click();await expect(details).not.toHaveAttribute('open','');
});
