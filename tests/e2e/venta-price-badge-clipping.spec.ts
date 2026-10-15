import {test,expect} from '@playwright/test';
test.use({serviceWorkers:'block'});
for(const vp of [{width:390,height:844},{width:1024,height:768},{width:1024,height:1366}])test(`Venta price badge stays inside its card at ${vp.width}x${vp.height}`,async({page})=>{
 await page.setViewportSize(vp);await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto('/index.html');await page.waitForFunction('_naFreeSaleShortcutState.ready');
 for(const mayor of [false,true]){
  await page.evaluate(m=>{const w=window as any;w.eval(`productos.unshift({id:991001,name:'Producto precio largo',sku:'PL1',barcode:'PL1',codigosAlternativos:[],cat:'abarrotes',precio:12345.5,precioCaja:98765.4,unidCaja:24,costo:1,stock:9,stockMin:1,unidad:'unidad',icon:'📦',venc:''});modoMayorista=${m};`);w.NA_MENU_NAVIGATION?.navigate?w.NA_MENU_NAVIGATION.navigate('pagePOS'):w.goPage('pagePOS');w.posRender();},mayor);
  await expect(page.locator('#pagePOS .product-card .p-price-badge').first()).toBeVisible();
  const bad=await page.evaluate(()=>{const area=document.getElementById('posArea')!.getBoundingClientRect();const cards=[...document.querySelectorAll('#pagePOS .product-card')].slice(0,12);const out:string[]=[];for(const c of cards){const b=c.querySelector('.p-price-badge');if(!b)continue;const cr=c.getBoundingClientRect(),br=b.getBoundingClientRect();if(br.width&&(br.left<cr.left-0.5||br.right>cr.right+0.5||br.left<area.left-0.5))out.push(`${(b as HTMLElement).innerText} badge ${br.left.toFixed(1)}-${br.right.toFixed(1)} card ${cr.left.toFixed(1)}-${cr.right.toFixed(1)}`);}return out;});
  expect(bad,`mayorista=${mayor}`).toEqual([]);
  await page.evaluate(()=>{(window as any).eval('productos.shift()');});
 }
});
