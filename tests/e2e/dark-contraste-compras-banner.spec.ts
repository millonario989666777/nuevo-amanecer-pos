import { test, expect, type Page } from '@playwright/test';

// Modo oscuro (visual en vivo web 150): «Total costo», «Desde foto/OCR», franja de caja abierta e ícono del menú.
// Oscuro: contraste WCAG AA (≥ 4.5:1). Claro: colores idénticos a los de antes. Tamaño y posición iguales en ambos.

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
  // El botón OCR ya no es el gris nativo claro.
  expect(dark.ocr.bg).not.toBe('rgb(239, 239, 239)');
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
  expect(removed).toBe(4);
  const before = await measureAll(page);
  // El ícono del menú no tiene reglas nuevas; en esta segunda medición la franja ya está visible y lo desplaza (bug de posición aparte).
  for (const k of ['total', 'ocr', 'banner'] as const) expect(dark[k].box, k).toEqual(before[k].box);
  // Y sin esas reglas vuelve el problema (la prueba detecta el arreglo).
  expect(before.total.ratio).toBeLessThan(4.5);
  expect(before.ocr.bg).toBe('rgb(239, 239, 239)');
});

test('modo claro 390px: colores idénticos a los de antes del cambio', async ({ page }) => {
  await boot(page, false);
  const light = await measureAll(page);
  expect([light.total.fg, light.total.bg]).toEqual(['rgb(15, 23, 42)', 'rgb(255, 255, 255)']);
  expect([light.ocr.fg, light.ocr.bg]).toEqual(['rgb(0, 0, 0)', 'rgb(239, 239, 239)']);
  expect([light.banner.fg, light.banner.bg]).toEqual(['rgb(153, 27, 27)', 'rgb(254, 226, 226)']);
  expect(await page.locator('#naStatusBanner').evaluate(el => getComputedStyle(el).borderBottomColor)).toBe('rgb(252, 165, 165)');
  expect(light.menu.fg).toBe(LIGHT_MENU_ICON);
});

const LIGHT_MENU_ICON = 'rgb(25, 52, 76)';
