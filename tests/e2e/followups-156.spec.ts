import { test, expect, type Page } from '@playwright/test';

// fix/followups-156: promedio diario <0.1, chip «Sin movimiento» a 768px, botón OCR y contraste oscuro (solo color).

async function boot(page: Page, dark: boolean, width = 1280, role?: 'owner') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: 'owner', owner_pin_set: true, roles_ready: true, device_id: 'fu-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/index.html');
  if (role) {
    await page.evaluate(() => {
      localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'fu-synthetic' }));
      localStorage.setItem('na_pos_role_v1', JSON.stringify({ role: 'owner' }));
    });
    await page.reload();
    await page.waitForFunction(() => (window as any).NA_ROLES?.role === 'owner' && (window as any).NA_ROLES.confirmed);
  }
  await page.waitForFunction(() => (window as any).NA_THEME && (window as any).NA_MENU_NAVIGATION && (window as any).NA_PURCHASES);
  await page.evaluate(dark => { const w = window as any; if (w.NA_THEME.isDark() !== dark) w.NA_THEME.toggle(); }, dark);
}

async function ratio(page: Page, selector: string) {
  return page.evaluate(selector => {
    const el = document.querySelector(selector) as HTMLElement;
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let p: HTMLElement | null = el, bg = '';
    while (p && ((bg = getComputedStyle(p).backgroundColor) === 'rgba(0, 0, 0, 0)' || parse(bg)[3] === 0)) p = p.parentElement;
    const a = lum(parse(getComputedStyle(el).color)), b = lum(parse(bg));
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
  }, selector);
}

async function openVentasStock(page: Page) {
  await page.evaluate(() => {
    (window as any).eval(`
      productos=[{id:'fu-1',name:'Lento prueba',cat:'abarrotes',stock:20},{id:'fu-2',name:'Medio prueba',cat:'abarrotes',stock:50},{id:'fu-3',name:'Quieto prueba',cat:'abarrotes',stock:5}];
      ventas=[{id:'fu-sale',fecha:NALimaTime.today(),items:[{id:'fu-1',qty:1,precio:1},{id:'fu-2',qty:15,precio:1}]}];
    `);
    (window as any).goPage('pageProximamente');
  });
  await page.locator('[data-feature-id="reporte-ventas-stock"]').click();
  await expect(page.locator('#pageVentasStock')).toBeVisible();
}

test('promedio diario positivo menor a 0.1 se distingue del cero real', async ({ page }) => {
  await boot(page, false, 1280, 'owner');
  await openVentasStock(page);
  const avg = (name: string) => page.locator('#pageVentasStock tbody tr', { hasText: name }).locator('td[data-label="Prom./día"]');
  await expect(avg('Lento prueba')).toHaveText('<0.1');   // 1/30 = 0.03
  await expect(avg('Medio prueba')).toHaveText('0.5');    // 15/30
  await expect(avg('Quieto prueba')).toHaveText('0');     // sin ventas: cero real
});

test('768px: el chip «Sin movimiento» queda en una sola línea', async ({ page }) => {
  await boot(page, false, 768, 'owner');
  await openVentasStock(page);
  const chip = page.locator('#pageVentasStock [data-vs-status="sin_movimiento"] .vs-badge');
  await expect(chip).toHaveText('Sin movimiento');
  await expect(chip).toHaveCSS('white-space', 'nowrap');
  const m = await chip.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return { rects: new Set([...r.getClientRects()].map(x => Math.round(x.top))).size, h: el.getBoundingClientRect().height, cell: el.parentElement!.scrollWidth <= el.parentElement!.clientWidth + 1 }; });
  expect(m.rects).toBe(1); expect(m.h).toBeLessThanOrEqual(30); expect(m.cell).toBe(true);
  expect(await page.locator('#pageVentasStock').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
});

for (const dark of [false, true]) test(`botón OCR con estilo propio (${dark ? 'oscuro' : 'claro'}) y 44px de alto`, async ({ page }) => {
  await boot(page, dark, 390);
  await page.evaluate(() => (window as any).NA_PURCHASES.open());
  const ocr = page.locator('.na-pur-box .na-pur-ocr');
  await expect(ocr).toBeVisible();
  const s = await ocr.evaluate(el => { const c = getComputedStyle(el); return { ap: c.appearance, r: c.borderTopLeftRadius, pt: c.paddingTop, pl: c.paddingLeft, h: el.getBoundingClientRect().height, ff: c.fontFamily, pff: getComputedStyle(el.parentElement!).fontFamily }; });
  expect(s.ap).toBe('none'); expect(s.r).toBe('10px'); expect(s.pt).toBe('0px'); expect(s.pl).toBe('14px');
  expect(s.h).toBeGreaterThanOrEqual(44); expect(s.h).toBeLessThan(46);
  expect(s.ff).toBe(s.pff);
  expect(await ratio(page, '.na-pur-box .na-pur-ocr')).toBeGreaterThanOrEqual(4.5);
});

test('modo oscuro: Todas, Permisos, KPI ámbar, «+S/» del cierre y botones naranjas ≥ 4.5:1', async ({ page }) => {
  await boot(page, true, 1280);
  const results: Record<string, number> = {};
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageProximamente'));
  await expect(page.locator('#pageProximamente .na-prox-chip.is-active')).toHaveText('Todas');
  results.todas = await ratio(page, '#pageProximamente .na-prox-chip.is-active');
  await page.evaluate(() => { const d = document.createElement('div'); d.id = 'fuPerm'; d.innerHTML = (window as any)._naF10CashierCardsHtml(); document.querySelector('#pageProximamente')!.appendChild(d); });
  results.permisos = await ratio(page, '#fuPerm .f10-btn.primary');
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageVentas'));
  // goPage difiere el render; _naSecRenderSaleKpis crea Gastos operativos dentro de #ventasKPI.
  const amber = page.locator('#ventasKPI .vkpi.amber .vkpi-val');
  await expect(amber).toBeVisible();
  results.kpiAmbar = await ratio(page, '#ventasKPI .vkpi.amber .vkpi-val');
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
  results.compras = await ratio(page, '#pageInventario .top-btn-nuevo.na-pur-btn');
  results.nuevo = await ratio(page, '#pageInventario .top-btn-nuevo[onclick^="abrirModalProd"]');
  await page.evaluate(() => { const w = window as any; w.eval("cajEstado={abierta:true,cerrada:false,fechaApertura:obtenerHoy(),fondo:100,sessionId:'fu-synthetic'};cajMovs=[];"); w.NA_MENU_NAVIGATION.navigate('pageCaja'); });
  // La pestaña Cierre llama cajSetTab/cajRender y _naSecCashClosing renderiza #cajContent.
  await page.locator('#pageCaja .tabs-wrap').getByRole('button', { name: 'Cierre', exact: true }).click();
  const plusSelector = '#cajContent span[style*="color: rgb(21, 128, 61)"]';
  const plus = page.locator(plusSelector);
  await expect(plus).toBeVisible();
  await expect(plus.locator('..')).toContainText('Ventas del día');
  await expect(plus).toHaveText(/^\+S\/ /);
  results.cierreMas = await ratio(page, plusSelector);
  test.info().annotations.push({ type: 'contraste', description: JSON.stringify(results) });
  for (const [k, v] of Object.entries(results)) expect(v, k).toBeGreaterThanOrEqual(4.5);
});

test('modo claro: esos elementos conservan sus colores', async ({ page }) => {
  await boot(page, false, 1280);
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
  const bgs = await page.locator('#pageInventario .top-btn-nuevo').evaluateAll(els => els.map(e => getComputedStyle(e).backgroundColor));
  expect(new Set(bgs).size).toBeGreaterThan(0);
  expect(bgs).not.toContain('rgb(194, 65, 12)');
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageVentas'));
  await expect(page.locator('#pageVentas .vkpi.amber .vkpi-val')).toHaveCSS('color', 'rgb(180, 83, 9)');
});
