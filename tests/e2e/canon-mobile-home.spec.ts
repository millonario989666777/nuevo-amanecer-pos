import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('phone uses one drawer for actions and genuine empty activity', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await expect(page.locator('#naMobileWelcome')).toBeVisible();
  await expect(page.locator('#naMobileQuickActions')).toHaveCount(0);
  await expect(page.locator('#pageMenu .modules-grid')).toBeHidden();
  await expect(page.locator('#naMobileActivityList .na-mobile-activity-row')).toHaveCount(1);
  await expect(page.locator('#naMobileActivityList')).toContainText('Sin movimientos recientes');
  await page.locator('#naMobileMenuToggle').click();
  const drawer = page.locator('#naMobileDrawer');
  await expect(drawer.getByRole('button')).toHaveCount(11);
  for (const label of ['Inicio', 'Nueva venta', 'Ventas', 'Ingresar mercadería', 'Compras', 'Buscar cliente', 'Registrar abono', 'Abrir / cerrar caja', 'Registrar gasto', 'Configuración']) {
    await expect(drawer.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(drawer.getByRole('button', { name: 'Inicio', exact: true })).toHaveAttribute('aria-current', 'page');
  await drawer.getByRole('button', { name: 'Nueva venta', exact: true }).click();
  await expect(page.locator('#pagePOS')).toHaveClass(/active/);
  await expect(drawer).not.toHaveClass(/is-open/);
  // P1-4: en Nueva venta (teléfono) ☰ es el único botón de navegación; "← Menú" ya no se superpone.
  await expect(page.locator('#backBtn')).toBeHidden();
  await page.locator('#naMobileMenuToggle').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#naMobileMenuToggle')).toBeFocused();
  await page.locator('#naMobileMenuToggle').click();
  await page.locator('#naMobileDrawerOverlay').click({ position: { x: 380, y: 400 } });
  await expect(drawer).not.toHaveClass(/is-open/);
});

for (const width of [320, 360, 390, 430, 768, 1024, 1366, 1920]) {
  test(`viewport boundary at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/index.html');
    if (width < 768) {
      await expect(page.locator('#naMobileLandscape')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('#naMobileMenuToggle').click();
      await page.locator('#naMobileDrawer').getByRole('button', { name: 'Configuración', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.locator('#naMobileDrawer').getByRole('button', { name: 'Configuración', exact: true })).toBeVisible();
    } else {
      await expect(page.locator('#naMobileWelcome')).toHaveCount(0);
      await expect(page.locator('#naMobileDrawer')).toHaveCount(0);
      await expect(page.locator('#naMobileHomeStyles')).toHaveCount(0);
      await expect(page.locator('#pageMenu .menu-desktop-sidebar')).toBeVisible();
    }
  });
}

for (const [hour, phase] of [[6, 'dawn'], [12, 'day'], [18, 'dusk'], [20, 'night'], [0, 'midnight']] as const) {
  test(`landscape at hour ${hour} in southern winter`, async ({ page }) => {
    await page.clock.install({ time: new Date(2026, 6, 8, hour, 0) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/index.html');
    await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-phase', phase);
    await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-season', 'winter');
    await expect(page.locator('#naMobileLandscape')).toHaveAttribute('aria-hidden', 'true');
  });
}

test('time changes, reduced motion and rotation preserve usable home', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 2, 1, 7, 59) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-season', 'autumn');
  await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-phase', 'dawn');
  await page.clock.runFor(61000);
  await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-phase', 'day');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.na-landscape-cloud').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#naMobileWelcome')).toBeHidden();
  await expect(page.locator('#naMobileMenuToggle')).toBeHidden();
  await expect(page.locator('#pageMenu .menu-desktop-sidebar')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#naMobileWelcome')).toBeVisible();
  await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-motion', 'running');
});

test('activity shows ordered records without duplicate sales or summary rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await page.goto('/index.html');
  await page.evaluate(() => window.eval(`ventas=[{id:'V-1',fecha:'2026-10-08',hora24:'09:00:00',clienteNombre:'Cliente <prueba>',items:[{precio:10,qty:2}]}]; cajMovs=[{id:'M-1',ventaId:'V-1',tipo:'ing',monto:20,timestamp:'2026-10-08T09:00:00',desc:'Venta POS V-1'},{id:'M-2',tipo:'cob',monto:5,timestamp:'2026-10-08T10:00:00',desc:'Abono cliente'}]; NA_MENU_NAVIGATION.refreshMobileHome();`));
  await expect(page.locator('#naMobileActivityList .na-mobile-activity-row')).toHaveCount(2);
  await expect(page.locator('#naMobileActivityList .na-mobile-activity-row').first()).toContainText('Abono registrado');
  await expect(page.locator('#naMobileActivityList')).toContainText('Cliente prueba');
  await expect(page.locator('#naMobileActivityList script, #naMobileActivityList prueba')).toHaveCount(0);
  await page.locator('#naMobileActivity').scrollIntoViewIfNeeded();
  await expect(page.locator('#naMobileActivity')).toBeVisible();
});

for (const [month, season] of [[0, 'summer'], [3, 'autumn'], [6, 'winter'], [9, 'spring']] as const) {
  test(`southern season ${season}`, async ({ page }) => {
    await page.clock.install({ time: new Date(2026, month, 8, 12) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/index.html');
    await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-season', season);
  });
}

test('drawer targets reuse existing routes and refresh leaves loaded business state intact', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  const unchanged = await page.evaluate(() => window.eval(`
    (() => {
      const before = JSON.stringify({ventas,cajMovs,appConfig,cajEstado,productos,clientes,creditos});
      NA_MENU_NAVIGATION.refreshMobileHome();
      return JSON.stringify({ventas,cajMovs,appConfig,cajEstado,productos,clientes,creditos}) === before;
    })()
  `));
  expect(unchanged).toBe(true);
  for (const [label, destination] of [['Ventas','pageVentas'],['Ingresar mercadería','pageInventario'],['Buscar cliente','pageClientes'],['Registrar abono','pageClientes'],['Abrir / cerrar caja','pageCaja'],['Registrar gasto','pageGastos'],['Configuración','pageConfig']]) {
    await page.locator('#naMobileMenuToggle').click();
    await page.locator('#naMobileDrawer').getByRole('button', { name:label, exact:true }).click();
    await expect(page.locator('#'+destination)).toHaveClass(/active/);
    await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-motion', 'paused');
    await page.locator('#backBtn').click();
  }
});


test('hidden document pauses decorative movement and resumes without extra chrome', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await page.goto('/index.html');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable:true, value:true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-motion', 'paused');
  expect(await page.locator('.na-landscape-cloud').first().evaluate(el => getComputedStyle(el).animationPlayState)).toBe('paused');
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#naMobileLandscape')).toHaveAttribute('data-motion', 'running');
  await expect(page.locator('#naMobileMenuToggle')).toHaveCount(1);
});

test('mobile groups money and distinguishes credit with full Lima date and known time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await expect(page.locator('#naMobileWelcome')).toBeVisible();
  await page.waitForFunction(() => window.eval('_naFreeSaleShortcutState.ready'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));
  await page.evaluate(() => window.eval(`ventas=[{id:'V-065',metodo:'efectivo',timestamp:'2026-10-08T00:21:00Z',clienteNombre:'Cliente venta',total:6},{id:'V-064',metodoPago:'credito',timestamp:'2026-10-07T18:37:00Z',clienteNombre:'Cliente crédito',total:10}];cajMovs=[{id:'M-1',tipo:'cob',timestamp:'2026-10-07T18:38:00Z',clienteNombre:'Cliente abono',monto:18.5},{id:'M-2',tipo:'cob',canonicalDateKnown:false,fecha:'Fecha no registrada',monto:1}];document.getElementById('qsPorCobrar').textContent='S/ 22387.35';NA_MENU_NAVIGATION.refreshMobileHome();`));
  await expect(page.locator('#qsPorCobrar')).toHaveText('S/ 22,387.35');
  const rows = page.locator('#naMobileActivityList .na-mobile-activity-row');
  await expect(rows.nth(0)).toContainText('Venta #065');
  await expect(rows.nth(0)).toContainText('miércoles, 07/10/2026');
  await expect(rows.nth(0)).toContainText('07:21 PM');
  await expect(rows.nth(1)).toContainText('Abono registrado');
  await expect(rows.nth(1)).toContainText('Cliente abono');
  await expect(rows.nth(2)).toContainText('Venta a crédito #064');
  await expect(rows.nth(3)).toContainText('Fecha y hora no registradas');
  await page.evaluate(() => window.eval(`ventas=[{id:'V-1',fecha:'2026-10-07',hora:'12:00 AM',metodo:'credito',total:10},{id:'V-2',fecha:'2026-10-06',total:2}];cajMovs=[];NA_MENU_NAVIGATION.refreshMobileHome();`));
  await expect(rows.nth(0)).toContainText('miércoles, 07/10/2026 · 12:00 AM');
  await expect(rows.nth(1)).toContainText('martes, 06/10/2026 · Hora no registrada');
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(page.locator('#qsPorCobrar')).toHaveText('S/ 22387.35');
});

test('mobile CSS loads in head and page/cart updates do not fade out', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/index.html');
  await expect(page.locator('#naMobileWelcome')).toBeVisible();
  expect(await page.locator('#naMobileHomeBaseStyles').evaluate(el => el.parentElement?.tagName)).toBe('HEAD');
  expect(await page.locator('#pageMenu').evaluate(el => {el.classList.add('na-enter-fade');return getComputedStyle(el).animationName;})).toBe('none');
  await page.evaluate(() => {const el=document.createElement('span');el.id='motionProbe';el.className='na-cart-pulse';document.getElementById('pagePOS')?.append(el);});
  expect(await page.locator('#motionProbe').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
});

test('failed mobile enhancement cannot leave home invisible indefinitely', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.route('**/js/navigation/menu-navigation.js',route=>route.abort());
  await page.goto('/index.html');
  await expect(page.locator('#pageMenu')).toBeVisible({timeout:5000});
  expect(await page.locator('#pageMenu').evaluate(el=>getComputedStyle(el).visibility)).toBe('visible');
});
