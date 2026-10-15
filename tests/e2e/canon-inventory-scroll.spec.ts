import {test,expect} from '@playwright/test';
for(const width of [360,390,430,701,767])for(const tab of ['todos','sugerencia'])test('inventory chrome remains stable while scrolling '+tab+' '+width,async({page})=>{
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.setViewportSize({width,height:844});await page.goto('/index.html?na-test=1');
 await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
 await page.evaluate((tab)=>{productos=Array.from({length:40},(_,i)=>({id:987000+i,name:'Producto '+i,sku:'test'+i,cat:'snacks',precio:2,costo:1,stock:0,stockMin:3,unidad:'unidad',icon:'📦'}));window.NA_MENU_NAVIGATION.navigate('pageInventario');invRender();if(tab==='sugerencia')invSetTab(document.querySelector('[onclick*="sugerencia"]'),'sugerencia');},tab);
 await expect(page.locator('#pageInventario')).toHaveClass(/inv-mobile-simple/);
 const height=await page.locator('#pageInventario>.page-chrome').evaluate(el=>el.getBoundingClientRect().height);
 const before=await page.evaluate(()=>JSON.stringify(productos));
 for(const y of [150,400,800,600,250,0]){
  await page.evaluate(y=>window.scrollTo(0,y),y);
  await expect(page.locator('#pageInventario>.page-chrome')).toBeVisible();
  await expect.poll(()=>page.locator('#pageInventario>.page-chrome').evaluate(el=>el.getBoundingClientRect().height)).toBeCloseTo(height,1);
  await expect(page.locator('.g-topbar')).not.toHaveClass(/g-topbar-hidden/);
 }
 expect(await page.evaluate(()=>JSON.stringify(productos))).toBe(before);
 await expect(page.locator('#invCat')).toBeVisible();await expect(page.locator('.inv-sticky-controls')).toBeVisible();
 await page.setViewportSize({width:768,height:844});
 // Etapa 2: en tablet Inventario tampoco oculta la cabecera (evita el salto del primer gesto).
 await expect.poll(()=>page.evaluate(()=>window._naTopbarGesture.isActive())).toBe(false);
 await page.setViewportSize({width,height:844});
 await expect.poll(()=>page.evaluate(()=>window._naTopbarGesture.isActive())).toBe(false);
 await expect(page.locator('#pageInventario>.page-chrome')).toBeVisible();
});
