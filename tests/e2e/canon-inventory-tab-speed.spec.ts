import {test,expect} from '@playwright/test';
test.use({serviceWorkers:'block'});
test('408 products with photos and sales change tabs with bounded work',async({page})=>{
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
 await page.evaluate(async()=>{
  window._naAuthorize=()=>true;window.securityIsLocked=()=>false;appConfig.stockAlertActive=true;
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT3sAAAAASUVORK5CYII=';
  productos=Array.from({length:408},(_,i)=>({id:70000+i,name:'Producto '+i,sku:'000'+i,barcode:'1000'+i,codigosAlternativos:['2000'+i],cat:'snacks',precio:2,costo:1,stock:i%3?2:0,stockMin:1,unidad:'unidad',icon:'📦',venc:''}));
  ventas=Array.from({length:1000},(_,i)=>({fecha:obtenerHoy(),items:[{productoId:70000+i%408,cantidad:1}]}));
  const entries=productos.map(p=>({codes:[p.sku],image,targetId:String(p.id)}));
  await new Promise<void>((resolve,reject)=>{const req=indexedDB.open('nuevo-amanecer-product-images-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('catalogs');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction('catalogs','readwrite');tx.objectStore('catalogs').put({entries},'local');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  await NuevoAmanecerImageBatch.open();document.getElementById('productImageBatchModal').classList.remove('open');document.getElementById('productImageBatchModal').style.display='none';
  return true;
 });
 await page.evaluate(()=>{
  window.NA_MENU_NAVIGATION.navigate('pageInventario');invRender();
  window.__speedDateReads=0;window.__speedSkuReads=0;
  const original=_naF9SaleDate;_naF9SaleDate=function(s){window.__speedDateReads++;return original(s);};
  for(const p of productos){const sku=p.sku;Object.defineProperty(p,'sku',{enumerable:true,configurable:true,get(){window.__speedSkuReads++;return sku;}});}return true;
 });
 const before=await page.evaluate(()=>JSON.stringify({productos,ventas}));
 const results=[];
 for(const tab of ['critico','sugerencia','todos','critico','todos']){
  const result=await page.evaluate(async tab=>{
   window.__speedDateReads=0;window.__speedSkuReads=0;const start=performance.now();
   invSetTab(document.querySelector(`#pageInventario [onclick*="'${tab}'"]`),tab);
   const syncMs=performance.now()-start;
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   return {tab,syncMs,paintMs:performance.now()-start,dateReads:window.__speedDateReads,skuReads:window.__speedSkuReads};
  },tab);
  results.push(result);
  if(tab==='sugerencia')await expect(page.locator('.purchase-summary')).toBeVisible();
  else {await expect(page.locator('#invBody .inv-product-menu')).toHaveCount(tab==='todos'?408:136);await expect(page.locator('#invBody img')).toHaveCount(tab==='todos'?408:136);await expect(page.locator('#invBody img').first()).toHaveAttribute('loading','lazy');await expect(page.locator('#invBody img').first()).toHaveAttribute('decoding','async');}
 }
 console.log('INVENTORY_TAB_TIMINGS',JSON.stringify(results));
 for(const result of results){expect(result.dateReads).toBe(1000);expect(result.skuReads).toBeLessThan(5000);}
 expect(await page.evaluate(()=>JSON.stringify({productos,ventas}))).toBe(before);
 // In-place code edits must immediately invalidate the render-local photo map.
 await page.evaluate(()=>{Object.defineProperty(productos[1],'sku',{value:productos[0].sku,enumerable:true,writable:true,configurable:true});invRender();});
 await expect(page.locator('#invBody tr').filter({has:page.getByText('Producto 0',{exact:true})}).locator('img')).toHaveCount(0);
 await expect(page.locator('#invBody tr').filter({has:page.getByText('Producto 1',{exact:true})}).locator('img')).toHaveCount(0);
});
