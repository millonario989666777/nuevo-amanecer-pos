import { test, expect, type Page } from '@playwright/test';

async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'kardex-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'kardex-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  return page.evaluate(() => {
    const w = window as any, today = w.NA_KARDEX.periodRange().to;
    const oldDay = new Date(Date.parse(today + 'T00:00:00Z') - 60 * 86400000).toISOString().slice(0, 10);
    w.eval(`
      productos=[
        {id:'k-1',name:'Ácido fólico <img src=x onerror=alert(1)> con nombre largo para verificar lectura en teléfono',sku:'K-01',stock:10,controlInventario:true},
        {id:'k-2',name:'Producto sin movimientos',sku:'K-02',stock:0,controlInventario:true}
      ];
      inventoryMovements=[
        {id:'k-in',productId:'k-1',type:'ENTRADA',delta:5,fecha:'${today}',timestamp:'${today}T09:00:00',referenceId:'PUR-synthetic:1',reason:'Compra sintética'},
        {id:'k-sale',productId:'k-1',type:'SALE',delta:-3,fecha:'${today}',timestamp:'${today}T10:00:00',referenceId:'ks-1'},
        {id:'k-void-out',productId:'k-1',type:'SALE',delta:-2,fecha:'${today}',timestamp:'${today}T11:00:00',referenceId:'ks-void'},
        {id:'k-void-in',productId:'k-1',type:'SALE_REVERSAL',delta:2,fecha:'${today}',timestamp:'${today}T12:00:00',referenceId:'ks-void'},
        {id:'k-adjust',productId:'k-1',type:'AJUSTE',delta:-1,fecha:'${today}',timestamp:'${today}T13:00:00',referenceId:'=1+1'},
        {id:'k-old',productId:'k-1',type:'ENTRADA',delta:10,fecha:'${oldDay}',timestamp:'${oldDay}T09:00:00',referenceId:'PUR-old'}
      ];
      ventas=[
        {id:'ks-1',fecha:'${today}',items:[{id:'k-1',qty:3}]},
        {id:'ks-void',fecha:'${today}',anulada:true,items:[{id:'k-1',qty:2}]},
        {id:'ks-unrecorded-void',fecha:'${today}',anulada:true,items:[{id:'k-2',qty:999}]},
        {id:'ks-pending',fecha:'${today}',status:'pending',operation_id:'synthetic-pending',items:[{id:'k-1',qty:1}]}
      ];
    `);
    localStorage.setItem('TEST-kardex-sale-outbox', JSON.stringify([{ id: 'synthetic-pending', status: 'PENDING' }]));
    localStorage.setItem('TEST-kardex-payment-pending', JSON.stringify([{ id: 'synthetic-payment', amount_cents: 200, status: 'PENDING' }]));
    return { today, oldDay, from: w.NA_KARDEX.periodRange().from };
  });
}
async function readState(page: Page) {
  return page.evaluate(() => {
    const pending = Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
      .filter(key => /pending|outbox|journal/.test(key)).sort().map(key => [key, localStorage.getItem(key)]));
    return {
      business: (window as any).eval('JSON.stringify({productos,ventas,inventoryMovements,clientes,creditos,cajMovs,cajEstado,cart})'),
      replica: (window as any).NuevoAmanecerCanonical.snapshot(),
      pending,
    };
  });
}
async function noOverflow(page: Page) {
  expect(await page.locator('#pageKardex').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('#pageKardex').evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,h2,input,button,tbody td,.kardex-summary-card')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
}
async function openCard(page: Page) {
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  const card = page.locator('[data-feature-id="kardex"]');
  await expect(card).toHaveClass(/is-enabled/);
  await card.click();
  await expect(page.locator('#pageKardex')).toBeVisible();
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner opens Kardex from its card at ${width}px, ${dark ? 'dark' : 'light'}, without overflow, writes or state changes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    const dates = await seed(page), before = await readState(page), writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.evaluate(dark => document.body.classList.toggle('dark', dark), dark);
    await openCard(page);
    const screen = page.locator('#pageKardex');
    await expect(screen.locator('[data-kardex-from]')).toHaveValue(dates.from);
    await expect(screen.locator('[data-kardex-to]')).toHaveValue(dates.today);
    await expect(screen.locator('[data-kardex-export]')).toBeDisabled();
    await screen.locator('[data-kardex-search]').fill('acido K-01');
    await expect(screen.locator('.kardex-product')).toHaveCount(1);
    await screen.locator('[data-product-id="k-1"]').click();
    await expect(screen.locator('[data-kardex-row="opening"]')).toContainText('Saldo inicial');
    await expect(screen.locator('[data-kardex-row="opening"] td').last()).toHaveText('10');
    await expect(screen.locator('.kardex-summary-card').nth(0).locator('strong')).toHaveText('7');
    await expect(screen.locator('.kardex-summary-card').nth(1).locator('strong')).toHaveText('7');
    await expect(screen.locator('.kardex-summary-card').nth(3).locator('strong')).toHaveText('10');
    await expect(screen.locator('tbody tr')).toHaveCount(7); // saldo inicial + 5 movimientos + 1 venta pendiente proyectada
    await expect(screen.locator('[data-kardex-row="k-void-in"]')).toContainText('Anulación');
    await expect(screen.locator('[data-kardex-content] h2')).toContainText('<img src=x onerror=alert(1)>');
    await expect(screen.locator('img,svg')).toHaveCount(0);
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await noOverflow(page);

    await screen.locator('[data-kardex-from]').fill(dates.oldDay);
    await expect(screen.locator('[data-kardex-row="k-old"]')).toBeVisible();
    await expect(screen.locator('.kardex-summary-card').nth(0).locator('strong')).toHaveText('17');
    await expect(screen.locator('[data-kardex-row="opening"] td').last()).toHaveText('0');
    await screen.locator('[data-kardex-to]').fill(dates.oldDay);
    await expect(screen.locator('tbody tr')).toHaveCount(2);
    await expect(screen.locator('.kardex-summary-card').nth(2).locator('strong')).toHaveText('10');
    await screen.locator('[data-kardex-from]').fill(dates.from);
    await expect(screen.locator('[data-kardex-status]')).toContainText('Elige un rango válido');
    await expect(screen.locator('[data-kardex-export]')).toBeDisabled();
    await screen.locator('[data-kardex-to]').fill(dates.today);

    const downloadEvent = page.waitForEvent('download');
    await screen.locator('[data-kardex-export]').click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`kardex-${dates.from}-a-${dates.today}.csv`);
    const stream = await download.createReadStream();
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString('utf8');
    expect(csv).toContain("'=1+1"); expect(csv).toContain('Saldo inicial');

    await screen.locator('[data-kardex-search]').fill('K-02');
    await screen.locator('[data-product-id="k-2"]').click();
    await expect(screen.locator('tbody tr')).toHaveCount(1);
    await expect(screen.locator('[data-kardex-content]')).toContainText('Sin movimientos registrados');
    await expect(screen.locator('[data-kardex-content]')).toContainText('Sin stock');
    await noOverflow(page);
    const refresh = screen.getByRole('button', { name: 'Actualizar Kardex' });
    await refresh.scrollIntoViewIfNeeded();
    expect(await refresh.evaluate(button => {
      const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    })).toBe(true);
    await refresh.click();
    await openCard(page);
    expect(await readState(page)).toEqual(before);
    expect(writes).toEqual([]);
    await expect(page.locator('#naMobileDrawer [data-page="pageKardex"], .menu-desktop-sidebar [data-menu-target="pageKardex"]')).toHaveCount(0);
  });
}

test('employee cannot open Kardex from navigation or card; direct render exposes no product data', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado'); await seed(page);
  const before = await readState(page), writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageKardex"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageKardex'); });
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageKardex')).not.toHaveClass(/\bactive\b/);
  await page.evaluate(async () => {
    const api = (window as any).NA_PROXIMAMENTE; await api.load(); api.openFeature(api.get('kardex'));
    (window as any).NA_KARDEX.render();
  });
  await expect(page.locator('#pageKardex [data-kardex-content]')).toBeEmpty();
  await expect(page.locator('#pageKardex [data-kardex-products]')).toBeEmpty();
  await expect(page.locator('#pageKardex [data-kardex-status]')).toContainText('Sin permiso');
  await expect(page.locator('#pageKardex [data-kardex-controls]')).toBeHidden();
  expect(await readState(page)).toEqual(before); expect(writes).toEqual([]);
});

test('role revocation clears a previously opened ledger and prevents CSV export', async ({ page }) => {
  await rolePage(page, 'owner'); await seed(page); await openCard(page);
  await page.locator('#pageKardex [data-product-id="k-1"]').click();
  await expect(page.locator('#pageKardex tbody tr')).toHaveCount(7);
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
    { pos_role: 'empleado', owner_pin_set: true, roles_ready: true, device_id: 'kardex-test-device' }) }));
  await page.evaluate(async () => { await (window as any).NA_ROLES.refresh(); });
  await expect(page.locator('#pageKardex [data-kardex-content]')).toBeEmpty();
  await expect(page.locator('#pageKardex [data-kardex-products]')).toBeEmpty();
  await expect(page.locator('#pageKardex [data-kardex-export]')).toBeDisabled();
});
