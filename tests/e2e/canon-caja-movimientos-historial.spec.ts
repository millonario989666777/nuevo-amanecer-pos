import { test, expect } from '@playwright/test';
for (const width of [390, 768, 1366]) test(`Caja movements and opening-date history at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/index.html');
  await page.waitForFunction(() => !!(window as any).NuevoAmanecerCajaViews && !!(window as any).NA_MENU_NAVIGATION);
  await page.evaluate(() => {
    (window as any).NuevoAmanecerCanonical = { enabled: () => false };
    // The legacy app stores these in global lexical bindings.
    (0, eval)(`cajMovs = [
      {id:'old', tipo:'ing',ventaId:'1',monto:20,metodo:'efectivo',desc:'Venta antigua',timestamp:'2026-10-14T13:00:00Z',sessionId:'A'},
      {id:'credit',tipo:'ing',ventaId:'2',monto:50,metodo:'credito',desc:'Venta crédito',timestamp:'2026-10-14T15:00:00Z',sessionId:'A'},
      {id:'new',tipo:'gas',monto:5,metodo:'efectivo',desc:'Gasto reciente',timestamp:'2026-10-14T16:00:00Z',sessionId:'A'}];
      cashClosures = [
      {id:'A',sessionId:'A',fechaApertura:'2026-10-13',hora24:'20:00',fechaCierre:'2026-10-14',horaCierre24:'00:40',cajeroNombre:'Ana',diferencia:0},
      {id:'B',sessionId:'B',fechaApertura:'2026-10-14',hora24:'08:00',fechaCierre:'2026-10-14',horaCierre24:'12:00',cajeroNombre:'Bea',diferencia:-2}];`);
    (window as any).NA_MENU_NAVIGATION.navigate('pageCaja');
  });
  await page.locator('#pageCaja .tab').filter({ hasText: 'Movimientos' }).click();
  await expect(page.locator('.cv-move')).toHaveCount(3);
  expect(await page.locator('.cv-move').evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.moveId))).toEqual(['new', 'credit', 'old']);
  expect(await page.locator('.cv-moves').evaluate(n => getComputedStyle(n).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.locator('.cv-view').evaluate(n => n.getBoundingClientRect().width)).toBeLessThanOrEqual(760);
  await page.locator('[data-filter="credito"]').click();
  await expect(page.locator('.cv-move')).toHaveCount(1);
  await expect(page.locator('.cv-move')).toContainText('no entra a caja');
  await expect(page.locator('[data-filter="credito"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-na-cash-history-tab]').click();
  await expect(page.locator('.cv-view')).toContainText('Datos locales de este dispositivo');
  await expect(page.locator('.cv-view')).toContainText('Cada turno cuenta en la fecha en que se abrió.');
  await expect(page.getByRole('button', { name: '7 días', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Rango', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Rango', exact: true }).click();
  await page.locator('[data-range="desde"]').fill('2026-10-13');
  await page.locator('[data-range="hasta"]').fill('2026-10-13');
  await expect(page.locator('.na-cash-hist-card')).toHaveCount(1);
  await expect(page.locator('.na-cash-hist-card')).toContainText('Ana');
  expect(await page.locator('.cv-sales-chart rect').evaluateAll(nodes => Math.max(...nodes.map(n => Number(n.getAttribute('height')))))).toBeGreaterThan(0);
  await expect(page.locator('.cv-sales-chart')).toContainText('S/ 70.00');
  await expect(page.locator('.cv-sales-chart')).toContainText('13/10');
  await page.locator('.cv-close-toggle').click();
  await expect(page.locator('.cv-close-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.cv-close-detail')).toContainText('Quedó a crédito');
  await page.evaluate(() => document.body.classList.add('dark'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
