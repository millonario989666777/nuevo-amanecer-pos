import { test, expect, type Page } from '@playwright/test';

// Modo oscuro (visual en vivo web 150): «Total costo», «Desde foto/OCR», franja de caja abierta e ícono del menú.
// Oscuro: contraste WCAG AA (≥ 4.5:1). Claro: colores anteriores, salvo el estilo propio OCR de followups-156.
// Tamaño y posición iguales en ambos modos.

async function boot(page: Page, dark: boolean, width = 390) {
  await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_PURCHASES && (window as any).NA_THEME && (window as any).NA_MENU_NAVIGATION && (window as any).NuevoAmanecerStatusBanner);
  await page.evaluate(dark => { const w = window as any; if (w.NA_THEME.isDark() !== dark) w.NA_THEME.toggle(); }, dark);
}

// Franja roja de «caja abierta de otro día»: CANON activo con una caja abierta de ayer.
async function showCashBanner(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.NuevoAmanecerCanonical = Object.assign({}, w.NuevoAmanecerCanonical || {}, { enabled: () => true, snapshot: () => ({ cashSessions: [] }), pendingSnapshot: () => null });
    w.NuevoAmanecerCanonicalUIAdapter = Object.assign({}, w.NuevoAmanecerCanonicalUIAdapter || {}, { cashState: () => ({ abierta: true, fechaApertura: '2026-10-15' }) });
    w.obtenerHoy = () => '2026-10-16';
    w.NuevoAmanecerStatusBanner.render();
  });
  await expect(page.locator('#naStatusBanner')).toContainText('La caja abierta es del 2026-10-15');
}

type Sample = { fg: string; bg: string; ratio: number; box: number[] };
async function sample(page: Page, selector: string, fgProp: 'color' | 'backgroundColor' = 'color', bgOf?: string): Promise<Sample> {
  return page.evaluate(({ selector, fgProp, bgOf }) => {
    const el = document.querySelector(selector) as HTMLElement;
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let p: HTMLElement | null = bgOf ? document.querySelector(bgOf) as HTMLElement : el, bg = 'rgba(0, 0, 0, 0)';
    while (p && ((bg = getComputedStyle(p).backgroundColor) === 'rgba(0, 0, 0, 0)' || parse(bg)[3] === 0)) p = p.parentElement;
    const fg = (getComputedStyle(el) as any)[fgProp] as string;
    const a = lum(parse(fg)), b = lum(parse(bg));
    const r = el.getBoundingClientRect();
    return { fg, bg, ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100, box: [r.x, r.y, r.width, r.height].map(v => Math.round(v)) };
  }, { selector, fgProp, bgOf });
}

async function measureAll(page: Page) {
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
  // Ícono del menú (máscara pintada con currentColor) sobre la cabecera, sin franja.
  const menu = await sample(page, '#naMobileMenuToggle .na-ic', 'backgroundColor', '#naMobileMenuToggle');
  await page.evaluate(() => (window as any).NA_PURCHASES.open());
  await expect(page.locator('.na-pur-total')).toBeVisible();
  const total = await sample(page, '.na-pur-total');
  const ocr = await sample(page, '.na-pur-ocr');
  await page.evaluate(() => document.querySelector('.na-pur-overlay')?.remove());
  await showCashBanner(page);
  const banner = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
  return { menu, total, ocr, banner };
}

test('modo oscuro 390px: los cuatro elementos alcanzan WCAG AA (≥ 4.5:1) sin cambiar tamaño', async ({ page }) => {
  await boot(page, true);
  const dark = await measureAll(page);
  test.info().annotations.push({ type: 'contraste-oscuro', description: JSON.stringify(Object.fromEntries(Object.entries(dark).map(([k, v]) => [k, v.ratio]))) });
  for (const [name, s] of Object.entries(dark)) expect(s.ratio, `${name}: ${s.fg} sobre ${s.bg}`).toBeGreaterThanOrEqual(4.5);
  // El botón OCR usa la superficie oscura en lugar de su nuevo gris claro propio.
  expect(dark.ocr.bg).not.toBe('rgb(241, 245, 249)');
  // Solo color: se quitan del CSSOM las reglas nuevas de theme-dark.css y las cajas deben ser las mismas.
  const removed = await page.evaluate(() => {
    let n = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      if (!/theme-dark\.css/.test(sheet.href || '')) continue;
      const rules = sheet.cssRules;
      for (let i = rules.length - 1; i >= 0; i--) {
        const sel = (rules[i] as CSSStyleRule).selectorText || '';
        if (/^body\.dark (\.na-pur-total|\.na-pur-box \.na-pur-ocr|#naStatusBanner\[)/.test(sel)) { sheet.deleteRule(i); n++; }
      }
    }
    return n;
  });
  // followups-156 agrega una segunda regla oscura OCR; sin ambas queda su nuevo estilo claro propio.
  expect(removed).toBe(5);
  const before = await measureAll(page);
  // El ícono del menú no tiene reglas nuevas; en esta segunda medición la franja ya está visible y lo desplaza (bug de posición aparte).
  for (const k of ['total', 'ocr', 'banner'] as const) expect(dark[k].box, k).toEqual(before[k].box);
  // Y sin esas reglas vuelve el problema (la prueba detecta el arreglo).
  expect(before.total.ratio).toBeLessThan(4.5);
  expect(before.ocr.bg).toBe('rgb(241, 245, 249)');
});

test('modo claro 390px: colores idénticos a los de antes del cambio', async ({ page }) => {
  await boot(page, false);
  const light = await measureAll(page);
  expect([light.total.fg, light.total.bg]).toEqual(['rgb(15, 23, 42)', 'rgb(255, 255, 255)']);
  // followups-156 reemplaza el estilo nativo OCR por texto teal sobre gris claro en stock-lots.css.
  expect([light.ocr.fg, light.ocr.bg]).toEqual(['rgb(15, 118, 110)', 'rgb(241, 245, 249)']);
  expect([light.banner.fg, light.banner.bg]).toEqual(['rgb(153, 27, 27)', 'rgb(254, 226, 226)']);
  expect(await page.locator('#naStatusBanner').evaluate(el => getComputedStyle(el).borderBottomColor)).toBe('rgb(252, 165, 165)');
  expect(light.menu.fg).toBe(LIGHT_MENU_ICON);
});

const LIGHT_MENU_ICON = 'rgb(25, 52, 76)';

// Tono ámbar de la franja (#fef3c7): una venta pendiente de envío, sin caja de otro día.
async function showAmberBanner(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.NuevoAmanecerCanonical = Object.assign({}, w.NuevoAmanecerCanonical || {}, { enabled: () => true, snapshot: () => ({ cashSessions: [] }), pendingSnapshot: () => null });
    w.NuevoAmanecerCanonicalUIAdapter = Object.assign({}, w.NuevoAmanecerCanonicalUIAdapter || {}, { cashState: () => null });
    w.NuevoAmanecerCanonicalSaleOutbox = Object.assign({}, w.NuevoAmanecerCanonicalSaleOutbox || {}, { snapshot: () => ({ intents: [{ id: 'amber-1' }] }), quarantine: () => ({ entries: [] }) });
    w.NuevoAmanecerStatusBanner.render();
  });
  await expect(page.locator('#naStatusBanner')).toContainText('1 operación pendiente · reintentando');
}

for (const dark of [true, false]) {
  test(`franja ámbar 390px, modo ${dark ? 'oscuro: AA sin el amarillo claro' : 'claro: colores de siempre'}`, async ({ page }) => {
    await boot(page, dark);
    await showAmberBanner(page);
    const s = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
    if (dark) {
      expect(s.bg).not.toBe('rgb(254, 243, 199)');
      expect(s.ratio, `${s.fg} sobre ${s.bg}`).toBeGreaterThanOrEqual(4.5);
      expect([s.fg, s.bg]).toEqual(['rgb(253, 230, 138)', 'rgb(69, 26, 3)']);
    } else {
      expect([s.fg, s.bg]).toEqual(['rgb(146, 64, 14)', 'rgb(254, 243, 199)']);
      expect(await page.locator('#naStatusBanner').evaluate(el => getComputedStyle(el).borderBottomColor)).toBe('rgb(252, 211, 77)');
    }
  });
}

// data-tone (danger/warn) es el único gancho del modo oscuro: los respaldos [style*="254, 226, 226"] y
// [style*="254, 243, 199"] se quitaron (render() es el único que pinta la franja y siempre pone data-tone).
test('theme-dark.css: las reglas de #naStatusBanner usan solo [data-tone], sin [style*=]', async ({ page }) => {
  await boot(page, true);
  const selectors = await page.evaluate(() => {
    const out: string[] = [];
    const walk = (rules: CSSRuleList) => { for (const r of Array.from(rules)) { const sel = (r as CSSStyleRule).selectorText; if (sel && sel.includes('#naStatusBanner')) out.push(sel); if ((r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules); } };
    for (const sheet of Array.from(document.styleSheets)) if (/theme-dark\.css/.test(sheet.href || '')) walk(sheet.cssRules);
    return out;
  });
  expect(selectors).toEqual(['body.dark #naStatusBanner[data-tone="danger"]', 'body.dark #naStatusBanner[data-tone="warn"]']);
});

const DARK_BANNER = { danger: ['rgb(254, 202, 202)', 'rgb(127, 29, 29)'], warn: ['rgb(253, 230, 138)', 'rgb(69, 26, 3)'] };
const LIGHT_BANNER = { danger: ['rgb(153, 27, 27)', 'rgb(254, 226, 226)'], warn: ['rgb(146, 64, 14)', 'rgb(254, 243, 199)'] };
for (const tone of ['danger', 'warn'] as const) {
  test(`franja ${tone} 390px, oscuro: la pinta data-tone; sin el atributo ya no hay respaldo por estilo inline`, async ({ page }) => {
    await boot(page, true);
    const show = () => tone === 'danger' ? showCashBanner(page) : showAmberBanner(page);
    await show();
    const banner = page.locator('#naStatusBanner');
    await expect(banner).toHaveAttribute('data-tone', tone);
    const s = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
    expect([s.fg, s.bg]).toEqual(DARK_BANNER[tone]);
    expect(s.ratio).toBeGreaterThanOrEqual(4.5);
    // Sin data-tone la regla oscura no aplica: quedan los colores inline claros (no hay [style*=]).
    await banner.evaluate(el => el.removeAttribute('data-tone'));
    const bare = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
    expect([bare.fg, bare.bg]).toEqual(LIGHT_BANNER[tone]);
    expect(bare.box).toEqual(s.box);
    // Cada render() vuelve a poner el atributo.
    await page.evaluate(() => (window as any).NuevoAmanecerStatusBanner.render());
    await expect(banner).toHaveAttribute('data-tone', tone);
    const again = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
    expect([again.fg, again.bg]).toEqual(DARK_BANNER[tone]);
  });
}

test('modo claro 390px: data-tone presente y sin efecto en los colores', async ({ page }) => {
  await boot(page, false);
  await showCashBanner(page);
  const banner = page.locator('#naStatusBanner');
  await expect(banner).toHaveAttribute('data-tone', 'danger');
  const withAttr = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
  await banner.evaluate(el => el.removeAttribute('data-tone'));
  const without = await sample(page, '#naStatusBanner .na-sb-text', 'color', '#naStatusBanner');
  expect(withAttr).toEqual(without);
});
