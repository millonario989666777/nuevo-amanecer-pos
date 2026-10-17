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

const unlockedPages = { 'creditos-vencimiento': 'pageClientes', gastos: 'pageGastos', reportes: 'pageVentas', 'filtro-fechas-export': 'pageVentas', 'clientes-filtro-deuda': 'pageClientes', 'valorizacion-inventario': 'pageValorizacion', 'rotacion-abc': 'pageRotacionAbc', 'clientes-frecuencia': 'pageClientesFrecuencia', kardex: 'pageKardex', 'reporte-ventas-stock': 'pageVentasStock', 'reporte-arqueo': 'pageReporteArqueo', 'historial-compras-producto': 'pageHistorialCompras', 'cliente-historial-compras': 'pageClienteHistorial' };

async function registry(page) {
  return page.evaluate(async () => { const api = (window as any).NA_PROXIMAMENTE; await api.load(); return api.list().map(f => ({ id: f.id, module: f.module, unlocked: api.isUnlocked(f), locked: (window as any).NA_PERMISSIONS.featureLocked(f.id), uncertain: !!f.uncertain })); });
}

test('registry is not loaded until Próximamente opens', async ({ page }) => {
  await rolePage(page, 'owner');
  expect(await page.evaluate(() => !!(window as any).NA_PROXIMAMENTE_REGISTRY)).toBe(false);
  expect(await page.locator('script[src*="proximamente-registry"]').count()).toBe(0);
  await page.evaluate(() => window.goPage('pageProximamente'));
  await expect(page.locator('#pageProximamente .na-prox-card').first()).toBeVisible();
  expect(await page.evaluate(() => !!(window as any).NA_PROXIMAMENTE_REGISTRY)).toBe(true);
});

test('employee cannot enter Próximamente', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado');
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageProximamente"]')).toHaveCount(0);
  await page.evaluate(() => window.goPage('pageProximamente'));
  await expect(page.locator('#naNoPermission')).toBeVisible();
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageProximamente')).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('#pageProximamente .na-prox-card')).toHaveCount(0);
  await expect(page.locator('.menu-desktop-sidebar [data-menu-target="pageProximamente"]')).toHaveCount(0);
});

test('every registry entry: server lock exists; locked ones show the lock and preview without writes; employee gets Sin permiso', async ({ page, browser }) => {
  test.setTimeout(180000);
  await rolePage(page, 'owner');
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
  await page.evaluate(() => window.goPage('pageConfig'));
  const configButton = page.locator('#na9Nav [data-go="pageProximamente"]');
  await expect(configButton).toContainText('Funciones en preparación');
  await configButton.click();
  await expect(page.locator('#pageProximamente')).toHaveClass(/\bactive\b/);
  const entries = await registry(page);
  expect(entries.length).toBeGreaterThan(0);
  const locks = await page.evaluate(() => Object.keys((window as any).NA_PERMISSIONS.FEATURE_LOCKS));
  for (const e of entries) {
    expect(locks, `server lock for ${e.id}`).toContain(e.id);
    expect(e.unlocked, e.id).toBe(e.id in unlockedPages);
    expect(e.locked, e.id).toBe(!(e.id in unlockedPages));
  }
  await expect(page.locator('#pageProximamente .na-prox-card')).toHaveCount(entries.length);
  const unlocked = entries.filter(e => e.unlocked);
  if (unlocked.length) await expect(page.locator('.na-prox-section[data-module="Disponible"] > .na-prox-summary')).toHaveText(`Disponible (${unlocked.length})`);
  for (const module of ['Ventas', 'Caja', 'Inventario', 'Clientes', 'Comprobantes', 'Extras']) {
    const n = entries.filter(e => e.module === module && !e.unlocked).length;
    if (!n) { await expect(page.locator(`.na-prox-section[data-module="${module}"]`)).toHaveCount(0); continue; }
    await expect(page.locator(`.na-prox-section[data-module="${module}"] > .na-prox-summary`)).toHaveText(`${module} (${n})`);
  }
  for (const e of unlocked) await expect(page.locator(`[data-feature-id="${e.id}"] .na-prox-available`)).toHaveText('Disponible');
  for (const id of ['reparto-abono-multiples-deudas', 'transferencias-cajas']) await expect(page.locator(`[data-feature-id="${id}"] .na-prox-note`)).toBeVisible();
  for (const id of ['reparto-abono-multiples-deudas', 'transferencias-cajas']) await expect(page.locator(`[data-feature-id="${id}"] .na-prox-note`)).toHaveText('Requiere CANON + migración');
  if (unlocked.length) {
    const iconOffset = (id: string) => page.locator(`[data-feature-id="${id}"]`).evaluate(c => c.querySelector('.na-prox-icon')!.getBoundingClientRect().top - c.getBoundingClientRect().top);
    const lockedId = entries.find(e => !e.unlocked)!.id;
    expect(Math.abs(await iconOffset(unlocked[0].id) - await iconOffset(lockedId)), 'no extra top strip on Disponible cards').toBeLessThan(1);
  }
  for (const e of entries) {
    const card = page.locator(`[data-feature-id="${e.id}"]`);
    if (e.unlocked) { await expect(card).toHaveClass(/is-enabled/); await expect(card.locator('.na-prox-badge')).toHaveCount(0); continue; }
    await expect(card.locator('.na-prox-badge')).toContainText('🔒 Próximamente');
    if (e.uncertain) await expect(card.locator('.na-prox-tag')).toHaveText('por confirmar');
    await card.click();
    const preview = page.locator('#naProxPreview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('.na-prox-banner')).toHaveText('Función en preparación, aún no guarda datos');
    for (const save of await preview.getByRole('button', { name: 'Guardar', exact: true }).all()) { await expect(save).toBeDisabled(); await save.click({ force: true }); }
    for (const input of await preview.locator('input').all()) await expect(input).toBeDisabled();
    await preview.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(preview).toHaveCount(0);
  }
  expect(writes).toEqual([]);
  await page.locator('[data-feature-id="gastos"]').click();
  await expect(page.locator('#pageGastos')).toHaveClass(/\bactive\b/);

  const employee = await browser.newPage();
  await rolePage(employee, 'empleado');
  for (const e of entries.filter(x => !x.unlocked)) {
    const r = await employee.evaluate(id => { const api = (window as any).NA_PROXIMAMENTE; (window as any).goPage('pageProximamente'); api.openPreview(id); return { preview: !!document.getElementById('naProxPreview'), denied: (window as any).NA_PERMISSIONS.canAccessScreen('empleado', 'pageProximamente') }; }, e.id);
    expect(r.preview, e.id).toBe(false);
    expect(r.denied, e.id).toBe(false);
  }
  await expect(employee.locator('#naNoPermission')).toContainText('Sin permiso');
  await employee.close();
});

test('Asistente virtual is visible for owner and locked; clicking only opens a disabled preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'owner');
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
  await page.evaluate(() => window.goPage('pageProximamente'));
  const card = page.locator('.na-prox-section[data-module="Extras"] [data-feature-id="asistente-virtual"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass('na-prox-card');
  await expect(card).toHaveAttribute('type', 'button');
  await expect(card.locator('.na-prox-name')).toHaveText('Asistente virtual');
  await expect(card.locator('.na-prox-description')).toHaveText('Asistente 3D animado que te ayuda con todo el POS: vender, productos y stock, compras, caja, clientes y crédito, reportes y configuración. Te guía paso a paso en cualquier función.');
  await expect(card.locator('.na-prox-badge')).toHaveText('🔒 Próximamente · Prioridad media');
  await expect(card.locator('.na-prox-available')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const api = (window as any).NA_PROXIMAMENTE, feature = api.get('asistente-virtual');
    return { locked: (window as any).NA_PERMISSIONS.featureLocked(feature.id), enabled: api.isEnabled(feature.id), page: feature.page, roles: feature.roles };
  })).toEqual({ locked: true, enabled: false, page: null, roles: ['owner'] });
  await card.click();
  const preview = page.locator('#naProxPreview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('#naProxPreviewTitle')).toHaveText('Asistente virtual');
  await expect(preview.locator('.na-prox-banner')).toHaveText('Función en preparación, aún no guarda datos');
  const save = preview.getByRole('button', { name: 'Guardar', exact: true });
  await expect(save).toBeDisabled();
  for (const input of await preview.locator('input').all()) await expect(input).toBeDisabled();
  await save.click({ force: true });
  await expect(page.locator('#pageProximamente')).toHaveClass(/\bactive\b/);
  await preview.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('priority chips and search filter the cards', async ({ page }) => {
  await rolePage(page, 'owner');
  await page.evaluate(() => window.goPage('pageProximamente'));
  await page.locator('.na-prox-chip[data-priority="alta"]').click();
  const alta = await page.locator('.na-prox-card').count();
  expect(alta).toBeGreaterThan(0);
  for (const badge of await page.locator('.na-prox-card .na-prox-badge').allTextContents()) expect(badge).toContain('Prioridad alta');
  await page.locator('.na-prox-chip[data-priority=""]').click();
  await page.locator('.na-prox-search').fill('kardex');
  await expect(page.locator('[data-feature-id="kardex"]')).toBeVisible();
  for (const text of await page.locator('.na-prox-card:visible').allTextContents()) expect(text).toMatch(/kardex/i);
});

for (const [width, columns] of [[1366, 3], [768, 2], [390, 1]]) {
  test(`sections use ${columns} columns at ${width}px without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await page.evaluate(() => window.goPage('pageProximamente'));
    await expect(page.locator('.na-prox-section-grid').first()).toBeVisible();
    const count = await page.locator('.na-prox-section-grid').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(count).toBe(columns);
    expect(await page.locator('#pageProximamente').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.locator('.na-prox-section[data-module="Caja"] > .na-prox-summary').click();
    await expect(page.locator('.na-prox-section[data-module="Caja"] .na-prox-card').first()).toBeHidden();
  });
}

test('local owner opens Próximamente from the drawer and configuration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/index.html');
  await page.waitForFunction(() => window.NA_ROLES?.isOwner());
  await page.locator('#naMobileMenuToggle').click();
  const row = page.locator('#naMobileDrawer [data-page="pageProximamente"]');
  await expect(row).toBeVisible();
  await expect(row.locator('small')).toHaveText('Funciones en preparación');
  await expect(row.locator('[data-icon="soon"]')).toHaveCSS('background-image', /svg/);
  await row.click();
  await expect(page.locator('#pageProximamente')).toHaveClass(/\bactive\b/);
  await page.evaluate(() => window.goPage('pageConfig'));
  const button = page.locator('#na9Nav [data-go="pageProximamente"]');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#pageProximamente')).toHaveClass(/\bactive\b/);
});
