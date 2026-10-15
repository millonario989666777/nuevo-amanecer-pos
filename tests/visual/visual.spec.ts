import { test, expect, Page } from '@playwright/test';

const fixedTime = new Date('2026-10-15T10:00:00-05:00');
const products = [
  { id: 91001, name: 'Agua de prueba 500 ml', cat: 'bebidas', precio: 2.5, costo: 1, stock: 20, stockMin: 2, icon: '💧' },
  { id: 91002, name: 'Arroz de prueba 1 kg', cat: 'abarrotes', precio: 5, costo: 3, stock: 15, stockMin: 2, icon: '📦' },
  { id: 91003, name: 'Jabón de prueba', cat: 'limpieza', precio: 3, costo: 1.5, stock: 12, stockMin: 2, icon: '🧴' },
];

// Mask only volatile chrome, preserving the business content under comparison.
const maskSelectors = [
  '#fechaHoy', '#menuDesktopDate', '#cajFechaLbl',
  '.na-mobile-activity-time', '#naMobileDrawerVersion',
  '#localStatus', '#saveStatus', '#naStatusBanner', '#gToast',
];

async function ready(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

async function load(page: Page, empty: boolean, colorScheme: 'light' | 'dark') {
  // Install before navigation; Date stays frozen while app timers can finish booting.
  await page.clock.install({ time: fixedTime });
  await page.clock.setFixedTime(fixedTime);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === 'http://127.0.0.1:4183' ? route.continue() : route.abort();
  });
  await page.addInitScript(({ products, empty, colorScheme }) => {
    localStorage.clear();
    localStorage.setItem('na_app_initialized_v1', 'true');
    localStorage.setItem('na_seed_catalog_suppressed', 'true');
    localStorage.setItem('na_productos', JSON.stringify(empty ? [] : products));
    for (const key of ['na_ventas', 'na_clientes', 'na_creditos', 'na_gastos', 'na_cajMovs', 'na_cart']) {
      localStorage.setItem(key, '[]');
    }
    // Caja del día abierta (fija) para que «Pagar» abra el diálogo real de cobro.
    localStorage.setItem('na_cajEstado', JSON.stringify({ abierta: true, cerrada: false, fechaApertura: '2026-10-15', fondo: 100, sessionId: 1 }));
    localStorage.setItem('na_v9_appearance', JSON.stringify({ mode: colorScheme === 'dark' ? 'noche' : 'claro', theme: 'azul' }));
    // No cloud credentials: deterministic local owner mode, no remote backend.
  }, { products, empty, colorScheme });
  await page.goto('/index.html');
  await expect(page.locator('#pageMenu')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).NA_MENU_NAVIGATION);
  if (colorScheme === 'dark') await expect(page.locator('body')).toHaveClass(/\bdark\b/);
  else await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
  await ready(page);
}

async function screenshot(page: Page, name: string) {
  await ready(page);
  await expect(page).toHaveScreenshot(name, { mask: maskSelectors.map(selector => page.locator(selector)) });
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    const combo = `${viewport.width}-${colorScheme}`;
    test.describe(combo, () => {
      test.use({ viewport, colorScheme, hasTouch: viewport.width === 390, isMobile: false });

      test('Inicio', async ({ page }) => {
        await load(page, false, colorScheme);
        await screenshot(page, `inicio-${combo}.png`);
      });

      if (viewport.width === 390) test('Inicio drawer open', async ({ page }) => {
        await load(page, false, colorScheme);
        await page.locator('#naMobileMenuToggle').click();
        await expect(page.locator('#naMobileDrawer')).toHaveAttribute('aria-hidden', 'false');
        await screenshot(page, `inicio-drawer-${combo}.png`);
      });

      for (const state of ['empty', 'cart', 'search', 'cobrar'] as const) {
        test(`Venta ${state}`, async ({ page }) => {
          await load(page, state === 'empty', colorScheme);
          await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pagePOS'));
          await expect(page.locator('#pagePOS')).toBeVisible();
          // Verify storage seeding actually reached the catalog, including zero products.
          expect(await page.evaluate(() => (window as any).eval('productos.length'))).toBe(state === 'empty' ? 0 : 3);
          if (state === 'cart' || state === 'cobrar') {
            await page.evaluate(ids => ids.forEach(id => (window as any).posAdd(id)), products.map(product => product.id));
            await expect(page.locator('.cart-item')).toHaveCount(3);
          }
          if (state === 'search' || (state === 'empty' && viewport.width === 390)) {
            if (viewport.width === 390) {
              await page.locator('#posPhoneAdd').click();
              await expect(page.locator('#posPhoneCatalog')).toBeVisible();
            }
            if (state === 'search') {
              await page.locator('#posSearch').pressSequentially('Agua');
              await expect(page.locator('#posSearch')).toHaveValue('Agua');
              await expect(page.locator('[data-product-id="91001"]')).toBeVisible();
              await expect(page.locator('[data-product-id="91002"]')).toHaveCount(0);
            }
          }
          if (state === 'cobrar') {
            // Botón real «Pagar» con la caja del día abierta (sembrada). Nunca se confirma el cobro.
            await page.locator('#btnPagar').click();
            await expect(page.locator('#mCobro')).toBeVisible();
            // Intentionally never click the confirm/pay action.
          }
          await screenshot(page, `venta-${state}-${combo}.png`);
          expect(await page.evaluate(() => (window as any).eval('ventas.length'))).toBe(0);
        });
      }
    });
  }
}
