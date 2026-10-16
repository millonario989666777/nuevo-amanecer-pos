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
      expect(await wordsSplit(page)).toEqual([]);
      const css = await h2.evaluate(el => { const s = getComputedStyle(el); return [s.overflowWrap, s.wordBreak, s.textOverflow]; });
      expect(css).toEqual(['normal', 'normal', 'ellipsis']);
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
