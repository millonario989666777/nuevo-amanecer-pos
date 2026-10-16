import { test, expect, type Page } from '@playwright/test';

test.use({ hasTouch: true });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

// This fixture unlocks only the browser under test. The integrator owns the
// real FEATURE_LOCKS/registry change. All names, IDs and payments are synthetic.
async function openClients(page: Page, dark = false, locked = false) {
  await page.goto('/index.html');
  await page.waitForFunction(() => !!(window as any).NA_CLIENT_CREDIT_ACCOUNTS_V2 && !!window.NA_MENU_NAVIGATION);
  await page.evaluate(({ dark, locked }) => {
    const w = window as any;
    const original = w.NA_PERMISSIONS;
    w.NA_PERMISSIONS = { ...original, featureLocked: (id: string) =>
      id === 'clientes-filtro-deuda' ? locked : original.featureLocked(id) };
    document.body.classList.toggle('dark', dark);
    clientes = [
      { id: 'test-debt', nombre: 'Prueba deuda', dni: '', telefono: '', creditos: [] },
      { id: 'test-clear', nombre: 'Prueba cero', dni: '', telefono: '', creditos: [] },
      { id: 'test-offline', nombre: 'Prueba offline', dni: '', telefono: '', creditos: [] }
    ];
    creditos = [
      { id: 'TEST-CR-DEBT', credit_id: 'TEST-CR-DEBT', cliId: 'test-debt', clienteId: 'test-debt',
        monto: 20, pagado: 0, saldo: 20, status: 'vigente', vence: '2099-12-31', pagos: [], items: [] },
      { id: 'TEST-CR-OFFLINE', credit_id: 'TEST-CR-OFFLINE', cliId: 'test-offline', clienteId: 'test-offline',
        monto: 10, pagado: 0, saldo: 10, status: 'vigente', vence: '2099-12-31', pagos: [], items: [] }
    ];
    w.__debtTestPending = { state: 'PENDING', command: 'payment.create', payload: {
      operation_id: 'TEST-OFFLINE-PAYMENT', credit_id: 'TEST-CR-OFFLINE', amount_cents: 1000
    } };
    const canonical = w.NuevoAmanecerCanonical;
    w.NuevoAmanecerCanonical = { ...canonical, pendingSnapshot: () => w.__debtTestPending };
    window.NA_MENU_NAVIGATION.navigate('pageClientes');
    w.cliRender();
  }, { dark, locked });
  await expect(page.locator('#pageClientes')).toHaveClass(/active/);
  await expect(page.locator('#cliList .client-card')).toHaveCount(3);
}

async function dataSnapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    return JSON.stringify({ clientes, creditos, pending: w.__debtTestPending,
      journal: localStorage.getItem('na_canonical_sale_journal'),
      protectedLayouts: ['pagePOS', 'pageMenu'].map(id => document.getElementById(id)!.innerHTML) });
  });
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`Clientes: segmentos accesibles y sin escrituras en ${width}px, tema ${dark ? 'oscuro' : 'claro'}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openClients(page, dark);
    const group = page.getByRole('group', { name: 'Filtrar clientes por deuda' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('button', { name: 'Todos', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const label of ['Con deuda', 'Sin deuda', 'Todos']) {
      const button = group.getByRole('button', { name: label, exact: true });
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await button.evaluate(element => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (hit === element || element.contains(hit));
      })).toBe(true);
    }
    const before = await dataSnapshot(page);
    await group.getByRole('button', { name: 'Con deuda', exact: true }).click();
    await expect(page.locator('#cliList .client-card')).toHaveCount(1);
    await expect(page.locator('#cliList [data-client-id="test-debt"]')).toBeVisible();
    await expect(page.locator('#cliList [data-client-id="test-offline"]')).toHaveCount(0);
    await expect(group.getByRole('button', { name: 'Con deuda', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Native buttons support keyboard activation as well as touch.
    await group.getByRole('button', { name: 'Sin deuda', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#cliList .client-card')).toHaveCount(2);
    await expect(page.locator('#cliList [data-client-id="test-offline"] .c-deuda')).toHaveText(/0[.,]00/);
    await group.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(page.locator('#cliList .client-card')).toHaveCount(3);
    expect(await dataSnapshot(page)).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('el filtro conserva la búsqueda y el orden; el lote pendiente afecta solo a su cliente', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openClients(page);
  const group = page.getByRole('group', { name: 'Filtrar clientes por deuda' });
  await group.getByRole('button', { name: 'Sin deuda', exact: true }).click();
  await page.locator('#cliSearch').fill('offline');
  await expect(page.locator('#cliList .client-card')).toHaveCount(1);
  await expect(page.locator('#cliList [data-client-id="test-offline"]')).toBeVisible();
  await group.getByRole('button', { name: 'Con deuda', exact: true }).click();
  await expect(page.locator('#cliList .empty-state')).toBeVisible();
  await page.locator('#cliSearch').fill('');
  await page.locator('#cliSort').selectOption('nombre');
  await page.evaluate(() => {
    const w = window as any;
    w.__debtTestPending = { state: 'PENDING', command: 'payment.batch', payload: { payments: [
      { operation_id: 'TEST-BATCH-PARTIAL', credit_id: 'TEST-CR-DEBT', amount_cents: 500 },
      { operation_id: 'TEST-BATCH-FULL', credit_id: 'TEST-CR-OFFLINE', amount_cents: 1000 }
    ] } };
    // Signal a new snapshot without sending any financial command.
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.locator('#cliList [data-client-id="test-debt"] .c-deuda')).toHaveText(/15[.,]00/);
  await expect(page.locator('#cliList .client-card')).toHaveCount(1);
  await group.getByRole('button', { name: 'Todos', exact: true }).click();
  expect(await page.locator('#cliList .c-name').allTextContents()).toEqual(['PRUEBA CERO', 'PRUEBA DEUDA', 'PRUEBA OFFLINE']);
});

test('el saldo se actualiza al entrar offline y al reconciliar; rechazos conservan la deuda', async ({ page }) => {
  await openClients(page);
  const group = page.getByRole('group', { name: 'Filtrar clientes por deuda' });
  await group.getByRole('button', { name: 'Con deuda', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.__debtTestPending.last_error = 'stale_credit';
    w.__debtTestPending.last_status = 409;
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.locator('#cliList .client-card')).toHaveCount(2);
  await page.evaluate(() => {
    const w = window as any;
    delete w.__debtTestPending.last_error;
    delete w.__debtTestPending.last_status;
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.locator('#cliList .client-card')).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    // The existing receipt mechanism supplies the reconciled balance.
    w.__debtTestPending = null;
    window.dispatchEvent(new CustomEvent('na:canonical-payment-receipt', { detail: {
      version: 1, command: 'payment.create', payload: {
        operation_id: 'TEST-OFFLINE-PAYMENT', credit_id: 'TEST-CR-OFFLINE', amount_cents: 1000
      }, receipt: { operation_id: 'TEST-OFFLINE-PAYMENT', credit_id: 'TEST-CR-OFFLINE',
        current_balance_cents: 0, status: 'created' }
    } }));
  });
  await expect(page.locator('#cliList .client-card')).toHaveCount(1);
  await group.getByRole('button', { name: 'Sin deuda', exact: true }).click();
  await expect(page.locator('#cliList [data-client-id="test-offline"]')).toBeVisible();
});

test('FEATURE_LOCKS bloqueado oculta el filtro y mantiene la lista completa', async ({ page }) => {
  await openClients(page, false, true);
  await expect(page.getByRole('group', { name: 'Filtrar clientes por deuda' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).NA_CLIENT_CREDIT_ACCOUNTS_V2.debtFilter.select('con-deuda'))).toBe(false);
  await expect(page.locator('#cliList .client-card')).toHaveCount(3);
});
