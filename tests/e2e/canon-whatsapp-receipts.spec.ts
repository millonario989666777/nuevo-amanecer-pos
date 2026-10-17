import {test,expect,Page} from '@playwright/test';

async function boot(page:Page){
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto('/index.html');
  await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function receipt(page:Page){
  await page.evaluate(()=>{const w=window as any;w.NAReceiptShare.onSale({id:'V-TEST',fecha:'2026-10-10',hora:'10:00',metodo:'efectivo',recibido:20,vuelto:6,items:[{name:'Arroz Costeño',qty:2,precio:7}]},{nombre:'María Pérez',tel:'987654321'});});
  await expect(page.locator('#naReceiptSend')).toBeEnabled();
}
for(const width of [320,360,390,430,768,1024,1366,1920]){
  test(`receipt fits ${width}px and cancellation leaves ledger unchanged`,async({page})=>{
    await page.setViewportSize({width,height:900});await boot(page);
    const before=await page.evaluate(()=>JSON.stringify({ventas,creditos,clientes}));
    await receipt(page);
    await expect(page.locator('#naReceiptClient')).toHaveText('María Pérez');
    await expect(page.locator('#naReceiptPhone')).toHaveValue('+51987654321');
    await expect(page.locator('#naReceiptText')).toContainText('Arroz');
    await page.locator('#naReceiptShare summary').click();
    const box=await page.locator('#naReceiptShare .modal').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.y+box!.height).toBeLessThanOrEqual(900);
    await page.locator('#naReceiptShare').getByRole('button',{name:'Cancelar',exact:true}).click();
    await expect(page.locator('#naReceiptShare')).not.toHaveClass(/open/);
    expect(await page.evaluate(()=>JSON.stringify({ventas,creditos,clientes}))).toBe(before);
  });
}
test('PNG and PDF are real files; text targets saved client without sending automatically',async({page})=>{
  await boot(page);await receipt(page);
  await page.evaluate(()=>{const w=window as any;w.__shares=[];Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async(data:any)=>{const f=data.files[0];w.__shares.push({name:f.name,type:f.type,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))});}});w.open=(url:string)=>{w.__opened=url;return{};};});
  await expect(page.locator('#naReceiptFormat')).toHaveValue('text');
  await page.locator('#naReceiptFormat').selectOption('image');await expect(page.locator('#naReceiptSend')).toBeEnabled();await page.locator('#naReceiptSend').click();
  await page.waitForFunction(()=>(window as any).__shares.length>=1);
  let file=await page.evaluate(()=>(window as any).__shares[0]);
  expect(file.type).toBe('image/png');expect(file.bytes.slice(0,8)).toEqual([137,80,78,71,13,10,26,10]);
  await page.locator('#naReceiptFormat').selectOption('pdf');await expect(page.locator('#naReceiptSend')).toBeEnabled();await page.locator('#naReceiptSend').click();
  await page.waitForFunction(()=>(window as any).__shares.length>=2);
  file=await page.evaluate(()=>(window as any).__shares[1]);expect(file.type).toBe('application/pdf');expect(String.fromCharCode(...file.bytes.slice(0,8))).toBe('%PDF-1.4');
  await page.locator('#naReceiptFormat').selectOption('text');await expect(page.locator('#naReceiptSend')).toBeEnabled();await page.locator('#naReceiptSend').click();
  const url=new URL(await page.evaluate(()=>(window as any).__opened));expect(url.hostname).toBe('wa.me');expect(url.pathname).toBe('/51987654321');expect(url.searchParams.get('text')).toContain('Arroz');
  expect(url.searchParams.get('text')).toMatch(/^Hola María Pérez, gracias por tu compra\.\n\n```\n/);
});
test('one click sends the receipt to the saved number; Enter in the phone field does the same',async({page})=>{
  await boot(page);await page.evaluate(()=>{const w=window as any;w.__opened=[];w.open=(url:string)=>{w.__opened.push(url);return{};};});
  await receipt(page);await expect(page.locator('#naReceiptFormat')).toHaveValue('text');
  await page.locator('#naReceiptSend').click();
  expect(await page.evaluate(()=>(window as any).__opened.length)).toBe(1);
  await page.locator('#naReceiptPhone').fill('987654322');await page.locator('#naReceiptPhone').press('Enter');
  const urls=await page.evaluate(()=>(window as any).__opened);expect(urls.length).toBe(2);expect(new URL(urls[1]).pathname).toBe('/51987654322');
});
test('without a saved number the phone field is focused and nothing opens until a valid one is typed',async({page})=>{
  await boot(page);await page.evaluate(()=>{const w=window as any;w.__opened=[];w.open=(url:string)=>{w.__opened.push(url);return{};};(w as any).NAReceiptShare.onSale({id:'V-NOPHONE',fecha:'2026-10-10',hora:'10:00',metodo:'efectivo',items:[{name:'Arroz',qty:1,precio:7}]},{nombre:'Luis'});});
  await expect(page.locator('#naReceiptSend')).toBeEnabled();await expect(page.locator('#naReceiptPhone')).toBeFocused();
  await page.locator('#naReceiptPhone').press('Enter');expect(await page.evaluate(()=>(window as any).__opened.length)).toBe(0);
  await page.locator('#naReceiptPhone').fill('987654321');await page.locator('#naReceiptPhone').press('Enter');
  expect(await page.evaluate(()=>(window as any).__opened.length)).toBe(1);
});
test('re-sharing a credit sale uses current associated balance',async({page})=>{
  await boot(page);await page.evaluate(()=>{ventas.push({id:'V-CREDIT-TEST',metodo:'credito',items:[{name:'Arroz',qty:2,precio:7}]});creditos.push({id:'C-TEST',ventaId:'V-CREDIT-TEST',monto:14,saldo:9});(window as any).NAReceiptShare.shareSale('V-CREDIT-TEST');});
  await expect(page.locator('#naReceiptText')).toContainText('Saldo pendiente: S/ 9.00');
});
test('pending edit of a different customer is never acknowledged as saved',async({page})=>{
  await boot(page);await page.evaluate(()=>{const w=window as any;clientes.push({id:'CONTACT-TEST',nombre:'María',tel:'987654321'});w.isModuleLocked=()=>false;w._naF10AuthorizePermission=()=>true;w.__retry=0;w.NuevoAmanecerCanonical={enabled:()=>true,pendingSnapshot:()=>({command:'customer.contact.set',payload:{customer_id:'OTHER',name:'Otro',phone:'+51911111111'}}),retryPending:async()=>{w.__retry++;},refresh:async()=>{}};w.NAReceiptUI.editContact('CONTACT-TEST');});
  await page.locator('#naContactSave').click();expect(await page.evaluate(()=>(window as any).__retry)).toBe(0);await expect(page.locator('#naCustomerContact')).toHaveClass(/open/);
});
test('temporary server error retries original contact edit and recovers its values',async({page})=>{
  await boot(page);await page.evaluate(()=>{const w=window as any;clientes.push({id:'CONTACT-TEST',nombre:'María',tel:'987654321'});w.isModuleLocked=()=>false;w._naF10AuthorizePermission=()=>true;w.__retry=0;w.NuevoAmanecerCanonical={enabled:()=>true,pendingSnapshot:()=>({command:'customer.contact.set',last_status:503,last_error:'temporarily_unavailable',payload:{customer_id:'CONTACT-TEST',name:'María pendiente',phone:'+51911111111'}}),retryPending:async()=>{w.__retry++;},refresh:async()=>{},discardRejectedCustomerContact:async()=>false};w.NAReceiptUI.editContact('CONTACT-TEST');});
  await page.locator('#naContactSave').click();expect(await page.evaluate(()=>(window as any).__retry)).toBe(1);await expect(page.locator('#naContactName')).toHaveValue('María pendiente');await expect(page.locator('#naContactStatus')).toContainText('edición pendiente');await expect(page.locator('#naCustomerContact')).toHaveClass(/open/);
});
test('configured receipt format and prompt survive real app reload',async({page})=>{
  await boot(page);await page.evaluate(async()=>{const w=window as any;w.NAReceiptShare.setSettings({format:'pdf',ask:false});if(await guardarConfig()!==true)throw new Error('Settings were not saved');});
  await page.reload();await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
  expect(await page.evaluate(()=>(window as any).NAReceiptShare.settings())).toEqual({format:'pdf',ask:false,app:'auto'});
  await page.evaluate(()=>(window as any).NAReceiptShare.onSale({id:'NO-PROMPT',items:[]},{nombre:'María'}));await expect(page.locator('#naReceiptShare.open')).toHaveCount(0);
});


test('invalid WhatsApp recipient explains error, focuses field and never opens a chat',async({page})=>{
  await boot(page);await receipt(page);
  await page.evaluate(()=>{const w=window as any;w.__opened=null;w.open=(url:string)=>{w.__opened=url;return{};};});
  await page.locator('#naReceiptFormat').selectOption('text');await expect(page.locator('#naReceiptSend')).toBeEnabled();
  await page.locator('#naReceiptPhone').fill('123');await page.locator('#naReceiptSend').click();
  expect(await page.evaluate(()=>(window as any).__opened)).toBeNull();
  await expect(page.locator('#gToast')).toContainText('número de WhatsApp válido');
  await expect(page.locator('#naReceiptPhone')).toBeFocused();
  await expect(page.locator('#naReceiptSend')).toBeEnabled();
});

const ANDROID_UA='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
async function captureOpen(page:Page){await page.evaluate(()=>{const w=window as any;w.__opened=[];w.open=(url:string)=>{w.__opened.push(url);return{};};});}
test.describe('Android: choose WhatsApp or WhatsApp Business',()=>{
  test.use({userAgent:ANDROID_UA});
  test('selector persists across reload and opens the intent with the right package',async({page})=>{
    await boot(page);await captureOpen(page);await receipt(page);
    const app=page.locator('#naReceiptApp');
    await expect(app).toBeVisible();await expect(app).toBeEnabled();await expect(app).toHaveValue('auto');
    await page.locator('#naReceiptSend').click();
    let urls=await page.evaluate(()=>(window as any).__opened);expect(new URL(urls[0]).hostname).toBe('wa.me');
    await app.selectOption('business');
    expect(await page.evaluate(()=>(window as any).NAReceiptShare.settings().app)).toBe('business');
    await page.locator('#naReceiptSend').click();
    urls=await page.evaluate(()=>(window as any).__opened);const business=urls[1] as string;
    expect(business.startsWith('intent://send?phone=51987654321&text=')).toBe(true);
    expect(business).toContain('#Intent;scheme=whatsapp;package=com.whatsapp.w4b;S.browser_fallback_url=https%3A%2F%2Fwa.me%2F51987654321%3Ftext%3D');
    expect(decodeURIComponent(/^intent:\/\/send\?phone=\d+&text=([^#]*)#/.exec(business)![1])).toMatch(/^Hola María Pérez, gracias por tu compra\.\n\n```\n/);
    await app.selectOption('whatsapp');await page.locator('#naReceiptSend').click();
    urls=await page.evaluate(()=>(window as any).__opened);expect(urls[2]).toContain(';package=com.whatsapp;S.browser_fallback_url=');expect(urls[2]).not.toContain('w4b');
    await app.selectOption('business');
    await page.reload();await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
    expect(await page.evaluate(()=>(window as any).NAReceiptShare.settings().app)).toBe('business');
    await captureOpen(page);await receipt(page);await expect(page.locator('#naReceiptApp')).toHaveValue('business');
    await page.locator('#naReceiptSend').click();
    expect(((await page.evaluate(()=>(window as any).__opened)) as string[])[0]).toContain('package=com.whatsapp.w4b');
  });
  test('image and PDF formats keep working and hide the app selector',async({page})=>{
    await boot(page);await receipt(page);
    await page.evaluate(()=>{const w=window as any;w.__shares=[];Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async(data:any)=>{w.__shares.push(data.files[0].type);}});});
    await page.locator('#naReceiptFormat').selectOption('pdf');await expect(page.locator('#naReceiptSend')).toBeEnabled();await expect(page.locator('#naReceiptApp')).toBeHidden();
    await page.locator('#naReceiptSend').click();await page.waitForFunction(()=>(window as any).__shares.length===1);
    expect(await page.evaluate(()=>(window as any).__shares[0])).toBe('application/pdf');
  });
  test('settings screen exposes the same choice',async({page})=>{
    await boot(page);
    await page.evaluate(()=>{const h=document.createElement('div');h.id='cfgHost';h.innerHTML=(window as any).NAReceiptUI.settingsHtml();document.body.append(h);});
    await expect(page.locator('#cfgReceiptApp')).toBeEnabled();
    await page.locator('#cfgReceiptApp').selectOption('business');
    await expect.poll(()=>page.evaluate(()=>(window as any).NAReceiptShare.settings().app)).toBe('business');
  });
});
const IPHONE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
async function expectWaMe(page:Page){
  await boot(page);await captureOpen(page);
  await page.evaluate(()=>{(window as any).NAReceiptShare.setSettings({format:'text',ask:true,app:'business'});});
  await receipt(page);
  await expect(page.locator('#naReceiptApp')).toBeDisabled();await expect(page.locator('#naReceiptAppNote')).toContainText('Android');
  await page.locator('#naReceiptSend').click();
  const urls=await page.evaluate(()=>(window as any).__opened);expect(urls.length).toBe(1);
  const url=new URL(urls[0]);expect(url.protocol).toBe('https:');expect(url.hostname).toBe('wa.me');expect(url.pathname).toBe('/51987654321');
}
test('desktop disables the selector and opens wa.me even with Business saved',async({page})=>{await expectWaMe(page);});
test.describe('iPhone',()=>{
  test.use({userAgent:IPHONE_UA});
  test('iOS disables the selector and opens wa.me even with Business saved',async({page})=>{await expectWaMe(page);});
});
