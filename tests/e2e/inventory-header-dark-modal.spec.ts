import {test,expect,type Page} from '@playwright/test';
test.use({serviceWorkers:'block'});
async function inventory(page:Page,width:number,dark=false){
 await page.setViewportSize({width,height:760});await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto('/index.html');await page.waitForFunction('_naFreeSaleShortcutState.ready');
 await page.evaluate(d=>{document.body.classList.toggle('dark',d);(window as any).NA_MENU_NAVIGATION.navigate('pageInventario');},dark);await page.waitForTimeout(300);
}
// WCAG contrast of an element's text against its own (or nearest opaque ancestor) background.
const contrast=(page:Page,sel:string)=>page.locator(sel).evaluate(el=>{
 const rgb=(s:string)=>{const m=s.match(/[\d.]+/g)!.map(Number);return {r:m[0],g:m[1],b:m[2],a:m[3]??1};};
 const lum=(c:any)=>{const f=(v:number)=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b);};
 const blend=(top:any,bottom:any)=>({r:top.r*top.a+bottom.r*(1-top.a),g:top.g*top.a+bottom.g*(1-top.a),b:top.b*top.a+bottom.b*(1-top.a),a:1});
 const layers:any[]=[];for(let a:Element|null=el;a;a=a.parentElement){const c=rgb(getComputedStyle(a).backgroundColor);if(c.a>0)layers.push(c);if(c.a>=1)break;}
 let bg={r:255,g:255,b:255,a:1};for(const l of layers.reverse())bg=blend(l,bg);
 const fg=blend(rgb(getComputedStyle(el).color),bg);const [L1,L2]=[lum(fg),lum(bg)].sort((x,y)=>y-x);return (L1+.05)/(L2+.05);});
test('dark Fotos múltiples: ✕ and secondary buttons are readable',async({page})=>{
 await inventory(page,1366,true);
 await page.evaluate(()=>(window as any).NuevoAmanecerImageBatch.open());await expect(page.locator('#productImageBatchModal .modal')).toBeVisible();
 expect(await contrast(page,'#productImageBatchModal .btn-close-m'),'✕').toBeGreaterThanOrEqual(4.5);
 for(const id of ['productImageBatchExport','productImageBatchUndo','productImageBatchUpload']){const sel='#'+id;if(await page.locator(sel).count())expect(await contrast(page,sel),id).toBeGreaterThanOrEqual(4.5);}
 // Buttons are distinguishable from the dialog surface.
 const surface=await page.locator('#productImageBatchModal .modal').evaluate(e=>getComputedStyle(e).backgroundColor);
 expect(await page.locator('#productImageBatchExport').evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe(surface);
 await page.screenshot({path:test.info().outputPath('fotos-dark-1366.png')});
});
for(const width of [320,338,360])test(`Inventario title does not overlap Compras at ${width}px`,async({page})=>{
 await inventory(page,width);
 const r=await page.evaluate(()=>{const t=document.querySelector('#pageInventario .top-mod-title')!.getBoundingClientRect(),c=document.querySelector('#pageInventario .ocr-purchase-actions')!.getBoundingClientRect();
  // Painted text extent: the title clips its overflow, so its box is what is drawn.
  const el=document.querySelector('#pageInventario .top-mod-title') as HTMLElement;return {tRight:t.right,cLeft:c.left,clipped:getComputedStyle(el).overflow==='hidden'||el.scrollWidth<=el.clientWidth};});
 expect(r.clipped).toBe(true);expect(r.tRight).toBeLessThanOrEqual(r.cLeft+0.5);
 await expect(page.locator('#pageInventario .na-pur-btn')).toBeVisible();
});
for(const width of [390,430,1024])test(`Inventario title is untouched at ${width}px`,async({page})=>{
 await inventory(page,width);
 const s=await page.locator('#pageInventario .top-mod-title').evaluate(el=>({ov:getComputedStyle(el).overflowX,full:(el as HTMLElement).scrollWidth<=(el as HTMLElement).clientWidth+0.5}));
 expect(s).toEqual({ov:'visible',full:true});
});
