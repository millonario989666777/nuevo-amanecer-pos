import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ timezoneId: 'UTC', serviceWorkers: 'block' });
const screenId = '#pageReporteProductosVencer';

async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'expiry-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'expiry-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}

async function seed(page: Page, unlock = true, dark = false) {
  await page.evaluate(({ unlock, dark }) => {
    const w = window as any;
    // Override only the browser fixture, before the lazy registry builds enabled flags.
    if (unlock) {
      const original = w.NA_PERMISSIONS;
      w.NA_PERMISSIONS = { ...original,
        FEATURE_LOCKS: { ...original.FEATURE_LOCKS, 'reporte-productos-vencer': false },
        featureLocked: (id: string) => id === 'reporte-productos-vencer' ? false : original.featureLocked(id) };
    }
    document.body.classList.toggle('dark', dark);
    const today = w.NA_REPORTE_PRODUCTOS_VENCER.horizonRange(30).today;
    const day = (offset: number) => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
    const lot = (id: string, offset: number, quantity = 5) => ({ lot_id: id, lot_code: id, expiry_date: day(offset), quantity });
    w.__expiryBase = { products: [{ product_id: 'synthetic', name: 'Stock remoto', lots: [lot('remote', 0, 20)] }] };
    w.__expiryProjection = { products: [
      { product_id: 'synthetic', name: 'Producto de prueba con nombre largo para comprobar lectura en teléfono <img src=x onerror=alert(1)>',
        unit: 'unidad', lots: [lot('day31', 31), lot('expired-old', -44), lot('day30', 30), lot('today', 0, 3), lot('empty', -1, 0)] },
      { id: 'json-product', nombre: '\n=Producto CSV', unit: 'kilogramo', lots_json: JSON.stringify([
        { ...lot('expired-new', -1, 1.25), lot_code: '\t+Lote' }, lot('day60', 60), lot('day61', 61), lot('day90', 90), lot('day91', 91)
      ]) }
    ] };
    w.__expiryPending = [{ operation_id: 'synthetic-pending-sale', status: 'pending', payload: { quantity: 17 } }];
    w.NuevoAmanecerCanonical = { ...w.NuevoAmanecerCanonical, enabled: () => true, snapshot: () => w.__expiryBase };
    w.NuevoAmanecerCanonicalSaleView = { lastView: () => w.__expiryProjection, rebuild() { throw new Error('Report cannot rebuild state'); } };
    w.NuevoAmanecerCanonicalSaleOutbox = { ...w.NuevoAmanecerCanonicalSaleOutbox, snapshot: () => ({ intents: w.__expiryPending }) };
    w.eval(`productos=[{id:'synthetic',name:'Producto runtime',stock:3}];
      ventas=[{id:'synthetic-sale',pending:true,items:[]}];clientes=[];
      creditos=[{id:'synthetic-credit',pagos:[{id:'synthetic-abono',pending:true}]}];cajMovs=[];`);
  }, { unlock, dark });
}

async function state(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    return { runtime: w.eval('JSON.stringify({productos,ventas,clientes,creditos,cajMovs})'),
      canonical: JSON.stringify({ base: w.__expiryBase, projected: w.__expiryProjection, pending: w.__expiryPending }),
      // Navigation persists ui.currentPage here; keep every other storage key strict.
      storage: Object.fromEntries(Object.keys(localStorage).filter(key => key !== 'na_local_config_v1').sort()
        .map(key => [key, localStorage.getItem(key)])) };
  });
}

async function openReport(page: Page) {
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  await page.locator('[data-feature-id="reporte-productos-vencer"]').click();
  await expect(page.locator(screenId)).toBeVisible();
}

async function noOverflow(page: Page) {
  expect(await page.locator(screenId).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator(screenId).evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,select,button,tbody th,tbody td')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
}

for (const width of [390, 650, 768, 1366]) for (const dark of [false, true]) {
  test(`read-only expiry report at ${width}px in ${dark ? 'dark' : 'light'} theme`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page, true, dark);
    const before = await state(page);
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await openReport(page);
    const screen = page.locator(screenId), rows = screen.locator('tbody tr'), horizon = screen.locator('[data-rpv-horizon]');
    await expect(horizon).toHaveValue('30');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Vencido (-44)');
    await expect(rows.nth(1)).toContainText('Vencido (-1)');
    await expect(rows.nth(2).locator('td').nth(2)).toHaveText('0');
    await expect(rows.nth(2).locator('td').nth(3)).toHaveText('3');
    await expect(rows.nth(3).locator('td').nth(2)).toHaveText('30');
    await expect(screen.locator('img,script')).toHaveCount(0);
    await noOverflow(page);
    // The 650px global CSS regression must be caught for both headers and every body cell.
    await expect(screen.locator('table')).toHaveCSS('display', width < 600 ? 'block' : 'table');
    const cells = screen.locator(width < 600 ? 'tbody :is(th,td)' : 'table :is(th,td)');
    await expect(cells).toHaveCount(width < 600 ? 20 : 25);
    for (const cell of await cells.all()) {
      await expect(cell).toBeVisible();
      await expect.poll(() => cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }
    if (width >= 600) for (const header of await screen.locator('thead .rpv-num').all()) await expect(header).toHaveCSS('text-align', 'right');
    // Verify WCAG AA text contrast on expired cells in both themes.
    const contrast = await rows.first().locator('td').first().evaluate(node => {
      const style = getComputedStyle(node);
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const fg = luminance(style.color), bg = luminance(style.backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await horizon.selectOption('60');
    await expect(rows).toHaveCount(6);
    await horizon.selectOption('90');
    await expect(rows).toHaveCount(8);
    await horizon.selectOption('30');
    await expect(rows).toHaveCount(4);
    await screen.locator('[data-rpv-refresh]').click();
    await expect(rows).toHaveCount(4);
    expect(await state(page)).toEqual(before);
    expect(writes).toEqual([]);
    if (width === 390) {
      await page.evaluate(() => (window as any).goMenu());
      await page.locator('#naMobileMenuToggle').click();
      await expect(page.locator('#naMobileDrawer [data-page="pageReporteProductosVencer"]')).toHaveCount(0);
    }
  });
}

test('owner CSV contains active horizon, dd/mm/yyyy, expired first and protected product/lot strings without writes', async ({ page }) => {
  await rolePage(page, 'owner');
  await seed(page);
  const before = await state(page);
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method()); });
  await openReport(page);
  await page.locator(`${screenId} [data-rpv-horizon]`).selectOption('60');
  const downloadPromise = page.waitForEvent('download');
  await page.locator(`${screenId} [data-rpv-export]`).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^productos-por-vencer-\d{4}-\d{2}-\d{2}-60-dias\.csv$/);
  const path = await download.path();
  const csv = await readFile(path!, 'utf8');
  expect(csv.slice(1).split('\r\n')[0]).toMatch(/^Filtro: próximos 60 días \(\d{2}\/\d{2}\/\d{4} al \d{2}\/\d{2}\/\d{4}\) \+ vencidos · día de Lima$/);
  expect(csv).toContain('Producto,Lote,Fecha vencimiento,Días restantes,Stock\r\n');
  expect(csv).toContain('"\'\n=Producto CSV",\'\t+Lote,');
  expect(csv).toMatch(/,-44,5\r\n/);
  expect(await state(page)).toEqual(before);
  expect(writes).toEqual([]);
});

test('default locked card keeps preview pending and direct render/export reveal no lot data', async ({ page }) => {
  await rolePage(page, 'owner');
  await seed(page, false);
  const before = await state(page);
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  const card = page.locator('[data-feature-id="reporte-productos-vencer"]');
  await expect(card.locator('.na-prox-badge')).toContainText('Próximamente');
  await card.click();
  await expect(page.locator('#naProxPreview')).toBeVisible();
  await expect(page.locator(screenId)).not.toHaveClass(/\bactive\b/);
  const result = await page.evaluate(() => {
    const w = window as any;
    return { locked: w.NA_PERMISSIONS.FEATURE_LOCKS['reporte-productos-vencer'],
      page: w.NA_PROXIMAMENTE.get('reporte-productos-vencer').page,
      rendered: w.NA_REPORTE_PRODUCTOS_VENCER.render(), exported: w.NA_REPORTE_PRODUCTOS_VENCER.exportCsv() };
  });
  expect(result).toEqual({ locked: true, page: 'pageReporteProductosVencer', rendered: false, exported: false });
  await expect(page.locator(`${screenId} [data-rpv-content]`)).toBeEmpty();
  await expect(page.locator(`${screenId} [data-rpv-controls]`)).toBeHidden();
  expect(await state(page)).toEqual(before);
});

test('employee cannot open report or export even when browser fixture is unlocked', async ({ page }) => {
  await rolePage(page, 'empleado');
  await seed(page);
  const before = await state(page);
  await page.evaluate(() => (window as any).goPage('pageReporteProductosVencer'));
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  expect(await page.evaluate(() => {
    const api = (window as any).NA_REPORTE_PRODUCTOS_VENCER;
    return { rendered: api.render(), exported: api.exportCsv() };
  })).toEqual({ rendered: false, exported: false });
  await expect(page.locator(`${screenId} [data-rpv-content]`)).toBeEmpty();
  await expect(page.locator(`${screenId} [data-rpv-status]`)).toContainText('Sin permiso');
  await expect(page.locator(`${screenId} [data-rpv-controls]`)).toBeHidden();
  expect(await state(page)).toEqual(before);
});

test('revoking owner clears rendered lot data and denies export', async ({ page }) => {
  await rolePage(page, 'owner');
  await seed(page);
  await openReport(page);
  await expect(page.locator(`${screenId} tbody tr`)).toHaveCount(4);
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
    { pos_role: 'empleado', owner_pin_set: true, roles_ready: true, device_id: 'expiry-test-device' }) }));
  await page.evaluate(() => (window as any).NA_ROLES.refresh());
  await page.waitForFunction(() => (window as any).NA_ROLES.role === 'empleado');
  await expect(page.locator(`${screenId} [data-rpv-content]`)).toBeEmpty();
  await expect(page.locator(`${screenId} [data-rpv-controls]`)).toBeHidden();
  expect(await page.evaluate(() => (window as any).NA_REPORTE_PRODUCTOS_VENCER.exportCsv())).toBe(false);
});
