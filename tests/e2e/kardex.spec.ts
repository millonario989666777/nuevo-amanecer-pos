import { test, expect, type Page } from '@playwright/test';

async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'kardex-test-device' } : url.pathname === '/auth/purchases' ? { purchases: [], truncated: false } : {}) });
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
        {id:'k-1',name:'Ácido fólico <img src=x onerror=alert(1)> con nombre largo para verificar lectura en teléfono',sku:'K-01',stock:10,costo:4,controlInventario:true},
        {id:'k-2',name:'Producto sin movimientos',sku:'K-02',stock:0,controlInventario:true}
      ];
      inventoryMovements=[
        {id:'k-in',productId:'k-1',type:'ENTRADA',delta:5,fecha:'${today}',timestamp:'${today}T09:00:00',referenceId:'PUR-synthetic:1',unit_cost_cents:400,reason:'Compra sintética'},
        {id:'k-sale',productId:'k-1',type:'SALE',delta:-3,fecha:'${today}',timestamp:'${today}T10:00:00',referenceId:'ks-1'},
        {id:'k-void-out',productId:'k-1',type:'SALE',delta:-2,fecha:'${today}',timestamp:'${today}T11:00:00',referenceId:'ks-void'},
        {id:'k-void-in',productId:'k-1',type:'SALE_REVERSAL',delta:2,fecha:'${today}',timestamp:'${today}T12:00:00',referenceId:'ks-void'},
        {id:'k-adjust',productId:'k-1',type:'AJUSTE',delta:-1,fecha:'${today}',timestamp:'${today}T13:00:00',referenceId:'=1+1'},
        {id:'k-old',productId:'k-1',type:'ENTRADA',delta:10,fecha:'${oldDay}',timestamp:'${oldDay}T09:00:00',referenceId:'PUR-old',unit_cost_cents:200}
      ];
      ventas=[
        {id:'ks-1',fecha:'${today}',items:[{id:'k-1',qty:3}]},
        {id:'ks-void',fecha:'${today}',anulada:true,items:[{id:'k-1',qty:2}]},
        {id:'ks-unrecorded-void',fecha:'${today}',anulada:true,items:[{id:'k-2',qty:999}]},
        {id:'ks-pending',fecha:'${today}',timestamp:'${today}T14:00:00',status:'pending',operation_id:'synthetic-pending',items:[{id:'k-1',qty:1}]}
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
    return [...node.querySelectorAll<HTMLElement>('h1,h2,input,button,.kardex-table-wrap,.kardex-summary-card')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 &&
        (child.classList.contains('kardex-table-wrap') || child.scrollWidth <= child.clientWidth + 1);
    }) && [...node.querySelectorAll<HTMLElement>('tbody td')].every(cell => {
      const tableBox = cell.closest('table')!.getBoundingClientRect(), rect = cell.getBoundingClientRect();
      return rect.left >= tableBox.left - 1 && rect.right <= tableBox.right + 1 && cell.scrollWidth <= cell.clientWidth + 1;
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
    await expect(screen.locator('[data-kardex-row="opening"] td[data-label="Saldo"]')).toHaveText('10');
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
    await expect(screen.locator('[data-kardex-row="opening"] td[data-label="Saldo"]')).toHaveText('0');
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

for (const width of [390, 600, 650, 700, 768, 1366]) {
  test(`owner sees every Kardex ${width >= 600 ? 'header and table' : 'card'} cell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await openCard(page);
    const screen = page.locator('#pageKardex');
    await screen.locator('[data-product-id="k-1"]').click();
    await expect(screen.locator('tbody tr')).toHaveCount(7);
    await expect(screen.locator('th')).toHaveCount(9);
    await expect(screen.locator('tbody tr').first().locator('td')).toHaveCount(9);

    const tables = screen.locator('table');
    expect(await tables.count()).toBeGreaterThan(0);
    for (const table of await tables.all()) {
      const cells = table.locator(width >= 600 ? 'th, td' : 'td');
      expect(await cells.count()).toBeGreaterThan(0);
      for (const cell of await cells.all()) {
        await expect(cell).toBeVisible();
        expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
        await expect(cell).toHaveCSS('display', width >= 600 ? 'table-cell' : 'block');
      }
    }
  });
}

for (const width of [650, 768]) for (const showCosts of [true, false]) {
  test(`Kardex headers stay on one line and numeric headers align right at ${width}px ${showCosts ? 'with' : 'without'} costs`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner'); await seed(page); await openCard(page);
    if (!showCosts) await page.evaluate(() => {
      const w = window as any, permissions = w.NA_PERMISSIONS;
      w.NA_PERMISSIONS = { ...permissions, canDo: (role: string, action: string) =>
        action === 'purchases.costs.view' ? false : permissions.canDo(role, action) };
      w.NA_KARDEX.render();
    });
    const screen = page.locator('#pageKardex');
    await screen.locator('[data-product-id="k-1"]').click();
    await expect(screen.locator('[data-kardex-export]')).toBeEnabled();
    await expect(screen.locator('th')).toHaveCount(showCosts ? 9 : 6);
    await page.evaluate(() => document.fonts.ready);
    for (const label of ['Fecha (Lima)', 'Movimiento']) {
      const header = screen.getByRole('columnheader', { name: label, exact: true });
      const metrics = await header.evaluate(node => {
        const style = getComputedStyle(node), range = document.createRange();
        range.selectNodeContents(node);
        const rects = Array.from(range.getClientRects());
        return { lines: rects.length, height: range.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight),
          textWidth: range.getBoundingClientRect().width,
          contentWidth: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          whiteSpace: style.whiteSpace, wordBreak: style.wordBreak, overflowWrap: style.overflowWrap, hyphens: style.hyphens };
      });
      expect(metrics.lines, label).toBe(1);
      expect(metrics.height, label).toBeLessThanOrEqual(metrics.lineHeight + 2);
      expect(metrics.textWidth, label).toBeLessThanOrEqual(metrics.contentWidth + 1);
      expect(metrics.whiteSpace).toBe('nowrap'); expect(metrics.wordBreak).toBe('normal');
      expect(metrics.overflowWrap).toBe('normal'); expect(metrics.hyphens).toBe('none');
    }
    const numericHeaders = ['Entrada', 'Salida', 'Saldo', ...(showCosts ? ['Costo entrada', 'Costo salida', 'Valor saldo'] : [])];
    for (const label of numericHeaders) {
      await expect(screen.getByRole('columnheader', { name: label, exact: true })).toHaveCSS('text-align', 'right');
    }
    for (const cell of await screen.locator('th, td').all()) {
      await expect(cell).toHaveCSS('display', 'table-cell');
      expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }
    await noOverflow(page);
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

test('picking a product moves focus to the Kardex heading', async ({ page }) => {
  await rolePage(page, 'owner'); await seed(page); await openCard(page);
  await page.locator('#pageKardex [data-kardex-search]').fill('K-01');
  await page.locator('#pageKardex [data-product-id="k-1"]').click();
  await expect(page.locator('#pageKardex [data-kardex-content] h2')).toBeFocused();
});

async function downloadCsv(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.locator('#pageKardex [data-kardex-export]').click();
  const stream = await (await downloaded).createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('owner sees weighted entry/exit costs, estimated return, balance value and cost metadata in UI and CSV', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await rolePage(page, 'owner'); const dates = await seed(page); await openCard(page);
  const screen = page.locator('#pageKardex');
  await screen.locator('[data-product-id="k-1"]').click();
  await expect(screen.locator('[data-kardex-cost-summary]')).toBeVisible();
  await expect(screen.locator('[data-kardex-row="k-in"] [data-label="Costo entrada"]')).toContainText('S/ 20.00');
  await expect(screen.locator('[data-kardex-row="k-sale"] [data-label="Costo salida"]')).toContainText('S/ 8.00');
  await expect(screen.locator('[data-kardex-row="k-void-in"]')).toContainText('costo estimado');
  await expect(screen.locator('[data-kardex-cost-summary]')).toContainText('S/ 26.67');
  await expect(screen.locator('[data-kardex-cost-summary]')).toContainText('S/ 4.00');
  await expect(screen.locator('[data-kardex-cost-summary]')).toContainText(dates.today.split('-').reverse().join('/'));
  await expect(screen.locator('[data-kardex-cost-footer]')).toContainText('0 sin costo');
  const csv = await downloadCsv(page);
  expect(csv).toContain('Costo entrada (S/)'); expect(csv).toContain('Costo salida (S/)');
  expect(csv).toContain('Valor saldo (S/)'); expect(csv).toContain('costo estimado'); expect(csv).toContain('26.67');
});

test('entries before the first known average show sin costo and footer count without adding value', async ({ page }) => {
  await rolePage(page, 'owner'); await seed(page);
  await page.evaluate(() => (window as any).eval(`
    inventoryMovements=inventoryMovements.filter(m=>m.id!=='k-old');
    delete inventoryMovements.find(m=>m.id==='k-in').unit_cost_cents;
  `));
  await openCard(page); const screen = page.locator('#pageKardex');
  await screen.locator('[data-product-id="k-1"]').click();
  await expect(screen.locator('[data-kardex-row="k-in"] [data-label="Costo entrada"]')).toHaveText('sin costo');
  await expect(screen.locator('[data-kardex-cost-footer]')).toContainText('6 sin costo');
  await expect(screen.locator('[data-kardex-cost-summary] .kardex-summary-card').first()).toContainText('S/ 0.00');
  await expect(screen.locator('[data-kardex-row="k-adjust"] [data-label="Valor saldo"]')).toContainText('u sin costo');
});

test('cost permission is checked separately for columns, summaries, method text and CSV', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await rolePage(page, 'owner'); await seed(page); await openCard(page);
  const screen = page.locator('#pageKardex');
  await screen.locator('[data-product-id="k-1"]').click();
  await expect(screen.locator('th')).toHaveCount(9);
  await page.evaluate(() => {
    const w = window as any, permissions = w.NA_PERMISSIONS;
    w.NA_PERMISSIONS = { ...permissions, canDo: (role: string, action: string) =>
      action === 'purchases.costs.view' ? false : permissions.canDo(role, action) };
    w.NA_KARDEX.render();
  });
  await expect(screen.locator('th')).toHaveCount(6);
  await expect(screen.locator('[data-kardex-cost-summary], [data-kardex-cost-footer]')).toHaveCount(0);
  await expect(screen.locator('[data-kardex-cost-method]')).toBeHidden();
  await expect(screen.getByRole('columnheader', { name: 'Costo entrada', exact: true })).toHaveCount(0);
  const csv = await downloadCsv(page);
  expect(csv).not.toContain('Costo entrada'); expect(csv).not.toContain('Costo salida'); expect(csv).not.toContain('Valor saldo');
  for (const cell of await screen.locator('th,td').all()) {
    expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
  }
});

test('purchase endpoint costs are joined by operation id and late responses cannot restore revoked costs', async ({ page }) => {
  await rolePage(page, 'owner'); await seed(page);
  let resolvePurchase!: () => void;
  const ready = new Promise<void>(resolve => { resolvePurchase = resolve; });
  await page.route('https://permissions.test/auth/purchases', async route => {
    await ready;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ purchases: [
      { purchase_id: 'PUR-synthetic', status: 'aplicada', lines: [{ line_number: 1, product_id: 'k-1', quantity: 5, unit_cost_cents: 600 }] }
    ] }) });
  });
  await openCard(page); const screen = page.locator('#pageKardex');
  await screen.locator('[data-product-id="k-1"]').click();
  await expect(screen).toContainText('Consultando costos');
  resolvePurchase();
  await expect(screen.locator('[data-kardex-row="k-in"] [data-label="Costo entrada"]')).toContainText('S/ 30.00');
  await expect(screen.locator('[data-kardex-cost-summary]')).toContainText('S/ 6.00');
  const csv = await downloadCsv(page); expect(csv).toContain('30.00');

  let resolveLate!: () => void;
  const late = new Promise<void>(resolve => { resolveLate = resolve; });
  await page.route('https://permissions.test/auth/purchases', async route => {
    await late;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ purchases: [
      { purchase_id: 'PUR-synthetic', lines: [{ line_number: 1, product_id: 'k-1', unit_cost_cents: 99900 }] }
    ] }) });
  });
  await screen.locator('[data-kardex-refresh]').click();
  await expect(screen).toContainText('Consultando costos');
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
    { pos_role: 'empleado', owner_pin_set: true, roles_ready: true, device_id: 'kardex-test-device' }) }));
  await page.evaluate(async () => { await (window as any).NA_ROLES.refresh(); });
  resolveLate();
  await expect(screen.locator('[data-kardex-content]')).toBeEmpty();
  await expect(screen.locator('[data-kardex-export]')).toBeDisabled();
  await expect(screen.locator('[data-kardex-cost-method]')).toBeHidden();
  expect(await page.evaluate(() => (window as any).NA_KARDEX.toCsv({ product: { name: 'p', code: 'c' }, rows: [] })))
    .not.toContain('Costo');
});
