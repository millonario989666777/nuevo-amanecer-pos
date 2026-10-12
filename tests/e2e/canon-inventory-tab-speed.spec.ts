import {test,expect} from '@playwright/test';
test.use({serviceWorkers:'block'});
test('408 products with photos and sales change tabs with bounded work',async({page})=>{
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
 await page.evaluate(async()=>{
  window._naAuthorize=()=>true;window.securityIsLocked=()=>false;appConfig.stockAlertActive=true;
  // A real-size raster exposes base64 HTML parsing costs hidden by 1-pixel photos.
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
  const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(256,256);let seed=1;
  for(let i=0;i<pixels.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;pixels.data[i]=seed&255;pixels.data[i+1]=seed>>>8&255;pixels.data[i+2]=seed>>>16&255;pixels.data[i+3]=255;}ctx.putImageData(pixels,0,0);
  productos=Array.from({length:408},(_,i)=>({id:70000+i,name:'Producto '+i,sku:'000'+i,barcode:'1000'+i,codigosAlternativos:['2000'+i],cat:'snacks',precio:2,costo:1,stock:i%3?2:0,stockMin:1,unidad:'unidad',icon:'📦',venc:''}));
  ventas=Array.from({length:1000},(_,i)=>({fecha:obtenerHoy(),items:[{productoId:70000+i%408,cantidad:1}]}));
  const entries=productos.map(p=>{ctx.fillStyle='#'+(p.id%0xffffff).toString(16).padStart(6,'0');ctx.fillRect(0,0,2,2);return {codes:[p.sku],image:canvas.toDataURL('image/jpeg',.65),targetId:String(p.id)};});
  await new Promise<void>((resolve,reject)=>{const req=indexedDB.open('nuevo-amanecer-product-images-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('catalogs');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction('catalogs','readwrite');tx.objectStore('catalogs').put({entries},'local');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  await NuevoAmanecerImageBatch.open();document.getElementById('productImageBatchModal').classList.remove('open');document.getElementById('productImageBatchModal').style.display='none';
  return true;
 });
 await page.evaluate(()=>{
  window.NA_MENU_NAVIGATION.navigate('pageInventario');invRender();
  window.__speedDateReads=0;window.__speedSkuReads=0;window.__speedCategoryReads=0;
  const original=_naF9SaleDate;_naF9SaleDate=function(s){window.__speedDateReads++;return original(s);};
  for(const p of productos){const sku=p.sku,cat=p.cat;Object.defineProperty(p,'sku',{enumerable:true,configurable:true,get(){window.__speedSkuReads++;return sku;}});Object.defineProperty(p,'cat',{enumerable:true,configurable:true,get(){window.__speedCategoryReads++;return cat;}});}return true;
 });
 const before=await page.evaluate(()=>JSON.stringify({productos,ventas}));
 const results=[];
 for(const tab of ['critico','sugerencia','todos','critico','todos']){
  const result=await page.evaluate(async tab=>{
   window.scrollTo(0,0);window.__speedDateReads=0;window.__speedSkuReads=0;window.__speedCategoryReads=0;const start=performance.now();
   invSetTab(document.querySelector(`#pageInventario [onclick*="'${tab}'"]`),tab);
   const syncMs=performance.now()-start;
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   return {tab,syncMs,paintMs:performance.now()-start,dateReads:window.__speedDateReads,skuReads:window.__speedSkuReads,categoryReads:window.__speedCategoryReads,htmlBytes:document.getElementById('invBody').innerHTML.length};
  },tab);
  results.push(result);
  if(tab==='sugerencia'){await expect(page.locator('.purchase-summary')).toBeVisible();expect(await page.locator('.purchase-card').count()).toBeLessThanOrEqual(48);}
  else {expect(await page.locator('#invBody .inv-product-menu').count()).toBeLessThanOrEqual(48);await expect(page.locator('#invBody img').first()).toHaveAttribute('loading','lazy');await expect(page.locator('#invBody img').first()).toHaveAttribute('decoding','async');}
 }
 console.log('INVENTORY_TAB_TIMINGS',JSON.stringify(results));
 for(const result of results){expect(result.dateReads).toBe(1000);expect(result.skuReads).toBeLessThan(5000);expect(result.categoryReads).toBeLessThan(5000);expect(result.htmlBytes).toBeLessThan(1000000);}
 await expect.poll(()=>page.locator('#invBody img').first().evaluate(img=>img.naturalWidth)).toBe(256);
 // All products and their original actions remain reachable by continuous scrolling.
 for(let i=0;i<20&&await page.locator('#invBody .inv-product-menu').count()<408;i++){
  const count=await page.locator('#invBody .inv-product-menu').count();
  await page.locator('#invBody tr').last().scrollIntoViewIfNeeded();
  if(count<408)await expect.poll(()=>page.locator('#invBody .inv-product-menu').count()).toBeGreaterThan(count);
 }
 await expect(page.locator('#invBody .inv-product-menu')).toHaveCount(408);
 await expect(page.locator('#invBody .btn-edt')).toHaveCount(408);
 expect(await page.locator('#invBody .prod-name-sm').allTextContents()).toEqual(Array.from({length:408},(_,i)=>'Producto '+i));
 expect(await page.evaluate(()=>JSON.stringify({productos,ventas}))).toBe(before);
 // In-place code edits must immediately invalidate the render-local photo map.
 await page.evaluate(()=>{Object.defineProperty(productos[1],'sku',{value:productos[0].sku,enumerable:true,writable:true,configurable:true});invRender();});
 await expect(page.locator('#invBody tr').filter({has:page.getByText('Producto 0',{exact:true})}).locator('img')).toHaveCount(0);
 await expect(page.locator('#invBody tr').filter({has:page.getByText('Producto 1',{exact:true})}).locator('img')).toHaveCount(0);
 // An observer from the previous list must not append stale rows after changing filters.
 await page.locator('#invSearch').fill('Producto 407');await expect(page.locator('#invBody .prod-name-sm')).toHaveCount(1);await expect(page.locator('#invBody .prod-name-sm')).toHaveText('Producto 407');
 await page.locator('#invBody tr').last().scrollIntoViewIfNeeded();await expect(page.locator('#invBody .prod-name-sm')).toHaveCount(1);
 await page.locator('#invSearch').fill('');await page.evaluate(()=>{window.scrollTo(0,0);invSetTab(document.querySelector("[onclick*=\"'sugerencia'\"]"),'sugerencia');});
 for(let i=0;i<10&&await page.locator('.purchase-card').count()<136;i++){
  const count=await page.locator('.purchase-card').count();await page.locator('.purchase-card').last().scrollIntoViewIfNeeded();
  if(count<136)await expect.poll(()=>page.locator('.purchase-card').count()).toBeGreaterThan(count);
 }
 await expect(page.locator('.purchase-card')).toHaveCount(136);await expect(page.locator('.purchase-detail-btn')).toHaveCount(136);
});
