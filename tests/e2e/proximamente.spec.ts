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

const ids = ['creditos-vencimiento', 'gastos', 'reportes', 'cotizaciones', 'cuentas-pagar', 'compartir-pdf-whatsapp', 'filtro-fechas-export'];

test('employee cannot enter Próximamente', async ({ page }) => {
  await rolePage(page, 'empleado');
  await page.evaluate(() => window.goPage('pageProximamente'));
  await expect(page.locator('#naNoPermission')).toBeVisible();
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageProximamente')).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('.menu-desktop-sidebar [data-menu-target="pageProximamente"]')).toBeHidden();
});

test('owner sees ordered previews without writes', async ({ page }) => {
  await rolePage(page, 'owner');
  const writes: string[] = [];
  page.on('request', request => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url());
  });
  await page.evaluate(() => window.goPage('pageProximamente'));
  const cards = page.locator('#pageProximamente .na-prox-card');
  await expect(cards).toHaveCount(7);
  expect(await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-feature-id')))).toEqual(ids);
  for (const id of ids) {
    await page.locator(`[data-feature-id="${id}"]`).click();
    const preview = page.locator('#naProxPreview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('.na-prox-banner')).toHaveText('Función en preparación, aún no guarda datos');
    const saves = preview.getByRole('button', { name: 'Guardar', exact: true });
    expect(await saves.count()).toBeGreaterThan(0);
    for (const save of await saves.all()) { await expect(save).toBeDisabled(); await save.click({ force: true }); }
    for (const input of await preview.locator('input').all()) await expect(input).toBeDisabled();
    await preview.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(preview).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});

for (const [width, columns] of [[1366, 3], [768, 2], [390, 1]]) {
  test(`grid uses ${columns} columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await page.evaluate(() => window.goPage('pageProximamente'));
    await expect(page.locator('.na-prox-card')).toHaveCount(7);
    const count = await page.locator('.na-prox-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(count).toBe(columns);
  });
}
