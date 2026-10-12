import {test,expect,type Page} from '@playwright/test';

test.use({hasTouch:true});
test.beforeEach(async({page})=>{
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
});

async function phoneSaleWithItem(page:Page,width=390){
 await page.setViewportSize({width,height:844});
 await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`productos=[{id:'SPD-1',name:'Agua de prueba',precio:3.5,costo:1,stock:10,cat:'bebidas'}];cart=[];posRender();`));
 await page.locator('#posPhoneAdd').click();
 await page.locator('#posSearch').fill('Agua');
 await page.locator('[data-product-id="SPD-1"]').click();
 await page.locator('#posPhoneCatalogClose').click();
 await expect(page.locator('#posTotal')).toHaveText('S/ 3.50');
}

test('P0-2: OCR, catálogo de referencia y SheetJS no se descargan al abrir; OCR carga al pedirlo',async({page})=>{
 const requested:string[]=[];
 page.on('request',r=>requested.push(new URL(r.url()).pathname));
 await page.setViewportSize({width:390,height:844});
 await page.goto('/index.html');
 await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
 expect(requested.some(p=>/\/js\/ocr\/|reference-catalog-data\.js/.test(p))).toBe(false);
 expect(await page.evaluate(()=>typeof extractPurchaseDocument)).toBe('undefined');
 expect(await page.evaluate(()=>typeof XLSX)).toBe('undefined');
 await page.evaluate(()=>{window.NA_MENU_NAVIGATION.navigate('pageInventario');invRender();});
 await page.getByRole('button',{name:'OCR compras',exact:true}).click();
 await page.waitForFunction(()=>typeof extractPurchaseDocument==='function'&&NuevoAmanecerLazyAssets.loaded('ocr'),null,{timeout:30000});
 expect(requested.some(p=>p.endsWith('reference-catalog-data.js'))).toBe(true);
 await expect(page.getByRole('button',{name:'Subir PDF o documento',exact:true})).toBeVisible();
});

for(const width of [320,360,390]) test(`P0-1 ${width}: el aviso de versión no tapa Cobrar y "Más tarde" lo oculta`,async({page})=>{
 await phoneSaleWithItem(page,width);
 await page.evaluate(()=>{const p=document.getElementById('pwaUpdatePrompt')!;p.dataset.state='ready';p.hidden=false;});
 await expect(page.locator('#pwaUpdatePrompt')).toBeVisible();
 const free=await page.evaluate(()=>{const b=document.getElementById('btnPagar')!.getBoundingClientRect();const el=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);const p=document.getElementById('pwaUpdatePrompt')!.getBoundingClientRect();return {hit:!!el&&!!el.closest('#btnPagar'),overlap:!(p.bottom<=b.top||p.top>=b.bottom||p.right<=b.left||p.left>=b.right)};});
 expect(free).toEqual({hit:true,overlap:false});
 const later=page.locator('#pwaUpdateLater');
 await expect(later).toBeVisible();
 const box=(await later.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);
 await later.click();
 await expect(page.locator('#pwaUpdatePrompt')).toBeHidden();
 await expect(page.locator('#posTotal')).toHaveText('S/ 3.50');
});

test('P0-1 escritorio: el aviso no tapa Pagar',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>{const p=document.getElementById('pwaUpdatePrompt')!;p.dataset.state='ready';p.hidden=false;});
 const hit=await page.evaluate(()=>{const b=document.getElementById('btnPagar')!.getBoundingClientRect();const el=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return !!el&&!!el.closest('#btnPagar');});
 expect(hit).toBe(true);
});

test('P1-4: un solo botón de menú, 44×44, abre el menú',async({page})=>{
 await phoneSaleWithItem(page,390);
 const toggle=page.locator('#naMobileMenuToggle');
 await expect(toggle).toBeVisible();
 const box=(await toggle.boundingBox())!;
 expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
 const topHit=await page.evaluate(({x,y})=>{const el=document.elementFromPoint(x,y);return el&&el.closest('#naMobileMenuToggle')?'toggle':(el&&el.id||el&&el.className);},{x:box.x+box.width/2,y:box.y+box.height/2});
 expect(topHit).toBe('toggle');
 const overlapping=await page.evaluate(()=>{const t=document.getElementById('naMobileMenuToggle')!.getBoundingClientRect();return [...document.querySelectorAll('.g-topbar button,.g-topbar a')].filter(e=>e.id!=='naMobileMenuToggle'&&(e as HTMLElement).offsetParent!==null).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&!(r.right<=t.left||r.left>=t.right||r.bottom<=t.top||r.top>=t.bottom);}).map(e=>e.id||e.className);});
 expect(overlapping).toEqual([]);
 await toggle.click();
 await expect(page.locator('body')).toHaveClass(/na-mobile-drawer-open/);
});

test('táctil: controles del carrito en móvil miden al menos 44 px',async({page})=>{
 await phoneSaleWithItem(page,360);
 const sizes=await page.evaluate(()=>{const out:Record<string,number[]>={};for(const sel of ['[data-na-cart-action="increase"]','[data-na-cart-action="decrease"]','#cartItems .btn-rm','#btnCartMenu','#backBtn']){const el=document.querySelector(sel) as HTMLElement|null;if(!el||!el.offsetParent)continue;const r=el.getBoundingClientRect();out[sel]=[Math.round(r.width),Math.round(r.height)];}return out;});
 expect(Object.keys(sizes).length).toBeGreaterThanOrEqual(2);
 for(const [sel,[w,h]] of Object.entries(sizes)){expect(w,sel).toBeGreaterThanOrEqual(44);expect(h,sel).toBeGreaterThanOrEqual(44);}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('el comprobante para compartir queda sobre la hoja de cliente',async({page})=>{
 await page.goto('/index.html');
 const z=await page.evaluate(()=>{const o=document.createElement('div');o.className='na-receipt-overlay';document.body.appendChild(o);const v=Number(getComputedStyle(o).zIndex);o.remove();return v;});
 expect(z).toBeGreaterThan(1200);expect(z).toBeLessThan(4000);
});
