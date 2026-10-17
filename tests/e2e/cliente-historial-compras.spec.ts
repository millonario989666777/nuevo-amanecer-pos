import { test, expect, type Locator, type Page } from '@playwright/test';

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
async function contrastRatio(locator: Locator) {
  return locator.evaluate(node => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let el: Element | null = node, bg = 'rgba(0, 0, 0, 0)';
    while (el && (bg = getComputedStyle(el).backgroundColor) && (bg === 'transparent' || rgb(bg)[3] === 0)) el = el.parentElement;
    const a = lum(rgb(getComputedStyle(node).color)), b = lum(rgb(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
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
    if (width === 390) {
      const dates = sales.locator('tbody th .ch-date');
      await expect(dates).toHaveCount(5);
      for (const date of await dates.all()) {
        const result = await date.evaluate(cell => {
          // El Range mide solo la fecha, sin la etiqueta ::before de la tarjeta.
          const range = document.createRange();
          range.selectNodeContents(cell);
          const lines = [...range.getClientRects()];
          const card = cell.closest('tr')!.getBoundingClientRect();
          return {
            lineCount: lines.length,
            fits: lines.every(rect => rect.width > 0 && rect.left >= card.left - 1 && rect.right <= card.right + 1
              && rect.top >= card.top - 1 && rect.bottom <= card.bottom + 1)
          };
        });
        expect(result.lineCount, await date.textContent() || 'Fecha').toBe(1);
        expect(result.fits, await date.textContent() || 'Fecha').toBe(true);
      }
    }
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
    {id:'filter-end',clienteId:'hist-c1',timestamp:'2026-10-16T04:30:00Z',cajero:' ana ',total:5,items:[{id:'fp1',name:'Producto elegido',qty:1,subtotal:5}]},
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
  await expect(seller.locator('option')).toHaveText(['Todos', 'Ana', 'Beatriz (sin id)', 'No registrado']);
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
  await seller.selectOption('name:beatriz');
  await expect(summary.nth(0)).toContainText('S/ 9.00');
  await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c2');
  await expect(seller.locator('option')).toHaveText(['Todos']);
  await expect(seller).toHaveValue('');
  expect(await readState(page)).toBe(before);
});

for (const width of [390, 768, 1366]) {
  test(`seller select folds only a unique id and CSV guards leading spaces at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(() => (window as any).goPage('pageClienteHistorial'));
    const screen = page.locator('#pageClienteHistorial');
    await screen.locator('[data-ch-period]').selectOption('all');
    await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
    const seller = screen.getByRole('combobox', { name: 'Vendedor', exact: true });
    for (const count of [0, 1, 2]) {
      await page.evaluate(count => {
        (window as any).eval(`ventas=[
          {id:'seller-legacy',clienteId:'hist-c1',fecha:'2026-10-15',cajero:' Luis ',total:5,items:[]}
        ];`);
        for (let index = 1; index <= count; index++) {
          (window as any).eval(`ventas.push({id:'seller-id-${index}',clienteId:'hist-c1',fecha:'2026-10-15',cajeroNombre:'Luis',cajeroId:'v${index}',total:10,items:[]});`);
        }
        (window as any).NA_CLIENTE_HISTORIAL.render();
      }, count);
      const before = await readState(page);
      const expected = count === 1 ? [{ value: '', label: 'Todos' }, { value: 'id:v1', label: 'Luis' }] : [
        { value: '', label: 'Todos' },
        ...(count === 2 ? [{ value: 'id:v1', label: 'Luis' }, { value: 'id:v2', label: 'Luis' }] : []),
        { value: 'name:luis', label: 'Luis (sin id)' }
      ];
      expect(await seller.locator('option').evaluateAll(nodes => nodes.map(node => ({
        value: (node as HTMLOptionElement).value, label: node.textContent
      })))).toEqual(expected);
      await seller.selectOption(count === 1 ? 'id:v1' : 'name:luis');
      const sales = screen.locator('[data-ch-table="sales"]');
      await expect(sales.locator('tbody tr')).toHaveCount(count === 1 ? 2 : 1);
      await expect(sales).toContainText('seller-legacy');
      if (count === 2) for (const index of [1, 2]) {
        await seller.selectOption('id:v' + index);
        await expect(sales.locator('tbody tr')).toHaveCount(1);
        await expect(sales).toContainText('seller-id-' + index);
        await expect(sales).not.toContainText('seller-legacy');
      }
      expect(await readState(page)).toBe(before);
      await noOverflow(page);
    }
    // Reporte sintético: conservar los espacios para probar el guard usado por la exportación.
    const csv = await page.evaluate(() => (window as any).NA_CLIENTE_HISTORIAL.toCsv({
      sales: [{ day: '2026-10-15', reference: '  =1+1', total: 5, method: 'efectivo' }], products: []
    }));
    expect(csv).toContain('"15/10/2026","\'  =1+1","5.00","Efectivo"');
  });
}

for (const dark of [false, true]) {
  test(`Período fills Desde/Hasta, manual edits switch to Personalizado, Todo clears and the date error is readable (${dark ? 'Nocturno' : 'claro'})`, async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageClienteHistorial'); }, dark);
    const screen = page.locator('#pageClienteHistorial');
    const period = screen.locator('[data-ch-period]');
    const from = screen.getByLabel('Desde', { exact: true }), to = screen.getByLabel('Hasta', { exact: true });
    const hint = screen.locator('[data-ch-date-hint]');
    const range = (days: string) => page.evaluate(days => (window as any).NA_CLIENTE_HISTORIAL.periodDates(days), days);
    await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
    await expect(period).toHaveValue('30');
    await expect(hint).toHaveAttribute('hidden', '');
    await expect(hint).toBeHidden();
    const p30 = await range('30');
    await expect(from).toHaveValue(p30.from); await expect(to).toHaveValue(p30.to);
    await period.selectOption('90');
    await expect(from).toHaveValue((await range('90')).from); await expect(to).toHaveValue(p30.to);
    await expect(screen.locator('[data-ch-table="sales"]')).toContainText('hist-90');
    await expect(screen.locator('[data-ch-table="products"]')).toContainText('Histórico de 90 días');
    await from.fill((await range('365')).from); await from.blur();
    await expect(period).toHaveValue('365');
    await from.fill('2026-01-02'); await from.blur();
    await expect(period).toHaveValue('custom');
    await expect(period.locator('option:checked')).toHaveText('Personalizado');
    await period.selectOption('all');
    await expect(from).toHaveValue(''); await expect(to).toHaveValue('');
    await expect(from).not.toHaveAttribute('placeholder'); await expect(to).not.toHaveAttribute('placeholder');
    await expect(hint).toHaveText('Sin límite de fechas');
    await expect(hint).toBeVisible();
    await expect(hint).not.toHaveAttribute('hidden');
    expect(await hint.evaluate(node => node.getBoundingClientRect().top >= node.closest('.ch-filter-row')!.querySelector('[data-ch-to]')!.getBoundingClientRect().bottom)).toBe(true);
    expect(await contrastRatio(hint)).toBeGreaterThanOrEqual(4.5);
    await expect(screen.locator('[data-ch-status]')).toContainText('Todo el historial');
    await expect(screen.locator('[data-ch-table="sales"]')).toContainText('2020');
    await period.selectOption('custom');
    await expect(from).toHaveValue(''); await expect(to).toHaveValue('');
    await expect(hint).toHaveAttribute('hidden', '');
    await expect(hint).toBeHidden();
    await period.selectOption('all');
    await expect(hint).toBeVisible();
    await period.selectOption('30');
    await expect(hint).toHaveAttribute('hidden', '');
    await expect(hint).toBeHidden();
    await period.selectOption('all');
    await to.fill('2020-01-01'); await to.blur();
    await expect(period).toHaveValue('custom');
    await expect(hint).toHaveAttribute('hidden', '');
    await from.fill('2026-10-15'); await from.blur();
    const status = screen.locator('[data-ch-status]');
    await expect(status).toContainText('no puede ser posterior');
    await expect(status).toHaveClass(/ch-error/);
    expect(await contrastRatio(status)).toBeGreaterThanOrEqual(4.5);
    await noOverflow(page);
  });
}

for (const width of [390, 650, 1366]) for (const dark of [false, true]) {
  test(`${width}px ${dark ? 'Nocturno' : 'claro'}: «Sin límite de fechas» va debajo de los filtros y oculto no ocupa espacio`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageClienteHistorial'); }, dark);
    const screen = page.locator('#pageClienteHistorial');
    await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
    const period = screen.locator('[data-ch-period]');
    const hint = screen.locator('[data-ch-date-hint]');
    const layout = () => hint.evaluate(node => {
      const row = node.closest('.ch-filter-row')!;
      const box = (selector: string) => row.querySelector(selector)!.closest('label')!.getBoundingClientRect();
      const from = box('[data-ch-from]'), to = box('[data-ch-to]'), seller = box('[data-ch-seller]');
      const rect = node.getBoundingClientRect();
      return { fromTop: from.top, toTop: to.top, sellerTop: seller.top, toBottom: to.bottom, hintGridRow: getComputedStyle(node).gridRowStart,
        fieldsBottom: Math.max(from.bottom, to.bottom, seller.bottom), hintTop: rect.top, hintHeight: rect.height,
        hintRects: node.getClientRects().length, display: getComputedStyle(node).display, rowBottom: row.getBoundingClientRect().bottom };
    });
    await period.selectOption('all');
    await expect(hint).toBeVisible();
    const all = await layout();
    expect(all.hintHeight).toBeGreaterThan(0);
    if (width === 1366) {
      // Desde, Hasta y Vendedor en la misma fila; la nota en su propia fila debajo.
      expect(Math.abs(all.toTop - all.fromTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(all.sellerTop - all.fromTop)).toBeLessThanOrEqual(1);
      expect(all.hintTop).toBeGreaterThanOrEqual(all.fieldsBottom - 1);
      expect(all.hintGridRow).toBe('3');
    } else {
      // Orden visual vigente en web 171 a 390 y 650 px (una columna): Desde, Hasta, nota y Vendedor, de arriba abajo.
      expect(all.hintGridRow).toBe('auto');
      expect(all.fromTop).toBeLessThan(all.toTop);
      expect(all.toTop).toBeLessThan(all.hintTop);
      expect(all.hintTop).toBeLessThan(all.sellerTop);
      expect(all.hintTop).toBeGreaterThanOrEqual(all.toBottom - 1);
    }
    expect(await contrastRatio(hint)).toBeGreaterThanOrEqual(4.5);
    await noOverflow(page);
    await period.selectOption('30');
    await expect(hint).toHaveAttribute('hidden', '');
    await expect(hint).toBeHidden();
    const other = await layout();
    expect(other.display).toBe('none');
    expect(other.hintRects).toBe(0);
    expect(other.hintHeight).toBe(0);
    // Oculta no deja fila vacía: la fila de filtros termina en los campos.
    expect(Math.abs(other.rowBottom - other.fieldsBottom)).toBeLessThanOrEqual(1);
    if (width === 1366) {
      expect(Math.abs(other.toTop - other.fromTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(other.sellerTop - other.fromTop)).toBeLessThanOrEqual(1);
    }
    await noOverflow(page);
  });
}

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

for (const dark of [false, true]) {
  test(`650px ${dark ? 'dark' : 'light'}: third summary card spans the full row and every summary word stays on one line`, async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageClienteHistorial'); }, dark);
    const screen = page.locator('#pageClienteHistorial');
    await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
    const summary = screen.locator('.ch-summary');
    await expect(summary.locator('.ch-summary-card')).toHaveCount(3);
    await expect(summary).toHaveCSS('grid-template-columns', /^\S+ \S+$/);
    const boxes = await summary.evaluate(grid => {
      const box = grid.getBoundingClientRect();
      const cards = [...grid.querySelectorAll('.ch-summary-card')].map(card => card.getBoundingClientRect());
      return { gridWidth: box.width, gridLeft: box.left, widths: cards.map(card => card.width), tops: cards.map(card => card.top), thirdLeft: cards[2].left, firstBottom: cards[0].bottom };
    });
    expect(Math.abs(boxes.widths[2] - boxes.gridWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes.thirdLeft - boxes.gridLeft)).toBeLessThanOrEqual(1);
    expect(boxes.tops[0]).toBe(boxes.tops[1]);
    expect(boxes.tops[2]).toBeGreaterThan(boxes.firstBottom);
    for (const value of await summary.locator('.ch-summary-card :is(span, strong)').evaluateAll(nodes => nodes.map(node => {
      const words: { text: string; lines: number; fits: boolean }[] = [];
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const box = node.getBoundingClientRect();
      let textNode: Node | null;
      while ((textNode = walker.nextNode())) {
        for (const match of textNode.textContent!.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(textNode, match.index!); range.setEnd(textNode, match.index! + match[0].length);
          const rects = [...range.getClientRects()];
          words.push({ text: match[0], lines: rects.length, fits: rects.every(rect => rect.width > 0 && rect.left >= box.left - 1 && rect.right <= box.right + 1) });
        }
      }
      return { text: node.textContent, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowWrap: getComputedStyle(node).overflowWrap, words };
    }))) {
      expect(value.scrollWidth, value.text!).toBeLessThanOrEqual(value.clientWidth);
      expect(value.overflowWrap, value.text!).toBe('normal');
      expect(value.words.length, value.text!).toBeGreaterThan(0);
      for (const word of value.words) {
        expect(word.lines, word.text).toBe(1);
        expect(word.fits, word.text).toBe(true);
      }
    }
  });

  test(`650px ${dark ? 'dark' : 'light'}: headers on one line, numbers right-aligned, readable row cells and full customer label`, async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageClienteHistorial'); }, dark);
    const screen = page.locator('#pageClienteHistorial');
    await expect(screen.locator('h1')).toHaveText('Historial de compras por cliente');
    await screen.getByRole('combobox', { name: 'Cliente', exact: true }).selectOption('hist-c1');
    const result = await screen.evaluate(node => {
      const one = (el: Element) => { const s = getComputedStyle(el); return el.getBoundingClientRect().height <= parseFloat(s.lineHeight || '0') * 1.5 + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + 2; };
      const heads = [...node.querySelectorAll('thead th')];
      const nums = [...node.querySelectorAll('.ch-table .ch-num')];
      const rowTh = [...node.querySelectorAll('tbody th')].map(el => getComputedStyle(el));
      const select = node.querySelector<HTMLSelectElement>('[data-ch-customer]')!;
      // Mide el ancho real del texto (un span heredaría display:block y mediría el contenedor).
      const ctx = document.createElement('canvas').getContext('2d')!; ctx.font = getComputedStyle(select).font;
      const fits = ctx.measureText(select.selectedOptions[0].textContent || '').width + 40 <= select.clientWidth;
      return {
        headsOneLine: heads.every(el => getComputedStyle(el).whiteSpace === 'nowrap' && one(el)),
        numLabels: nums.map(el => (el.closest('table')!.querySelectorAll('thead th')[(el as HTMLTableCellElement).cellIndex] as HTMLElement).textContent),
        numsRight: nums.length > 0 && nums.every(el => getComputedStyle(el).textAlign === 'right' && getComputedStyle(el).whiteSpace === 'nowrap'),
        rowReadable: rowTh.every(s => s.textTransform === 'none' && parseFloat(s.fontSize) >= 14 && s.color === getComputedStyle(node).color),
        fits
      };
    });
    const sales = screen.locator('[data-ch-table="sales"]');
    await expect(sales.getByRole('columnheader', { name: 'Total', exact: true })).toHaveCSS('text-align', 'right');
    await expect(sales.locator('tbody td[data-label="Total"]').first()).toHaveCSS('text-align', 'right');
    await expect(screen.locator('.ch-summary')).toHaveCSS('grid-template-columns', /^\S+ \S+$/);
    for (const v of await screen.locator('.ch-summary-card :is(span, strong)').evaluateAll(nodes => nodes.map(n => ({
      text: n.textContent, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth, overflowWrap: getComputedStyle(n).overflowWrap })))) {
      expect(v.scrollWidth, v.text!).toBeLessThanOrEqual(v.clientWidth);
      expect(v.overflowWrap, v.text!).toBe('normal');
    }
    expect(result.headsOneLine).toBe(true);
    expect(result.numsRight).toBe(true);
    expect(new Set(result.numLabels)).toEqual(new Set(['Total', 'Cantidad', 'Importe']));
    expect(result.rowReadable).toBe(true);
    expect(result.fits).toBe(true);
    await noOverflow(page);
  });
}
