import { test, expect, type Page } from '@playwright/test';

// No DOM/permission injection: these cases exercise the integrated page.
async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'vs-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'vs-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  await page.evaluate(() => {
    (window as any).eval(`
      productos=[
        {id:'vs-1',name:'Ácido de prueba con nombre largo para verificar lectura en teléfono',sku:'AC-1',cat:'farmacia',stock:0,stockMin:1,costo:999},
        {id:'vs-2',name:'Reponer prueba',cat:'farmacia',stock:3.5},
        {id:'vs-3',name:'Sin movimiento prueba',cat:'abarrotes',stock:20},
        {id:'vs-4',name:'Suficiente prueba',cat:'abarrotes',stock:100}
      ];
      ventas=[{id:'vs-sale',fecha:NALimaTime.today(),items:[
        {id:'vs-1',qty:2,precio:4},{id:'vs-2',qty:30,precio:2},
        {id:'vs-4',qty:1,precio:3},{id:'vs-missing',name:'Fuera del catálogo',qty:1,precio:1}
      ]}];
    `);
  });
}
async function readState(page: Page) {
  return page.evaluate(() => (window as any).eval('JSON.stringify({productos,ventas})'));
}
async function noOverflow(page: Page) {
  expect(await page.locator('#pageVentasStock').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('#pageVentasStock').evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,h2,input,select,button,tbody th,tbody td,.vs-summary-card')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner ventas con stock ${width}px ${dark ? 'dark' : 'light'}: no overflow or writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner'); await seed(page);
    const before = await readState(page);
    const storageBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    await page.evaluate(() => {
      (window as any).__vsStorageWrites = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        (window as any).__vsStorageWrites.push(key); return original.call(this, key, value);
      };
    });
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageProximamente'); }, dark);
    const card = page.locator('[data-feature-id="reporte-ventas-stock"]');
    await expect(card).toHaveClass(/is-enabled/); await card.click();
    const screen = page.locator('#pageVentasStock'); await expect(screen).toBeVisible();
    await expect(screen.locator('[data-vs-period]')).toHaveValue('30');
    await expect(screen.locator('.vs-summary-card').first()).toContainText('34');
    for (const [status, label] of Object.entries({sin_stock:'Sin stock',reponer:'Reponer',sin_movimiento:'Sin movimiento',ok:'OK',sin_control:'Sin control'})) {
      await expect(screen.locator(`[data-vs-status="${status}"] .vs-badge`)).toHaveText(label);
    }
    await noOverflow(page);
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await screen.locator('[data-vs-search]').fill('acido');
    await expect(screen.locator('tbody tr')).toHaveCount(1);
    await expect(screen.locator('tbody')).toContainText('Ácido');
    await screen.locator('[data-vs-search]').fill('AC-1');
    await expect(screen.locator('tbody tr')).toHaveCount(1);
    await screen.locator('[data-vs-search]').fill('');
    await screen.locator('[data-vs-category]').selectOption('abarrotes');
    await expect(screen.locator('tbody tr')).toHaveCount(2);
    await screen.locator('[data-vs-category]').selectOption('*');
    for (const period of ['7', '90', '30']) await screen.locator('[data-vs-period]').selectOption(period);
    await screen.locator('[data-vs-refresh]').click();
    const downloadPromise = page.waitForEvent('download');
    await screen.locator('[data-vs-export]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^ventas-con-stock-\d{4}-\d{2}-\d{2}-a-\d{4}-\d{2}-\d{2}\.csv$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString('utf8');
    expect(csv).toContain('Producto,Código,Categoría,Unidades vendidas,Importe,Stock,Promedio diario,Días de cobertura,Estado\r\n');
    expect(csv.startsWith('\uFEFF')).toBe(true); expect(csv).not.toMatch(/costo|precioCompra|margin/i);
    await noOverflow(page);
    expect(await readState(page)).toBe(before);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(storageBefore);
    expect(await page.evaluate(() => (window as any).__vsStorageWrites)).toEqual([]);
    expect(writes).toEqual([]);
  });
}
test('employee cannot see the drawer entry or open ventas con stock; direct rendering exposes no products', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado');
  await seed(page);
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageVentasStock"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageVentasStock'); });
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageVentasStock')).not.toHaveClass(/\bactive\b/);
  await page.evaluate(() => (window as any).NA_VENTAS_STOCK.render());
  await expect(page.locator('#pageVentasStock [data-vs-content]')).toBeEmpty();
  await expect(page.locator('#pageVentasStock [data-vs-status]')).toContainText('Sin permiso');
  await expect(page.locator('#pageVentasStock [data-vs-controls]')).toBeHidden();
});

