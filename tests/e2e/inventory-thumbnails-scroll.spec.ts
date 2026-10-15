import {test,expect} from '@playwright/test';
test.use({serviceWorkers:'block'});
for(const viewport of [{width:1366,height:768},{width:1024,height:768},{width:390,height:844}])test(`400 inventory thumbnails scroll at ${viewport.width}`,async({page})=>{
 await page.setViewportSize(viewport);await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());await page.goto('/index.html');await page.waitForFunction('_naFreeSaleShortcutState.ready');
 await page.evaluate(async()=>{const w=window as any;w._naAuthorize=()=>true;w.securityIsLocked=()=>false;
  w.eval(`productos=Array.from({length:400},(_,i)=>({id:70000+i,name:'Producto '+i,sku:'000'+i,barcode:'1000'+i,codigosAlternativos:[],cat:'snacks',precio:2,costo:1,stock:20,stockMin:1,unidad:'unidad',icon:'📦',venc:''}));`);
  w.NA_MENU_NAVIGATION.navigate('pageInventario');w.invRender();
 });
 const first=page.locator('#invBody tr').first();await expect(first).toBeVisible();await expect.poll(()=>first.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(20);const iconHeight=await first.evaluate(el=>el.getBoundingClientRect().height);
 await page.evaluate(async()=>{const w=window as any,c=document.createElement('canvas');c.width=384;c.height=384;const ctx=c.getContext('2d')!;ctx.fillStyle='#2AB0AE';ctx.fillRect(0,0,384,384);const image=c.toDataURL('image/webp',.8),entries=w.eval('productos').map((p:any)=>({codes:[p.sku],image,targetId:String(p.id)}));
  await new Promise<void>((resolve,reject)=>{const r=indexedDB.open('nuevo-amanecer-product-images-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('catalogs');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('catalogs','readwrite');tx.objectStore('catalogs').put({entries},'local');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  await w.NuevoAmanecerImageBatch.open();const modal=document.getElementById('productImageBatchModal')!;modal.classList.remove('open');modal.style.display='none';w.invRender();
 });
 const image=first.locator('img');await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(384);expect(await first.evaluate(el=>el.getBoundingClientRect().height)).toBeCloseTo(iconHeight,1);
 await expect(image).toHaveAttribute('width',viewport.width===390?'42':'44');await expect(image).toHaveAttribute('height',viewport.width===390?'56':'44');
 await page.evaluate(()=>{const w=window as any;w.__scrollTasks=[];w.__scrollObserver=new PerformanceObserver(list=>w.__scrollTasks.push(...list.getEntries().map(e=>e.duration)));w.__scrollObserver.observe({type:'longtask',buffered:false});});
 const scrollPosition=()=>page.evaluate(()=>Math.max(window.scrollY,document.scrollingElement?.scrollTop||0,document.getElementById('pageInventario')!.scrollTop));const start=await scrollPosition();
 const box=await first.boundingBox();await page.mouse.move(box!.x+box!.width/2,Math.min(viewport.height-100,box!.y+box!.height/2));await page.mouse.wheel(0,650);await expect.poll(scrollPosition).toBeGreaterThan(start);
 // Small repeated scrolls trigger the real progressive row observer, including mobile.
 for(let i=0;i<250;i++){
  if(viewport.width===390)await page.evaluate(()=>{const el=document.getElementById('pageInventario')!;if(el.scrollHeight>el.clientHeight&&getComputedStyle(el).overflowY.match(/auto|scroll/))el.scrollBy(0,1000);else window.scrollBy(0,1000);});else await page.mouse.wheel(0,2000);
  await page.waitForTimeout(70);
  if(await page.locator('#invBody tr').count()===400&&await page.locator('#invBody tr').last().evaluate(el=>{const b=el.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;}))break;
 }
 await expect(page.locator('#invBody .prod-name-sm')).toHaveCount(400);const last=page.locator('#invBody tr').last();await expect(last).toContainText('Producto 399');expect(await last.evaluate(el=>{const b=el.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;})).toBe(true);await expect(last.locator('img')).toHaveAttribute('loading','lazy');expect(Math.abs(await last.evaluate(el=>el.getBoundingClientRect().height)-iconHeight),'thumbnail does not change row height (last row has no bottom border)').toBeLessThanOrEqual(1.5);
 const tasks=await page.evaluate(()=>{const w=window as any;w.__scrollTasks.push(...w.__scrollObserver.takeRecords().map((e:PerformanceEntry)=>e.duration));w.__scrollObserver.disconnect();return w.__scrollTasks as number[];});expect(tasks.filter(ms=>ms>250)).toEqual([]);
});
