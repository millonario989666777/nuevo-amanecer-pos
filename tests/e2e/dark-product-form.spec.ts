import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, colorScheme: 'dark' });

    test('dark product form keeps natural card heights and accessible stock fields', async ({ page }) => {
      await page.goto('/index.html');
      await expect(page.locator('#pageMenu')).toBeVisible();
      await page.waitForFunction(() => typeof (window as any).toggleDark === 'function' && !!(window as any).NA_MENU_NAVIGATION);
      await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
      await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
      const firstCard = page.locator('#mProd .inv-form-section').first();
      await page.locator('#invBody .btn-edt').first().click();
      await expect(page.locator('#mProd')).toBeVisible();
      const lightHeight = (await firstCard.boundingBox())!.height;
      await page.evaluate(() => (window as any).toggleDark());
      await expect(page.locator('body')).toHaveClass(/\bdark\b/);
      await page.waitForTimeout(100);
      const darkHeight = (await firstCard.boundingBox())!.height;
      // 'Datos básicos' card must keep the same natural height as in light mode.
      expect(Math.abs(darkHeight - lightHeight)).toBeLessThanOrEqual(2);
      await page.locator('#mProd details.inv-form-section').evaluateAll(details => {
        details.forEach(detail => (detail as HTMLDetailsElement).open = true);
      });

      const sections = page.locator('#mProd .inv-form-section');
      expect(await sections.count()).toBeGreaterThan(0);
      const geometry = await sections.evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      }));
      for (const [index, section] of geometry.entries()) {
        expect(section.scrollHeight).toBeLessThanOrEqual(section.clientHeight + 2);
        expect(section.height).toBeGreaterThan(60);
        if (index > 0) expect(section.top).toBeGreaterThanOrEqual(geometry[index - 1].bottom);
      }

      for (const id of ['pStock', 'pStockMin']) {
        const input = page.locator(`#mProd #${id}`);
        await input.scrollIntoViewIfNeeded();
        await expect(input).toBeVisible();
        await expect(input).toBeInViewport();
        expect(await input.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit === element || element.contains(hit);
        })).toBe(true);
      }
      await expect(page.locator('#mProd .mbtns')).toBeInViewport();
    });
  });
}
