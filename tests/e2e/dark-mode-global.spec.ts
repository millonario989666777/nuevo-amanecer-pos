import { test, expect } from '@playwright/test';

test.use({ colorScheme: 'dark', viewport: { width: 390, height: 844 } });

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/index.html');
  await expect(page.locator('#pageMenu')).toBeVisible();
  await page.waitForFunction(() => typeof (window as any).toggleDark === 'function' && !!(window as any).NA_MENU_NAVIGATION);
}

test('fresh storage stays light through inventory rows and the product form', async ({ page }) => {
  await ready(page);
  await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
  await expect(page.locator('#pageInventario')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
  await expect(page.locator('#invBody .prod-name-sm').first()).toBeVisible();
  await expect(page.locator('#invBody .btn-edt').first()).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
  await page.evaluate(() => (window as any).abrirModalProd());
  await expect(page.locator('#mProd')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
  await page.evaluate(() => (window as any).NA_CONFIG_V9_BOOT.applyAppearance());
  await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
});

test('explicit toggle persists night mode after reload', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).toggleDark());
  await expect(page.locator('body')).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator('#pageMenu')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bdark\b/);
  expect(await page.evaluate(() => (window as any).NA_THEME.mode())).toBe('noche');
});

test('explicit auto follows the dark system scheme and later changes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('na_v9_appearance', JSON.stringify({ mode: 'auto', theme: 'azul' })));
  await ready(page);
  await expect(page.locator('body')).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).not.toHaveClass(/\bdark\b/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('na_v9_appearance')!).theme)).toBe('azul');
});
