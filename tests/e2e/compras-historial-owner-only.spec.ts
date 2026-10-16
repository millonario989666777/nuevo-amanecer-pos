import { test, expect, type Page } from '@playwright/test';

const FULL = [
  {
    purchase_id: 'PUR-a', status: 'aplicada', created_at: '2026-10-14T02:00:00Z',
    supplier: 'Proveedor Secreto SAC', document_ref: 'F001-9', total_cost_cents: 4550,
    lines: [{ purchase_id: 'PUR-a', line_number: 1, product_id: '101', quantity: 7, unit_cost_cents: 650 }],
  },
  {
    purchase_id: 'PUR-b', status: 'en_curso', created_at: '2026-10-14T02:00:00Z',
    supplier: 'Proveedor Secreto SAC', total_cost_cents: 1300,
    lines: [{ purchase_id: 'PUR-b', line_number: 1, product_id: '101', quantity: 2, unit_cost_cents: 650 }],
  },
];

const REDACTED = FULL.map(({ supplier, total_cost_cents, lines, ...purchase }) => ({
  ...purchase,
  lines: lines.map(({ unit_cost_cents, ...line }) => line),
}));

async function setup(page: Page, role: 'owner' | 'empleado', purchases: typeof REDACTED) {
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname !== 'permissions.test') return route.abort();
    if (request.method() === 'GET' && url.pathname === '/auth/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'TEST-device',
      }) });
    }
    if (request.method() === 'GET' && url.pathname === '/auth/purchases' && !url.search) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ purchases, truncated: false }) });
    }
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test_endpoint_unavailable' }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'TEST-synthetic-token' }));
  });
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return typeof w.NA_PURCHASES?.history === 'function' && typeof w.NA_ROLES?.refresh === 'function';
  }), { timeout: 30_000 }).toBe(true);
  await page.evaluate(async () => { await (window as any).NA_ROLES.refresh(); });
  await expect.poll(() => page.evaluate(role => {
    const roles = (window as any).NA_ROLES;
    return roles.role === role && roles.confirmed;
  }, role), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => {
    (0, eval)('productos = ' + JSON.stringify([{ id: 101, name: 'Paracetamol', stock: 5 }]));
    (window as any).NuevoAmanecerCanonical = { enabled: () => true, snapshot: () => ({}), refresh: async () => {} };
  });
  await page.evaluate(() => (window as any).NA_PURCHASES.history());
  await expect(page.locator('#naPurchaseHistory .na-pur-item')).toHaveCount(2);
}

for (const width of [390, 768, 1366]) {
  test(`owner con datos completos: proveedor y costos visibles (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, 'owner', FULL);
    const history = page.locator('#naPurchaseHistory');
    await expect(history).toContainText('Proveedor Secreto SAC');
    await expect(history).toContainText(/45[.,]50/);
    await expect(history).toContainText('×');
    await expect(history.locator('.na-pur-item')).toHaveCount(2);
    await expect(history.locator('.na-pur-row')).toHaveCount(2);
  });

  for (const [label, purchases] of [['redactados', REDACTED], ['completos (defensa ante fuga del servidor)', FULL]] as const) {
    test(`empleado con datos ${label}: oculta proveedor y costos (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await setup(page, 'empleado', purchases);
      const history = page.locator('#naPurchaseHistory');
      await expect(history).not.toContainText('Proveedor');
      await expect(history).not.toContainText(/45[.,]50|13[.,]00|6[.,]50/);
      await expect(history).not.toContainText('×');
      await expect(history).not.toContainText('sin costo');
      await expect(history).not.toContainText('S/');
      await expect(history).toContainText('Compra');
      await expect(history).toContainText('F001-9');
      await expect(history).toContainText('x 7');
      await expect(history.locator('.na-pur-finish-h')).toBeVisible();
      await expect(history.locator('.na-pur-item')).toHaveCount(2);
      await expect(history.locator('.na-pur-row')).toHaveCount(2);
    });
  }
}
