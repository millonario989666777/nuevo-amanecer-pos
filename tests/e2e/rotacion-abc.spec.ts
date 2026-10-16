import { test, expect, type Page } from '@playwright/test';

// Run only after docs/ROTACION_ABC_INTEGRACION.md wiring has been applied.
// No DOM/permission injection: these cases exercise the integrated page.
async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'abc-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'abc-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  await page.evaluate(() => {
    (window as any).eval(`
      productos=[
        {id:'abc-1',name:'Producto de prueba con nombre largo para verificar lectura en teléfono',cat:'farmacia'},
        {id:'abc-2',name:'Producto B',cat:'farmacia'},
        {id:'abc-3',name:'Producto C',cat:'farmacia'},
        {id:'abc-4',name:'Producto sin ventas',cat:'abarrotes'},
        {id:'abc-5',name:'Histórico de 90 días',cat:'abarrotes'}
      ];
      ventas=[
        {id:'abc-sale',fecha:NALimaTime.today(),items:[{id:'abc-1',precio:80,qty:1},{id:'abc-2',precio:15,qty:1},{id:'abc-3',precio:5,qty:1}]},
        {id:'abc-void',fecha:NALimaTime.today(),anulada:true,items:[{id:'abc-4',precio:999,qty:1}]},
        {id:'abc-old',fecha:NA_ROTACION_ABC.periodRange(90).from,items:[{id:'abc-5',precio:40,qty:1}]}
      ];
    `);
  });
}
async function readState(page: Page) {
  return page.evaluate(() => (window as any).eval('JSON.stringify({productos,ventas})'));
}
async function noOverflow(page: Page) {
  expect(await page.locator('#pageRotacionAbc').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('#pageRotacionAbc').evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,h2,select,button,tbody th,tbody td,.abc-summary-card')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner opens ABC at ${width}px, ${dark ? 'dark' : 'light'}, without overflow or writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    const before = await readState(page);
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageProximamente'); }, dark);
    const card = page.locator('[data-feature-id="rotacion-abc"]');
    await expect(card).toHaveClass(/is-enabled/);
    await card.click();
    const screen = page.locator('#pageRotacionAbc');
    await expect(screen).toBeVisible();
    await expect(screen.locator('[data-abc-period]')).toHaveValue('30');
    await expect(screen.locator('.abc-summary-card').first()).toContainText('100');
    await expect(screen.locator('[data-abc-class="A"]')).toContainText('Producto de prueba');
    await expect(screen.locator('[data-abc-class="B"]')).toContainText('Producto B');
    await expect(screen).toContainText('sin ventas');
    await noOverflow(page);
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await screen.locator('[data-abc-category]').selectOption('abarrotes');
    await expect(screen.locator('.abc-group')).toHaveCount(1);
    await expect(screen.locator('.abc-summary-card').first()).toContainText('0');
    await screen.locator('[data-abc-period]').selectOption('90');
    await expect(screen.locator('.abc-summary-card').first()).toContainText('40');
    await expect(screen.locator('[data-abc-class="A"]')).toContainText('Histórico de 90 días');
    await screen.locator('[data-abc-category]').selectOption('*');
    await expect(screen.locator('.abc-summary-card').first()).toContainText('140');
    await noOverflow(page);
    const refresh = screen.getByRole('button', { name: 'Actualizar reporte' });
    await refresh.scrollIntoViewIfNeeded();
    expect(await refresh.evaluate(button => {
      const r = button.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    })).toBe(true);
    await refresh.click();
    expect(await readState(page)).toBe(before);
    expect(writes).toEqual([]);
    if (width === 390) {
      await page.evaluate(() => (window as any).goMenu());
      // Acceso por Próximamente (la pantalla no agrega filas al drawer del Inicio).
      await page.evaluate(() => (window as any).goPage('pageProximamente'));
      const card = page.locator('#pageProximamente [data-feature-id="rotacion-abc"]');
      await expect(card).toContainText('Disponible');
      await card.click();
      await expect(screen).toBeVisible();
      await expect(screen.locator('.abc-summary-card').first()).toContainText('140');
    }
  });
}

test('employee cannot see the drawer entry or open ABC; direct rendering exposes no products', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado');
  await seed(page);
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageRotacionAbc"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageRotacionAbc'); });
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageRotacionAbc')).not.toHaveClass(/\bactive\b/);
  await page.evaluate(() => (window as any).NA_ROTACION_ABC.render());
  await expect(page.locator('#pageRotacionAbc [data-abc-content]')).toBeEmpty();
  await expect(page.locator('#pageRotacionAbc [data-abc-status]')).toContainText('Sin permiso');
  await expect(page.locator('#pageRotacionAbc [data-abc-controls]')).toBeHidden();
});
