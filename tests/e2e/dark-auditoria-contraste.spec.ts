import { test, expect, type Page } from '@playwright/test';

// Auditoría de modo oscuro (visual en vivo web 154): Configuración (interruptores, aviso, Usuarios y PIN, copia),
// Caja (tarjeta verde, cierre), Reportes (chips y gráfico), Inventario (Nueva compra, Compras registradas,
// detalle del producto, chip de categoría) y Próximamente (tarjetas bloqueadas).
// Oscuro: texto ≥ 4.5:1 y componentes (interruptor) ≥ 3:1, sin cambiar tamaños.
// Claro: colores, bordes, opacidad y tamaños idénticos con y sin las reglas nuevas.

const MARKER = 'body.dark .cfg-toggle';
const RULES = 26;

type Sample = { ratio: number; fg: string; bg: string; border: string; image: string; opacity: string; box: number[] };

async function boot(page: Page, width: number, dark: boolean) {
  await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_THEME && (window as any).NA_MENU_NAVIGATION && (window as any).NA_PURCHASES && (window as any).NA_ROLES?.isOwner());
  await page.evaluate(dark => { const w = window as any; if (w.NA_THEME.isDark() !== dark) w.NA_THEME.toggle(); }, dark);
  await page.evaluate(() => (window as any).eval(`
    productos=[{id:9001,name:'Paracetamol 500',cat:'farmacia',costo:2,precio:10,stock:5,stockMin:1,sku:'P-9001'},{id:9002,name:'Galleta soda',cat:'snacks',costo:1,precio:1.3,stock:9,stockMin:1,sku:'G-9002'}];
    ventas=[{id:'V-dk1',fecha:NALimaTime.today(),hora:'10:00',total:30,metodo:'yape',cajeroNombre:'Admin',items:[{id:9001,name:'Paracetamol 500',precio:10,qty:3,costo:2}]},
      {id:'V-dk2',fecha:NALimaTime.today(),hora:'11:00',total:6,metodo:'credito',estado:'credito',cajeroNombre:'Admin',items:[{id:'VL-1',name:'VARIOS',precio:2,qty:1,ventaLibre:true},{id:9002,name:'Galleta soda',precio:2,qty:2,costo:1}]}];
    gastos=[];cajMovs=[];creditos=[];clientes=[];`));
}

// Contraste efectivo: el texto contra el fondo (o contra cada parada del degradado), con la opacidad propia y la del grupo.
async function sample(page: Page, selector: string, kind: 'text' | 'track' | 'knob' = 'text'): Promise<Sample> {
  const el = page.locator(selector).first();
  await expect(el, selector).toBeVisible();
  return el.evaluate((node, kind) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const contrast = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const mix = (a: number[], b: number[], t: number) => [0, 1, 2].map(i => a[i] * t + b[i] * (1 - t));
    const over = (c: number[], under: number[]) => c.length > 3 && c[3] < 1 ? mix(c, under, c[3]) : c.slice(0, 3);
    // Fondo pintado: primer ancestro (o el propio) con color opaco o degradado; devuelve sus colores y el elemento.
    const paint = (start: Element | null): { stops: number[][]; el: HTMLElement | null } => {
      for (let p = start as HTMLElement | null; p; p = p.parentElement) {
        const s = getComputedStyle(p), c = parse(s.backgroundColor), grad = (s.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse);
        if (grad.length) return { stops: grad.map(g => over(g, c.length && c[3] !== 0 ? c : [15, 23, 42])), el: p };
        if (c.length && (c.length < 4 || c[3] > 0.05)) { const under = c.length > 3 && c[3] < 1 ? paint(p.parentElement).stops[0] : c; return { stops: [over(c, under)], el: p }; }
      }
      return { stops: [[255, 255, 255]], el: null };
    };
    const h = node as HTMLElement, s = getComputedStyle(h);
    let fg: number[], bgInfo: { stops: number[][]; el: HTMLElement | null };
    if (kind === 'track') { bgInfo = paint(h.parentElement); fg = parse(s.backgroundColor); }
    else if (kind === 'knob') { bgInfo = paint(h.parentElement); fg = parse(s.backgroundColor); }
    else { bgInfo = paint(h); fg = parse(s.color); }
    // Opacidad: la de los nodos por debajo del fondo atenúa solo el texto; la del fondo y arriba, ambos hacia lo de atrás.
    let aText = 1, aGroup = 1, top: HTMLElement | null = null;
    let below = true;
    for (let p: HTMLElement | null = h; p; p = p.parentElement) {
      if (p === bgInfo.el) below = false;
      const o = +getComputedStyle(p).opacity;
      if (o < 1) { if (below) aText *= o; else { aGroup *= o; top = p; } }
    }
    const backdrop = top ? paint(top.parentElement).stops[0] : [0, 0, 0];
    let fgD = fg.slice(0, 3);
    const ratios = bgInfo.stops.map(stop => {
      let f = mix(fgD, stop, aText), b = stop;
      if (aGroup < 1) { f = mix(f, backdrop, aGroup); b = mix(b, backdrop, aGroup); }
      return contrast(f, b);
    });
    const r = h.getBoundingClientRect();
    return { ratio: Math.round(Math.min(...ratios) * 100) / 100, fg: s.color, bg: s.backgroundColor, border: [s.borderTopColor, s.borderTopStyle, s.borderTopWidth].join(' '), image: s.backgroundImage, opacity: s.opacity, box: [r.width, r.height].map(v => Math.round(v * 10) / 10) };
  }, kind);
}

async function config(page: Page, top: string, tab: string) {
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageConfig'));
  // Clic delegado de Configuración v9 (en el teléfono la lista de secciones queda oculta dentro de una sección).
  await expect(page.locator(`[data-top="${top}"]`).first()).toBeAttached();
  await page.locator(`[data-top="${top}"]`).first().evaluate(n => (n as HTMLElement).click());
  await expect(page.locator(`[data-tab="${tab}"]`).first()).toBeAttached();
  await page.locator(`[data-tab="${tab}"]`).first().evaluate(n => (n as HTMLElement).click());
}

// [nombre, selector, tipo, mínimo exigido en oscuro]
type Target = [string, string, 'text' | 'track' | 'knob', number];
const SCREENS: { name: string; open: (page: Page) => Promise<void>; targets: Target[] }[] = [
  { name: 'bloqueos', open: page => config(page, 'pers', 'perm'), targets: [
    ['interruptor apagado (riel)', '#cfgContent .cfg-toggle:not(.active)', 'track', 3],
    ['interruptor apagado (perilla)', '#cfgContent .cfg-toggle:not(.active) .cfg-toggle-knob', 'knob', 3],
    ['interruptor encendido (riel)', '#cfgContent .cfg-toggle.active', 'track', 3],
    ['interruptor encendido (perilla)', '#cfgContent .cfg-toggle.active .cfg-toggle-knob', 'knob', 3],
    ['aviso rojo', '#cfgContent .f10-warning', 'text', 4.5],
    ['Bloquear ahora', '#cfgContent .sec-action-btn.danger', 'text', 4.5]] },
  { name: 'usuarios', open: page => config(page, 'pers', 'pin'), targets: [
    ['Desactivar', '.cashier-mini-btn.danger', 'text', 4.5],
    ['Guardar PIN', '#naCfgV9 .na9-btn:not(.sec):not(.red)', 'text', 4.5]] },
  { name: 'copia', open: page => config(page, 'sis', 'backup'), targets: [
    ['Descargar copia', '#naCfgV9 .na9-btn:not(.sec):not(.red)', 'text', 4.5]] },
  { name: 'caja resumen', open: async page => {
    // Caja abierta solo desde aquí: con caja abierta Configuración no muestra sus secciones.
    await page.evaluate(() => { const w = window as any; w.eval("cajEstado={abierta:true,cerrada:false,fechaApertura:obtenerHoy(),fondo:1,montoInicial:1,sessionId:'dk-audit',cajero:'Prueba'}"); w.NA_MENU_NAVIGATION.navigate('pageCaja'); w.eval('cajRender()'); });
  }, targets: [
    ['tarjeta verde: monto', '#pageCaja .banner-abierta .bn-monto', 'text', 4.5],
    ['tarjeta verde: título', '#pageCaja .banner-abierta .bn-title', 'text', 4.5],
    ['tarjeta verde: fondo/cajero', '#pageCaja .banner-abierta .bn-sub', 'text', 4.5],
    ['Cerrar (tarjeta verde)', '#pageCaja .banner-abierta .btn-cerrar-cj', 'text', 4.5]] },
  { name: 'caja cierre', open: async page => { await page.locator('#pageCaja .tab', { hasText: 'Cierre' }).click(); }, targets: [
    ['Proceder al cierre de caja', '#pageCaja [data-na-cash-action="close"]', 'text', 4.5]] },
  { name: 'reportes', open: async page => { await page.evaluate(() => (window as any).goPage('pageVentas')); await page.locator('#pageVentas .tab', { hasText: 'Historial' }).first().click().catch(() => {}); }, targets: [
    ['COMPLETADA', '#pageVentas .sale-state-badge.completed', 'text', 4.5],
    ['EN CRÉDITO', '#pageVentas .sale-state-badge.credit', 'text', 4.5],
    ['MINORISTA', '#pageVentas .sale-type-badge', 'text', 4.5],
    ['VARIOS', '#pageVentas .sale-special-badge.free', 'text', 4.5]] },
  { name: 'top productos', open: async page => { await page.locator('#pageVentas .tab', { hasText: 'Top prods' }).click(); }, targets: [
    ['etiqueta del gráfico', '#pageVentas .v-chart .bar-v', 'text', 4.5]] },
  { name: 'nueva compra', open: async page => { await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'); (window as any).NA_PURCHASES.open(); }); }, targets: [
    ['Desde foto/OCR', '#naPurchaseDialog .na-pur-ocr', 'text', 4.5],
    ['Historial', '#naPurchaseDialog .na-pur-hist', 'text', 4.5],
    ['Cancelar', '#naPurchaseDialog .na-pur-cancel', 'text', 4.5]] },
  { name: 'compras registradas', open: async page => { await page.locator('#naPurchaseDialog .na-pur-hist').click(); }, targets: [
    ['Cerrar (Compras registradas)', '#naPurchaseHistory .na-pur-close', 'text', 4.5]] },
  { name: 'detalle producto', open: async page => {
    await page.evaluate(() => { document.querySelectorAll('#naPurchaseHistory,#naPurchaseDialog').forEach(n => n.remove()); (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'); });
    await page.locator('#invBody .btn-edt').first().click(); await expect(page.locator('#mProd')).toBeVisible();
    await page.locator('#mProd .prod-margin').evaluate(n => n.closest('details')?.setAttribute('open', ''));
  }, targets: [
    ['margen: etiqueta', '#mProd .prod-margin strong', 'text', 4.5]] },
  // Los tres colores que pone el formulario según el margen (<50 %, 50–99 %, ≥100 %).
  ...([['rojo', 'var(--red)'], ['turquesa', 'var(--teal)'], ['verde', '#15803d']] as const).map(([tone, color]) => ({
    name: 'margen ' + tone, open: async (page: Page) => { await page.locator('#mProd #mgVal').evaluate((n, c) => { (n as HTMLElement).style.color = c; }, color); },
    targets: [['margen: valor ' + tone, '#mProd .prod-margin #mgVal', 'text', 4.5]] as Target[] })),
  { name: 'chip categoría', open: async page => { await page.evaluate(() => { const w = window as any; w.eval("document.getElementById('mProd')?.classList.remove('open')"); w.NA_MENU_NAVIGATION.navigate('pageInventario'); }); }, targets: [
    ['chip Snacks (texto)', '#invBody .cat-pill', 'text', 4.5],
    ['chip Snacks (forma)', '#invBody .cat-pill', 'track', 1.3]] },
  { name: 'próximamente', open: async page => { await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageProximamente')); await page.locator('.na-prox-section').first().evaluate(n => n.setAttribute('open', '')); }, targets: [
    ['bloqueada: nombre', '.na-prox-card:not(.is-enabled) .na-prox-name', 'text', 4.5],
    ['bloqueada: descripción', '.na-prox-card:not(.is-enabled) .na-prox-description', 'text', 4.5],
    ['bloqueada: insignia', '.na-prox-card:not(.is-enabled) .na-prox-badge', 'text', 4.5]] }
];

async function measureAll(page: Page) {
  const out: Record<string, Sample> = {};
  for (const screen of SCREENS) {
    await screen.open(page);
    await page.waitForTimeout(350); // transiciones de pantalla/modal (opacidad) antes de medir
    for (const [name, selector, kind] of screen.targets) out[name] = await sample(page, selector, kind);
  }
  return out;
}

async function removeRules(page: Page) {
  return page.evaluate(marker => {
    for (const sheet of Array.from(document.styleSheets)) {
      if (!/theme-dark\.css/.test(sheet.href || '')) continue;
      const rules = Array.from(sheet.cssRules) as CSSStyleRule[];
      let start = -1; rules.forEach((r, i) => { if (r.selectorText === marker) start = i; }); // la última: theme-dark.css ya tenía una «body.dark .cfg-toggle»
      if (start < 0) return -1;
      const followups = rules.findIndex((r, i) => i > start && (r.selectorText || '').includes('body.dark .f10-btn.primary'));
      const end = followups > start ? followups : rules.length;
      const n = end - start;
      for (let i = end - 1; i >= start; i--) sheet.deleteRule(i);
      return n;
    }
    return -1;
  }, MARKER);
}

for (const width of [390, 1366]) {
  test(`oscuro ${width}px: AA en los puntos de la auditoría y mismos tamaños`, async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page, width, true);
    const after = await measureAll(page);
    for (const screen of SCREENS) for (const [name, , , min] of screen.targets) expect(after[name].ratio, `${name}: ${after[name].fg} sobre ${after[name].bg}`).toBeGreaterThanOrEqual(min);
    // Encendido y apagado se distinguen: rieles distintos y la perilla cambia de claro a oscuro.
    expect(after['interruptor encendido (riel)'].bg).not.toBe(after['interruptor apagado (riel)'].bg);
    // «Proceder al cierre de caja» ya no queda casi blanco (var(--dark) es claro en oscuro): fondo del tema.
    expect(after['Proceder al cierre de caja'].bg).toBe('rgb(15, 118, 110)');
    // «Desde foto/OCR» ya no es el botón nativo claro.
    expect(after['Desde foto/OCR'].bg).toBe('rgb(51, 65, 85)');
    expect(after['Desde foto/OCR'].border).toContain('solid');
    // Tienen style="background:#64748b" inline; gana la regla oscura con !important.
    for (const k of ['Historial', 'Cancelar']) {
      expect(after[k].bg).toBe('rgb(51, 65, 85)');
      expect(after[k].fg).toBe('rgb(248, 250, 252)');
    }
    // Antes (sin las reglas nuevas, en la misma página): mismas cajas y vuelve el problema.
    await page.reload();
    await boot(page, width, true);
    expect(await removeRules(page)).toBe(RULES);
    const before = await measureAll(page);
    test.info().annotations.push({ type: 'ratios', description: JSON.stringify(Object.fromEntries(Object.keys(after).map(k => [k, [before[k].ratio, after[k].ratio]]))) });
    for (const k of Object.keys(after)) expect(after[k].box, `${k}: tamaño`).toEqual(before[k].box);
    expect(before['interruptor encendido (riel)'].bg).toBe(before['interruptor apagado (riel)'].bg);
    expect(before['Proceder al cierre de caja'].bg).toBe('rgb(229, 231, 235)');
    for (const k of ['aviso rojo', 'Desactivar', 'Descargar copia', 'tarjeta verde: monto', 'Cerrar (tarjeta verde)', 'COMPLETADA', 'MINORISTA', 'VARIOS']) expect(before[k].ratio, `${k} antes`).toBeLessThan(4.5);
  });

  test(`claro ${width}px: colores, bordes, opacidad y tamaños idénticos con y sin las reglas`, async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page, width, false);
    const withRules = await measureAll(page);
    await page.reload();
    await boot(page, width, false);
    expect(await removeRules(page)).toBe(RULES);
    const without = await measureAll(page);
    for (const k of Object.keys(withRules)) expect(withRules[k], k).toEqual(without[k]);
  });
}

// Recorrido táctil real con las hojas tardías cargadas: OCR oscuro y AA en cada estado del botón.
test('oscuro 390px táctil: «Desde foto/OCR» oscuro y AA en todos los estados, por el camino real', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  try {
    await boot(page, 390, true);
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .filter(link => link.href.startsWith(location.origin))
      .every(link => link.media !== 'print' && !!link.sheet));
    await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageInventario'));
    const purchase = page.locator('#pageInventario .na-pur-btn');
    await expect(purchase).toBeVisible();
    await purchase.tap();
    const ocrSelector = '.na-pur-overlay .na-pur-box button.na-pur-ocr';
    const ocr = page.locator(ocrSelector);
    await expect(ocr).toBeVisible();
    await page.waitForTimeout(350);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: ocrSelector });
    for (const forced of [[], ['hover'], ['active', 'hover'], ['focus'], ['focus', 'focus-visible']]) {
      const state = forced.join('+') || 'normal';
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: forced });
      const s = await sample(page, ocrSelector);
      expect(s.bg, `${state}: fondo`).toBe('rgb(51, 65, 85)');
      expect(s.fg, `${state}: texto`).toBe('rgb(241, 245, 249)');
      expect(s.ratio, `${state}: contraste`).toBeGreaterThanOrEqual(4.5);
      expect(s.image, `${state}: imagen de fondo`).toBe('none');
    }
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    expect(await ocr.evaluate(el => getComputedStyle(el).appearance)).toBe('none');
    for (const selector of ['.na-pur-hist', '.na-pur-cancel']) {
      const fullSelector = '.na-pur-overlay .na-pur-box ' + selector;
      expect(await page.locator(fullSelector).getAttribute('style')).toContain('#64748b');
      const s = await sample(page, fullSelector);
      expect([s.bg, s.fg], selector).toEqual(['rgb(51, 65, 85)', 'rgb(248, 250, 252)']);
      expect(s.ratio, `${selector}: contraste`).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    await ctx.close();
  }
});
