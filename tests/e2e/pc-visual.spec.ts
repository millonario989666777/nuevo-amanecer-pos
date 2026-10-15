import { test, expect } from '@playwright/test';

async function rolePage(page, role) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'employee-device' } : {}) });
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


for (const width of [1366, 390]) {
  test(`financial detail columns and placeholder at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await page.evaluate(() => {
      window.goPage('pageClientes');
      clientes = [{id:'pc-fixture',nombre:'Ana Prueba',dni:'SIN-DOC-x',color:0}];
      creditos = [];
      window.naCanonOpenClientAccount('pc-fixture');
    });
    const detail = page.locator('.na-v2-client-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.na-v2-client-head p')).toHaveText('Sin DNI');
    const left = await detail.locator('.na-v2-accounts-section').boundingBox();
    const right = await detail.locator(':scope > .na-v2-section:last-child').boundingBox();
    expect(left).toBeTruthy(); expect(right).toBeTruthy();
    if (width >= 1024) expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
    else { expect(Math.abs(right!.x - left!.x)).toBeLessThan(2); expect(right!.y).toBeGreaterThan(left!.y); }
  });
}
test('Caja uses desktop width', async ({ page }) => {
  await page.setViewportSize({width:1366,height:900});
  await rolePage(page,'owner');
  await page.evaluate(() => window.goPage('pageCaja'));
  await expect(page.locator('#cajContent')).toBeVisible();
  expect((await page.locator('#cajContent').boundingBox())!.width).toBeGreaterThan(1000);
});
