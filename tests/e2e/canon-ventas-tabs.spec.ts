import { test, expect } from '@playwright/test';

// Ventas sub-tabs (Hoy / Semana / Historial / Top prods. / Reportes) measure
// ~471px. On phones the strip used to scroll sideways, so after choosing
// Reportes "📅 Hoy" sat off-screen at negative x with no visual hint.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

for (const width of [320, 360, 390, 400, 430]) {
  test(`ventas sub-tabs stay fully on screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/index.html');
    await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageVentas'));
    const strip = page.locator('#pageVentas .tabs-wrap');
    const tabs = strip.locator('.tab');
    await expect(tabs).toHaveCount(5);
    for (const label of ['Reportes', 'Top prods.', 'Hoy']) {
      await tabs.filter({ hasText: label }).click();
      const boxes = await tabs.evaluateAll(nodes => nodes.map(n => {
        const r = n.getBoundingClientRect();
        return { text: (n.textContent || '').trim(), left: r.left, right: r.right, width: r.width };
      }));
      for (const box of boxes) {
        expect(box.width, box.text).toBeGreaterThan(0);
        expect(box.left, box.text).toBeGreaterThanOrEqual(0);
        expect(box.right, box.text).toBeLessThanOrEqual(width + 0.5);
      }
      expect(await strip.evaluate(el => el.scrollLeft)).toBe(0);
    }
    await expect(page.locator('#ventasContent')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('desktop keeps the single-row ventas sub-tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/index.html');
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageVentas'));
  const tops = await page.locator('#pageVentas .tabs-wrap .tab').evaluateAll(nodes => nodes.map(n => Math.round(n.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  expect(await page.locator('#pageVentas .tabs-wrap').evaluate(el => getComputedStyle(el).flexWrap)).toBe('nowrap');
});
