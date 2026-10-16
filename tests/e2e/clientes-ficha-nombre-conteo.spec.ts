import { test, expect, type Page } from '@playwright/test';

async function openClientes(page: Page, width: number) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_MENU_NAVIGATION && typeof (window as any).naCanonOpenClientAccount === 'function');
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageClientes'));
}

// Cada palabra del nombre queda en una sola línea: todos sus caracteres comparten la misma fila.
async function wordsSplit(page: Page) {
  return page.locator('.na-v2-client-head h2').evaluate(h2 => {
    if (!h2.isConnected) return ['<h2 desconectado>'];
    const node = h2.firstChild as Text; const text = node.textContent || ''; const split: string[] = [];
    const re = /\S+/g; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const tops = new Set<number>();
      for (let i = m.index; i < m.index + m[0].length; i++) {
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0]; if (rect && rect.width) tops.add(Math.round(rect.top));
      }
      if (tops.size > 1) split.push(m[0]);
    }
    return split;
  });
}

// La ficha se vuelve a dibujar sola: la lista de Clientes anima cada refresco (clase na-client-refresh-out
// y redibujo 850 ms después) y ese redibujo, más el MutationObserver de #cliList, reemplazan el <h2> de la
// ficha abierta. Medir antes de que termine deja un nodo desconectado (getComputedStyle devuelve "").
// Se espera a que no haya refresco en curso y el <h2> sea el mismo nodo sin mutaciones durante 300 ms.
async function waitFichaStable(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__fichaObs) return;
    w.__fichaMut = performance.now();
    w.__fichaObs = new MutationObserver(() => { w.__fichaMut = performance.now(); });
    w.__fichaObs.observe(document.getElementById('pageClientes')!, { childList: true, subtree: true });
  });
  let prev = 0;
  await expect.poll(async () => {
    const st = await page.evaluate(() => {
      const w = window as any, page = document.getElementById('pageClientes')!;
      const h2 = document.querySelector('.na-v2-client-head h2') as any;
      if (!h2 || !h2.isConnected) return { id: 0, ok: false };
      if (!h2.__fichaId) h2.__fichaId = (w.__fichaSeq = (w.__fichaSeq || 0) + 1);
      const refreshing = page.classList.contains('na-client-refresh-out') || page.classList.contains('na-client-refresh-in');
      return { id: h2.__fichaId as number, ok: !refreshing && performance.now() - w.__fichaMut >= 300 };
    });
    const same = st.id === prev; prev = st.id;
    return st.ok && same;
  }, { timeout: 8000, intervals: [100, 150, 200] }).toBe(true);
}

for (const width of [320, 360, 390, 430, 768, 1024]) {
  for (const name of ['MISAEL QUISPE HUAMANCHUMO', 'MISAELMONTENEGROQUISPEHUAMAN']) {
    test(`ficha: «${name}» nunca se corta a mitad de palabra a ${width}px`, async ({ page }) => {
      await openClientes(page, width);
      await page.evaluate(name => {
        (window as any).eval(`clientes=[{id:'ficha-nombre',nombre:${JSON.stringify(name)},dni:'',tel:'',creditCategories:[]}];creditos=[];`);
        (window as any).naCanonOpenClientAccount('ficha-nombre');
      }, name);
      const h2 = page.locator('.na-v2-client-head h2');
      await expect(h2).toBeVisible();
      await waitFichaStable(page);
      expect(await wordsSplit(page)).toEqual([]);
      const css = await h2.evaluate(el => { const s = getComputedStyle(el); return [el.isConnected, el.textContent, s.overflowWrap, s.wordBreak, s.textOverflow]; });
      expect(css).toEqual([true, name, 'normal', 'normal', 'ellipsis']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });
  }
}

test('la tarjeta «Clientes» cuenta lo mismo que la lista filtrada (Vigentes 30 de 40)', async ({ page }) => {
  await openClientes(page, 390);
  await page.evaluate(() => {
    (window as any).eval(`
      clientes=Array.from({length:40},(_,i)=>({id:'cc-'+i,nombre:'Cliente sintético '+String(i).padStart(2,'0'),dni:'',tel:'',creditCategories:[]}));
      creditos=Array.from({length:30},(_,i)=>({id:'cr-'+i,credit_id:'cr-'+i,cliId:'cc-'+i,clienteId:'cc-'+i,monto:10,pagado:0,fecha:'2026-09-01',vence:'2099-01-01',status:'vigente',estado:'vigente',anulado:false,pagos:[]}));
      cliRender();`);
  });
  const shown = () => page.evaluate(() => document.querySelectorAll('#cliList .client-card').length);
  const card = page.locator('#cliS0');
  await expect.poll(shown).toBe(40);
  await expect(card).toHaveText('40');
  await page.locator('.tabs-wrap .tab', { hasText: 'Vigentes' }).click();
  await expect.poll(shown).toBe(30);
  await expect(card).toHaveText('30');
  await expect(page.locator('#cliB0')).toHaveText('40');
  await page.locator('#cliSearch').fill('sintético 0');
  await expect.poll(shown).toBe(10);
  await expect(card).toHaveText('10');
});

// Hotfix post-#749: con «Deuda total S/ 4125.00» la columna del nombre no debe encogerse
// hasta mostrar «MIS…» cuando sobra espacio; la elipsis solo aparece si el nombre de verdad no entra.
async function openFichaConDeuda(page: Page, width: number, name: string) {
  await openClientes(page, width);
  await page.evaluate(name => {
    (window as any).eval(`clientes=[{id:'ficha-deuda',nombre:${JSON.stringify(name)},dni:'',tel:'',creditCategories:[]}];
      creditos=[{id:'cr-ficha',credit_id:'cr-ficha',cliId:'ficha-deuda',clienteId:'ficha-deuda',monto:4125,pagado:0,fecha:'2026-09-01',vence:'2099-01-01',status:'vigente',estado:'vigente',anulado:false,pagos:[]}];`);
    (window as any).naCanonOpenClientAccount('ficha-deuda');
  }, name);
  await expect(page.locator('.na-v2-client-head h2')).toBeVisible();
  await expect(page.locator('.na-v2-head-money strong')).toContainText('4125.00');
  await waitFichaStable(page);
}

for (const width of [1366, 1024, 390]) {
  test(`ficha ${width}px: «MISAEL» se ve completo junto a la deuda, sin elipsis`, async ({ page }) => {
    await openFichaConDeuda(page, width, 'MISAEL');
    const h2 = page.locator('.na-v2-client-head h2');
    await expect(h2).toHaveText('MISAEL');
    const fit = await h2.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    // El monto tampoco se recorta ni se desborda.
    const money = await page.locator('.na-v2-head-money strong').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
    expect(money).toBe(true);
    expect(await wordsSplit(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test(`ficha ${width}px: nombre muy largo puede llevar elipsis pero nunca parte una palabra`, async ({ page }) => {
    await openFichaConDeuda(page, width, 'MISAELMONTENEGROQUISPEHUAMANCHUMODELASFLORESYCASTILLO PEREZ');
    const h2 = page.locator('.na-v2-client-head h2');
    expect(await wordsSplit(page)).toEqual([]);
    const css = await h2.evaluate(el => { const s = getComputedStyle(el); return [s.textOverflow, s.overflowX]; });
    expect(css).toEqual(['ellipsis', 'hidden']);
    const money = await page.locator('.na-v2-head-money strong').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
    expect(money).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}
