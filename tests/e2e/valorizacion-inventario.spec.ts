import { test, expect, type Page } from '@playwright/test';

// Uses the actual integrated HTML/scripts. No injected page or permission policy.
// Apply the handoff wiring before running; all network/data below are synthetic.
async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'valuation-test-device' } : {}
    ) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.addInitScript(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.goto('/index.html');
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
  await page.evaluate(() => {
    // Assignment to the legacy global lexical let, after synthetic role confirmation.
    // @ts-ignore POS runtime globals
    productos = [
      { id: 'valuation-1', name: 'Producto sintético A', cat: 'farmacia', stock: 7, costo: 1.25, precio: 2,
        lots: [{ quantity: 8, expiry_date: '2025-01-01' }], _canonicalPendingStock: true, _canonicalRemoteStock: 10 },
      { id: 'valuation-2', name: 'Producto sintético B', cat: 'farmacia', stock: 3, costo: null, precio: 4 },
      { id: 'valuation-3', name: 'Producto sintético C', cat: 'abarrotes', stock: 3, costo: 0.4, precio: 1 },
      { id: 'valuation-4', name: 'Producto sintético D', cat: 'abarrotes', stock: -5, costo: 3, precio: 6 },
      { id: 'valuation-5', name: 'Servicio sintético', cat: 'servicios', stock: 20, costo: 5, precio: 8, controlInventario: false },
      { id: 'valuation-6', name: 'Producto sintético E', cat: 'categoria_con_nombre_muy_largo_para_comprobar_ajuste_en_telefono', stock: 0, costo: 0, precio: 1 }
    ];
  });
}

for (const width of [390, 768, 1366]) {
  for (const dark of [false, true]) {
    test(`owner valuation at ${width}px, ${dark ? 'dark' : 'light'}: values, layout and read-only refresh`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await rolePage(page, 'owner');
      await page.evaluate(dark => document.body.classList.toggle('dark', dark), dark);
      await page.evaluate(() => (window as any).goPage('pageProximamente'));
      const entry = page.locator('#pageProximamente [data-feature-id="valorizacion-inventario"]');
      await expect(entry).toContainText('Disponible');
      await entry.click();
      const screen = page.locator('#pageValorizacion');
      await expect(screen).toHaveClass(/\bactive\b/);
      await expect(screen.getByRole('heading', { name: 'Valorización de inventario', exact: true })).toBeVisible();
      const total = screen.locator('tfoot tr');
      await expect(total.locator('td').nth(0)).toHaveText('13');
      await expect(total.locator('td').nth(1)).toContainText('S/ 9.95');
      await expect(total.locator('td').nth(2)).toHaveText('S/ 29.00');
      await expect(screen.locator('.val-notices')).toContainText('1 producto(s) sin costo (3 unidades)');
      await expect(screen.locator('.val-notices')).toContainText('stock negativo');
      await expect(screen.locator('.val-notices')).toContainText('stock proyectado');
      await expect(screen.locator('.val-notices')).toContainText('sin control de inventario excluidos');
      await expect(page.locator('#naNoPermission')).toHaveCount(0);
      expect(await screen.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
      const refresh = screen.getByRole('button', { name: 'Actualizar', exact: true });
      await expect(refresh).toBeVisible();
      expect(await refresh.evaluate(el => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      expect(await screen.evaluate(el => {
        const content = el.querySelector('.val-content')!;
        const bounds = el.getBoundingClientRect();
        return content.scrollWidth <= content.clientWidth + 1 && Array.from(el.querySelectorAll('.val-card, td, th[scope="row"]')).every(cell => {
          const box = cell.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        }) && document.documentElement.scrollWidth <= window.innerWidth + 1;
      })).toBe(true);

      // Capture only the module render: general navigation persists UI state in this app.
      const unchanged = await page.evaluate(() => {
        // @ts-ignore POS runtime globals
        const before = JSON.stringify({ productos, appConfig });
        const original = Storage.prototype.setItem;
        const originalRemove = Storage.prototype.removeItem, originalClear = Storage.prototype.clear;
        let writes = 0;
        const fail = () => { writes++; };
        Storage.prototype.setItem = fail; Storage.prototype.removeItem = fail; Storage.prototype.clear = fail;
        try {
          (document.querySelector('#pageValorizacion [data-valorizacion-refresh]') as HTMLButtonElement).click();
          // @ts-ignore POS runtime globals
          return writes === 0 && before === JSON.stringify({ productos, appConfig });
        } finally {
          Storage.prototype.setItem = original; Storage.prototype.removeItem = originalRemove; Storage.prototype.clear = originalClear;
        }
      });
      expect(unchanged).toBe(true);
    });

    test(`employee cannot see valuation at ${width}px, ${dark ? 'dark' : 'light'}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await rolePage(page, 'empleado');
      await page.evaluate(dark => document.body.classList.toggle('dark', dark), dark);
      if (width === 390) {
        await page.locator('#naMobileMenuToggle').click();
        await expect(page.locator('#naMobileDrawer [data-page="pageValorizacion"]')).toHaveCount(0);
      }
      await page.evaluate(() => (window as any).goPage('pageValorizacion'));
      await expect(page.locator('#naNoPermission')).toBeVisible();
      await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
      await expect(page.locator('#pageValorizacion')).not.toHaveClass(/\bactive\b/);
      await expect(page.locator('#pageValorizacion .val-table')).toHaveCount(0);
      await page.evaluate(() => (window as any).NA_VALORIZACION.render());
      await expect(page.locator('#pageValorizacion [data-valorizacion-report]')).toHaveText('Sin permiso. Pídele acceso al dueño.');
    });
  }
}
