import { test, expect, type Page } from '@playwright/test';

test.use({ timezoneId: 'UTC', serviceWorkers: 'block' });

const pageId = 'pageCatalogoDesdePos';
const maliciousName = 'Paracetamol <img src=x onerror=alert(1)> & "Prueba"';
async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'catalog-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'catalog-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  await page.evaluate(name => {
    (window as any).eval('productos=' + JSON.stringify([
      { id: 'catalog-farmacia', name, cat: 'farmacia', presentacion: 'Blíster <b>de 10</b>', precio: 3.5, costo: 9876.54, stock: 0 },
      { id: 'catalog-arroz', name: 'Arroz de prueba con un nombre largo para comprobar la lectura en teléfono', cat: 'abarrotes', unidad: 'kilogramo', precio: 4.25, costo: 8765.43, stock: -2222 },
      { id: 'catalog-empty', name: 'Producto sin presentación', cat: 'farmacia', precio: 0 },
      { id: 'catalog-no-category', name: 'Producto sin categoría', precio: 7 }
    ]) + ';');
  }, maliciousName);
}
async function readState(page: Page) {
  return page.evaluate(() => ({
    data: (window as any).eval('JSON.stringify({productos,ventas,clientes,creditos,cajMovs,appConfig,cart})'),
    storage: Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]))
  }));
}
async function openCatalog(page: Page) {
  // Keep the real registry/lock untouched: this candidate is reviewed via direct owner navigation.
  await page.evaluate(() => (window as any).goPage('pageCatalogoDesdePos'));
  await expect(page.locator('#' + pageId)).toBeVisible();
  await expect(page.locator('#' + pageId + ' tbody tr')).toHaveCount(4);
}
async function noOverflow(page: Page) {
  expect(await page.locator('#' + pageId).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('#' + pageId).evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,select,button,tbody th,tbody td')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
}

for (const width of [390, 650, 768, 1366]) for (const dark of [false, true]) {
  test(`owner catalog at ${width}px, ${dark ? 'dark' : 'light'}: only public fields, filters and print without writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(dark => document.body.classList.toggle('dark', dark), dark);
    await openCatalog(page);
    const screen = page.locator('#' + pageId), rows = screen.locator('tbody tr');
    const before = await readState(page);
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await expect(screen.locator('[data-cdp-date]')).toHaveText(await page.evaluate(() => {
      const day = (window as any).NALimaTime.today();
      return day.split('-').reverse().join('/') + ' · Lima';
    }));
    await expect(screen.locator('[data-cdp-category]')).toHaveValue('*');
    await expect(screen.locator('thead th')).toHaveText(['Producto', 'Presentación', 'Precio de venta']);
    await expect(screen).toContainText(maliciousName);
    await expect(screen).toContainText('Blíster <b>de 10</b>');
    const drug = rows.filter({ hasText: maliciousName });
    expect(await drug.locator('.cdp-price').textContent()).toBe('S/\u00a03.50');
    await expect(rows.filter({ hasText: 'Producto sin presentación' }).locator('[data-label="Presentación"]')).toHaveText('—');
    expect(await rows.filter({ hasText: 'Producto sin presentación' }).locator('.cdp-price').textContent()).toBe('S/\u00a00.00');
    await expect(screen.locator('img,script,b')).toHaveCount(0);
    await expect(screen).not.toContainText(/costo|stock|9876\.54|8765\.43|-2222/i);
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await noOverflow(page);
    const select = screen.locator('[data-cdp-category]');
    await select.selectOption('farmacia'); await expect(rows).toHaveCount(2);
    await expect(screen).not.toContainText('Arroz de prueba');
    await select.selectOption('abarrotes'); await expect(rows).toHaveCount(1);
    await expect(screen).toContainText('Arroz de prueba');
    await select.selectOption(''); await expect(rows).toHaveCount(1);
    await expect(screen).toContainText('Producto sin categoría');
    await select.selectOption('farmacia');
    await page.evaluate(() => (window as any).eval('productos=productos.filter(p=>p.cat!=="farmacia");'));
    await page.evaluate(() => (window as any).NA_CATALOGO_DESDE_POS.render());
    await expect(rows).toHaveCount(0);
    await expect(screen).toContainText('No hay productos');
    await seed(page);
    await select.selectOption('*'); await expect(rows).toHaveCount(4);
    await noOverflow(page);
    // At all table widths, including the global mobile CSS range, every header and cell has width.
    await expect(screen.locator('table')).toHaveCSS('display', width < 600 ? 'block' : 'table');
    const cells = screen.locator(width < 600 ? 'tbody :is(th,td)' : 'th,td');
    await expect(cells).toHaveCount(width < 600 ? 12 : 15);
    for (const cell of await cells.all()) {
      await expect(cell).toBeVisible();
      expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }
    await select.selectOption('farmacia');
    await page.evaluate(() => {
      (window as any).__catalogPrints = 0;
      window.print = () => { (window as any).__catalogPrints++; };
    });
    const print = screen.getByRole('button', { name: 'Imprimir / PDF' });
    await print.scrollIntoViewIfNeeded();
    expect(await print.evaluate(button => {
      const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    })).toBe(true);
    await print.click();
    expect(await page.evaluate(() => (window as any).__catalogPrints)).toBe(1);
    await expect(rows).toHaveCount(2);
    expect(await readState(page)).toEqual(before);
    expect(writes).toEqual([]);
  });
}

test('Próximamente keeps catalog locked and pending; no side menu entry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'owner');
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  const card = page.locator('[data-feature-id="catalogo-desde-pos"]');
  await expect(card).toBeVisible(); await expect(card).not.toHaveClass(/is-enabled/);
  await expect(card).toContainText('Próximamente');
  expect(await page.evaluate(() => {
    const api = (window as any).NA_PROXIMAMENTE, feature = api.get('catalogo-desde-pos');
    return { page: feature.page, pending: feature.pending, enabled: api.isEnabled(feature.id), locked: (window as any).NA_PERMISSIONS.FEATURE_LOCKS[feature.id] };
  })).toEqual({ page: pageId, pending: true, enabled: false, locked: true });
  await card.click();
  await expect(page.locator('#' + pageId)).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('#naProxPreview')).toBeVisible();
  await page.locator('#naProxPreview').evaluate(node => (node as HTMLDialogElement).close());
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="' + pageId + '"]')).toHaveCount(0);
});

test('employee cannot open catalog or print; revoking owner clears cached products and categories', async ({ page }) => {
  await rolePage(page, 'owner'); await seed(page); await openCatalog(page);
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
    { pos_role: 'empleado', owner_pin_set: true, roles_ready: true, device_id: 'catalog-test-device' }) }));
  await page.evaluate(() => (window as any).NA_ROLES.refresh());
  await page.waitForFunction(() => (window as any).NA_ROLES.role === 'empleado');
  const screen = page.locator('#' + pageId);
  await expect(screen.locator('[data-cdp-content]')).toBeEmpty();
  await expect(screen.locator('[data-cdp-category]')).toBeEmpty();
  await expect(screen.locator('[data-cdp-controls]')).toBeHidden();
  await page.evaluate(() => (window as any).goPage('pagePOS'));
  await page.evaluate(() => (window as any).goPage('pageCatalogoDesdePos'));
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(screen).not.toHaveClass(/\bactive\b/);
  expect(await page.evaluate(() => {
    window.print = () => { throw new Error('Unauthorized print'); };
    return { render: (window as any).NA_CATALOGO_DESDE_POS.render(), print: (window as any).NA_CATALOGO_DESDE_POS.print() };
  })).toEqual({ render: false, print: false });
  await expect(screen.locator('[data-cdp-status]')).toContainText('Sin permiso');
});

for (const width of [390, 650, 1366]) {
  test(`print CSS at ${width}px shows only active catalog, restores table, and does not affect other-page printing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner'); await seed(page); await openCatalog(page);
    const screen = page.locator('#' + pageId);
    await screen.locator('[data-cdp-category]').selectOption('farmacia');
    await page.emulateMedia({ media: 'print' });
    await expect(screen).toBeVisible(); await expect(screen.locator('[data-cdp-controls]')).toBeHidden();
    await expect(page.locator('.g-topbar')).toBeHidden();
    await expect(screen.locator('table')).toHaveCSS('display', 'table');
    await expect(screen.locator('thead')).toHaveCSS('display', 'table-header-group');
    await expect(screen.locator('tbody tr')).toHaveCount(2);
    for (const cell of await screen.locator('th,td').all()) {
      await expect(cell).toBeVisible();
      expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }
    // Every rendered branch outside the catalog/its ancestors is hidden, including overlays and navigation.
    expect(await page.evaluate(() => {
      const catalog = document.getElementById('pageCatalogoDesdePos')!;
      return [...document.body.querySelectorAll<HTMLElement>('*')].every(node =>
        node === catalog || catalog.contains(node) || node.contains(catalog) || getComputedStyle(node).display === 'none' || node.getClientRects().length === 0);
    })).toBe(true);
    await page.emulateMedia({ media: 'screen' });
    await expect(screen.locator('[data-cdp-controls]')).toBeVisible();
    await page.evaluate(() => (window as any).goPage('pageClientesFrecuencia'));
    await page.emulateMedia({ media: 'print' });
    // Disabling just this stylesheet must leave the other page's computed print styles identical.
    const readStyles = () => page.evaluate(() => ['body', '.g-topbar', '#pageClientesFrecuencia'].map(selector => {
      const node = document.querySelector(selector)!; const style = getComputedStyle(node);
      return { display: style.display, position: style.position, height: style.height, overflow: style.overflow, background: style.backgroundColor };
    }));
    const before = await readStyles();
    await page.evaluate(() => {
      (document.querySelector('link[href="css/catalogo-desde-pos.css"]') as HTMLLinkElement).disabled = true;
    });
    expect(await readStyles()).toEqual(before);
  });
}
