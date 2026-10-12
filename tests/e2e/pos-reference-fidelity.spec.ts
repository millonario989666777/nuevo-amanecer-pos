import { test, expect, Page } from '@playwright/test';

async function enterPos(page: Page) {
  if (await page.evaluate(() => innerWidth >= 768)) {
    const sidebar = page.locator('[data-menu-target="pagePOS"]');
    await expect(sidebar).toBeVisible();
    await sidebar.click();
    return;
  }
  await page.locator('#naMobileMenuToggle').click();
  const quickSale = page.getByRole('button', { name: 'Nueva venta', exact: true });
  if (await quickSale.isVisible()) {
    await quickSale.click();
    return;
  }
  await page.locator('.module-card').first().click();
}

async function prepare(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await enterPos(page);
  await page.evaluate(() => {
    // Isolated synthetic session. No remote API or actual business data.
    window.eval(`productos = [
      {id:'VIS-A',name:'Producto A',cat:'abarrotes',precio:10,costo:4,stock:10,stockMin:1,icon:'📦'},
      {id:'VIS-B',name:'Producto B',cat:'abarrotes',precio:5,costo:2,stock:8,stockMin:1,icon:'📦'}
    ]; clientes=[{id:'VIS-C',nombre:'Cliente prueba',dni:''}];
    cajEstado={abierta:true,cerrada:false,fechaApertura:obtenerHoy(),cajero:'Prueba',cajeroId:'TEST'};
    cart=[]; appConfig.margenActive=true; posRender(); posUpdateCart();`);
  });
}

test('current sale controls edit real cart and survive canonical capture', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await prepare(page);
  await expect(page.locator('#btnPagar')).toBeDisabled();
  await expect(page.locator('#posQuantity')).toBeDisabled();
  await page.locator('[data-product-id="VIS-A"]').click();
  await expect(page.locator('.cart-item')).toHaveCount(1);
  await page.locator('[data-na-cart-action="increase"]').click();
  await expect(page.locator('.qty-num')).toHaveText('2');
  await page.locator('[data-na-cart-action="decrease"]').click();
  await page.locator('#posQuantity').click();
  await page.locator('#posLineValue').fill('3');
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(page.locator('.qty-num')).toHaveText('3');
  await page.locator('#posQuantity').click();
  await page.locator('#posLineValue').fill('11');
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(page.locator('#posLineError')).toContainText('Stock insuficiente');
  await page.locator('#posLineEditor').getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.locator('#posPrice').click();
  await page.locator('#posLineValue').fill('3');
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(page.locator('#posLineError')).toContainText('bajo costo');
  await page.locator('#posLineValue').fill('8.50');
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(page.locator('#posTotal')).toHaveText('S/ 25.50');
  await page.locator('[data-product-id="VIS-B"]').click();
  await expect(page.locator('.cart-item')).toHaveCount(2);
  await page.locator('.cart-item').last().locator('[data-na-cart-action="remove"]').click();
  await expect(page.locator('.cart-item')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept('10'));
  await page.locator('#posDiscount').click();
  await expect(page.locator('#posTotal')).toHaveText('S/ 22.95');
  await page.locator('.pos-customer-button').click();
  await page.locator('.na-client-picker-row').filter({ hasText: 'Cliente prueba' }).click();
  await expect(page.locator('#posCustomer')).toHaveText('Cliente prueba');
  await page.locator('#btnPagar').click();
  await expect(page.locator('#mCobro')).toHaveClass(/open/);
  await expect(page.locator('#mVentaCliente')).toHaveValue('VIS-C');
  await page.evaluate(() => {
    const root = window as any;
    root.__capturedSale = null;
    root.NuevoAmanecerCanonical = { enabled: () => true, snapshot: () => ({sales:[],products:[]}) };
    root.NuevoAmanecerCanonicalSaleOutbox = {
      snapshot: () => ({intents:[]}),
      enqueue: async (input: any) => { const intent = root.NuevoAmanecerCanonicalSaleIntent.build(input); root.__capturedSale = intent; return intent; },
      sync: async () => {},
    };
  });
  await page.locator('#mBtnConf').click();
  await expect.poll(() => page.evaluate(() => (window as any).__capturedSale)).toMatchObject({
    customer_id:'VIS-C', total_cents:2295, items:[{product_id:'VIS-A',quantity:3,unit_price_cents:765}],
  });
  await expect(page.locator('.cart-item')).toHaveCount(0);
  await expect(page.locator('#posCustomer')).toHaveText('Cliente genérico');
});

test('desktop fidelity uses one header, aligned categories and five product columns', async ({ page }) => {
  await page.setViewportSize({width:1536,height:1024}); await prepare(page);
  const dimensions = await page.evaluate(() => {
    const style = (selector:string) => getComputedStyle(document.querySelector(selector)!);
    return { columns:style('#posArea').gridTemplateColumns.split(' ').length,
      categoryHeight:document.querySelector('.cat-btn:nth-child(2)')!.getBoundingClientRect().height,
      sidebarScroll:style('#posSidebar').overflowY, cart:style('#cartDrawer').position };
  });
  expect(dimensions).toEqual({columns:5,categoryHeight:41,sidebarScroll:'auto',cart:'relative'});
  await expect(page.locator('#posSidebar .ci svg')).toHaveCount(await page.locator('#posSidebar .cat-btn').count());
  await expect(page.locator('#posClear')).toBeVisible();
  await expect(page.locator('#posRuntimeStatus')).toHaveAttribute('data-state','disconnected');
  await page.locator('#btnMayorista').click();
  await expect(page.locator('#modoMayoristaTag')).toBeVisible();
  await page.locator('#btnMayorista').click();
  await page.locator('#btnVentaLibre').click();
  await expect(page.locator('#mVentaLibre')).toHaveClass(/open/);
  await page.locator('#mVentaLibre .mbtn-cancel').click();
  await page.locator('#backBtn').click();
  await expect(page.locator('#pageMenu')).toBeVisible();
});

test('quick payment and clear keep their existing workflows', async ({ page }) => {
  await page.setViewportSize({width:1536,height:1024}); await prepare(page);
  await page.locator('[data-product-id="VIS-A"]').click();
  await page.locator('#btnRapido').click();
  await expect(page.locator('#mCobroRapido')).toHaveClass(/open/);
  await page.evaluate(() => window.eval("cerrarModal('mCobroRapido')"));
  await page.locator('#posClear').click();
  await page.locator('#naConfirmOk').click();
  await expect(page.locator('.cart-item')).toHaveCount(0);
  await expect(page.locator('#btnPagar')).toBeDisabled();
  await page.locator('[data-product-id="VIS-A"]').click();
  await page.evaluate(() => {
    const root=window as any;
    root.NuevoAmanecerCanonical={enabled:()=>true,snapshot:()=>({sales:[],products:[]})};
    root.NuevoAmanecerCanonicalSaleOutbox={snapshot:()=>({intents:[]}),
      enqueue:async(input:any)=>{const intent=root.NuevoAmanecerCanonicalSaleIntent.build(input);root.__quickSale=intent;return intent;},sync:async()=>{}};
  });
  await page.locator('#btnRapido').click();
  await page.locator('#mQuickCash').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__quickSale)).toMatchObject({total_cents:1000,payment_method:'efectivo'});
  await expect(page.locator('.cart-item')).toHaveCount(0);
});

for (const width of [320,360,390,430,768,1024,1366,1920]) {
  test(`responsive layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:900}); await prepare(page);
    const geometry = await page.evaluate(() => {
      const area=document.querySelector('#posArea')!.getBoundingClientRect();
      return {right:area.right,width:area.width,viewport:innerWidth,
        cart:getComputedStyle(document.querySelector('#cartDrawer')!).position};
    });
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.width).toBeGreaterThan(width < 700 ? 200 : 400);
    // Etapa 2: tablet (701-1099px) docks VENTA ACTUAL as a column so it never covers product cards.
    expect(geometry.cart).toBe(width<=700?'absolute':'relative');
    if(width<=700) {
      await page.locator('.cart-fab').click();
      await expect(page.locator('.cart-mobile-close')).toBeVisible();
      await page.locator('.cart-mobile-close').click();
      await expect(page.locator('#cartDrawer')).not.toHaveClass(/open/);
    }
  });
}

test('Android desktop-site keeps phone sale and hidden catalog on a wide viewport', async ({ browser }) => {
  const context=await browser.newContext({viewport:{width:1280,height:900},screen:{width:390,height:844},hasTouch:true,isMobile:true});
  const page=await context.newPage(); await prepare(page);
  await expect(page.locator('body')).toHaveClass(/na-pos-phone-device/);
  await expect(page.locator('#posArea')).toBeHidden();
  await expect(page.locator('#cartItems')).toBeVisible();
  expect(await page.locator('#cartDrawer').evaluate(el=>getComputedStyle(el).position)).toBe('relative');
  await page.locator('#posPhoneAdd').click();
  await expect(page.locator('#posPhoneCatalog')).toBeVisible();
  expect(await page.locator('#posArea').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(3);
  await page.locator('#posPhoneCatalogClose').click();
  await expect(page.locator('#posArea')).toBeHidden();
  await context.close();
});


test('current sale panel matches the approved desktop hierarchy', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await prepare(page);
  await page.locator('[data-product-id="VIS-A"]').click();

  await expect(page.locator('#cartDrawer .cart-head-title')).toContainText('Venta actual');
  await expect(page.locator('#posClear')).toBeVisible();
  await expect(page.locator('#posCustomerButton')).toBeVisible();
  await expect(page.locator('#cartDrawer .cart-item')).toHaveCount(1);
  await expect(page.locator('#cartDrawer .cart-line-unit')).toContainText('1 unidad');
  await expect(page.locator('#posProductCount')).toHaveText('Nro. de productos: 1');
  await expect(page.locator('#posUnitCount')).toBeHidden();
  await expect(page.locator('#posTotal')).toHaveText('S/ 10.00');
  await expect(page.locator('#posQuantity')).toBeEnabled();
  await expect(page.locator('#posDiscount')).toBeEnabled();
  await expect(page.locator('#posPrice')).toBeEnabled();
  await expect(page.locator('#btnRapido')).toBeEnabled();
  await expect(page.locator('#btnPagar')).toBeEnabled();
  await expect(page.getByPlaceholder('Nota de venta (opcional)')).toHaveCount(0);
});

test('short desktop viewport compacts the current-sale footer without changing tall desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 627 });
  await prepare(page);
  await page.locator('[data-product-id="VIS-A"]').click();
  const compact = await page.evaluate(() => ({
    total: document.querySelector('.total-main')!.getBoundingClientRect().height,
    secondary: document.querySelector('.cart-secondary-actions button')!.getBoundingClientRect().height,
    pay: document.querySelector('#btnPagar')!.getBoundingClientRect().height,
  }));
  expect(compact.total).toBeLessThanOrEqual(36);
  expect(compact.secondary).toBeLessThanOrEqual(32);
  expect(compact.pay).toBeLessThanOrEqual(44);

  await page.setViewportSize({ width: 1366, height: 900 });
  const tall = await page.evaluate(() => ({
    total: document.querySelector('.total-main')!.getBoundingClientRect().height,
    secondary: document.querySelector('.cart-secondary-actions button')!.getBoundingClientRect().height,
    pay: document.querySelector('#btnPagar')!.getBoundingClientRect().height,
  }));
  expect(tall.total).toBeGreaterThanOrEqual(44);
  expect(tall.secondary).toBeGreaterThanOrEqual(36);
  expect(tall.pay).toBeGreaterThanOrEqual(52);
});
