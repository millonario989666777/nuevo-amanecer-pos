import { test, expect, type Page, type Locator } from '@playwright/test';

// Estos tests exigen el cableado real del integrador: no inyectan la pantalla,
// permisos ni navegación y no reemplazan editProd.
const products = [
  { id: 990101, name: 'Paracetamol 500 mg, caja de 100 tabletas — presentación para farmacia',
    sku: ' 0077500012345 ', barcode: '0077500012345', codigosAlternativos: ['0077500012345'], codigoAlternativo: '0077500012345', stock: 120 },
  { id: 990102, name: 'Arroz extra en bolsa de 1 kilogramo — abarrotes Nuevo Amanecer',
    sku: 'ARROZ-TEST-1KG', barcode: '0077500012345', codigosAlternativos: [], codigoAlternativo: '', stock: 24 },
  { id: 990103, name: 'Jabón de tocador, paquete familiar de tres unidades',
    sku: 'JABON-TEST-3', barcode: '7750009990001', codigosAlternativos: [' 0077500012345 '], codigoAlternativo: '', stock: 0 },
  { id: 990104, name: 'Producto descontinuado de prueba', sku: 'INACTIVO-TEST', barcode: '0077500012345', codigosAlternativos: [], codigoAlternativo: '', stock: 10, activo: false },
  { id: 990105, name: 'Producto eliminado de prueba', sku: 'ELIMINADO-TEST', barcode: '0077500012345', codigosAlternativos: [], codigoAlternativo: '', stock: 10, eliminado: true }
].map(p => ({ descripcion: 'Fixture sintético; sin clientes reales', cat: p.id === 990101 ? 'farmacia' : 'abarrotes',
  marca: 'Marca de prueba', unidad: 'unidad', unidadCompra: 'unidad', factorCompra: 1,
  costo: 1, precio: 2, stockMin: 3, venc: '', icon: '📦', imagen: null,
  incluyeIGV: true, tipoImpuesto: 'gravado', impuestoComplementario: '', controlInventario: true,
  precioCaja: null, unidCaja: null, activo: true, ...p }));
const sale = (id: string, date: string, ids: number[], extra = {}) => ({ id, fecha: date, hora: '10:00', hora24: '10:00:00',
  total: 2 * ids.length, metodo: 'efectivo', estado: 'completada', anulada: false, clienteId: null,
  items: ids.map(id => ({ id, name: 'Nombre histórico distinto', qty: 1, cantidad: 1, precio: 2, costo: 1, unitsPerQty: 1 })), ...extra });
const sales = [sale('TEST-OLD', '2026-10-10', [990101]), sale('TEST-NEW', '2026-10-12', [990101]),
  sale('TEST-ANNUL', '2026-10-15', [990101, 990103], { anulada: true, estado: 'anulada' }),
  sale('TEST-LIMA', '2026-10-14', [990102], { timestamp: '2026-10-14T04:30:00Z' }),
  sale('TEST-PENDING', '2026-10-11', [990102], { pending: true, confirmed: false, operation_id: 'synthetic-pending-sale' })];

async function setup(page: Page, role: 'owner' | 'empleado' = 'owner', dark = false) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'synthetic-catalog-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'synthetic-test-only' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
  await page.waitForFunction(() => (0, eval)('typeof _naFreeSaleShortcutState !== "undefined" && _naFreeSaleShortcutState.ready'));
  expect(await page.locator('#pageCodigosDuplicados').count(), 'Integrar primero el HTML de entrega').toBe(1);
  expect(await page.evaluate(() => !!(window as any).NA_CODIGOS_DUPLICADOS), 'Integrar primero el script de entrega').toBe(true);
  await page.evaluate(({ products, sales, dark }) => {
    // Fixture local aislado. La edición real conserva sus validaciones locales.
    const w = window as any;
    w.NuevoAmanecerCanonical.enabled = () => false;
    w.NA_THEME.setMode(dark ? 'noche' : 'claro');
    // productos y ventas son let globales: asignar al binding, no a window.
    (0, eval)('productos = ' + JSON.stringify(products));
    (0, eval)('ventas = ' + JSON.stringify(sales));
    w.NA_MENU_NAVIGATION.navigate('pageInventario');
    w.invRender();
  }, { products, sales, dark });
  await expect(page.locator('#pageInventario')).toHaveClass(/\bactive\b/);
}
const snapshot = (page: Page) => page.evaluate(() => (0, eval)('JSON.stringify({productos,ventas,creditos})'));
async function assertTouchable(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  expect(await button.evaluate(node => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!hit && (hit === node || node.contains(hit));
  })).toBe(true);
}
async function enterFromMenu(page: Page) {
  const button = page.locator('#pageInventario .inv-secondary-menu [data-codigos-duplicados]');
  await expect(button).toHaveCount(1);
  await expect(button).toBeHidden();
  await page.locator('#pageInventario .inv-secondary > summary').click();
  await expect(button).toHaveText('Códigos duplicados');
  await assertTouchable(button);
  await button.click();
  await expect(page.locator('#pageCodigosDuplicados')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#pageCodigosDuplicados .cd-pair')).toHaveCount(3);
}

for (const width of [1366, 768, 390]) for (const dark of [false, true]) {
  test(`owner ${width}px ${dark ? 'oscuro' : 'claro'}: pares, entrada, edición y catálogo intacto`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, 'owner', dark);
    const before = await snapshot(page);
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
    await enterFromMenu(page);
    const screen = page.locator('#pageCodigosDuplicados');
    await expect(screen.locator('[data-cd-status]')).toHaveText('3 pares de productos con códigos duplicados');
    await expect(screen.locator('.cd-intro')).toContainText('Las fotos de esos códigos no se asignan solas');
    await expect(screen.locator('.cd-intro')).toContainText('editando el producto');
    await expect(screen.locator('.cd-code')).toHaveText(Array(3).fill('Código: 0077500012345'));
    const firstPair = screen.locator('.cd-pair').first();
    await expect(firstPair.locator('.cd-product').first()).toContainText('120');
    await expect(firstPair.locator('.cd-product').first()).toContainText('12/10/2026');
    await expect(firstPair.locator('.cd-product').nth(1)).toContainText('13/10/2026');
    await expect(screen.locator('.cd-pair').nth(1).locator('.cd-product').nth(1)).toContainText('sin ventas');
    await expect(screen).not.toContainText('descontinuado');
    await expect(screen).not.toContainText('eliminado');
    expect(await screen.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await screen.locator('.cd-pair,.cd-product,h1,h2,h3,button').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    expect(await screen.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(dark ? 'rgb(17, 28, 43)' : 'rgb(245, 248, 250)');

    const edit = firstPair.getByRole('button', { name: 'Abrir producto: ' + products[0].name, exact: true });
    await assertTouchable(edit);
    await edit.click();
    await expect(page.locator('#mProd')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#pNombre')).toHaveValue(products[0].name);
    await expect(page.locator('#pStock')).toHaveValue('120');
    await page.locator('#mProd .mbtn-cancel').click();
    await expect(page.locator('#mProd')).not.toHaveClass(/\bopen\b/);
    await screen.getByRole('button', { name: 'Actualizar lista', exact: true }).click();
    await expect(screen.locator('.cd-pair')).toHaveCount(3);
    expect(await snapshot(page)).toBe(before);
    expect(writes).toEqual([]);
    await screen.getByRole('button', { name: 'Volver a Inventario', exact: true }).click();
    await expect(page.locator('#pageInventario')).toHaveClass(/\bactive\b/);
    expect(await snapshot(page)).toBe(before);
  });
}

test('empleado no tiene entrada; navegación directa muestra Sin permiso y no revela el catálogo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, 'empleado');
  const before = await snapshot(page);
  await page.locator('#pageInventario .inv-secondary > summary').click();
  await expect(page.locator('#pageInventario [data-codigos-duplicados]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).NA_CODIGOS_DUPLICADOS.open())).toBe(false);
  await expect(page.locator('#pageCodigosDuplicados [data-cd-status]')).toHaveText('Sin permiso');
  expect(await page.evaluate(() => (window as any).NA_CODIGOS_DUPLICADOS.openProduct(990101))).toBe(false);
  await expect(page.locator('#mProd')).not.toHaveClass(/\bopen\b/);
  await page.evaluate(() => (window as any).goPage('pageCodigosDuplicados'));
  await expect(page.locator('#naNoPermission')).toBeVisible();
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageCodigosDuplicados')).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('#pageCodigosDuplicados .cd-pair')).toHaveCount(0);
  expect(await snapshot(page)).toBe(before);
});

test('catálogo sin colisiones muestra Sin códigos duplicados sin tocar datos', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => (0, eval)('productos = productos.slice(0,1)'));
  const before = await snapshot(page);
  await page.locator('#pageInventario .inv-secondary > summary').click();
  await page.locator('#pageInventario [data-codigos-duplicados]').click();
  await expect(page.locator('#pageCodigosDuplicados [data-cd-status]')).toHaveText('Sin códigos duplicados');
  await expect(page.locator('#pageCodigosDuplicados .cd-pair')).toHaveCount(0);
  expect(await snapshot(page)).toBe(before);
});
