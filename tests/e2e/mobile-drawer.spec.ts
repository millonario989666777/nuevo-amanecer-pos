import { test, expect, Page } from '@playwright/test';

const pages = ['pageMenu', 'pagePOS', 'pageVentas', 'pageInventario', 'pageClientes', 'pageCaja', 'pageGastos', 'pageProximamente', 'pageConfig'];

async function openDrawer(page: Page) {
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer')).toHaveAttribute('aria-hidden', 'false');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' && url.port !== '9' ? route.continue() : route.abort();
  });
});

for (const employee of [false, true]) {
  test(`${employee ? 'employee' : 'owner'} drawer exposes permitted destinations and navigates`, async ({ page }) => {
    if (employee) {
      await page.addInitScript(() => {
        localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'http://127.0.0.1:9', token: 'test-only' }));
        localStorage.setItem('na_pos_role_v1', JSON.stringify({ role: 'empleado', label: 'María Torres', at: Date.now() }));
      });
    }
    await page.goto('/index.html');
    await openDrawer(page);
    const drawer = page.locator('#naMobileDrawer');
    if (employee) {
      await expect(drawer.locator('[data-page="pageConfig"]')).toHaveCount(0);
      await expect(page.locator('#naMobileProfileName')).toHaveText('María Torres');
      // The cached role cannot be confirmed offline, so the label stays pending.
      await expect(page.locator('#naMobileProfileRole')).toHaveText('Verificando permisos…');
      await expect(page.locator('#naMobileProfileAvatar')).toHaveText('MT');
    } else {
      await expect(drawer.locator('button')).toHaveCount(10);
      await expect(drawer.locator('#naMobileDrawerVersion')).toHaveText('Versión local');
      await expect(drawer.locator('.na-mobile-drawer-head .na-mobile-drawer-logo')).toHaveCSS('background-image', /svg/);
      await expect(drawer.locator('.na-mobile-drawer-head img')).toHaveCount(0);
    }
    const permitted = await page.evaluate(ids => ids.filter(id => (window as any).NA_MENU_NAVIGATION.canShowDrawerPage(id)), pages);
    const destinations = await drawer.locator('.na-mobile-drawer-link').evaluateAll(rows => rows.map(row => row.getAttribute('data-page')!));
    expect(destinations).toEqual(permitted);
    for (const id of pages.filter(id => !permitted.includes(id))) {
      await expect(drawer.locator(`[data-page="${id}"]`)).toHaveCount(0);
    }
    for (const id of destinations) {
      const row = drawer.locator(`[data-page="${id}"]`);
      const box = await row.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      await expect(row.locator('small')).not.toHaveText('');
      expect(await page.evaluate(id => !!document.getElementById(id), id)).toBe(true);
      await row.click();
      await expect(page.locator(`#${id}`)).toHaveClass(/\bactive\b/);
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');
      // Configuración usa su propia cabecera móvil (sin ☰), así que va al final de la lista.
      if (id === destinations[destinations.length - 1]) break;
      await openDrawer(page);
      await expect(drawer.locator(`[data-page="${id}"]`)).toHaveAttribute('aria-current', 'page');
    }
  });
}

test('only the list scrolls while header and profile stay fixed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 560 });
  await page.goto('/index.html');
  await openDrawer(page);
  const head = page.locator('.na-mobile-drawer-head');
  const profile = page.locator('.na-mobile-profile');
  const nav = page.locator('.na-mobile-drawer-nav');
  // Wait for the drawer entrance to finish before comparing coordinates.
  await expect.poll(async () => (await page.locator('#naMobileDrawer').boundingBox())!.x).toBe(0);
  const beforeHead = await head.boundingBox();
  const beforeProfile = await profile.boundingBox();
  const sizes = await nav.evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  await nav.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await nav.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect((await head.boundingBox())!.y).toBe(beforeHead!.y);
  expect((await profile.boundingBox())!.y).toBe(beforeProfile!.y);
});

test('desktop does not build drawer or load its stylesheet', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto('/index.html');
  await expect(page.locator('#pageMenu')).toBeVisible();
  await expect(page.locator('#naMobileDrawer')).toHaveCount(0);
  await expect(page.locator('#naMobileDrawerStyles')).toHaveCount(0);
});
