import { test, expect, type Page } from '@playwright/test';

// Requiere el HTML y cableado entregados al integrador. Red completamente simulada.
const fixture = {
  products: [
    { id: 101, name: 'Paracetamol 500 mg', sku: 'FAR-101', barcode: '7750000000101', alternateCodes: ['MED-101'], unidad: 'unidad', stock: 60, costo: 9 },
    { id: 202, name: 'Azúcar rubia 1 kg', sku: 'AB-202', barcode: '7750000000202', unidad: 'unidad', stock: 20, costo: 4 },
    { id: 303, name: 'Alcohol 70°', sku: 'FAR-303', unidad: 'unidad', stock: 0, costo: 3 }
  ],
  purchases: [
    { purchase_id: 'PUR-e2e-old', status: 'aplicada', created_at: '2026-10-10T18:00:00Z', supplier: 'Distribuidora de prueba', total_cost_cents: 6800, lines: [
      { purchase_id: 'PUR-e2e-old', line_number: 1, product_id: '101', quantity: 20, unit_cost_cents: 100 },
      { purchase_id: 'PUR-e2e-old', line_number: 2, product_id: '202', quantity: 12, unit_cost_cents: 400 }
    ] },
    { purchase_id: 'PUR-e2e-new', status: 'aplicada', created_at: '2026-10-14T02:00:00Z', supplier: 'ProveedorDePruebaConNombreMuyLargoSinEspacios'.repeat(3).slice(0, 120), total_cost_cents: 6000, lines: [
      { purchase_id: 'PUR-e2e-new', line_number: 1, product_id: '101', quantity: 40, unit_cost_cents: 150 }
    ] },
    { purchase_id: 'PUR-e2e-pending', status: 'en_curso', created_at: '2026-10-15T17:00:00Z', supplier: 'Compra sin confirmar de prueba', lines: [
      { purchase_id: 'PUR-e2e-pending', line_number: 1, product_id: '101', quantity: 50, unit_cost_cents: 200 }
    ] }
  ],
  inventoryMovements: [
    { movement_id: 'IM-e2e-new', operation_id: 'PUR-e2e-new:1', product_id: '101', movement_type: 'ENTRADA', quantity: 40, reason: 'Compra proveedor de prueba', created_at: '2026-10-14T02:00:00Z' }
  ],
  sales: [{ id: 'TEST-sale', items: [{ id: 101, qty: 1 }], total: 2 }],
  payments: [{ id: 'TEST-payment', amount_cents: 200 }],
  cashMovements: [{ id: 'TEST-cash', monto: 2 }],
  credits: [{ id: 'TEST-credit', saldo: 4 }]
};

async function setup(page: Page, role: 'owner' | 'empleado', options: { fail?: boolean; delay?: boolean; notReady?: boolean } = {}) {
  const writes: string[] = [], reads: string[] = [];
  let release: (() => void) | undefined;
  const hold = options.delay ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname !== 'permissions.test') return route.abort();
    // POST /settings es la sincronización de configuración que dispara saveAppState() de la propia prueba (en CI llega tarde); el módulo nunca la llama.
    if (request.method() !== 'GET') { if (url.pathname !== '/settings') writes.push(request.method() + ' ' + url.pathname); return route.abort(); }
    if (url.pathname === '/auth/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'TEST-device' }) });
    // La ruta real permite GET a ambos roles; el módulo debe impedir la lectura al empleado.
    if (url.pathname === '/auth/purchases' && !url.search) {
      reads.push(url.pathname);
      await hold;
      return route.fulfill({ status: options.fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(options.fail ? { error: 'unavailable' } : options.notReady ? { purchases: [], ready: false } : { purchases: fixture.purchases }) });
    }
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test_endpoint_unavailable' }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'TEST-synthetic-token' }));
  });
  await page.goto('/index.html');
  await expect(page.locator('script[src="js/inventory/historial-compras.js"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return typeof w.NA_ROLES?.refresh === 'function' && typeof w.NA_HISTORIAL_COMPRAS?.readPurchases === 'function' && typeof w.NA_CONFIG_G?.flush === 'function';
  }), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => {
    const w = window as any, api = w.NA_ROLES.api;
    w.__hcPendingApi = 0;
    w.__hcCompletedPurchases = 0;
    w.NA_ROLES.api = async function (...args: any[]) {
      w.__hcPendingApi++;
      try { return await api.apply(this, args); }
      finally {
        w.__hcPendingApi--;
        if (args[0] === '/auth/purchases') w.__hcCompletedPurchases++;
      }
    };
  });
  await page.evaluate(async () => { await (window as any).NA_ROLES.refresh(); });
  await expect.poll(() => page.evaluate(role => {
    const roles = (window as any).NA_ROLES;
    return roles.role === role && roles.confirmed;
  }, role), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__hcPendingApi)).toBe(0);
  await page.evaluate(data => {
    const w = window as any;
    const clone = () => JSON.parse(JSON.stringify(data));
    w.NuevoAmanecerCanonical = { enabled: () => true, snapshot: clone, sourceState: () => ({ source: 'remote' }) };
    // La app guarda sus colecciones en bindings léxicos globales.
    (0, eval)('productos = ' + JSON.stringify(data.products));
    (0, eval)('inventoryMovements = ' + JSON.stringify(data.inventoryMovements));
    (0, eval)('ventas = ' + JSON.stringify(data.sales));
    (0, eval)('creditos = ' + JSON.stringify(data.credits));
    (0, eval)('cajMovs = ' + JSON.stringify(data.cashMovements));
    localStorage.setItem('na_purchase_pending_ops_v2', JSON.stringify({ 'TEST-purchase-pending': { fp: 'TEST', at: 1, noted: false } }));
    localStorage.setItem('na_canonical_journal', JSON.stringify({ state: 'PENDING', command: 'payment.create', payload: { operation_id: 'TEST-payment-pending' } }));
    localStorage.setItem('TEST-sale-outbox', JSON.stringify([{ id: 'TEST-sale-pending', state: 'PENDING' }]));
  }, fixture);
  // Conserva todo el registro de red: reiniciarlo ocultaría escrituras o carreras del arranque.
  return { writes, reads, release: () => release?.() };
}

async function settlePreferences(page: Page) {
  // saveAppState/goPage programan un push de settings a 600 ms y no devuelven su promesa.
  // flush cancela ese timer y espera el guardado y su caché antes de observar storage.
  await page.evaluate(async () => { await (window as any).NA_CONFIG_G.flush(); });
  await expect.poll(() => page.evaluate(() => (window as any).__hcPendingApi)).toBe(0);
}

async function businessData(page: Page) {
  return page.evaluate(() => {
    const stored: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (/pending|outbox|journal/.test(key)) stored[key] = localStorage.getItem(key);
      else {
        // saveAppState guarda también preferencias de navegación. Solo comparamos datos de negocio.
        try { const value = JSON.parse(localStorage.getItem(key)!); if (value?.data?.productos) stored[key] = JSON.stringify(value.data); } catch {}
      }
    }
    return { snapshot: (window as any).NuevoAmanecerCanonical.snapshot(), lexical: (0, eval)('JSON.stringify({productos, inventoryMovements, ventas, creditos, cajMovs})'), stored };
  });
}

const UI_STATE_KEY = 'na_local_config_v1';

async function watchStorage(page: Page) {
  await page.evaluate((UI_STATE_KEY) => {
    const w = window as any;
    w.__hcStorageWrites = [];
    w.__hcStoredBefore = [localStorage, sessionStorage].map(storage => Object.fromEntries(
      Array.from({ length: storage.length }, (_, i) => storage.key(i)!).map(key => [key, storage.getItem(key)])
    ));
    for (const method of ['setItem', 'removeItem', 'clear'] as const) {
      const original = Storage.prototype[method];
      (Storage.prototype as any)[method] = function (...args: string[]) {
        // No guarda valores de credenciales ni de datos, solo el nombre de la operación.
        // Estado de UI de la app (página activa) no es dato de negocio ni escritura del módulo.
        if (args[0] !== UI_STATE_KEY) w.__hcStorageWrites.push(method);
        return (original as any).apply(this, args);
      };
    }
  }, UI_STATE_KEY);
}

async function expectStorageUnchanged(page: Page) {
  const check = await page.evaluate(() => {
    const after = [localStorage, sessionStorage].map(storage => Object.fromEntries(
      Array.from({ length: storage.length }, (_, i) => storage.key(i)!).map(key => [key, storage.getItem(key)])
    ));
    const w = window as any;
    return { writes: w.__hcStorageWrites, before: w.__hcStoredBefore, after };
  });
  expect(check.writes).toEqual([]);
  const strip = (all: any[]) => all.map(store => Object.fromEntries(Object.entries(store).filter(([key]) => key !== UI_STATE_KEY)));
  expect(strip(check.after)).toEqual(strip(check.before));
}

async function overflowAndTap(page: Page) {
  await expect.poll(() => page.locator('#pageHistorialCompras').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const selected = page.locator('#pageHistorialCompras [data-product-id="101"]');
  await selected.scrollIntoViewIfNeeded();
  await expect.poll(() => selected.evaluate(node => {
    const r = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })).toBe(true);
  await expect(page.locator('#pageHistorialCompras .hc-table td').first()).toHaveCSS('white-space', 'normal');
  await page.locator('#pageHistorialCompras .hc-table td').first().hover();
  await expect.poll(() => page.locator('#pageHistorialCompras .hc-table td').first().evaluate(node => {
    const page = node.closest('#pageHistorialCompras')!;
    const expected = document.createElement('span');
    expected.style.backgroundColor = getComputedStyle(page).getPropertyValue('--hc-selected');
    page.appendChild(expected);
    const matches = getComputedStyle(expected).backgroundColor === getComputedStyle(node).backgroundColor;
    expected.remove();
    return matches;
  })).toBe(true);
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner: ${width}px, tema ${dark ? 'oscuro' : 'claro'}, consulta por tarjeta sin escrituras`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const io = await setup(page, 'owner');
    await page.evaluate(dark => document.body.classList.toggle('dark', dark), dark);
    // Se crea un snapshot local de prueba antes de iniciar para comparar datos persistidos.
    await page.evaluate(() => (window as any).saveAppState());
    await settlePreferences(page);
    const before = await businessData(page);
    await page.evaluate(() => (window as any).goPage('pageProximamente'));
    await expect(page.locator('#pageProximamente')).toHaveClass(/\bactive\b/);
    await expect(page.locator('[data-feature-id="historial-compras-producto"]')).toHaveCount(1);
    await page.locator('[data-feature-id="historial-compras-producto"]').click();
    await expect(page.locator('#pageHistorialCompras')).toHaveClass(/\bactive\b/);
    await expect(page.locator('[data-hc-status]')).toContainText('300 compras recientes');
    await expect.poll(() => page.evaluate(() => (window as any).__hcCompletedPurchases)).toBe(1);
    // goPage persiste preferencias de navegación en el POS; la consulta no debe persistir nada.
    await settlePreferences(page);
    await watchStorage(page);
    const search = page.locator('[data-hc-search]');
    await search.fill('paracetamol');
    await expect(page.locator('[data-hc-products] button')).toHaveCount(1);
    await page.locator('[data-hc-products] button').click();
    await expect(page.locator('.hc-table tbody tr')).toHaveCount(2);
    expect(await page.locator('.hc-table tbody tr').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.purchaseId))).toEqual(['PUR-e2e-new:1', 'PUR-e2e-old:1']);
    await expect(page.locator('.hc-table tbody tr').first()).toContainText('13/10/2026 21:00');
    await expect(page.locator('.hc-table tbody tr').first()).toContainText('S/ 60.00');
    await expect(page.locator('.hc-summary')).toContainText('60 · unidad');
    await expect(page.locator('.hc-summary')).toContainText('S/ 1.33');
    await expect(page.locator('[data-hc-result]')).toContainText('sin aplicación confirmada');
    await overflowAndTap(page);
    for (const code of ['far-101', '7750000000101', 'med-101']) {
      await search.fill(code);
      await expect(page.locator('[data-hc-products] button')).toHaveCount(1);
      await expect(page.locator('[data-hc-products] button')).toHaveAttribute('data-product-id', '101');
    }
    await search.fill('azucar');
    await expect(page.locator('[data-hc-products] button')).toHaveCount(1);
    await expect(page.locator('[data-hc-products] button')).toHaveAttribute('data-product-id', '202');
    await page.locator('[data-hc-products] button').click();
    await expect(page.locator('.hc-table tbody tr')).toHaveCount(1);
    await expect(page.locator('.hc-summary')).toContainText('S/ 4.00');
    await search.fill('FAR-303');
    await expect(page.locator('[data-hc-products] button')).toHaveCount(1);
    await expect(page.locator('[data-hc-products] button')).toHaveAttribute('data-product-id', '303');
    await page.locator('[data-hc-products] button').click();
    await expect(page.locator('[data-hc-result]')).toContainText('Sin compras registradas');
    await search.fill('producto inexistente');
    await expect(page.locator('[data-hc-products]')).toContainText('No se encontraron productos');
    expect(await businessData(page)).toEqual(before);
    expect(io.writes).toEqual([]);
    expect(io.reads.filter(path => path.startsWith('/auth/purchases'))).toEqual(['/auth/purchases']);
    await expectStorageUnchanged(page);
  });
}

test('empleado: navegación y render directo dicen Sin permiso, sin leer compras ni cambiar datos', async ({ page }) => {
  const io = await setup(page, 'empleado');
  const before = await businessData(page);
  await page.evaluate(() => (window as any).goPage('pageHistorialCompras'));
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageHistorialCompras')).not.toHaveClass(/\bactive\b/);
  await watchStorage(page);
  // Defensa del módulo si un caller activa el DOM por otro camino.
  await page.evaluate(() => {
    document.getElementById('naNoPermission')?.remove();
    document.querySelectorAll('.page').forEach(node => node.classList.remove('active'));
    document.getElementById('pageHistorialCompras')!.classList.add('active');
  });
  // La guarda de la app vuelve a ocultar la página; el módulo igual queda en estado denegado.
  await expect(page.locator('[data-hc-denied]')).not.toHaveAttribute('hidden', /.*/);
  await expect(page.locator('[data-hc-content]')).toHaveAttribute('hidden', /.*/);
  await expect(page.locator('[data-hc-products] button')).toHaveCount(0);
  expect(io.reads.filter(path => path.startsWith('/auth/purchases'))).toEqual([]);
  expect(io.writes).toEqual([]);
  expect(await businessData(page)).toEqual(before);
  await expectStorageUnchanged(page);
});

test('fallo de lectura no se disfraza de historial vacío', async ({ page }) => {
  const io = await setup(page, 'owner', { fail: true });
  await page.evaluate(() => (window as any).goPage('pageHistorialCompras'));
  await expect(page.locator('[data-hc-status]')).toContainText('No se pudo cargar');
  await expect(page.locator('[data-hc-retry]')).toBeVisible();
  await expect(page.locator('[data-hc-result]')).toBeEmpty();
  expect(io.reads.filter(path => path.startsWith('/auth/purchases'))).toEqual(['/auth/purchases']);
  expect(io.writes).toEqual([]);
});

test('registro no disponible (ready:false) no se presenta como historial vacío', async ({ page }) => {
  const io = await setup(page, 'owner', { notReady: true });
  await page.evaluate(() => (window as any).goPage('pageHistorialCompras'));
  await expect(page.locator('[data-hc-status]')).toContainText('todavía no está disponible');
  await page.locator('[data-hc-search]').fill('FAR-101');
  await expect(page.locator('[data-hc-products] button')).toHaveCount(1);
  await expect(page.locator('[data-hc-products] button')).toHaveAttribute('data-product-id', '101');
  await page.locator('[data-hc-products] button').click();
  await expect(page.locator('[data-hc-result]')).toBeEmpty();
  await expect(page.locator('[data-hc-retry]')).toBeVisible();
  expect(io.reads.filter(path => path.startsWith('/auth/purchases'))).toEqual(['/auth/purchases']);
  expect(io.writes).toEqual([]);
});

test('al perder permisos una respuesta tardía no muestra datos del owner', async ({ page }) => {
  const io = await setup(page, 'owner', { delay: true });
  await page.evaluate(() => (window as any).goPage('pageHistorialCompras'));
  await expect.poll(() => io.reads.length).toBe(1);
  await page.evaluate(() => {
    (window as any).NA_ROLES = { role: 'unknown', confirmed: false, isOwner: () => false };
    window.dispatchEvent(new CustomEvent('na:role'));
  });
  await expect(page.locator('[data-hc-denied]')).toBeVisible();
  io.release();
  // Espera el consumo/rechazo de la respuesta en el navegador, no solo route.fulfill.
  await expect.poll(() => page.evaluate(() => (window as any).__hcCompletedPurchases)).toBe(1);
  await expect(page.locator('[data-hc-denied]')).toBeVisible();
  await expect(page.locator('[data-hc-result]')).toBeEmpty();
  await expect(page.locator('[data-hc-products]')).toBeEmpty();
  expect(io.reads.filter(path => path.startsWith('/auth/purchases'))).toEqual(['/auth/purchases']);
  expect(io.writes).toEqual([]);
});
