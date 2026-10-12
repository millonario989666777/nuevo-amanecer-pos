import {test,expect} from '@playwright/test';

test.use({hasTouch:true});
test.beforeEach(async({page})=>{
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
});
for(const width of [320,360,390,430]) test(`phone sale ${width}: hidden catalog and real cart controls`,async({page})=>{
 await page.setViewportSize({width,height:844});
 await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await expect(page.locator('#cartItems')).toBeVisible();
 await expect(page.locator('#posArea')).toBeHidden();
 await expect(page.locator('#posPhoneAdd')).toBeVisible();
 await expect(page.locator('#posPhoneAccount')).toBeHidden();
 await page.evaluate(()=>window.eval(`productos=[{id:'PHONE-1',name:'Agua de prueba',precio:3.5,costo:1,stock:10,cat:'bebidas'}];cart=[];posRender();`));
 await page.locator('#posPhoneAdd').click();
 await expect(page.locator('#posPhoneCatalog')).toBeVisible();
 await page.locator('#posSearch').fill('Agua');
 await page.locator('[data-product-id="PHONE-1"]').click();
 await page.locator('#posPhoneCatalogClose').click();
 await expect(page.locator('#posTotal')).toHaveText('S/ 3.50');
 await page.locator('[data-na-cart-action="increase"]').click();
 await expect(page.locator('#posTotal')).toHaveText('S/ 7.00');
 await expect(page.locator('#posPhonePayLabel')).toHaveText('Cobrar S/ 7.00');
 await expect(page.locator('#posCustomerButton')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#posPhoneScan').click();
 await expect(page.locator('#posPhoneCamera')).toBeVisible();
 await expect(page.locator('#posPhoneCameraStatus')).toContainText('cámara');
 await page.locator('#posPhoneCameraClose').click();
 await expect(page.locator('#posPhoneCamera')).toBeHidden();
});
for(const width of [768,1024,1366,1920]) test(`tablet / PC ${width} keeps catalog`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await expect(page.locator('#posSearch')).toBeVisible();
 await expect(page.locator('#posArea')).toBeVisible();
 await expect(page.locator('#posPhoneAdd')).toBeHidden();
 await expect(page.locator('#btnPagar')).toContainText('Pagar');
});

test('phone selects a real customer; credit account appears only for assigned line; VARIOS modal is accessible',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`clientes=[{id:'PHONE-C',nombre:'Cliente prueba',lineaCreditoManualActiva:false}];`));
 await page.locator('#posCustomerButton').click();
 await page.locator('.na-client-picker-row').filter({hasText:'Cliente prueba'}).click();
 await expect(page.locator('#posCustomer')).toHaveText('Cliente prueba');
 await expect(page.locator('#posPhoneAccount')).toBeHidden();
 await page.evaluate(()=>window.eval(`clientes[0].lineaCreditoManualActiva=true;clientes[0].lineaCreditoManual=100;document.getElementById('mVentaCliente').dispatchEvent(new Event('change'));`));
 await expect(page.locator('#posPhoneAccount')).toBeVisible();
 await page.locator('#posPhoneAdd').click();await page.locator('#btnVentaLibre').click();
 await expect(page.locator('#posPhoneCatalog')).toBeHidden();
 await expect(page.locator('#mVentaLibre')).toBeVisible();
 await page.locator('#vlNombre').fill('Prueba manual');
});

test('camera reads barcode once through existing stock-aware handler and stops tracks',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{
  (window as any).phoneStopped=0;
  (window as any).BarcodeDetector=class {static async getSupportedFormats(){return ['ean_13'];}async detect(){return [{rawValue:'7750000000001'}];}};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{(window as any).phoneStopped++;}}]})}});
  Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{get(){return null;},set(){},configurable:true});
  HTMLMediaElement.prototype.play=async()=>{};
 });
 await page.goto('/index.html');await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`productos=[{id:'CAM-1',name:'Escaneo prueba',barcode:'7750000000001',precio:4,costo:1,stock:10,cat:'bebidas'}];cart=[];posRender();`));
 await page.locator('#posPhoneScan').click();
 await expect(page.locator('#posTotal')).toHaveText('S/ 4.00');
 await expect(page.locator('.cart-item')).toHaveCount(1);
 await expect(page.locator('.qty-num')).toHaveText('1');
 await expect(page.locator('#posPhoneCamera')).toBeHidden();
 expect(await page.evaluate(()=>(window as any).phoneStopped)).toBe(1);
});

test('closing camera while permission is pending stops late stream without adding products',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{
  (window as any).phoneStopped=0;
  (window as any).BarcodeDetector=class {static async getSupportedFormats(){return ['ean_13'];}async detect(){throw new Error('must not detect');}};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise(resolve=>{(window as any).grantPhoneCamera=()=>resolve({getTracks:()=>[{stop:()=>{(window as any).phoneStopped++;}}]});})}});
 });
 await page.goto('/index.html');await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.locator('#posPhoneScan').click();
 await page.waitForFunction(()=>typeof (window as any).grantPhoneCamera==='function');
 await page.locator('#posPhoneCameraClose').click();
 await page.evaluate(()=>(window as any).grantPhoneCamera());
 await expect.poll(()=>page.evaluate(()=>(window as any).phoneStopped)).toBe(1);
 await expect(page.locator('.cart-item')).toHaveCount(0);
});

test('phone payment stays inside changing visual viewport, including keyboard and credit account',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{
  const viewport=new EventTarget();
  Object.assign(viewport,{height:760,offsetTop:0,scale:1});
  Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
  (window as any).setPhoneVisibleArea=(height:number,offsetTop=0)=>{
   Object.assign(viewport,{height,offsetTop});viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'));
  };
 });
 await page.goto('/index.html');await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`clientes=[{id:'VIEW-C',nombre:'Crédito prueba',lineaCreditoManualActiva:true,lineaCreditoManual:100}];document.getElementById('mVentaCliente').innerHTML='<option value="VIEW-C" selected>Crédito prueba</option>';document.getElementById('mVentaCliente').dispatchEvent(new Event('change'));`));
 await expect(page.locator('#posPhoneAccount')).toBeVisible();
 for(const [height,top] of [[760,0],[680,0],[400,35],[760,0]]){
  await page.evaluate(([h,t])=>(window as any).setPhoneVisibleArea(h,t),[height,top]);
  await expect.poll(async()=>{const r=await page.locator('#btnPagar').boundingBox();return !!r&&r.y>=top&&r.y+r.height<=height+top-8;}).toBe(true);
  const r=await page.locator('#btnPagar').boundingBox();
  expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('#btnPagar'),{x:r!.x+r!.width/2,y:r!.y+r!.height/2})).toBe(true);
 }
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pageClientes'));
 await expect(page.locator('#pageClientes')).toBeVisible();
 expect(await page.locator('#pageClientes').evaluate(el=>getComputedStyle(el).position)).not.toBe('fixed');
});

for(const width of [320,390,430]) test(`long customer name ${width} keeps add and scanner fully visible`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 const name='ALCY STALIM CASTRO PONCE Y APELLIDO EXTRA LARGO';
 await page.evaluate(name=>window.eval(`clientes=[{id:'LONG-C',nombre:${JSON.stringify(name)}}];`),name);
 await page.locator('#posCustomerButton').click();
 await page.locator('.na-client-picker-row').filter({hasText:name}).click();
 await expect(page.locator('#posCustomer')).toHaveText(name);
 for(const id of ['posCustomerButton','posPhoneAdd','posPhoneScan']){
  const box=await page.locator('#'+id).boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(({x,y,id})=>!!document.elementFromPoint(x,y)?.closest('#'+id),{x:box!.x+box!.width/2,y:box!.y+box!.height/2,id})).toBe(true);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#posPhoneScan').click();await expect(page.locator('#posPhoneCamera')).toBeVisible();await page.locator('#posPhoneCameraClose').click();
 await page.locator('#posPhoneAdd').click();await expect(page.locator('#posPhoneCatalog')).toBeVisible();await page.locator('#posPhoneCatalogClose').click();
 await page.locator('#posCustomerButton').click();await expect(page.locator('.na-client-picker-row').filter({hasText:name})).toBeVisible();
});

for(const width of [320,390,430]) test(`phone catalog ${width}: dropdown categories, three columns, bounded photos and vertical scroll`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto('/index.html');await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`productos=Array.from({length:36},(_,i)=>({id:'GRID-'+i,name:i%2?'Producto de nombre largo prueba':'Agua prueba',precio:3.5,costo:1,stock:10,cat:i%2?'snacks':'bebidas',imagen:(()=>{const c=document.createElement('canvas');c.width=i%2?1200:80;c.height=i%2?80:1200;c.getContext('2d').fillRect(0,0,c.width,c.height);return c.toDataURL('image/png');})()}));cart=[];posRender();`));
 await page.locator('#posPhoneAdd').click();
 await expect(page.locator('#posPhoneCategories')).toHaveText(/Todo/);
 await expect(page.locator('#posSidebar')).toBeHidden();
 await expect(page.locator('#btnMayorista')).toBeVisible();
 const actions=await page.locator('#btnVentaLibre,#btnMayorista,#posPhoneCategories').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));expect(Math.max(...actions)-Math.min(...actions)).toBeLessThan(2);
 await page.locator('#posPhoneCategories').click();await expect(page.locator('#posSidebar')).toBeVisible();
 await page.locator('#posSidebar [data-cat="bebidas"]').click();await expect(page.locator('#posSidebar')).toBeHidden();await expect(page.locator('#posPhoneCategories')).toContainText('Bebidas');await expect(page.locator('#posArea .product-card')).toHaveCount(18);
 await page.locator('#posPhoneCategories').click();await page.locator('#posSidebar [data-cat="todo"]').click();await expect(page.locator('#posArea .product-card')).toHaveCount(36);
 const metrics=await page.locator('#posArea').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,scroll:el.scrollHeight>el.clientHeight,horizontal:el.scrollWidth>el.clientWidth}));expect(metrics).toEqual({columns:3,scroll:true,horizontal:false});
 const images=await page.locator('#posArea .p-img').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(),im=n.querySelector('img')!,ir=im.getBoundingClientRect();return {w:r.width,h:r.height,contain:getComputedStyle(im).objectFit,inside:ir.x>=r.x&&ir.y>=r.y&&ir.right<=r.right&&ir.bottom<=r.bottom};}));
 expect(new Set(images.map(x=>x.w+':'+x.h)).size).toBe(1);
 expect(images.every(x=>x.w>=58&&x.w<=72&&x.w===x.h&&x.contain==='contain'&&x.inside)).toBe(true);
 const photoLayout=await page.locator('#posArea .product-card').evaluateAll(cards=>cards.map(card=>{
  const box=card.getBoundingClientRect(),photo=card.querySelector('.p-img')!.getBoundingClientRect(),name=card.querySelector('.p-name')!.getBoundingClientRect(),stock=card.querySelector('.p-stock-badge')!.getBoundingClientRect();
  return {photoInside:photo.left>=box.left&&photo.right<=box.right,photoAboveName:photo.bottom<=name.top+1,stockBelowName:stock.top>=name.bottom-1};
 }));
 expect(photoLayout.every(card=>card.photoInside&&card.photoAboveName&&card.stockBelowName)).toBe(true);
 await page.locator('#posArea').evaluate(el=>{el.scrollTop=el.scrollHeight});expect(await page.locator('#posArea').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 await page.locator('[data-product-id="GRID-35"]').click();await expect(page.locator('#posTotal')).toHaveText('S/ 3.50');
});

for(const width of [320,360,390,430]) test(`phone checkout ${width}: footer stays within visible viewport`,async({page})=>{
 await page.setViewportSize({width,height:844});
 await page.addInitScript(()=>{
  const viewport=new EventTarget();Object.assign(viewport,{height:760,offsetTop:0,scale:1});
  Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
  (window as any).resizeCheckout=(height:number,offsetTop:number)=>{Object.assign(viewport,{height,offsetTop});viewport.dispatchEvent(new Event('resize'));};
 });
 await page.goto('/index.html');await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'CHECK',name:'Prueba',precio:1,qty:1}];posPayM='efectivo';document.getElementById('mMontoRec').value='1';_naRenderCashQuickOptions(1);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 for(const [height,top] of [[760,0],[500,0],[340,35],[760,0]]){
  await page.evaluate(([h,t])=>(window as any).resizeCheckout(h,t),[height,top]);
  await expect.poll(async()=>{const b=await page.locator('#mBtnConf').boundingBox();return !!b&&b.y>=top&&b.y+b.height<=top+height-8;}).toBe(true);
  const b=await page.locator('#mBtnConf').boundingBox();
  expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('#mBtnConf'),{x:b!.x+b!.width/2,y:b!.y+b!.height/2})).toBe(true);
 }
 await expect(page.locator('#mCashInlineNote')).toBeHidden();await expect(page.locator('#mPaymentHint')).toContainText('Monto exacto');
 await expect(page.locator('#mMontoRec')).toBeVisible();
 await page.locator('#mMontoRec').fill('5');await expect(page.locator('#mCambio')).toHaveText('S/ 4.00');
 await page.locator('#mCobro [data-method="yape"]').click();await expect(page.locator('#mDigitalVerified')).toBeVisible();
 await expect(page.locator('#mPaymentHint')).toContainText('verificaste');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('phone credit reuses the sale customer without repeating customer or category controls',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`clientes=[{id:'CREDIT-START',nombre:'Cliente elegido al inicio',lineaCreditoManualActiva:true,lineaCreditoManual:100},{id:'CREDIT-SECOND',nombre:'Segundo cliente',lineaCreditoManualActiva:true,lineaCreditoManual:100}];productos=[{id:'CREDIT-PRODUCT',name:'Producto prueba',precio:5,costo:1,stock:10,cat:'bebidas'}];cart=[{id:'CREDIT-PRODUCT',name:'Producto prueba',precio:5,qty:1}];cajEstado={abierta:true,cerrada:false,fechaApertura:obtenerHoy()};posUpdateCart(false);posRender();`));
 await page.locator('#posCustomerButton').click();
 await page.locator('.na-client-picker-row').filter({hasText:'Cliente elegido al inicio'}).click();
 await page.evaluate(()=>window.eval(`abrirCobro();`));
 await page.locator('#mCobro [data-method="credito"]').click();
 await expect(page.locator('#mCreditoCliente')).toHaveValue('CREDIT-START');
 await expect(page.locator('#mCreditoClienteSearchTrigger').locator('xpath=..')).toBeHidden();
 await expect(page.locator('#mClienteDetails')).toBeHidden();
 await expect(page.locator('#mCreditoSection')).not.toContainText('¿Dónde registrar esta venta?');
 await expect(page.locator('#mCreditoSection .na-credit-destination-options')).toHaveCount(0);
 await expect(page.locator('#mCreditoSection .na-credit-new-category')).toHaveCount(0);
 expect(await page.evaluate(()=>({accountId:NA_CLIENT_CREDIT_ACCOUNTS_V2.saleDraft()?.account.account_id,defaultId:NA_CLIENT_CREDIT_ACCOUNTS_V2.smallAccountId}))).toMatchObject({accountId:'small',defaultId:'small'});
 await page.locator('#mCobro [data-method="efectivo"]').click();
 await expect(page.locator('#mClienteDetails')).toBeHidden();
 await page.locator('#mCobro .pay-modal-footer .pay-btn-secondary').click();
 await page.locator('#posCustomerButton').click();
 await page.locator('.na-client-picker-row').filter({hasText:'Segundo cliente'}).click();
 await expect(page.locator('#posCustomer')).toHaveText('Segundo cliente');
 await page.evaluate(()=>window.eval(`abrirCobro();`));
 await page.locator('#mCobro [data-method="credito"]').click();
 await expect(page.locator('#mCreditoCliente')).toHaveValue('CREDIT-SECOND');
 await expect(page.locator('#mClienteDetails')).toBeHidden();
 await page.evaluate(()=>window.eval(`cerrarModal('mCobro');document.getElementById('mCreditoCliente').value='CREDIT-START';document.getElementById('mCreditoCliente').dispatchEvent(new Event('change',{bubbles:true}));abrirCobro();`));
 await expect(page.locator('#mCreditoCliente')).toHaveValue('');
});

test('phone credit keeps one picker when no customer was selected at sale start',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`clientes=[{id:'CREDIT-ONLY',nombre:'Cliente de crédito',lineaCreditoManualActiva:true,lineaCreditoManual:100}];productos=[{id:'CREDIT-PRODUCT',name:'Producto prueba',precio:5,costo:1,stock:10,cat:'bebidas'}];cart=[{id:'CREDIT-PRODUCT',name:'Producto prueba',precio:5,qty:1}];cajEstado={abierta:true,cerrada:false,fechaApertura:obtenerHoy()};posUpdateCart(false);posRender();`));
 await page.evaluate(()=>window.eval(`abrirCobro();`));
 await page.locator('#mCobro [data-method="credito"]').click();
 await expect(page.locator('#mClienteDetails')).toBeHidden();
 await expect(page.locator('#mCreditoClienteSearchTrigger').locator('xpath=..')).toBeVisible();
 await page.locator('#mCreditoClienteSearchTrigger').click();
 await page.locator('.na-client-picker-row').filter({hasText:'Cliente de crédito'}).click();
 await expect(page.locator('#mCreditoCliente')).toHaveValue('CREDIT-ONLY');
 await expect(page.locator('#mCreditoClienteSearchTrigger').locator('xpath=..')).toBeHidden();
 await expect(page.locator('#mVentaCliente')).toHaveValue('CREDIT-ONLY');
 await page.locator('#mCobro [data-method="efectivo"]').click();
 await expect(page.locator('#mClienteDetails')).toBeHidden();
});

test('phone checkout groups digital payments while retaining the selected channel',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'DIGITAL-CHECK',name:'Producto prueba',precio:5,qty:1}];posPayM='efectivo';document.getElementById('mCobro').classList.add('open');`));
 await expect(page.locator('#mCobro .pay-methods [data-method]')).toHaveCount(4);
 await expect(page.locator('#mCobro .pay-methods [data-method="transferencia"]')).toHaveCount(0);
 await page.locator('#mCobro .pay-methods [data-digital-group]').click();
 await expect(page.locator('#mDigitalSection')).toBeVisible();
 // Ítem 3: Yape y Plin son métodos separados.
 await expect(page.locator('#mDigitalChannels')).toContainText('Yape');
 await expect(page.locator('#mDigitalChannels')).toContainText('Plin');
 await expect(page.locator('#mDigitalChannels')).toContainText('Transferencia');
 await page.locator('#mDigitalChannels [data-digital-method="transferencia"]').click();
 expect(await page.evaluate(()=>posPayM)).toBe('transferencia');
 await expect(page.locator('#mCobro .pay-methods [data-digital-group]')).toHaveClass(/active/);
 await page.locator('#mDigitalChannels [data-digital-method="yape"]').click();
 expect(await page.evaluate(()=>posPayM)).toBe('yape');
 await page.locator('#mDigitalChannels [data-digital-method="plin"]').click();
 expect(await page.evaluate(()=>posPayM)).toBe('plin');
});

for(const width of [320,360,390,430]) test(`phone checkout reference layout ${width}: three method cards and cash change are visible`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'CASH-REF',name:'Producto de prueba',precio:9.5,qty:1}];posPayM='efectivo';document.getElementById('mCobroTotal').textContent='S/ 9.50';document.getElementById('mMontoRec').value='9.50';_naRenderCashQuickOptions(9.5);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 const row=await page.locator('#mCobro .pay-methods [data-method="efectivo"],#mCobro .pay-methods [data-digital-group],#mCobro .pay-methods [data-method="credito"]').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));
 expect(row).toHaveLength(3);
 expect(row.every(r=>r.width>0&&r.height>0)).toBe(true);
 expect(Math.max(...row.map(r=>r.y))-Math.min(...row.map(r=>r.y))).toBeLessThan(2);
 await expect(page.locator('#mCashAdvanced')).toBeVisible();
 await expect(page.locator('#mMontoRec')).toBeVisible();
 await expect(page.locator('#mCashQuickInline button')).toHaveCount(5);
 await expect(page.locator('#mCambio')).toBeVisible();
 await page.locator('#mCashQuickInline [data-cash-inline="10"]').click();await expect(page.locator('#mMontoRec')).toHaveValue('10.00');await expect(page.locator('#mCambio')).toHaveText('S/ 0.50');
 await expect(page.locator('#mCobro .pay-methods [data-method="mixto"]')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


for(const width of [320,360,390,430]) test(`approved phone cash layout ${width}: concise received amount, three presets and highlighted change`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'CASH-DESIGN',name:'Producto prueba',precio:7.7,qty:1}];posPayM='efectivo';document.getElementById('mMontoRec').value='7.70';_naRenderCashQuickOptions(7.7);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 await expect(page.locator('#mCashAdvanced')).toBeVisible();
 await expect(page.locator('#mCashAdvanced .pay-amount-head label')).toHaveText('Efectivo recibido');
 await expect(page.locator('#mCashQuickInline button:visible')).toHaveCount(3);
 const changeStyle=await page.locator('#mCambio').evaluate(el=>({background:getComputedStyle(el.parentElement!).backgroundColor,radius:getComputedStyle(el.parentElement!).borderRadius}));
 expect(changeStyle.background).not.toBe('rgba(0, 0, 0, 0)');expect(changeStyle.radius).not.toBe('0px');
 const split=await page.locator('#mCobro .pay-methods [data-method="mixto"]').evaluate(el=>({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderTopWidth}));
 expect(split.background).not.toBe('rgba(0, 0, 0, 0)');expect(split.border).not.toBe('0px');
 await page.locator('#mCashQuickInline [data-cash-inline="10"]').click();
 await expect(page.locator('#mMontoRec')).toHaveValue('10.00');await expect(page.locator('#mCambio')).toHaveText('S/ 2.30');
 const cashBox=await page.locator('#mCashAdvanced').boundingBox();
 const splitBox=await page.locator('#mCobro .pay-methods [data-method="mixto"]').boundingBox();
 expect(splitBox!.y).toBeGreaterThanOrEqual(cashBox!.y+cashBox!.height-1);
 await expect(page.locator('#mBtnConf')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('phone hides only redundant cash success hint and retains digital success feedback',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'HINT-DESIGN',name:'Producto prueba',precio:7.7,qty:1}];posPayM='efectivo';_naRenderCashQuickOptions(7.7);document.getElementById('mMontoRec').value='7.70';calcCambio();document.getElementById('mCobro').classList.add('open');`));
 const hint=page.locator('#mPaymentHint');
 await hint.evaluate(el=>{el.classList.add('ok');el.textContent='Monto exacto listo para cobrar.';});
 await expect(hint).toBeHidden();
 await page.locator('#mCobro [data-digital-group]').click();
 await hint.evaluate(el=>{el.classList.add('ok');el.textContent='Pago digital verificado.';});
 await expect(hint).toBeVisible();
});

for(const width of [320,360,390,430]) test(`approved phone checkout ${width}: total scrolls in flow without covering payment methods`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:500});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'VISUAL-TOTAL',name:'Producto prueba',precio:7.7,qty:1}];posPayM='efectivo';document.getElementById('mCobroTotal').textContent='S/ 7.70';document.getElementById('mMontoRec').value='7.70';_naRenderCashQuickOptions(7.7);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 const body=page.locator('#mCobro .pay-modal-body'),total=page.locator('#mCobro .pay-total-card');
 await expect(total).toContainText('Total a cobrar');
 await expect(page.locator('#mCobroTotal')).toHaveText('S/ 7.70');
 await page.waitForFunction(()=>{const el=document.querySelector('#mCobro .pay-modal-body');return !!el&&el.scrollHeight>el.clientHeight+40;});
 await testInfo.attach('checkout-approved-'+width,{body:await page.screenshot(),contentType:'image/png'});
 const before=await total.boundingBox();
 const method=page.locator('#mCobro [data-method="efectivo"]');
 await body.evaluate(el=>{el.scrollTop=100;el.dispatchEvent(new Event('scroll',{bubbles:true}));});
 const after=await total.boundingBox(), methodBox=await method.boundingBox();
 expect(before!.y-after!.y).toBeGreaterThan(80);
 expect(after!.y+after!.height).toBeLessThanOrEqual(methodBox!.y);
 expect(await method.evaluate(el=>getComputedStyle(el,'::after').display)).toBe('none');
 const quick=await page.locator('#mCashQuickInline button:visible').allTextContents();
 expect(quick).toEqual(['S/ 10','S/ 20','S/ 50']);
});

test('phone checkout uses reference line icons and separates the currency from the cash amount',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'VISUAL-TOTAL',name:'Producto prueba',precio:7.7,qty:1}];posPayM='efectivo';document.getElementById('mCobroTotal').textContent='S/ 7.70';document.getElementById('mMontoRec').value='7.70';_naRenderCashQuickOptions(7.7);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 await expect(page.locator('#mCobro .pay-methods .pmi-icon svg')).toHaveCount(4);
 const icons=await page.locator('#mCobro .pay-methods .pmi-icon').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).display));
 expect(icons.every(display=>display!=='none')).toBe(true);
 const divider=await page.locator('#mCashAdvanced .pay-amount-input-wrap>span').evaluate(el=>getComputedStyle(el).borderRightWidth);
 expect(parseFloat(divider)).toBeGreaterThan(0);
});

test('phone overflow preserves original sale actions in sale and checkout, then restores desktop',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.locator('#btnCartMenu').click();
 for(const label of ['Aplicar descuento','Guardar borrador','Cargar borrador','Generar catálogo','Limpiar carrito','Cantidad','Cambiar precio','Pago rápido']){
  await expect(page.locator('#cartMenuDropdown button').filter({hasText:label})).toBeVisible();
 }
 await page.evaluate(()=>window.eval(`closeCartMenu();cart=[{id:'MENU-PRODUCT',name:'Prueba',precio:7.7,qty:1}];posPayM='efectivo';document.getElementById('mCobroTotal').textContent='S/ 7.70';document.getElementById('mMontoRec').value='7.70';_naRenderCashQuickOptions(7.7);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 await expect(page.locator('#mCobro .pay-modal-head #btnCartMenu')).toBeVisible();
 await page.locator('#btnCartMenu').click();await expect(page.locator('#cartMenuDropdown')).toBeVisible();
 await page.locator('#cartMenuDropdown button').filter({hasText:'Aplicar descuento'}).click();
 await expect(page.locator('#naDiscountSheet')).toContainText('Descuento a la venta');
 await page.locator('#naDiscountSheet .na-ds-cancel').click();
 await expect(page.locator('#naDiscountSheet')).toHaveCount(0);
 await expect(page.locator('#mCobro')).not.toHaveClass(/open/);
 await expect(page.locator('#mCobro')).toHaveCSS('opacity','0');
 await expect(page.locator('#mCobro')).toHaveCSS('pointer-events','none');
 await page.evaluate(()=>window.eval(`closeCartMenu();`));
 await page.setViewportSize({width:1366,height:900});
 await expect(page.locator('.cart-secondary-actions #posQuantity')).toBeVisible();
 await expect(page.locator('.cart-secondary-actions #posPrice')).toBeVisible();
 await expect(page.locator('.cart-actions #btnRapido')).toBeVisible();
 await expect(page.locator('#btnCartMenu')).toHaveCount(1);
});

for(const width of [320,360,390,430]) test(`compact phone payment cards ${width}: smaller cards retain all digital controls`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:740});await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pagePOS'));
 await page.evaluate(()=>window.eval(`cart=[{id:'COMPACT',name:'Producto prueba',precio:22,qty:1}];posPayM='efectivo';document.getElementById('mCobroTotal').textContent='S/ 22.00';document.getElementById('mMontoRec').value='22.00';_naRenderCashQuickOptions(22);calcCambio();document.getElementById('mCobro').classList.add('open');`));
 await page.locator('#mCobro [data-digital-group]').click();
 const methods=page.locator('#mCobro [data-method="efectivo"],#mCobro [data-digital-group],#mCobro [data-method="credito"]');
 for(const card of await methods.all()){
  const box=await card.boundingBox();expect(box!.height).toBeLessThanOrEqual(96);expect(box!.height).toBeGreaterThanOrEqual(44);
 }
 await expect(page.locator('#mDigitalVerified')).toBeVisible();
 await expect(page.locator('#mDigitalRef')).toBeVisible();
 await page.locator('#mDigitalChannels [data-digital-method="transferencia"]').click();
 expect(await page.evaluate(()=>posPayM)).toBe('transferencia');
 await page.locator('#mDigitalRef').fill('12345678');await page.locator('#mDigitalVerified').check();
 await expect(page.locator('#mDigitalRef')).toHaveValue('12345678');
 await expect(page.locator('#mCobro .pay-modal-head #btnCartMenu')).toBeVisible();
 const confirm=await page.locator('#mBtnConf').boundingBox();expect(confirm!.y+confirm!.height).toBeLessThanOrEqual(740);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await testInfo.attach('compact-digital-'+width,{body:await page.screenshot(),contentType:'image/png'});
});
