import { test, expect, type Page } from '@playwright/test';

// Página integrada, roles reales simulados y réplica sintética sin backend real.
async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'ra-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'ra-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  return page.evaluate(() => {
    const win = window as any;
    const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
    const offsetDay = (days: number) => new Date(Date.parse(today + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
    const at = (day: string, time: string) => new Date(day + 'T' + time + ':00-05:00').toISOString();
    const session = (id: string, day: string, time: string, extra: Record<string, unknown> = {}) => Object.freeze({
      session_id: id, status: 'CLOSED', opened_at: at(day, '08:00'), closed_at: at(day, time),
      expected_cents: 1250, counted_cents: 1200, difference_cents: -50,
      opened_by_name: 'Persona de prueba con nombre muy largo para comprobar que se puede leer en teléfonos pequeños',
      closed_by_name: 'Persona de cierre de prueba con nombre largo y sin datos reales', ...extra,
    });
    const snapshot = Object.freeze({ cashSessions: Object.freeze([
      session('ra-first', today, '10:00'),
      session('ra-late', today, '23:30', { opened_by_name: ' =HYPERLINK(1)', counted_cents: 1300, difference_cents: 50 }),
      session('ra-null', offsetDay(-1), '15:00', { expected_cents: 250, counted_cents: null, difference_cents: null, opened_by_name: null, closed_by_name: null }),
      session('ra-open', today, '18:00', { status: 'OPEN', opened_by_name: 'OPEN excluido', expected_cents: 999999 }),
      session('ra-old', offsetDay(-30), '18:00', { opened_by_name: 'Fuera del rango' }),
    ]) });
    win.__raRefreshCalls = 0;
    win.NuevoAmanecerCanonical = Object.assign({}, win.NuevoAmanecerCanonical, {
      snapshot: () => snapshot,
      refresh: () => { win.__raRefreshCalls++; throw new Error('El reporte no debe refrescar la réplica'); },
    });
    return { today, desde: offsetDay(-29), yesterday: offsetDay(-1) };
  });
}
async function readState(page: Page) {
  return page.evaluate(() => JSON.stringify({
    snapshot: (window as any).NuevoAmanecerCanonical.snapshot(),
    app: (window as any).eval('JSON.stringify({productos,ventas,appConfig})'),
  }));
}
async function noOverflow(page: Page) {
  const screen = page.locator('#pageReporteArqueo');
  expect(await screen.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await screen.evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,p,label,input,button,.ra-table-wrap')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 &&
        (child.classList.contains('ra-table-wrap') || child.scrollWidth <= child.clientWidth + 1);
    });
  })).toBe(true);
  expect(await screen.locator('.ra-table').evaluate(table => [...table.querySelectorAll<HTMLElement>('th,td')]
    .every(cell => cell.scrollWidth <= cell.clientWidth + 1))).toBe(true);
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner arqueo ${width}px ${dark ? 'dark' : 'light'}: local rows, totals, guarded CSV, no writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner'); const dates = await seed(page);
    const before = await readState(page);
    // goPage (menu-navigation persistVisiblePage) guarda el estado de la app en cada cambio de página
    // (na_snapshot_v9[_session] / na_local_config_v1, solo cambia updatedAt). No es del reporte: se excluyen esas claves
    // y su contenido (productos, ventas, appConfig) se compara aparte en readState.
    const storageSnapshot = () => page.evaluate(() => { const copy: Record<string, string> = { ...localStorage }; delete copy.na_local_config_v1; delete copy.na_snapshot_v9; delete copy.na_snapshot_v9_session; return JSON.stringify(copy); });
    const storageBefore = await storageSnapshot();
    await page.evaluate(() => {
      const win = window as any; win.__raStorageWrites = [];
      const setItem = Storage.prototype.setItem, removeItem = Storage.prototype.removeItem, clear = Storage.prototype.clear;
      Storage.prototype.setItem = function (key, value) { win.__raStorageWrites.push('set:' + key); return setItem.call(this, key, value); };
      Storage.prototype.removeItem = function (key) { win.__raStorageWrites.push('remove:' + key); return removeItem.call(this, key); };
      Storage.prototype.clear = function () { win.__raStorageWrites.push('clear'); return clear.call(this); };
    });
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageProximamente'); }, dark);
    const card = page.locator('[data-feature-id="reporte-arqueo"]');
    await expect(card).toHaveClass(/is-enabled/); await card.click();
    const screen = page.locator('#pageReporteArqueo'); await expect(screen).toBeVisible();
    await expect(screen.locator('[data-ra-desde]')).toHaveValue(dates.desde);
    await expect(screen.locator('[data-ra-hasta]')).toHaveValue(dates.today);
    await expect(screen.locator('tbody tr')).toHaveCount(3);
    await expect(screen.locator('tbody tr').first()).toContainText('23:30');
    await expect(screen.locator('tbody tr').first()).toContainText(' =HYPERLINK(1)');
    await expect(screen.locator('tbody tr').first()).toContainText('+S/ 0.50 (sobrante)');
    await expect(screen.locator('tbody tr').nth(1)).toContainText('-S/ 0.50 (faltante)');
    await expect(screen.locator('tbody tr').last()).toContainText('No registrado');
    await expect(screen.locator('tbody tr').last().locator('td').nth(3)).toHaveText('—');
    await expect(screen.locator('tbody')).not.toContainText('OPEN excluido');
    await expect(screen.locator('tbody')).not.toContainText('Fuera del rango');
    await expect(screen.locator('tfoot th')).toHaveText('Total · 3 cierres · 1 sin contar');
    await expect(screen.locator('tfoot td')).toHaveText(['S/ 25.00', 'S/ 25.00', 'S/ 0.00']);
    await noOverflow(page);
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await expect(screen.locator('.ra-table-wrap')).toHaveCSS('background-color', dark ? 'rgb(30, 41, 59)' : 'rgb(255, 255, 255)');
    await expect(screen.locator('tbody td').first()).toHaveCSS('color', dark ? 'rgb(248, 250, 252)' : 'rgb(15, 23, 42)');
    await expect(screen.locator('tfoot')).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    const exportButton = screen.locator('[data-ra-export]');
    expect(await exportButton.evaluate(button => {
      const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!hit && (button === hit || button.contains(hit));
    })).toBe(true);
    // Fechas inclusivas: ambos cierres de hoy, incluso el de 23:30 cuyo UTC es mañana.
    await screen.locator('[data-ra-desde]').fill(dates.today);
    await expect(screen.locator('tbody tr')).toHaveCount(2);
    await expect(screen.locator('tfoot th')).toHaveText('Total · 2 cierres');
    await expect(screen.locator('tfoot td')).toHaveText(['S/ 25.00', 'S/ 25.00', 'S/ 0.00']);
    await screen.locator('[data-ra-hasta]').fill(dates.yesterday);
    await expect(screen.locator('[data-ra-status]')).toContainText('Desde no puede ser posterior a Hasta');
    await expect(screen.locator('[data-ra-content]')).toBeEmpty(); await expect(exportButton).toBeDisabled();
    await screen.locator('[data-ra-hasta]').fill(dates.today);
    await screen.locator('[data-ra-desde]').fill(dates.desde);
    await expect(screen.locator('tbody tr')).toHaveCount(3);
    const downloadPromise = page.waitForEvent('download'); await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`arqueo-caja-${dates.desde}-a-${dates.today}.csv`);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString('utf8');
    expect(csv.startsWith('\uFEFFFecha cierre,Hora cierre,Abrió,Cerró,Esperado,Contado,Diferencia\r\n')).toBe(true);
    expect(csv).toContain(",23:30,' =HYPERLINK(1),");
    expect(csv).toContain(',12.50,12.00,-0.50\r\n');
    expect(csv.endsWith('Total,3,1 sin contar,,25.00,25.00,0.00\r\n')).toBe(true);
    await noOverflow(page);
    expect(await readState(page)).toBe(before);
    expect(await storageSnapshot()).toBe(storageBefore);
    expect(await page.evaluate(() => (window as any).__raStorageWrites.filter((w: string) => !/^set:(na_snapshot_v9(_session)?|na_local_config_v1)$/.test(w)))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__raRefreshCalls)).toBe(0);
    expect(writes).toEqual([]);
  });
}

test('employee cannot open arqueo; direct rendering exposes nothing and never reads the replica', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado'); await seed(page);
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageReporteArqueo"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageReporteArqueo'); });
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('#pageReporteArqueo')).not.toHaveClass(/\bactive\b/);
  await page.evaluate(() => {
    const win = window as any; win.__raDeniedReads = 0;
    win.NuevoAmanecerCanonical.snapshot = () => { win.__raDeniedReads++; throw new Error('Lectura sin permiso'); };
    win.NA_REPORTE_ARQUEO.render();
  });
  await expect(page.locator('#pageReporteArqueo [data-ra-content]')).toBeEmpty();
  await expect(page.locator('#pageReporteArqueo [data-ra-status]')).toContainText('Sin permiso');
  await expect(page.locator('#pageReporteArqueo [data-ra-controls]')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__raDeniedReads)).toBe(0);
});

test('owner online reads cash closes from the owner-only server route instead of the local replica', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'owner'); const dates = await seed(page);
  const requests: string[] = [];
  await page.route('https://permissions.test/auth/cash-closes**', route => {
    requests.push(route.request().url());
    const at = new Date(dates.today + 'T12:00:00-05:00').toISOString();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ range: {}, cash_closes: [
      { session_id: 'srv-1', status: 'CLOSED', opened_at: at, closed_at: at, expected_cents: 5000, counted_cents: 5100, difference_cents: 100,
        opened_by_name: 'Servidor abrió', closed_by_name: 'Servidor cerró' }] }) });
  });
  await page.evaluate(() => (window as any).goPage('pageReporteArqueo'));
  const screen = page.locator('#pageReporteArqueo');
  await expect(screen.locator('[data-ra-status]')).toContainText('desde el servidor');
  await expect(screen.locator('tbody tr')).toHaveCount(1);
  await expect(screen.locator('tbody')).toContainText('Servidor abrió');
  await expect(screen.locator('tbody')).not.toContainText('Persona de prueba');
  expect(requests.length).toBeGreaterThan(0);
  expect(new URL(requests.at(-1)!).searchParams.get('hasta')).toBe(dates.today);
});

test('server 403 for the cash-close report shows no data even if the client role is stale', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'owner'); await seed(page);
  await page.route('https://permissions.test/auth/cash-closes**', route =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden_role' }) }));
  await page.evaluate(() => (window as any).goPage('pageReporteArqueo'));
  const screen = page.locator('#pageReporteArqueo');
  await expect(screen.locator('[data-ra-status]')).toContainText('Sin permiso');
  await expect(screen.locator('[data-ra-content]')).toBeEmpty();
  await expect(screen.locator('[data-ra-export]')).toBeDisabled();
});

test('server truncated:true shows a visible notice that the totals are incomplete', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'owner'); const dates = await seed(page);
  await page.route('https://permissions.test/auth/cash-closes**', route => {
    const at = new Date(dates.today + 'T12:00:00-05:00').toISOString();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ range: {}, truncated: true, cash_closes: [
      { session_id: 'srv-1', status: 'CLOSED', opened_at: at, closed_at: at, expected_cents: 5000, counted_cents: 5100, difference_cents: 100,
        opened_by_name: 'Servidor abrió', closed_by_name: 'Servidor cerró' }] }) });
  });
  await page.evaluate(() => (window as any).goPage('pageReporteArqueo'));
  const screen = page.locator('#pageReporteArqueo');
  await expect(screen.locator('[data-ra-status]')).toContainText('desde el servidor');
  const notice = screen.locator('[data-ra-truncated]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(notice).toContainText('totales están incompletos');
  await expect(screen.locator('tbody tr')).toHaveCount(1);
});
