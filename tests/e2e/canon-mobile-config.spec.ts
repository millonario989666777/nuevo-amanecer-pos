import {test,expect} from '@playwright/test';

test.beforeEach(async ({page}) => {await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());});

async function openConfig(page,width){
  await page.setViewportSize({width,height:844});await page.goto('/index.html');
  await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0))));
  await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pageConfig'));
}

// Etapa 2: en celular Configuración abre una lista de secciones; cada sección es su pantalla,
// sin acordeones ni íconos "i". En tablet/PC: lista a la izquierda y formulario a la derecha.
for(const width of [320,360,390,430,768,1024,1366,1920])test('settings '+width,async({page})=>{
  await openConfig(page,width);
  if(width<768){
    await expect(page.locator('#cfgSidebar [data-cfgcat="negocio"]')).toBeVisible();
    await expect(page.locator('#cfgNombre')).toBeHidden();
    await page.locator('#cfgSidebar [data-cfgcat="negocio"]').click();
  }
  await expect(page.locator('#cfgNombre')).toBeVisible();
  await expect(page.locator('#cfgContent .cfg-accordion-toggle')).toHaveCount(0);
  await expect(page.locator('#cfgContent .cfg-help-toggle')).toHaveCount(0);
  await expect(page.locator('#cfgContent .na-cfg-save-btn')).toBeVisible();
  if(width<768)await expect(page.locator('#naMobileMenuToggle')).toBeHidden();
  for(const cat of ['pos','apariencia','ticket','control','reseteo','importar','info','negocio']){await page.evaluate(cat=>window.switchCfgCategory(cat),cat);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
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
