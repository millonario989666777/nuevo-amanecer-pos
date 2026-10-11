import {test,expect} from '@playwright/test';
// Valid 1px PNG; the previous fixture had an invalid IDAT checksum.
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg2LIAAAIMAVUeX9q0AAAAAElFTkSuQmCC';
async function setup(page:any){
  await page.goto('/index.html');
  await page.waitForFunction('_naFreeSaleShortcutState.ready');
  await page.evaluate("productos=[{id:99001,name:'Producto de prueba',sku:'04692485',barcode:'01',codigosAlternativos:['12345'],precio:2,costo:1,stock:20,stockMin:2,cat:'abarrotes',icon:'📦',unidad:'unidad',venc:'',imagen:''}]");
  await page.evaluate(()=>{
    // Synthetic canonical promotion; no production writes or backend calls.
    (window as any).NuevoAmanecerCanonical={enabled:()=>true,sourceState:()=>({cache:{promotion_id:'image-batch-test'}}),snapshot:()=>{throw new Error('Photo lookup copied the full CANON snapshot');}};
    (window as any)._naAuthorize=()=>true;
    (window as any).securityIsLocked=()=>false;
    // Use the real renderers against a synthetic product.
    (window as any).NuevoAmanecerImageBatch.open();
  });
  await expect(page.locator('#productImageBatchModal')).toBeVisible();
  await expect(page.locator('#productImageBatchStatus')).toContainText('Selecciona');
}
test('CANON image batch previews, persists, resolves and undoes without mutating products',async({page})=>{
  await setup(page);
  const before=await page.evaluate('JSON.stringify(productos)'),code=await page.evaluate('productos[0].sku');
  await page.locator('#productImageBatchFiles').setInputFiles({name:'lote.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,entries:[{codes:[code],image}]}))});
  await expect(page.locator('#productImageBatchStatus')).toContainText('1 fotos listas');
  await page.locator('#productImageBatchReplace').check();
  await expect(page.locator('#productImageBatchStatus')).toContainText('1 fotos listas');
  await page.locator('#productImageBatchApply').click();
  await expect(page.locator('#productImageBatchStatus')).toContainText('1 fotos guardadas y verificadas');
  expect(await page.evaluate('JSON.stringify(productos)')).toBe(before);
  expect(await page.evaluate('NuevoAmanecerImageBatch.source(productos[0])')).toBe(image);
  await expect(page.locator('#invBody img')).toHaveCount(1);
  // The lightweight display URL must contain exactly the original persisted raster bytes.
  await expect(page.locator('#invBody img')).toHaveAttribute('src',/^blob:/);
  const raster=await page.locator('#invBody img').evaluate(async img=>{const blob=await (await fetch(img.src)).blob(),bitmap=await createImageBitmap(blob),width=bitmap.width;bitmap.close();return {width,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};});
  expect(raster.width).toBe(1);expect(Buffer.from(raster.bytes)).toEqual(Buffer.from(image.split(',')[1],'base64'));
  // Reimporting exported bytes stays idempotent.
  await page.locator('#productImageBatchFiles').setInputFiles({name:'otra.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,entries:[{codes:[code],image}]}))});
  await expect(page.locator('#productImageBatchRows')).toContainText('Sin cambios');
  await page.locator('#productImageBatchUndo').click();
  await expect(page.locator('#productImageBatchStatus')).toContainText('restauró');
  expect(await page.evaluate('NuevoAmanecerImageBatch.source(productos[0])')).toBeNull();
  await expect(page.locator('#invBody img')).toHaveCount(0);
  expect(await page.evaluate('JSON.stringify(productos)')).toBe(before);
});
test('a changed stored catalog rejects a stale preview',async({page})=>{
  await setup(page);const code=await page.evaluate('productos[0].sku');
  await page.locator('#productImageBatchFiles').setInputFiles({name:'lote.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,entries:[{codes:[code],image}]}))});
  await expect(page.locator('#productImageBatchStatus')).toContainText('1 fotos listas');
  await page.evaluate(async({code,image})=>{await new Promise<void>((resolve,reject)=>{const r=indexedDB.open('nuevo-amanecer-product-images-v1',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('catalogs','readwrite');tx.objectStore('catalogs').put({entries:[{codes:[code],image}]},'canon:image-batch-test');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});},{code,image});
  await page.locator('#productImageBatchApply').click();
  await expect(page.locator('#productImageBatchStatus')).toContainText('catálogo cambió');
});
