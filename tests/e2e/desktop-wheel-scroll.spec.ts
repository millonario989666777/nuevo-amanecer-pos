import { test, expect, type Page } from '@playwright/test';

async function rolePage(page: Page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(url.pathname === '/auth/me'
        ? { pos_role: 'owner', owner_pin_set: true, roles_ready: true, device_id: 'wheel-fixture' } : {}),
    });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role: 'owner' }));
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).NA_ROLES?.role === 'owner' && (window as any).NA_ROLES.confirmed);
  await page.waitForFunction(() => typeof (window as any).goPage === 'function');
}

async function wheelScroll(page: Page, id: string) {
  const active = page.locator(`#${id}`);
  await expect(active).toHaveClass(/\bactive\b/);
  await expect.poll(() => active.evaluate(el => Math.max(
    el.scrollHeight - el.clientHeight,
    document.documentElement.scrollHeight - innerHeight,
  ))).toBeGreaterThan(0);
  await active.evaluate(el => { el.scrollTop = 0; window.scrollTo(0, 0); });
  const point = await active.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2,
      y: (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => active.evaluate(el => Math.max(el.scrollTop, window.scrollY))).toBeGreaterThan(0);
}

for (const width of [1366, 1024]) {
  for (const id of ['pageInventario', 'pageCaja', 'pageVentas']) {
    test(`mouse wheel scrolls ${id} at ${width}x768`, async ({ page }) => {
      await page.setViewportSize({ width, height: 768 });
      await rolePage(page);
      await page.evaluate(id => {
        const w = window as any;
        // Synthetic cash session and movements in isolated browser state only.
        w.eval(`cajEstado={abierta:true,cerrada:false,sessionId:'wheel-session',fechaApertura:obtenerHoy(),cajero:'Prueba',montoInicial:0};
          cajMovs=Array.from({length:60},(_,i)=>({id:'wheel-move-'+i,tipo:'ing',monto:2,efectivo:2,desc:'Movimiento rueda '+i,cat:'Ingreso',metodo:'efectivo',hora:'10:00',fecha:obtenerHoy(),sessionId:'wheel-session'}));`);
        w.goPage(id);
      }, id);
      if (id === 'pageInventario') await expect.poll(() => page.locator('#invBody > tr').count()).toBeGreaterThan(20);
      if (id === 'pageCaja') await page.locator('#pageCaja .tab').filter({ hasText: 'Movimientos' }).click();
      if (id === 'pageVentas') {
        await page.locator('#pageVentas .tab').filter({ hasText: 'Reportes' }).click();
        await expect(page.locator('#ventasContent')).toContainText('Resultado del período');
      }
      await wheelScroll(page, id);
    });
  }
}

test('phone inventory retains document scrolling at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page);
  await page.evaluate(() => (window as any).goPage('pageInventario'));
  await expect(page.locator('#pageInventario')).toHaveClass(/inv-mobile-simple/);
  await expect.poll(() => page.locator('#invBody > tr').count()).toBeGreaterThan(20);
  await wheelScroll(page, 'pageInventario');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await page.locator('#pageInventario').evaluate(el => el.scrollTop)).toBe(0);
});
