import { test, expect, type Page } from '@playwright/test';

// Clientes en modo oscuro (visual en vivo web 151): cabecera de la cuenta «Créditos pequeños», cabecera del detalle
// «VENTA 2026-09-18 · 19:00» y cuota «Vencida». Oscuro: todo texto ≥ 4.5:1. Claro y tamaños: idénticos sin/con las reglas.

const TARGETS = {
  cuenta: '#pageClientes .na-v2-subhead.na-v2-category-head',
  detalle: '#pageClientes .na-v2-subhead.na-v2-tone-teal:not(.na-v2-category-head)',
  vencida: '#pageClientes .na-v2-installment.na-v2-installment-overdue',
};

async function boot(page: Page, width: number, dark: boolean) {
  await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_MENU_NAVIGATION && (window as any).NA_THEME && typeof (window as any).naCanonOpenSmallPurchase === 'function');
  await page.evaluate(dark => {
    const w = window as any; if (w.NA_THEME.isDark() !== dark) w.NA_THEME.toggle();
    w.NA_MENU_NAVIGATION.navigate('pageClientes');
    // Crédito de 11 cuotas con la primera ya vencida (01/10/2026 frente a hoy).
    const inst = Array.from({ length: 11 }, (_, i) => ({ number: i + 1, due: new Date(Date.UTC(2026, 9 + i, 1)).toISOString().slice(0, 10), amount: i < 10 ? 374.64 : 374.6 }));
    w.eval(`clientes=[{id:'cdk',nombre:'MISAEL',dni:'',tel:'',creditCategories:[]}];creditos=[{id:'crdk',credit_id:'crdk',cliId:'cdk',clienteId:'cdk',monto:4121,pagado:0,fecha:'2026-09-18',hora24:'19:00:00',vence:'2027-08-01',status:'vigente',estado:'vigente',anulado:false,pagos:[],tipo:'venta_credito',items:[{nombre:'Samsung Galaxy S25 Ultra',cantidad:1,precio:4121,subtotal:4121}],installments:${JSON.stringify(inst)}}];`);
    w.naCanonOpenClientAccount('cdk');
  }, dark);
}

// box = [ancho, alto]: la transición de pantalla mueve la posición entre pasadas, el tamaño no.
type Measure = { minRatio: number; worst: string; box: number[]; colors: string[] };
async function measure(page: Page, selector: string): Promise<Measure> {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  // Espera a que termine la transición de pantalla: misma caja (no nula) en dos lecturas seguidas.
  let last = '';
  await expect.poll(async () => {
    const r = await el.evaluate(n => { const b = n.getBoundingClientRect(); return b.width && b.height && document.querySelectorAll('#pageClientes .na-v2-screen').length === 1 ? [b.x, b.y, b.width, b.height].map(Math.round).join(',') : ''; });
    const stable = !!r && r === last; last = r; return stable;
  }, { intervals: [100, 100, 150, 250] }).toBe(true);
  return el.evaluate(root => {
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    // Fondo efectivo: todos los colores del primer ancestro con fondo (color o paradas del degradado).
    const backgrounds = (node: Element | null): number[][] => {
      for (let p = node; p; p = p.parentElement) {
        const s = getComputedStyle(p), stops = (s.backgroundImage.match(/rgba?\([^)]*\)/g) || []).map(parse).filter(c => c[3] !== 0);
        if (stops.length) return stops;
        const bg = parse(s.backgroundColor); if (bg.length && bg[3] !== 0) return [bg];
      }
      return [[255, 255, 255]];
    };
    let minRatio = 99, worst = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const host = t.parentElement!; const text = (t.textContent || '').trim();
      if (!text || !host.getClientRects().length || getComputedStyle(host).visibility === 'hidden') continue;
      const fg = parse(getComputedStyle(host).color);
      for (const bg of backgrounds(host)) { const r = ratio(fg, bg); if (r < minRatio) { minRatio = r; worst = text.slice(0, 30) + ' ' + getComputedStyle(host).color + ' / rgb(' + bg.slice(0, 3).join(', ') + ')'; } }
    }
    const r = root.getBoundingClientRect();
    const colors = [root, ...Array.from(root.querySelectorAll('*'))].map(n => { const s = getComputedStyle(n); return [s.color, s.backgroundColor, s.backgroundImage, s.borderTopColor, s.borderLeftColor].join(' '); });
    return { minRatio: Math.round(minRatio * 100) / 100, worst, box: [r.width, r.height].map(v => Math.round(v)), colors };
  });
}

async function measureAll(page: Page) {
  await page.evaluate(() => (window as any).naCanonOpenCreditCategory('small'));
  const cuenta = await measure(page, TARGETS.cuenta);
  await page.evaluate(() => (window as any).naCanonOpenSmallPurchase('crdk'));
  const detalle = await measure(page, TARGETS.detalle);
  const vencida = await measure(page, TARGETS.vencida);
  await expect(page.locator(TARGETS.vencida).first()).toContainText('Cuota 1');
  await expect(page.locator(TARGETS.vencida).first()).toContainText('Vencida');
  await page.evaluate(() => (window as any).naCanonOpenClientAccount('cdk'));
  return { cuenta, detalle, vencida };
}

// Quita del CSSOM las reglas nuevas de este arreglo (theme-dark.css) para comparar en la misma página.
async function removeFixRules(page: Page) {
  return page.evaluate(() => {
    let n = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      if (!/theme-dark\.css/.test(sheet.href || '')) continue;
      const marker = Array.from(sheet.cssRules).findIndex(r => ((r as CSSStyleRule).selectorText || '') === 'body.dark #pageClientes .na-v2-subhead');
      if (marker < 0) continue;
      while (sheet.cssRules.length > marker && ((sheet.cssRules[marker] as CSSStyleRule).selectorText || '').includes('#pageClientes')) { sheet.deleteRule(marker); n++; }
    }
    return n;
  });
}

for (const width of [1366, 768, 390]) {
  test(`oscuro ${width}px: cuenta, detalle y cuota vencida legibles (AA) sin cambiar tamaños`, async ({ page }) => {
    await boot(page, width, true);
    const after = await measureAll(page);
    test.info().annotations.push({ type: 'contraste-oscuro-' + width, description: JSON.stringify({ cuenta: after.cuenta.minRatio, detalle: after.detalle.minRatio, vencida: after.vencida.minRatio }) });
    for (const [name, m] of Object.entries(after)) expect(m.minRatio, `${name}: ${m.worst}`).toBeGreaterThanOrEqual(4.5);
    expect(after.vencida.colors[0]).toMatch(/rgb\(42, 15, 20\)/);
    expect(await removeFixRules(page)).toBe(6);
    const before = await measureAll(page);
    for (const k of ['cuenta', 'detalle', 'vencida'] as const) expect(after[k].box, k).toEqual(before[k].box);
    // Sin las reglas vuelve el problema (la prueba detecta el arreglo).
    expect(Math.min(before.cuenta.minRatio, before.detalle.minRatio, before.vencida.minRatio)).toBeLessThan(4.5);
  });

  test(`claro ${width}px: colores idénticos con y sin las reglas nuevas`, async ({ page }) => {
    await boot(page, width, false);
    const withRules = await measureAll(page);
    await removeFixRules(page);
    const without = await measureAll(page);
    for (const k of ['cuenta', 'detalle', 'vencida'] as const) {
      expect(withRules[k].colors, k).toEqual(without[k].colors);
      expect(withRules[k].box, k).toEqual(without[k].box);
    }
  });
}
