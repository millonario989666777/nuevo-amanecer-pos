import { test, expect, type Page } from '@playwright/test';

// fix/pulido-159: Compras 44 px en celular, contraste oscuro (Vencidos, ✕ Permisos),
// Compras/«+ Nuevo» naranjas en Nocturno a 390 px y aviso de desplazamiento del arqueo por desborde real.

async function boot(page: Page, width: number) {
  await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_THEME && (window as any).NA_PURCHASES && (window as any).NA_MENU_NAVIGATION);
  await page.waitForFunction(() => (window as any).eval('typeof _naFreeSaleShortcutState !== "undefined" && _naFreeSaleShortcutState.ready'));
}
async function nocturnoDesdeConfig(page: Page) {
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageConfig'));
  await page.locator('#na9Nav [data-top="sis"]').click();
  const noche = page.locator('[data-act="mode"][data-t="noche"]');
  if (!(await noche.isVisible())) await page.locator('#naCfgV9 button', { hasText: 'Apariencia' }).first().click();
  await noche.click();
  await expect(page.locator('body')).toHaveClass(/\bdark\b/);
}
async function ratio(page: Page, selector: string) {
  return page.evaluate(selector => {
    const el = document.querySelector(selector) as HTMLElement;
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let p: HTMLElement | null = el, bg = '';
    while (p && ((bg = getComputedStyle(p).backgroundColor) === 'rgba(0, 0, 0, 0)' || parse(bg)[3] === 0)) p = p.parentElement;
    const a = lum(parse(getComputedStyle(el).color)), b = lum(parse(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selector);
}

for (const dark of [false, true]) test(`390px: Historial y Cancelar de Compras miden ≥44 px (${dark ? 'oscuro' : 'claro'})`, async ({ page }) => {
  await boot(page, 390);
  if (dark) await nocturnoDesdeConfig(page);
  await page.evaluate(() => (window as any).NA_PURCHASES.open());
  for (const sel of ['.na-pur-box .na-pur-hist', '.na-pur-box .na-pur-cancel']) {
    const box = await page.locator(sel).boundingBox();
    expect(box!.height, sel).toBeGreaterThanOrEqual(44);
  }
});

test('390px Nocturno desde Configuración: Compras y «+ Nuevo» siguen naranjas', async ({ page }) => {
  await boot(page, 390);
  await nocturnoDesdeConfig(page);
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
  for (const sel of ['#pageInventario .top-btn-nuevo.na-pur-btn', '#pageInventario .top-btn-nuevo[onclick^="abrirModalProd"]']) {
    await expect(page.locator(sel)).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  }
});

test('oscuro: KPI «Vencidos» de Clientes y ✕ de Permisos con contraste ≥4.5:1', async ({ page }) => {
  await boot(page, 390);
  await nocturnoDesdeConfig(page);
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageClientes'));
  expect(await ratio(page, '#cliS2')).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => document.getElementById('mMasterPermissions')!.classList.add('open'));
  expect(await ratio(page, '#mMasterPermissions .btn-close-m')).toBeGreaterThanOrEqual(4.5);
});

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
    return { today };
  });
}

for (const width of [390, 768, 1280]) test(`arqueo ${width}px: «Desliza» se muestra solo si la tabla desborda`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await rolePage(page, 'owner');
  await seed(page);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer?.(); (window as any).goPage('pageReporteArqueo'); });
  const wrap = page.locator('#pageReporteArqueo .ra-table-wrap');
  await expect(wrap).toBeVisible();
  const hint = page.locator('#pageReporteArqueo .ra-scroll-hint');
  await expect(hint).toHaveText('Desliza para ver más →');
  await expect.poll(async () => {
    const overflow = await wrap.evaluate(n => n.scrollWidth > n.clientWidth + 1);
    return (await hint.isVisible()) === overflow;
  }).toBe(true);
  if (width === 390) await expect(hint).toBeVisible();
  // Forzar desborde a cualquier ancho: el aviso aparece al recalcular (resize).
  await page.evaluate(() => { (document.querySelector('#pageReporteArqueo .ra-table') as HTMLElement).style.minWidth = '3000px'; window.dispatchEvent(new Event('resize')); });
  await expect(hint).toBeVisible();
});

for (const dark of [false, true]) test(`arqueo: sobrante verde y faltante rojo con contraste ≥4.5:1 (${dark ? 'oscuro' : 'claro'})`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await rolePage(page, 'owner');
  await seed(page);
  await page.evaluate(dark => { const w = window as any; if (w.NA_THEME.isDark() !== dark) w.NA_THEME.toggle(); w.goPage('pageReporteArqueo'); }, dark);
  const sob = page.locator('#pageReporteArqueo tbody td.ra-sobrante').first(), fal = page.locator('#pageReporteArqueo tbody td.ra-faltante').first();
  await expect(sob).toContainText('(sobrante)'); await expect(fal).toContainText('(faltante)');
  const [sc, fc] = [await sob.evaluate(e => getComputedStyle(e).color), await fal.evaluate(e => getComputedStyle(e).color)];
  const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
  expect(rgb(sc)[1]).toBeGreaterThan(rgb(sc)[0]); expect(rgb(fc)[0]).toBeGreaterThan(rgb(fc)[1]);
  expect(await ratio(page, '#pageReporteArqueo tbody td.ra-sobrante')).toBeGreaterThanOrEqual(4.5);
  expect(await ratio(page, '#pageReporteArqueo tbody td.ra-faltante')).toBeGreaterThanOrEqual(4.5);
});
