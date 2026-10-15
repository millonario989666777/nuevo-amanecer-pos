import {test,expect,type Page} from '@playwright/test';
test.use({serviceWorkers:'block'});
async function asRole(page:Page,role:'owner'|'empleado'){
 await page.route('**/*',route=>{const url=new URL(route.request().url());
  if(url.hostname==='permissions.test'){let body:any={};if(url.pathname==='/auth/me')body={pos_role:role,owner_pin_set:true,roles_ready:true,device_id:'img-'+role};else if(url.pathname.startsWith('/auth/product-images'))body={status:'ok',version:'v1',images:[],...(role==='owner'?{storage:{used:34000000,cap:40000000}}:{})};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});}
  return url.hostname==='127.0.0.1'?route.continue():route.abort();});
 await page.goto('/index.html');
 await page.evaluate(r=>{localStorage.setItem('na_cloud_sync_credentials',JSON.stringify({endpoint:'https://permissions.test',token:'synthetic'}));localStorage.setItem('na_pos_role_v1',JSON.stringify({role:r}));},role);
 await page.reload();
 await page.waitForFunction(r=>(window as any).NA_ROLES?.role===r&&(window as any).NA_ROLES.confirmed,role);
 await page.waitForFunction('_naFreeSaleShortcutState.ready');
 await page.evaluate(()=>{const w=window as any;w.NA_MENU_NAVIGATION?.navigate?w.NA_MENU_NAVIGATION.navigate('pageInventario'):w.goPage('pageInventario');});
 // Fotos lives under "Más opciones": open it so visibility reflects the role rule only.
 await page.evaluate(()=>document.querySelectorAll('#pageInventario details.inv-secondary').forEach(d=>(d as HTMLDetailsElement).open=true));
 await expect(page.locator('#pageInventario details.inv-secondary').first()).toHaveAttribute('open','');
}
test('employees do not see or open the photo upload UI',async({page})=>{
 await asRole(page,'empleado');
 await expect(page.locator('#invPhotosBtn')).toBeHidden();
 await page.evaluate(()=>(window as any).NuevoAmanecerImageBatch.open());
 await expect(page.locator('#productImageBatchModal')).toBeHidden();
 await expect(page.locator('#productImageBatchFiles')).toBeHidden();
});
test('owner sees the photo manager and an 80% storage warning',async({page})=>{
 await asRole(page,'owner');
 await expect(page.locator('#invPhotosBtn')).toBeVisible();
 await page.evaluate(()=>{const w=window as any;w.NuevoAmanecerCanonical={enabled:()=>true,sourceState:()=>({cache:{promotion_id:'followup'}}),snapshot:()=>{throw Error('x')}};w._naAuthorize=()=>true;w.securityIsLocked=()=>false;});
 await page.evaluate(()=>(window as any).NuevoAmanecerImageBatch.open());
 await expect(page.locator('#productImageBatchModal')).toBeVisible();
 await expect(page.locator('#productImageBatchStorage')).toBeVisible();
 await expect(page.locator('#productImageBatchStorage')).toContainText('85 %');
});
test('inventory escapes product name, SKU and brand',async({page})=>{
 await page.goto('/index.html');await page.waitForFunction('_naFreeSaleShortcutState.ready');
 await page.evaluate(()=>{const w=window as any;w.__xss=0;w.eval(`productos=[{id:5001,name:'<img src=x onerror="window.__xss=1">Malo',sku:'<b>SKU</b>',marca:'<i>M</i>',barcode:'',codigosAlternativos:[],cat:'abarrotes',precio:1,costo:1,stock:5,stockMin:1,unidad:'unidad',icon:'📦',venc:''}]`);w.NA_MENU_NAVIGATION?.navigate?w.NA_MENU_NAVIGATION.navigate('pageInventario'):w.goPage('pageInventario');w._baseInvRender();});
 const row=page.locator('#invBody tr').first();
 await expect(row.locator('.prod-name-sm')).toHaveText('<img src=x onerror="window.__xss=1">Malo');
 await expect(row.locator('.prod-sku-sm')).toContainText('<b>SKU</b>');
 await expect(row.locator('.prod-sku-sm')).toContainText('<i>M</i>');
 await expect(row.locator('.prod-name-sm img, .prod-sku-sm b, .prod-sku-sm i')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__xss)).toBe(0);
});
