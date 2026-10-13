import {test,expect} from '@playwright/test';

// Bot 5: «PIN incorrecto. Quedan N intentos.» se escribe DENTRO de la ventana del PIN (no en un aviso
// flotante que el teclado tapa) y la ventana sigue abierta para reintentar.
test('wrong owner PIN shows the remaining attempts inside the PIN window',async({page})=>{
  let calls=0;
  await page.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.hostname==='pin.test'&&u.pathname==='/auth/owner-approval'){
      calls++;
      return calls===1?route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'owner_pin_invalid',attempts_left:2})})
        :route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({approval_id:'ap-1'})});
    }
    return u.hostname==='127.0.0.1'?route.continue():route.abort();
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto('/index.html');
  await page.waitForFunction(()=>window.NA_ROLES&&window.NA_ROLES.approve);
  await page.evaluate(()=>{localStorage.setItem('na_cloud_sync_credentials',JSON.stringify({endpoint:'https://pin.test',token:'t'}));window.__ap=window.NA_ROLES.approve('inventory.adjust','op-1','Autorización del dueño','Ajuste de stock');});
  await page.locator('.na-pin-input').fill('1111');
  await page.locator('.na-pin-ok').click();
  await expect(page.locator('.na-pin-msg')).toHaveText('PIN incorrecto. Quedan 2 intentos.');
  await expect(page.locator('.na-pin-overlay')).toBeVisible();
  await expect(page.locator('.na-pin-input')).toHaveValue('');
  await page.locator('.na-pin-input').fill('2222');
  await page.locator('.na-pin-ok').click();
  await expect(page.locator('.na-pin-overlay')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__ap)).toBe('ap-1');
});
