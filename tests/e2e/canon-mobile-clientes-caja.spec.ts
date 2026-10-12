import {test,expect} from '@playwright/test';

test.use({hasTouch:true});
test.beforeEach(async({page})=>{
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
});

test('P2-6: Clientes en 360 px muestra las 4 pestañas completas y controles de 44 px',async({page})=>{
 await page.setViewportSize({width:360,height:800});
 await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pageClientes'));
 await expect(page.locator('#pageClientes')).toHaveClass(/active/);
 const tabs=await page.locator('#pageClientes .tabs-wrap .tab').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right,h:r.height};}));
 expect(tabs.length).toBe(4);
 for(const t of tabs){expect(t.l).toBeGreaterThanOrEqual(0);expect(t.r).toBeLessThanOrEqual(360);expect(t.h).toBeGreaterThanOrEqual(44);}
 for(const sel of ['#pageClientes .top-btn-nuevo','#pageClientes .search-box','#cliSort']){
  const box=(await page.locator(sel).boundingBox())!;expect(box.height,sel).toBeGreaterThanOrEqual(44);
 }
 expect(await page.locator('#cliSearch').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('P2-2: la búsqueda de clientes redibuja una vez por ráfaga de teclas',async({page})=>{
 await page.setViewportSize({width:360,height:800});
 await page.goto('/index.html');
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pageClientes'));
 await page.waitForTimeout(800); // deja terminar los renders propios de la navegación
 await page.evaluate(()=>{const w=window as any;const orig=w.cliRender;w.__cliRenders=0;w.cliRender=function(){w.__cliRenders++;return orig.apply(this,arguments);};});
 await page.locator('#cliSearch').pressSequentially('maria',{delay:20});
 await page.waitForTimeout(400);
 const renders=await page.evaluate(()=>(window as any).__cliRenders);
 expect(renders).toBe(1);
});

for(const height of [800,450]) test(`P2-4 ${height}: "Confirmar" del modal Registrar pago queda visible sin desplazar`,async({page})=>{
 await page.setViewportSize({width:360,height});
 await page.goto('/index.html');
 await page.evaluate(()=>{window.NA_MENU_NAVIGATION.navigate('pageClientes');const w=document.getElementById('pagoOperacionWrap');if(w)w.hidden=false;document.getElementById('mPagoCred')!.classList.add('open');});
 await page.waitForTimeout(400);
 const hit=await page.evaluate(()=>{const b=document.getElementById('pagoConfirmBtn')!.getBoundingClientRect();if(b.bottom>innerHeight||b.top<0)return 'offscreen '+b.top+'-'+b.bottom;const el=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return el&&el.closest('#pagoConfirmBtn')?'ok':'covered';});
 expect(hit).toBe('ok');
 const box=(await page.locator('#pagoConfirmBtn').boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);
});

test('P2-1: la actividad de Inicio no se reconstruye fuera de Inicio y se pone al día al volver',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/index.html');
 await page.waitForFunction(()=>!!document.getElementById('naMobileActivityList'));
 await page.evaluate(()=>window.NA_MENU_NAVIGATION.navigate('pageClientes'));
 await page.evaluate(()=>{const w=window as any;w.__activityMutations=0;new MutationObserver(()=>w.__activityMutations++).observe(document.getElementById('naMobileActivityList')!,{childList:true});
  for(let i=0;i<5;i++)window.dispatchEvent(new CustomEvent('na:canonical-updated',{detail:{}}));});
 await page.waitForTimeout(100);
 expect(await page.evaluate(()=>(window as any).__activityMutations)).toBe(0);
 await page.evaluate(()=>(window as any).goMenu());
 await expect(page.locator('#pageMenu')).toHaveClass(/active/);
 await page.waitForTimeout(100);
 expect(await page.evaluate(()=>(window as any).__activityMutations)).toBeGreaterThanOrEqual(1);
});
