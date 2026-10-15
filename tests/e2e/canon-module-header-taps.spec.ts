import {test,expect,Page} from '@playwright/test';
// 390px: la cabecera de los módulos con lista no puede dejar pasar toques a las tarjetas,
// ninguna capa invisible captura toques y la lista recupera el espacio al desplazarse.
const OPEN='.modal-overlay.open,#mProd.open,#mMovInv.open,[role="dialog"][open]';
async function boot(page:Page){
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html?na-test=1');
 await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
}
async function seed(page:Page,pid:string){
 await page.evaluate((pid)=>{
  productos=Array.from({length:40},(_,i)=>({id:987000+i,name:'Producto '+i,sku:'t'+i,cat:'snacks',precio:2,costo:1,stock:5,stockMin:3,unidad:'unidad',icon:'📦'}));
  try{clientes=Array.from({length:40},(_,i)=>({id:886000+i,nombre:'Cliente '+i,name:'Cliente '+i,telefono:'9000000'+i,deuda:0}));}catch(_){}
  window.NA_MENU_NAVIGATION.navigate(pid);
  if(pid==='pageInventario')invRender();
  if(pid==='pageClientes'&&typeof cliRender==='function')try{cliRender();}catch(_){}
 },pid);
 await expect(page.locator('#'+pid)).toHaveClass(/active/);
}
// Puntos de la cabecera realmente pintados: los que el hit-test atribuye a la cabecera
// deben estar visibles (opacidad > 0) y no ser controles interactivos.
async function headerProbe(page:Page,pid:string){
 return page.evaluate((pid)=>{
  const chrome=document.querySelector('#'+pid+'>.page-chrome') as HTMLElement;const r=chrome.getBoundingClientRect();
  const points:{x:number,y:number}[]=[];const invisible:string[]=[];const leaks:string[]=[];
  const collapse=parseFloat(getComputedStyle(chrome.parentElement!).getPropertyValue('--na-scroll-collapse-y'))||0;
  const tb=document.querySelector('.g-topbar')!.getBoundingClientRect().bottom;
  // Toda la franja pintada de la cabecera debe pertenecer a la cabecera (ningún toque cae detrás).
  for(let y=Math.ceil(Math.max(tb,r.top))+1;y<Math.min(innerHeight-2,r.bottom-collapse)-1;y+=6)for(const x of [24,200,366]){
   const el=document.elementFromPoint(x,y);if(el&&!chrome.contains(el)&&!el.closest('.g-topbar'))leaks.push(x+','+y+':'+(el as HTMLElement).className);}
  for(let y=Math.max(64,r.top+4);y<Math.min(innerHeight-4,r.bottom);y+=10)for(const x of [24,120,200,280,366]){
   const el=document.elementFromPoint(x,y) as HTMLElement|null;if(!el||!chrome.contains(el))continue;
   for(let n:HTMLElement|null=el;n&&n!==chrome.parentElement;n=n.parentElement){const s=getComputedStyle(n);if(Number(s.opacity)<0.05||s.visibility==='hidden'){invisible.push(x+','+y+':'+n.className);break;}}
   if(!el.closest('button,input,select,summary,a,label,[onclick]'))points.push({x,y});
  }
  return {points,invisible,leaks,collapse,bottom:r.bottom};
 },pid);
}
for(const pid of ['pageInventario','pageClientes','pageVentas','pageGastos'])test('390 header blocks taps and hides nothing invisible '+pid,async({page})=>{
 await boot(page);await seed(page,pid);
 for(const y of [0,300,900]){
  await page.evaluate(y=>window.scrollTo(0,y),y);await page.waitForTimeout(150);
  const probe=await headerProbe(page,pid);
  expect(probe.leaks,'toques que caen detrás de la cabecera').toEqual([]);
  expect(probe.invisible,'capas invisibles que capturan toques').toEqual([]);
  for(const p of probe.points.filter((_,i)=>i%3===0)){
   await page.mouse.click(p.x,p.y);
   await expect(page.locator(OPEN),`toque en cabecera ${p.x},${p.y} abrió un diálogo`).toHaveCount(0);
  }
 }
 if(pid==='pageClientes')expect((await headerProbe(page,pid)).collapse,'Clientes colapsa de verdad').toBeGreaterThan(0);
 else expect(await page.evaluate(pid=>getComputedStyle(document.querySelector('#'+pid+'>.page-chrome')!).clipPath,pid),'sin recorte invisible').toBe('none');
 // La lista recupera el espacio: el área recortada de la cabecera no ocupa pantalla.
 const gap=await page.evaluate((pid)=>{const pg=document.getElementById(pid)!,c=pg.querySelector(':scope>.page-chrome') as HTMLElement,next=Array.from(pg.children).find(n=>n!==c&&(n as HTMLElement).getBoundingClientRect().height>0) as HTMLElement|undefined;
  const collapse=parseFloat(getComputedStyle(pg).getPropertyValue('--na-scroll-collapse-y'))||0;
  if(!next||!collapse)return 0;return Math.round(next.getBoundingClientRect().top-(c.getBoundingClientRect().bottom-collapse));},pid);
 expect(Math.abs(gap)).toBeLessThanOrEqual(24);
});
test('390 inventory summary never opens Entrada/Salida/edit and closing a form keeps scroll',async({page})=>{
 await boot(page);await seed(page,'pageInventario');
 const chromeH=await page.locator('#pageInventario>.page-chrome').evaluate(el=>el.getBoundingClientRect().height);
 expect(chromeH,'cabecera compacta').toBeLessThan(844*0.4);
 await page.evaluate(()=>window.scrollTo(0,700));await page.waitForTimeout(150);
 const ss=await page.locator('#pageInventario .stats-strip').boundingBox();expect(ss).not.toBeNull();
 for(const fx of [0.1,0.5,0.9])for(const fy of [0.2,0.6,0.95]){
  await page.mouse.click(ss!.x+ss!.width*fx,ss!.y+ss!.height*fy);
  await expect(page.locator(OPEN)).toHaveCount(0);
 }
 // Sin rendija: justo debajo de la barra superior se pinta la cabecera, no una tarjeta.
 const hit=await page.evaluate(()=>{const tb=document.querySelector('.g-topbar')!.getBoundingClientRect();const out:string[]=[];for(let y=Math.ceil(tb.bottom);y<tb.bottom+12;y+=2){const e=document.elementFromPoint(200,y);if(e&&e.closest('#invBody'))out.push(String(y));}return out;});
 expect(hit,'tarjeta asomando sobre el título').toEqual([]);
 const edit=page.locator('#invBody .btn-edt').nth(20);await edit.scrollIntoViewIfNeeded();await page.waitForTimeout(150);
 const before=await page.evaluate(()=>window.scrollY);expect(before).toBeGreaterThan(200);
 await edit.click();await expect(page.locator('#mProd')).toHaveClass(/open/);
 await page.locator('#mProd .mbtn-cancel').click();await expect(page.locator('#mProd')).not.toHaveClass(/open/);
 await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeGreaterThan(before-4);
 expect(Math.abs(await page.evaluate(()=>window.scrollY)-before)).toBeLessThanOrEqual(4);
});
test('390 Venta and Inicio are not touched by the header collapse',async({page})=>{
 await boot(page);
 for(const pid of ['pageMenu','pagePOS']){
  await page.evaluate(pid=>window.NA_MENU_NAVIGATION.navigate(pid),pid);
  await page.evaluate(()=>window.scrollTo(0,300));await page.waitForTimeout(150);
  const s=await page.evaluate(pid=>{const pg=document.getElementById(pid)!;const c=pg.querySelector(':scope>.page-chrome');return {linked:pg.classList.contains('na-scroll-linked'),mb:c?getComputedStyle(c).marginBottom:'0px',clip:c?getComputedStyle(c).clipPath:'none'};},pid);
  expect(s).toEqual({linked:false,mb:'0px',clip:'none'});
 }
});
