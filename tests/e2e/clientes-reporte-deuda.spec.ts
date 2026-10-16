import { test, expect, type Page } from '@playwright/test';

// Ejecutar después del cableado del integrador. No se sustituyen SCREENS,
// ALLOWED_PAGES, la navegación ni la API financiera V2 en estas pruebas.
test.use({ hasTouch:true, serviceWorkers:'block' });

async function setup(page: Page, role: 'owner' | 'empleado' = 'owner', dark = false) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') {
      return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(
        url.pathname === '/auth/me' ? { pos_role:role, owner_pin_set:true, roles_ready:true,
          device_id:'TEST-REPORT-DEVICE' } : {}) });
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.addInitScript(({ role }) => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint:'https://permissions.test', token:'synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, { role });
  await page.goto('/index.html');
  await page.waitForFunction(role => {
    const w = window as any;
    return w.NA_ROLES?.role === role && w.NA_ROLES.confirmed && w.NA_CLIENT_CREDIT_ACCOUNTS_V2 &&
      w.NA_MENU_NAVIGATION && typeof w.cliRender === 'function';
  }, role);
  await expect(page.locator('#pageReporteDeuda'), 'integrar primero el HTML de la página').toHaveCount(1);
  await page.waitForFunction(() => !!(window as any).NA_CLIENTES_REPORTE_DEUDA);
  await page.evaluate(({ dark }) => {
    const w = window as any;
    document.body.classList.toggle('dark', dark);
    const names = ['Cliente de prueba saldo mayor con nombre extenso para teléfono',
      'Cliente de prueba deuda vencida', 'Cliente de prueba sin deuda', 'Cliente de prueba pago offline'];
    clientes = names.map((nombre, index) => ({ id:101 + index, nombre, dni:'', tel:'', dir:'',
      color:index, totalCompras:0, creditCategories:[], lineaCreditoManualActiva:false,
      lineaCreditoManual:0 }));
    const credit = (id: number, clientId: number, amount: number, date: string, due = '2099-12-31', paid = 0) => ({
      id, credit_id:String(id), cliId:clientId, clienteId:clientId, clienteNombre:names[clientId - 101],
      clienteDni:'', tipo:'venta_credito', desc:'Crédito sintético ' + id, monto:amount, pagado:paid,
      saldo:amount - paid, fecha:date, hora:'10:00:00', hora24:'10:00:00', timestamp:date + 'T15:00:00.000Z',
      vence:due, status:paid === amount ? 'cancelado' : due === '2000-01-01' ? 'vencido' : 'vigente',
      estado:paid === amount ? 'cancelado' : due === '2000-01-01' ? 'vencido' : 'vigente',
      anulado:false, ventaId:null, pagos:[], canonicalDueKnown:true,
      cajero:'Cajero de prueba', cajeroNombre:'Cajero de prueba', cajeroId:'TEST-CASHIER',
      items:[{ itemKey:'concepto:0', productoId:null, id:null, sku:'', nombre:'Compra de prueba',
        name:'Compra de prueba', cantidad:1, qty:1, precioUnitario:amount, precio:amount,
        subtotal:amount, modo:'concepto', ventaModo:'unidad' }]
    });
    creditos = [credit(1001, 101, 80, '2024-04-03'), credit(1002, 101, 20, '2024-02-01'),
      credit(1003, 101, 10, '2020-01-01', '2099-12-31', 10),
      credit(1004, 102, 50, '2024-03-10', '2000-01-01'), credit(1005, 104, 10, '2024-05-01')];
    w.__rdPending = { state:'PENDING', command:'payment.batch', payload:{ operation_id:'TEST-RD-BATCH',
      payments:[{ operation_id:'TEST-RD-PARTIAL', credit_id:'1001', amount_cents:3000 },
        { operation_id:'TEST-RD-FULL', credit_id:'1005', amount_cents:1000 }] } };
    // Simula solamente la lectura del outbox. El saldo sigue siendo la API V2 real.
    w.NuevoAmanecerCanonical = { ...w.NuevoAmanecerCanonical, pendingSnapshot:() => w.__rdPending };
    w._naNormalizeData();
    w._naEnsureClientCreditIndex(true);
    w.NA_MENU_NAVIGATION.navigate('pageClientes');
    w.cliRender();
  }, { dark });
  await expect(page.locator('#pageClientes')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#cliList .client-card')).toHaveCount(4);
}

async function financialSnapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    const protectedKeys = Object.keys(localStorage).filter(key => /^na_canonical_/.test(key)).sort();
    return JSON.stringify({ clientes, creditos, ventas, cajMovs, cajEstado, pending:w.__rdPending,
      creditPolicy:appConfig.creditPolicy,
      storage:protectedKeys.map(key => [key, localStorage.getItem(key)]),
      layouts:['pagePOS', 'pageMenu'].map(id => document.getElementById(id)!.innerHTML) });
  });
}

async function accessibleHit(page: Page, selector: string) {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await target.evaluate(element => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === element || element.contains(hit));
  })).toBe(true);
}

for (const width of [1366, 768, 390]) for (const dark of [false, true]) {
  test(`owner: reporte ${width}px, ${dark ? 'oscuro' : 'claro'}, orden/pie/ficha sin escrituras`, async ({ page }) => {
    await page.setViewportSize({ width, height:900 });
    await setup(page, 'owner', dark);
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    const before = await financialSnapshot(page);
    await expect(page.locator('#naClientesReporteDeudaBtn')).toBeVisible();
    await accessibleHit(page, '#naClientesReporteDeudaBtn');
    if (width === 390) {
      const search = page.locator('#cliSearch');
      expect((await search.boundingBox())!.width).toBeGreaterThanOrEqual(80);
      expect(await search.evaluate(node => {
        const r = node.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === node;
      })).toBe(true);
    }
    await page.locator('#naClientesReporteDeudaBtn').tap();
    const report = page.locator('#pageReporteDeuda');
    await expect(report).toHaveClass(/\bactive\b/);
    await expect(report.locator('.rd-row')).toHaveCount(2);
    await expect(report.locator('.rd-row').first()).toHaveAttribute('data-client-id', '101');
    await expect(report.locator('[data-client-id="101"] .rd-balance .rd-value')).toHaveText('S/ 70.00');
    await expect(report.locator('[data-client-id="101"]')).toContainText('01/02/2024');
    await expect(report.locator('[data-client-id="101"] .rd-cell').last().locator('.rd-value')).toHaveText('2');
    await expect(report.locator('[data-client-id="102"] .rd-overdue .rd-value')).toHaveText('S/ 50.00');
    await expect(report.locator('[data-rd-total]')).toHaveText('S/ 120.00');
    await expect(report.locator('[data-rd-count]')).toHaveText('2');
    expect(await report.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await report.locator('.rd-row').first().evaluate(node => getComputedStyle(node).whiteSpace)).toBe('normal');
    if (width === 390) expect(await report.locator('.rd-row').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1);
    expect(await report.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(dark ? 'rgb(16, 26, 37)' : 'rgb(244, 247, 250)');
    // El control de entrada debe mantener disponible la búsqueda a 390px.
    expect(await page.locator('#naClientesReporteDeudaBtn').evaluate(node => !node.closest('.filter-bar'))).toBe(true);
    await expect(report.locator('[data-rd-back]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(report.locator('[data-rd-sort]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(report.locator('.rd-row').first()).toBeFocused();
    await report.getByLabel('Ordenar por').selectOption('vencida');
    await expect(report.locator('.rd-row').first()).toHaveAttribute('data-client-id', '102');
    await expect(report.locator('[data-rd-total]')).toHaveText('S/ 120.00');
    await expect(report.locator('[data-rd-count]')).toHaveText('2');
    expect(await financialSnapshot(page)).toBe(before);
    await accessibleHit(page, '#pageReporteDeuda [data-client-id="102"]');
    await report.locator('[data-client-id="102"]').tap();
    await expect(page.locator('#pageClientes')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#pageClientes .na-client-account-screen')).toBeVisible();
    await expect(page.locator('#pageClientes .na-v2-client-head h2')).toHaveText('CLIENTE DE PRUEBA DEUDA VENCIDA');
    await page.evaluate(() => (window as any).NA_CLIENTES_REPORTE_DEUDA.open());
    await expect(report).toHaveClass(/\bactive\b/);
    await report.getByLabel('Ordenar por').selectOption('saldo');
    await report.locator('[data-client-id="101"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#pageClientes')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#pageClientes .na-v2-client-head h2')).toContainText('SALDO MAYOR');
    await page.evaluate(() => (window as any).NA_CLIENTES_REPORTE_DEUDA.open());
    await expect(report.locator('[data-rd-back]')).toBeFocused();
    await report.locator('[data-client-id="101"]').focus();
    await page.evaluate(() => {
      const row = document.querySelector('#pageReporteDeuda [data-client-id="101"]')!;
      (window as any).__rdFocusedRow = row;
      window.dispatchEvent(new Event('focus'));
    });
    await expect(report.locator('[data-client-id="101"]')).toBeFocused();
    expect(await page.evaluate(() => {
      (window as any).NA_CLIENTES_REPORTE_DEUDA.render();
      return (window as any).__rdFocusedRow === document.activeElement;
    })).toBe(true);
    await page.keyboard.press('Space');
    await expect(page.locator('#pageClientes .na-v2-client-head h2')).toContainText('SALDO MAYOR');
    expect(await financialSnapshot(page)).toBe(before);
    expect(writes).toEqual([]);
  });
}

test('empleado: sin botón ni datos del reporte; acceso directo muestra Sin permiso y no escribe', async ({ page }) => {
  await page.setViewportSize({ width:390, height:900 });
  await setup(page, 'empleado');
  const before = await financialSnapshot(page);
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method()); });
  await expect(page.locator('#naClientesReporteDeudaBtn')).toBeHidden();
  expect(await page.evaluate(() => (window as any).NA_CLIENTES_REPORTE_DEUDA.open())).toBe(false);
  await page.evaluate(() => (window as any).goPage('pageReporteDeuda'));
  await expect(page.locator('#naNoPermission')).toBeVisible();
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageReporteDeuda')).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(0);
  expect(await financialSnapshot(page)).toBe(before);
  expect(writes).toEqual([]);
});

test('pérdida del rol owner borra inmediatamente datos y controles del reporte', async ({ page }) => {
  await setup(page);
  await page.locator('#naClientesReporteDeudaBtn').click();
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(2);
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status:200,
    contentType:'application/json', body:JSON.stringify({ pos_role:'empleado', roles_ready:true }) }));
  await page.evaluate(() => (window as any).NA_ROLES.refresh());
  await expect(page.locator('#naClientesReporteDeudaBtn')).toBeHidden();
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(0);
  await expect(page.locator('#pageReporteDeuda [data-rd-total]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).NA_CLIENTES_REPORTE_DEUDA.openClient(101))).toBe(false);
});

test('1000 clientes: filas/pie íntegros, sin recrear DOM por eventos de foco', async ({ page }) => {
  await page.setViewportSize({ width:390, height:900 });
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    clientes = Array.from({ length:1000 }, (_, i) => ({ ...clientes[0], id:i + 10000,
      nombre:'Cliente sintético extenso ' + i + ' ' + 'X'.repeat(120) }));
    const template = creditos[0];
    creditos = clientes.map((client, i) => ({ ...template, id:20000 + i, credit_id:String(20000 + i),
      cliId:client.id, clienteId:client.id, clienteNombre:client.nombre, monto:10, pagado:0, saldo:10,
      items:(template.items || []).map((item: any) => ({ ...item, precioUnitario:10, precio:10, subtotal:10 })) }));
    w.__rdPending = null;
    w._naEnsureClientCreditIndex(true);
  });
  const before = await financialSnapshot(page);
  await page.locator('#naClientesReporteDeudaBtn').click();
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(1000);
  await expect(page.locator('#pageReporteDeuda [data-rd-total]')).toHaveText('S/ 10000.00');
  await expect(page.locator('#pageReporteDeuda [data-rd-count]')).toHaveText('1000');
  expect(await page.locator('#pageReporteDeuda').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const first = page.locator('#pageReporteDeuda .rd-row').first();
  await first.focus();
  expect(await first.evaluate(node => {
    performance.mark('rd-start');
    (window as any).NA_CLIENTES_REPORTE_DEUDA.render();
    performance.mark('rd-end');
    performance.measure('rd-refresh-1000', 'rd-start', 'rd-end');
    return node === document.querySelector('#pageReporteDeuda .rd-row');
  })).toBe(true);
  await expect(first).toBeFocused();
  expect(await financialSnapshot(page)).toBe(before);
  const duration = await page.evaluate(() => performance.getEntriesByName('rd-refresh-1000')[0].duration);
  test.info().annotations.push({ type:'performance', description:`Refresh 1000 clientes: ${duration.toFixed(1)} ms` });
});

test('actualiza pendientes y limpia totales ante errores de snapshot o API, sin asumir outbox vacío', async ({ page }) => {
  await setup(page);
  await page.locator('#naClientesReporteDeudaBtn').click();
  await page.evaluate(() => {
    const w = window as any;
    w.__rdPending = null;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(3);
  await expect(page.locator('#pageReporteDeuda [data-rd-total]')).toHaveText('S/ 160.00');
  await page.evaluate(() => {
    const w = window as any;
    w.NuevoAmanecerCanonical = { ...w.NuevoAmanecerCanonical, pendingSnapshot:() => { throw new Error('offline fixture'); } };
    w.NA_CLIENTES_REPORTE_DEUDA.render();
  });
  await expect(page.locator('#pageReporteDeuda [data-rd-total]')).toHaveCount(0);
  await expect(page.locator('#pageReporteDeuda [data-rd-status]')).toContainText('No se pudo cargar');
  await page.evaluate(() => {
    const w = window as any;
    w.NuevoAmanecerCanonical = { ...w.NuevoAmanecerCanonical, pendingSnapshot:() => w.__rdPending };
    w.NA_CLIENT_CREDIT_ACCOUNTS_V2 = { ...w.NA_CLIENT_CREDIT_ACCOUNTS_V2,
      summarizeClient:() => { throw new Error('unavailable fixture'); } };
    w.NA_CLIENTES_REPORTE_DEUDA.render();
  });
  await expect(page.locator('#pageReporteDeuda [data-rd-status]')).toContainText('No se pudo cargar');
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(0);
  await expect(page.locator('#pageReporteDeuda [data-rd-total]')).toHaveCount(0);
});

test('sin clientes deudores muestra estado vacío y pie con cero', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    clientes = [];
    creditos = [];
    w.__rdPending = null;
  });
  await page.locator('#naClientesReporteDeudaBtn').click();
  await expect(page.locator('#pageReporteDeuda [data-rd-status]')).toHaveText('No hay clientes con deuda pendiente.');
  await expect(page.locator('#pageReporteDeuda .rd-row')).toHaveCount(0);
  await expect(page.locator('#pageReporteDeuda [data-rd-total]')).toHaveText('S/ 0.00');
  await expect(page.locator('#pageReporteDeuda [data-rd-count]')).toHaveText('0');
});
