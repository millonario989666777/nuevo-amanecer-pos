import { test, expect } from '@playwright/test';

async function rolePage(page, role) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => window.NA_ROLES?.role === role && window.NA_ROLES.confirmed, role);
}

test('employee navigation to owner screens shows a friendly permission overlay', async ({ page }) => {
  await rolePage(page, 'empleado');
  for (const id of ['pageGastos', 'pageConfig']) {
    await page.evaluate(id => window.goPage(id), id);
    await expect(page.locator('#naNoPermission')).toBeVisible();
    await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
    await expect(page.locator('#' + id)).not.toHaveClass(/\bactive\b/);
    await page.getByRole('button', { name: 'Volver a la venta', exact: true }).click();
    await expect(page.locator('#pagePOS')).toHaveClass(/\bactive\b/);
  }
  // Direct restoration/class changes are guarded even when navigation bypasses goPage.
  await page.evaluate(() => { document.getElementById('pageGastos').classList.add('active'); });
  await expect(page.locator('#naNoPermission')).toBeVisible();
  await expect(page.locator('#pageGastos')).not.toHaveClass(/\bactive\b/);
  await page.getByRole('button', { name: 'Volver a la venta', exact: true }).click();
  await page.evaluate(() => window.ventasSetTab(document.querySelector('#pageVentas .tab'), 'reportes'));
  await expect(page.locator('#naNoPermission')).toBeVisible();
});

test('owner can open expenses without a permission overlay', async ({ page }) => {
  await rolePage(page, 'owner');
  await page.evaluate(() => window.goPage('pageGastos'));
  await expect(page.locator('#pageGastos')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#naNoPermission')).toHaveCount(0);
});
