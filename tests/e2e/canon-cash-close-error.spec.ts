import {test,expect} from '@playwright/test';

for (const width of [390,1024]) {
  test('close error remains visible when an old cash session redraws at '+width+'px',async({page})=>{
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.setViewportSize({width,height:900});
    await page.goto('/index.html');
    await page.waitForFunction(()=>window.NA_MENU_NAVIGATION);
    await page.evaluate(()=>{
      cajEstado={abierta:true,cerrada:false,fechaApertura:'2020-01-01',fondo:1072.5,sessionId:'synthetic-old-cash'};
      cajMovs=[];
      window.NA_MENU_NAVIGATION.navigate('pageCaja');
      window.prepCierre();
      // Test transport boundary only: keep the real closing bridge, renderer,
      // modal and global lexical toast from the complete production page.
      window.NuevoAmanecerCanonical={enabled:()=>true,pendingSnapshot:()=>({command:'payment.create',last_status:409,last_error:'stale_credit',payload:{}})};
      window._naAuthorize=()=>true;
    });
    await page.locator('#cajContado').fill('1100');
    await page.locator('#mCierre .mbtn-ok').click();
    await expect(page.locator('#cajCloseStatus')).toContainText('un abono que el servidor rechazó');
    await page.evaluate(()=>window.cajRender());
    await expect(page.locator('#cajCloseStatus')).toBeVisible();
    await expect(page.locator('#cajCloseStatus')).toContainText('el saldo del crédito cambió');
    await expect(page.locator('#mCierre')).toHaveClass(/open/);
    await expect(page.locator('#mCierre .mbtn-ok')).toBeEnabled();
    expect(await page.evaluate(()=>cajEstado.cerrada)).toBe(false);
  });
}
