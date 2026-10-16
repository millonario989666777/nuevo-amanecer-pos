import { test, expect, type Page } from '@playwright/test';

// Mismo rolePage/seed de Rotación ABC; solo backend ficticio y datos sintéticos.
async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'historial-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'historial-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  await page.evaluate(() => {
    (window as any).eval(`
      clientes=[
        {id:'hist-c1',nombre:'José Cliente de prueba con nombre largo <img src=x onerror=alert(1)>',dni:'00000001'},
        {id:'hist-c2',nombre:'José Cliente de prueba con nombre largo <img src=x onerror=alert(1)>',dni:'00000002'},
        {id:'hist-empty',nombre:'Cliente sin compras',dni:'00000003'}
      ];
      productos=[{id:'hist-p1',name:'Producto de prueba',stock:12}];
      ventas=[
        {id:'hist-sale-1',clienteId:'hist-c1',fecha:NALimaTime.today(),total:10,comprobante:'B001-PRUEBA',metodoPago:'credito',items:[{id:'hist-p1',name:'Producto de prueba largo <img src=x onerror=alert(1)>',precio:6,qty:2,subtotal:10}]},
        {id:'hist-sale-2',customer_id:'hist-c1',fecha:NALimaTime.today(),total:5,metodo:'yape',items:[{productoId:'hist-p1',nombre:'Producto de prueba largo <img src=x onerror=alert(1)>',precioUnitario:5,cantidad:1}]},
        {id:'hist-90',clienteId:'hist-c1',fecha:NA_CLIENTE_HISTORIAL.periodRange(90).from,total:7,metodo:'efectivo',items:[{id:'hist-p2',name:'Histórico de 90 días',precio:7,qty:1}]},
        {id:'hist-365',clienteId:'hist-c1',fecha:NA_CLIENTE_HISTORIAL.periodRange(365).from,total:9,metodo:'plin',items:[{id:'hist-p3',name:'Histórico de 365 días',precio:9,qty:1}]},
        {id:'hist-all',clienteId:'hist-c1',fecha:'2020-01-01',total:11,metodo:'mixto',items:[{id:'hist-p4',name:'Histórico anterior',precio:11,qty:1}]},
        {id:'hist-void',clienteId:'hist-c1',fecha:NALimaTime.today(),anulada:true,total:999,items:[{id:'hist-p5',name:'Producto anulado excluido',precio:999,qty:1}]},
        {id:'hist-other',clienteId:'hist-c2',fecha:NALimaTime.today(),total:3,metodo:'efectivo',items:[{id:'hist-p6',name:'Compra de otro cliente',precio:3,qty:1}]},
        {id:'hist-unlinked',clienteId:null,clienteNombre:clientes[0].nombre,clienteDni:clientes[0].dni,fecha:NALimaTime.today(),total:500,items:[]}
      ];
    `);
    const intent = (window as any).NuevoAmanecerCanonicalSaleIntent.build({
      operation_id: 'hist-pending-sale-operation', sale_id: 'HIST-PENDING-SALE', created_at: '2026-10-16T10:00:00.000Z',
      payment_method: 'efectivo', total_cents: 200,
      payment: { cash_cents: 200, digital_cents: 0, credit_cents: 0, digital_method: null, reference: '' },
      items: [{ product_id: 'hist-p1', quantity: 1, unit_price_cents: 200, line_total_cents: 200 }]
    });
    localStorage.setItem('na_canonical_sale_outbox_v1', JSON.stringify({ version: 1, intents: [intent] }));
    localStorage.setItem('na_canonical_sale_journal', JSON.stringify({
      state: 'PENDING', command: 'payment.create', route: '/commands/payment.create',
      binding: { endpoint: location.origin, promotion_id: 'hist-synthetic-promotion', authority_epoch: 1, revision: 1 },
      payload: { operation_id: 'hist-pending-payment-operation', promotion_id: 'hist-synthetic-promotion',
        client_contract: 'a6-gate-c-v1', authority_epoch: 1, expected_control_revision: 1,
        created_at: '2026-10-16T10:00:00.000Z', credit_id: 'hist-synthetic-credit', expected_credit_revision: 1,
        amount_cents: 100, payment_method: 'yape' }
    }));
  });
}
async function readState(page: Page) {
  return page.evaluate(() => (window as any).eval(`JSON.stringify({productos,ventas,clientes,creditos,cajEstado,cajMovs,
    outbox:localStorage.getItem('na_canonical_sale_outbox_v1'),journal:localStorage.getItem('na_canonical_sale_journal'),
    quarantine:localStorage.getItem('na_canonical_sale_outbox_v1_quarantine')})`));
}
async function noOverflow(page: Page) {
  expect(await page.locator('#pageClienteHistorial').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('#pageClienteHistorial').evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,h2,input,select,button,tbody th,tbody td,.ch-summary-card')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner opens customer history from Próximamente at ${width}px ${dark ? 'dark' : 'light'} without writes or overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    const before = await readState(page), writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !(request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/settings'))) writes.push(request.method() + ' ' + request.url()); });
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageProximamente'); }, dark);
    const card = page.locator('#pageProximamente [data-feature-id="cliente-historial-compras"]');
    await expect(card).toHaveClass(/is-enabled/);
    await expect(card).toContainText('Disponible');
    await card.click();
    const screen = page.locator('#pageClienteHistorial');
    await expect(screen).toBeVisible();
    await expect(screen.locator('[data-ch-period]')).toHaveValue('30');
    await expect(screen.locator('[data-ch-content]')).toContainText('selecciona un cliente');
    const search = screen.getByRole('searchbox', { name: 'Buscar por nombre o DNI' });
    const customer = screen.getByRole('combobox', { name: 'Cliente', exact: true });
    await search.fill('jose');
    await expect(customer.locator('option')).toHaveCount(3);
    await search.fill('00000001');
    await expect(customer.locator('option')).toHaveCount(2);
    await customer.selectOption('hist-c1');
    const summary = screen.locator('.ch-summary-card');
    await expect(summary.nth(0)).toContainText('S/ 15.00');
    await expect(summary.nth(1)).toContainText('2');
    const todayLabel = await page.evaluate(() => (window as any).NALimaTime.today().split('-').reverse().join('/'));
    await expect(summary.nth(2)).toContainText(todayLabel);
    const sales = screen.locator('[data-ch-table="sales"]');
    await expect(sales.locator('tbody tr')).toHaveCount(2);
    await expect(sales).toContainText('B001-PRUEBA');
    await expect(sales).toContainText('Crédito');
    await expect(sales).toContainText('Yape');
    const products = screen.locator('[data-ch-table="products"]');
    await expect(products.locator('tbody tr')).toHaveCount(1);
    await expect(products.locator('tbody td').nth(0)).toHaveText('3');
    await expect(products).toContainText('S/ 15.00');
    await expect(screen).not.toContainText('Producto anulado excluido');
    await expect(screen.locator('[data-ch-content] img')).toHaveCount(0);
    await expect(screen).toContainText('<img src=x onerror=alert(1)>');
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await noOverflow(page);
    for (const [days, total, count] of [['90', '22.00', '3'], ['365', '31.00', '4'], ['all', '42.00', '5']]) {
      await screen.locator('[data-ch-period]').selectOption(days);
      await expect(summary.nth(0)).toContainText('S/ ' + total);
      await expect(summary.nth(1)).toContainText(count);
    }
    await expect(products).toContainText('Histórico anterior');
    await noOverflow(page);
    const refresh = screen.getByRole('button', { name: 'Actualizar reporte' });
    await refresh.scrollIntoViewIfNeeded();
    expect(await refresh.evaluate(button => {
      const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    })).toBe(true);
    await refresh.click();
    await expect(summary.nth(0)).toContainText('S/ 42.00');
    await search.fill('00000002');
    await expect(screen.locator('[data-ch-table]')).toHaveCount(0);
    await customer.selectOption('hist-c2');
    await expect(summary.nth(0)).toContainText('S/ 3.00');
    await expect(products).toContainText('Compra de otro cliente');
    await search.fill('00000003');
    await customer.selectOption('hist-empty');
    await expect(summary.nth(0)).toContainText('S/ 0.00');
    await expect(summary.nth(2)).toContainText('Sin compras');
    await expect(screen).toContainText('no tiene compras en el período');
    await search.fill('Sin coincidencias');
    await expect(customer).toContainText('No se encontraron clientes');
    await expect(screen.locator('[data-ch-table]')).toHaveCount(0);
    expect(await readState(page)).toBe(before);
    expect(writes).toEqual([]);
    if (width === 390) {
      await page.evaluate(() => (window as any).goMenu());
      await page.locator('#naMobileMenuToggle').click();
      await expect(page.locator('#naMobileDrawer [data-page="pageClienteHistorial"]')).toHaveCount(0);
      await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageProximamente'); });
      await card.click();
      await expect(screen).toBeVisible();
    }
  });
}

test('owner sees every sales and products table cell at 650px', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await rolePage(page, 'owner');
  await seed(page);
  await page.evaluate(() => (window as any).goPage('pageClienteHistorial'));
  const screen = page.locator('#pageClienteHistorial');
  await expect(screen).toBeVisible();
  await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
  await expect(screen.locator('.ch-table')).toHaveCount(2);
  for (const [kind, rows] of [['sales', 2], ['products', 1]] as const) {
    const table = screen.locator(`.ch-table[data-ch-table="${kind}"]`);
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(rows);
    for (const cell of await table.locator('th, td').all()) {
      await expect(cell).toBeVisible();
      expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }
  }
});

test('date and seller filters update tables, summaries and CSV with full filter rows at 650px', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await rolePage(page, 'owner');
  await seed(page);
  await page.evaluate(() => (window as any).eval(`ventas=[
    {id:'filter-start',clienteId:'hist-c1',fecha:'2026-10-13',cajeroNombre:'Ana',cajeroId:'v1',total:10,items:[{id:'fp1',name:'Producto elegido',qty:1,subtotal:10}]},
    {id:'filter-end',clienteId:'hist-c1',timestamp:'2026-10-16T04:30:00Z',cajero:'Ana',cajeroId:'v1',total:5,items:[{id:'fp1',name:'Producto elegido',qty:1,subtotal:5}]},
    {id:'filter-old',clienteId:'hist-c1',fecha:'2026-10-12',cajeroNombre:'Ana',cajeroId:'v1',total:7,items:[{id:'fp2',name:'Producto fuera de fecha',qty:1,subtotal:7}]},
    {id:'filter-other',clienteId:'hist-c1',fecha:'2026-10-14',cajero:'Beatriz',total:9,items:[{id:'fp3',name:'Producto otro vendedor',qty:1,subtotal:9}]},
    {id:'filter-missing',clienteId:'hist-c1',fecha:'2026-10-14',total:3,items:[]}
  ];`));
  const before = await readState(page);
  await page.evaluate(() => (window as any).goPage('pageClienteHistorial'));
  const screen = page.locator('#pageClienteHistorial');
  await expect(screen).toBeVisible();
  await screen.locator('[data-ch-period]').selectOption('all');
  await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
  const seller = screen.getByRole('combobox', { name: 'Vendedor', exact: true });
  await expect(seller.locator('option')).toHaveText(['Todos', 'Ana', 'Beatriz', 'No registrado']);
  await screen.getByLabel('Desde', { exact: true }).fill('2026-10-13');
  await screen.getByLabel('Desde', { exact: true }).blur();
  await screen.getByLabel('Hasta', { exact: true }).fill('2026-10-15');
  await screen.getByLabel('Hasta', { exact: true }).blur();
  await seller.selectOption('id:v1');
  const summary = screen.locator('.ch-summary-card');
  await expect(summary.nth(0)).toContainText('S/ 15.00');
  await expect(summary.nth(1)).toContainText('2');
  await expect(summary.nth(2)).toContainText('15/10/2026');
  const sales = screen.locator('[data-ch-table="sales"]');
  await expect(sales.locator('tbody tr')).toHaveCount(2);
  await expect(sales).toContainText('filter-start');
  await expect(sales).toContainText('filter-end');
  await expect(screen.locator('[data-ch-table="products"] tbody tr')).toHaveCount(1);
  await expect(screen.locator('[data-ch-table="products"]')).toContainText('S/ 15.00');
  // Cada filtro ocupa su propia fila; las tablas conservan todas las columnas a 650px.
  const filters = await screen.locator('.ch-filter-row').evaluate(row => {
    const box = row.getBoundingClientRect();
    return [...row.querySelectorAll('label')].map(label => {
      const rect = label.getBoundingClientRect();
      return { width: rect.width, rowWidth: box.width, top: rect.top, bottom: rect.bottom };
    });
  });
  expect(filters).toHaveLength(4);
  filters.forEach((filter, index) => {
    expect(Math.abs(filter.width - filter.rowWidth)).toBeLessThanOrEqual(1);
    if (index) expect(filter.top).toBeGreaterThan(filters[index - 1].bottom);
  });
  for (const cell of await screen.locator('.ch-table :is(th,td)').all()) {
    await expect(cell).toHaveCSS('display', 'table-cell');
    expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
  }
  await noOverflow(page);
  const downloadPromise = page.waitForEvent('download');
  await screen.getByRole('button', { name: 'Exportar CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('cliente-historial-compras.csv');
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('filter-start'); expect(csv).toContain('filter-end'); expect(csv).toContain('Producto elegido');
  expect(csv).not.toMatch(/filter-old|filter-other|filter-missing|fuera de fecha|otro vendedor/);
  await screen.getByLabel('Desde', { exact: true }).fill('2026-10-16');
  await screen.getByLabel('Desde', { exact: true }).blur();
  await expect(screen.getByLabel('Desde', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(screen.getByRole('status')).toContainText('no puede ser posterior');
  await expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled();
  await screen.getByLabel('Desde', { exact: true }).fill('');
  await screen.getByLabel('Desde', { exact: true }).blur();
  await screen.getByLabel('Hasta', { exact: true }).fill('');
  await screen.getByLabel('Hasta', { exact: true }).blur();
  await expect(summary.nth(0)).toContainText('S/ 22.00');
  await seller.selectOption('missing:');
  await expect(summary.nth(0)).toContainText('S/ 3.00');
  await expect(sales.locator('tbody tr')).toHaveCount(1);
  await seller.selectOption('name:Beatriz');
  await expect(summary.nth(0)).toContainText('S/ 9.00');
  await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c2');
  await expect(seller.locator('option')).toHaveText(['Todos']);
  await expect(seller).toHaveValue('');
  expect(await readState(page)).toBe(before);
});

test('employee cannot open customer history and direct rendering clears customer details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado');
  await seed(page);
  const before = await readState(page), writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !(request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/settings'))) writes.push(request.url()); });
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageClienteHistorial"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageClienteHistorial'); });
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  const screen = page.locator('#pageClienteHistorial');
  await expect(screen).not.toHaveClass(/\bactive\b/);
  await page.evaluate(() => (window as any).NA_CLIENTE_HISTORIAL.render());
  await expect(screen.locator('[data-ch-content]')).toBeEmpty();
  await expect(screen.locator('[data-ch-status]')).toContainText('Sin permiso');
  await expect(screen.locator('[data-ch-controls]')).toBeHidden();
  await expect(screen.locator('[data-ch-customer] option')).toHaveCount(0);
  expect(await readState(page)).toBe(before);
  expect(writes).toEqual([]);
});
