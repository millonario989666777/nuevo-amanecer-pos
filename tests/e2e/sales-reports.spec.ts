import { test, expect } from '@playwright/test';
for (const width of [390, 768, 1366]) {
 test(`local owner reports at ${width}px in light and dark`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_ROLES?.isOwner());
  await page.evaluate(() => {
   const w=window as any;
   // Isolated synthetic records in app state: no storage writes or sale commands.
   w.eval(`productos=[{id:9001,name:'Reporte prueba',cat:'farmacia',costo:2}];ventas=[{id:'test-report',fecha:NALimaTime.today(),total:30,metodo:'yape',cajeroNombre:'Cajero prueba',items:[{id:9001,name:'Reporte prueba',precio:10,qty:3,costo:2}]}];gastos=[];cajMovs=[];creditos=[];clientes=[];`);
   w.goPage('pageVentas');
  });
  await page.locator('#pageVentas .tab').filter({ hasText: 'Reportes' }).click();
  await page.locator('#salesReportPeriod').selectOption('today');
  await expect(page.locator('#ventasContent')).toContainText('Ventas por categoría');
  await expect(page.locator('#ventasContent')).toContainText('Cajero prueba');
  await expect(page.locator('#ventasContent')).toContainText('Top 10 por importe');
  for(const period of ['week','month','previousMonth','custom']) {
   await page.locator('#salesReportPeriod').selectOption(period);
   if(period==='custom') {
    const today=await page.evaluate(()=>(window as any).NALimaTime.today());
    await page.locator('#salesReportFrom').fill(today);await page.locator('#salesReportTo').fill(today);
   }
   if(period!=='previousMonth') await expect(page.locator('#ventasContent')).toContainText('Cajero prueba');
   else await expect(page.locator('#ventasContent')).not.toContainText('Cajero prueba');
  }
  for(const dark of [false,true]) {
   await page.evaluate(dark=>document.body.classList.toggle('dark',dark),dark);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
   expect(overflow).toBe(false);
   const select=page.locator('#salesReportPeriod');await select.scrollIntoViewIfNeeded();
   expect(await select.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
   await expect(page.locator('#ventasContent .report-section').first()).toBeVisible();
  }
  const download=page.waitForEvent('download');
  await page.evaluate(()=>{(window as any).XLSX=undefined;});
  await page.locator('.sales-report-export').click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
 });
}
