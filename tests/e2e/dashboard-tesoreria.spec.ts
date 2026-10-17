import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ timezoneId: 'UTC' });
const PAGE = '#pageDashboardTesoreria';

async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'treasury-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'treasury-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}

async function seed(page: Page, canonical = true) {
  return page.evaluate(canonical => {
    const w = window as any, today = w.NA_DASHBOARD_TESORERIA.periodRange(7).to;
    const ago = (n: number) => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
    const cashSessions = [
      { session_id: 'dt-shift-1', opened_at: today + 'T08:00:00-05:00', closed_at: today + 'T18:00:00-05:00', status: 'CLOSED', expected_cents: 12000, counted_cents: 11000 },
      { session_id: 'dt-shift-2', opened_at: ago(1) + 'T23:00:00-05:00', closed_at: today + 'T02:00:00-05:00', status: 'CLOSED', expected_cents: 2000, counted_cents: 2500 },
      { session_id: 'dt-old', opened_at: ago(20) + 'T08:00:00-05:00', status: 'CLOSED', expected_cents: 1000, counted_cents: 1000 },
      { session_id: 'dt-missing-count', opened_at: ago(2) + 'T08:00:00-05:00', status: 'CLOSED', expected_cents: 1000, counted_cents: null },
      { session_id: 'dt-missing-moves', opened_at: ago(3) + 'T08:00:00-05:00', status: 'CLOSED', expected_cents: 3000, counted_cents: 3000 }
    ];
    const cashMovements = [
      { movement_id: 'dt-mixed', session_id: 'dt-shift-1', sale_id: 'dt-sale-1', created_at: today + 'T10:00:00-05:00', cash_cents: 300, digital_cents: 700, digital_method: 'yape', credit_cents: 500 },
      { movement_id: 'dt-plin', session_id: 'dt-shift-1', sale_id: 'dt-sale-2', cash_cents: 0, digital_cents: 200, digital_method: 'plin', credit_cents: 0 },
      { movement_id: 'dt-card', session_id: 'dt-shift-1', sale_id: 'dt-sale-3', cash_cents: 0, digital_cents: 400, digital_method: 'tarjeta', credit_cents: 0 },
      { movement_id: 'dt-transfer', session_id: 'dt-shift-1', sale_id: 'dt-sale-4', cash_cents: 0, digital_cents: 100, digital_method: 'transferencia', credit_cents: 0 },
      { movement_id: 'dt-night', session_id: 'dt-shift-2', sale_id: 'dt-sale-5', created_at: today + 'T01:00:00-05:00', cash_cents: 1000 },
      { movement_id: 'dt-old', session_id: 'dt-old', sale_id: 'dt-sale-old', cash_cents: 1000 },
      { movement_id: 'dt-missing-count', session_id: 'dt-missing-count', sale_id: 'dt-sale-no-count', cash_cents: 1000 },
      { movement_id: 'dt-collection', session_id: 'dt-shift-1', event_type: 'PAYMENT', cash_cents: 99999 }
    ];
    const snapshot = { cashSessions, cashMovements, financialEvents: [], expenses: [], pending: [{ operation_id: 'dt-pending', status: 'pending' }] };
    // Este stub representa la réplica en memoria y jamás consulta red ni storage.
    w.__dtSnapshot = snapshot;
    const original = w.NuevoAmanecerCanonical;
    w.NuevoAmanecerCanonical = Object.assign({}, original, { snapshot: () => canonical ? structuredClone(w.__dtSnapshot) : {} });
    w.eval(`cashClosures=${JSON.stringify(cashSessions.map(s => ({ id: s.session_id, sessionId: s.session_id,
      fechaApertura: s.opened_at.slice(0, 10), timestampCierre: s.closed_at, esperado: s.expected_cents / 100,
      contado: s.counted_cents === null ? null : s.counted_cents / 100 })))};
      cajMovs=${JSON.stringify(cashMovements.filter(m => !m.event_type).map(m => ({ id: m.movement_id, sessionId: m.session_id,
        ventaId: m.sale_id, tipo: 'ing', metodo: 'mixto', monto: ((m.cash_cents || 0) + (m.digital_cents || 0) + (m.credit_cents || 0)) / 100,
        detallePago: { efectivo: (m.cash_cents || 0) / 100, digital: (m.digital_cents || 0) / 100, digitalMethod: m.digital_method, credito: (m.credit_cents || 0) / 100 } })))};
      ventas=[{id:'dt-pending-sale',pending:true}];
      creditos=[{id:'dt-credit',pagos:[{id:'dt-pending-payment',pending:true,monto:2}]}];`);
    return { today, yesterday: ago(1), noCount: ago(2), noMoves: ago(3), old: ago(20) };
  }, canonical);
}

async function readState(page: Page) {
  return page.evaluate(() => ({
    state: (window as any).eval('JSON.stringify({productos,ventas,clientes,creditos,cajEstado,cajMovs,cashClosures})'),
    snapshot: JSON.stringify((window as any).__dtSnapshot),
    storage: Object.fromEntries(Object.keys(localStorage).filter(key => key !== 'na_local_config_v1').sort().map(key => [key, localStorage.getItem(key)]))
  }));
}

async function assertLayout(page: Page, width: number) {
  const screen = page.locator(PAGE);
  expect(await screen.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await screen.evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,select,button,tbody th,tbody td')].every(child => {
      const r = child.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
  // 650px debe seguir siendo tabla y mostrar cada columna, incluidas la cuarta y quinta.
  const table = screen.locator('table');
  await expect(table).toHaveCSS('display', width < 600 ? 'block' : 'table');
  if (width >= 600) {
    await expect(table.locator('thead th')).toHaveCount(11);
    for (const cell of await table.locator('th,td').all()) {
      await expect(cell).toBeVisible();
      expect(await cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
      await expect(cell).toHaveCSS('display', 'table-cell');
    }
  }
  for (const cell of await table.locator(width < 600 ? 'tbody .cf-num' : '.cf-num').all()) await expect(cell).toHaveCSS('text-align', 'right');
  const select = screen.locator('[data-dt-period]');
  expect(await select.evaluate(node => {
    const clone = node.cloneNode(true) as HTMLSelectElement;
    clone.style.width = 'max-content'; clone.style.position = 'absolute'; clone.style.visibility = 'hidden';
    node.parentElement!.appendChild(clone);
    const fits = node.getBoundingClientRect().width + .5 >= clone.getBoundingClientRect().width;
    clone.remove(); return fits;
  })).toBe(true);
}

for (const width of [390, 650, 768, 1366]) for (const dark of [false, true]) {
  test(`owner treasury at ${width}px ${dark ? 'dark' : 'light'} shows daily methods, exports active range and never writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    const dates = await seed(page);
    const before = await readState(page), requests: string[] = [];
    page.on('request', r => {
      if (!['GET', 'HEAD'].includes(r.method()) || /^\/commands\/(?:cash|treasury|expense)\./.test(new URL(r.url()).pathname))
        requests.push(r.method() + ' ' + r.url());
    });
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageDashboardTesoreria'); }, dark);
    const screen = page.locator(PAGE);
    await expect(screen).toBeVisible();
    await expect(screen.locator('[data-dt-period]')).toHaveValue('7');
    await expect(screen.locator('tbody tr')).toHaveCount(7);
    const today = screen.locator(`[data-dt-day="${dates.today}"]`);
    for (const [label, amount] of [['Efectivo', '3.00'], ['Yape', '7.00'], ['Plin', '2.00'], ['Tarjeta', '4.00'], ['Transferencia', '1.00'], ['Crédito', '5.00'], ['Otros', '0.00'], ['Esperado', '120.00'], ['Contado', '110.00']])
      await expect(today.locator(`[data-label="${label}"]`)).toHaveText('S/\u00a0' + amount);
    const negative = today.locator('[data-label="Diferencia"]');
    await expect(negative).toHaveText('-S/\u00a010.00 (faltante)');
    await expect(negative).toHaveCSS('color', dark ? 'rgb(252, 165, 165)' : 'rgb(153, 27, 27)');
    // Contraste WCAG AA del faltante sobre el fondo de la tabla.
    expect(await negative.evaluate(node => {
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => { const c = n / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      const fg = luminance(getComputedStyle(node).color), bg = luminance(getComputedStyle(node.closest('.dt-results')!).backgroundColor);
      return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
    })).toBeGreaterThanOrEqual(4.5);
    await expect(screen.locator(`[data-dt-day="${dates.yesterday}"] [data-label="Efectivo"]`)).toHaveText('S/\u00a010.00');
    await expect(screen.locator(`[data-dt-day="${dates.yesterday}"] [data-label="Diferencia"]`)).toHaveText('+S/\u00a05.00 (sobrante)');
    for (const label of ['Contado', 'Diferencia']) await expect(screen.locator(`[data-dt-day="${dates.noCount}"] [data-label="${label}"]`)).toHaveText('—');
    await expect(screen.locator(`[data-dt-day="${dates.noMoves}"] [data-label="Efectivo"]`)).toHaveText('—');
    await expect(screen.locator('img,script')).toHaveCount(0);
    await assertLayout(page, width);
    await screen.locator('[data-dt-period]').selectOption('30');
    await expect(screen.locator('tbody tr')).toHaveCount(30);
    await expect(screen.locator(`[data-dt-day="${dates.old}"] [data-label="Efectivo"]`)).toHaveText('S/\u00a010.00');
    const exportButton = screen.getByRole('button', { name: 'Exportar CSV', exact: true });
    await exportButton.scrollIntoViewIfNeeded();
    expect(await exportButton.evaluate(button => {
      const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    })).toBe(true);
    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('tesoreria-' + (await page.evaluate(() => (window as any).NA_DASHBOARD_TESORERIA.periodRange(30).from)) + '-a-' + dates.today + '.csv');
    const csv = await readFile((await download.path())!, 'utf8');
    expect(csv).toMatch(/^\uFEFFFiltro activo,Últimos 30 días,/);
    expect(csv).toContain(',120.00,110.00,-10.00\r\n');
    await screen.getByRole('button', { name: 'Actualizar reporte' }).click();
    await assertLayout(page, width);
    expect(await readState(page)).toEqual(before);
    expect(requests).toEqual([]);
  });
}

test('local closure/movement data renders with the same amounts and remains unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await rolePage(page, 'owner'); const dates = await seed(page, false);
  const before = await readState(page);
  await page.evaluate(() => (window as any).goPage('pageDashboardTesoreria'));
  await expect(page.locator(`${PAGE} [data-dt-day="${dates.today}"] [data-label="Tarjeta"]`)).toHaveText('S/\u00a04.00');
  await expect(page.locator(`${PAGE} [data-dt-day="${dates.today}"] [data-label="Diferencia"]`)).toHaveText('-S/\u00a010.00 (faltante)');
  expect(await readState(page)).toEqual(before);
});

test('registry remains pending/locked, searching stays scoped, click opens disabled preview and no side-menu item is added', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await rolePage(page, 'owner'); await seed(page);
  const before = await readState(page);
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  const search = page.locator('#pageProximamente .na-prox-search');
  await search.fill('tesoreria');
  const card = page.locator('#pageProximamente [data-feature-id="dashboard-tesoreria"]');
  await expect(card).toHaveClass('na-prox-card');
  await expect(card).toContainText('🔒 Próximamente');
  expect(await page.evaluate(() => {
    const w = window as any, f = w.NA_PROXIMAMENTE.get('dashboard-tesoreria');
    return { page: f.page, pending: f.pending, locked: w.NA_PERMISSIONS.featureLocked(f.id), enabled: w.NA_PROXIMAMENTE.isUnlocked(f) };
  })).toEqual({ page: 'pageDashboardTesoreria', pending: true, locked: true, enabled: false });
  await card.click();
  await expect(page.locator('#naProxPreview')).toBeVisible();
  await expect(page.locator('#naProxPreview').getByRole('button', { name: 'Guardar', exact: true })).toBeDisabled();
  await expect(page.locator(PAGE)).not.toHaveClass(/\bactive\b/);
  await page.locator('#naProxPreview').getByRole('button', { name: 'Cerrar', exact: true }).click();
  await search.fill('kardex');
  await expect(page.locator('#pageProximamente [data-feature-id="kardex"]')).toBeVisible();
  for (const text of await page.locator('#pageProximamente .na-prox-card:visible').allTextContents()) expect(text).toMatch(/kardex/i);
  await search.fill('');
  await page.evaluate(() => (window as any).goMenu());
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageDashboardTesoreria"]')).toHaveCount(0);
  await expect(page.locator('.menu-desktop-sidebar [data-menu-target="pageDashboardTesoreria"]')).toHaveCount(0);
  expect(await readState(page)).toEqual(before);
});

test('employee cannot navigate, render or export treasury even with cash data already in memory', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await rolePage(page, 'empleado'); await seed(page);
  const before = await readState(page);
  const downloads: string[] = []; page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.evaluate(() => (window as any).goPage('pageDashboardTesoreria'));
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator(PAGE)).not.toHaveClass(/\bactive\b/);
  expect(await page.evaluate(() => {
    const a = (window as any).NA_DASHBOARD_TESORERIA;
    return { render: a.render(), exported: a.exportCsv() };
  })).toEqual({ render: false, exported: false });
  await expect(page.locator(`${PAGE} [data-dt-content]`)).toBeEmpty();
  await expect(page.locator(`${PAGE} [data-dt-controls]`)).toBeHidden();
  await expect(page.locator(`${PAGE} [data-dt-export]`)).toBeDisabled();
  expect(downloads).toEqual([]); expect(await readState(page)).toEqual(before);
});

test('role revocation clears previously rendered amounts and blocks export', async ({ page }) => {
  await rolePage(page, 'owner'); await seed(page);
  await page.evaluate(() => (window as any).goPage('pageDashboardTesoreria'));
  await expect(page.locator(`${PAGE} tbody tr`)).toHaveCount(7);
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
    { pos_role: 'empleado', owner_pin_set: true, roles_ready: true, device_id: 'treasury-test-device' }) }));
  await page.evaluate(() => (window as any).NA_ROLES.refresh());
  await page.waitForFunction(() => (window as any).NA_ROLES.role === 'empleado');
  await expect(page.locator(`${PAGE} [data-dt-content]`)).toBeEmpty();
  await expect(page.locator(`${PAGE} [data-dt-controls]`)).toBeHidden();
  expect(await page.evaluate(() => (window as any).NA_DASHBOARD_TESORERIA.exportCsv())).toBe(false);
});
