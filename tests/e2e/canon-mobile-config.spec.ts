import {test,expect} from '@playwright/test';

test.beforeEach(async ({page}) => {await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());});

async function openConfig(page,width){
  await page.setViewportSize({width,height:844});await page.goto('/index.html');
  await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0))));
  await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pageConfig'));
}

// Etapa 2: en celular Configuración abre una lista de secciones; cada sección es su pantalla,
// sin acordeones ni íconos "i". En celular no cambia nada.
for(const width of [320,360,390,430])test('settings '+width,async({page})=>{
  await openConfig(page,width);
  await expect(page.locator('#cfgSidebar [data-cfgcat="negocio"]')).toBeVisible();
  await expect(page.locator('#cfgNombre')).toBeHidden();
  await expect(page.locator('#naCfgV9')).toBeHidden();
  await page.locator('#cfgSidebar [data-cfgcat="negocio"]').click();
  await expect(page.locator('#cfgNombre')).toBeVisible();
  await expect(page.locator('#cfgContent .cfg-accordion-toggle')).toHaveCount(0);
  await expect(page.locator('#cfgContent .cfg-help-toggle')).toHaveCount(0);
  await expect(page.locator('#cfgContent .na-cfg-save-btn')).toBeVisible();
  await expect(page.locator('#naMobileMenuToggle')).toBeHidden();
  for(const cat of ['pos','apariencia','ticket','control','reseteo','importar','info','negocio']){await page.evaluate(cat=>window.switchCfgCategory(cat),cat);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
});

// PC y tablet (>= 701 px): Configuración v9 aprobada por el admin. 5 temas con pestañas y Reseteo al final.
for(const width of [768,1024,1366,1920])test('settings v9 '+width,async({page})=>{
  await openConfig(page,width);
  await expect(page.locator('#naCfgV9')).toBeVisible();
  await expect(page.locator('#cfgSidebar')).toBeHidden();
  await expect(page.locator('#na9Nav [data-top]')).toHaveCount(6);
  await expect(page.locator('#na9Nav .na9-reset [data-top="reset"]')).toBeVisible();
  await page.locator('#na9Nav [data-top="neg"]').click();
  await page.locator('#naCfgV9 [data-tab="datos"]').click();
  await expect(page.locator('[data-na9="biz.nombre"]')).toBeVisible();
  const tabs={prod:['stock','igv'],ventas:['pv','cred'],neg:['datos','ticket'],pers:['pin','devs','perm'],sis:['apar','backup','estado']};
  for(const [top,list] of Object.entries(tabs))for(const tab of list){
    await page.locator(`#na9Nav [data-top="${top}"]`).click();await page.locator(`#naCfgV9 [data-tab="${tab}"]`).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.evaluate(()=>/Dueño|dueño/.test(document.getElementById('na9Main').innerText))).toBe(false);
  }
  await page.locator('#na9Nav [data-top="neg"]').click();await page.locator('#naCfgV9 [data-tab="ticket"]').click();
  await expect(page.locator('#naCfgV9')).toContainText('no son comprobantes electrónicos SUNAT');
  await expect(page.locator('#na9Tk')).toContainText(/Sungaro/i);
});

test('mobile: back to sections list and edits are retained',async({page})=>{
  await openConfig(page,390);
  await page.locator('#cfgSidebar [data-cfgcat="negocio"]').click();
  await page.locator('#cfgNombre').fill('Nombre de prueba local');
  await page.evaluate(()=>_naCaptureVisibleConfig());
  expect(await page.evaluate(()=>appConfig.business.nombre)).toBe('Nombre de prueba local');
  await page.locator('.na-cfg-back').click();
  await expect(page.locator('#cfgSidebar [data-cfgcat="apariencia"]')).toBeVisible();
  await page.locator('#cfgSidebar [data-cfgcat="apariencia"]').click();
  await expect(page.locator('#naAppearancePanel')).toBeVisible();
});

test('appearance is clamped 85-125, saved per device and resettable',async({page})=>{
  await openConfig(page,390);
  await page.locator('#cfgSidebar [data-cfgcat="apariencia"]').click();
  await page.locator('.na-ap-step[data-ap="buttons"][data-val="125"]').click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('na_appearance_v1')).buttons)).toBe(125);
  expect(await page.evaluate(()=>[NA_CONFIG_E2.clamp(300),NA_CONFIG_E2.clamp(10)])).toEqual([125,85]);
  await page.locator('.na-ap-reset').click();
  expect(await page.evaluate(()=>localStorage.getItem('na_appearance_v1'))).toBeNull();
});

// Tablet vertical (768-960): la lista de temas queda fija a la izquierda, sin ☰ deslizable.
for(const width of [768,820,960])test('tablet portrait fixed section list '+width,async({page})=>{
  await openConfig(page,width);
  const sb=await page.locator('#na9Nav').boundingBox(),ct=await page.locator('#na9Main').boundingBox();
  expect(sb.x).toBeGreaterThanOrEqual(0);expect(ct.x).toBeGreaterThanOrEqual(sb.x+sb.width-1);
  await expect(page.locator('#pageConfig .cfg-menu-toggle')).toBeHidden();
  await page.locator('#na9Nav [data-top="sis"]').click();await page.locator('#naCfgV9 [data-tab="apar"]').click();
  await expect(page.locator('#naCfgV9 .na9-themes .na9-th')).toHaveCount(5);
  await expect(page.locator('#cfgFontSize')).toHaveCount(0);
});

test('phone entry shows only the sections list',async({page})=>{
  await openConfig(page,360);
  await expect(page.locator('#cfgContent')).toBeHidden();
});
