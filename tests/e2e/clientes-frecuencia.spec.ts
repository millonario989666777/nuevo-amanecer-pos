import { test, expect, type Page } from '@playwright/test';

test.use({ timezoneId: 'UTC' });

async function rolePage(page: Page, role: 'owner' | 'empleado') {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'frequency-test-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'frequency-synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => (window as any).NA_ROLES?.role === role && (window as any).NA_ROLES.confirmed, role);
}
async function seed(page: Page) {
  await page.evaluate(() => {
    (window as any).eval(`
      productos=[{id:'cf-product',name:'Producto de prueba',stock:10}];
      clientes=[
        {id:'cf-inactive',nombre:'Cliente inactivo de prueba con un nombre muy largo para verificar lectura en teléfono'},
        {id:'cf-due',nombre:'José Álvarez <img src=x onerror=alert(1)> & "Cliente"'},
        {id:'cf-current',nombre:'Cliente al día'},
        {id:'cf-single',nombre:'Cliente de una sola compra'},
        {id:'cf-history',nombre:'Cliente histórico de 180 días'},
        {id:'cf-year',nombre:'Cliente histórico de 365 días'},
        {id:'cf-void',nombre:'Cliente solo con venta anulada'}
      ];
      var cfToday=NA_CLIENTES_FRECUENCIA.periodRange(90).to;
      var cfDayAgo=days=>new Date(Date.parse(cfToday+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
      var cfSale=(id,days,extra)=>Object.assign({id:'cf-'+id+'-'+days,clienteId:'cf-'+id,fecha:cfDayAgo(days),items:[{id:'cf-product',precio:10,qty:1}]},extra||{});
      ventas=[
        cfSale('inactive',80),cfSale('inactive',70),
        cfSale('due',25),cfSale('due',15),
        cfSale('current',10),cfSale('current',0,{pending:true}),
        cfSale('single',1),cfSale('history',100),cfSale('year',200),
        cfSale('void',0,{anulada:true}),cfSale('anonymous',0,{clienteId:null,clienteNombre:'Consumidor final'})
      ];
      creditos=[{id:'cf-credit',cliId:'cf-current',monto:10,pagado:0,pagos:[{id:'cf-pending-payment',monto:2,pending:true}]}];
      cajMovs=[{id:'cf-cash',tipo:'ing',monto:10}];
    `);
  });
}
async function readState(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).eval('JSON.stringify({productos,ventas,clientes,creditos,cajMovs})');
    const storage = Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
    return { state, storage };
  });
}
async function noOverflow(page: Page) {
  expect(await page.locator('#pageClientesFrecuencia').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('#pageClientesFrecuencia').evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('h1,select,input,button,tbody th,tbody td,.cf-badge,.cf-summary-card')].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
  const select = page.locator('#pageClientesFrecuencia [data-cf-period]');
  const [needed, actual] = await select.evaluate(node => {
    const clone = node.cloneNode(true) as HTMLSelectElement;
    clone.style.width = 'max-content'; clone.style.position = 'absolute'; clone.style.visibility = 'hidden';
    node.parentElement!.appendChild(clone);
    const result = [clone.getBoundingClientRect().width, node.getBoundingClientRect().width];
    clone.remove();
    return result;
  });
  expect(actual + 0.5).toBeGreaterThanOrEqual(needed);
}

for (const width of [390, 768, 1366]) for (const dark of [false, true]) {
  test(`owner opens customer frequency from Próximamente at ${width}px, ${dark ? 'dark' : 'light'}, without overflow or writes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // A device set outside Peru must still report Lima calendar days.
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await rolePage(page, 'owner');
    await seed(page);
    const before = await readState(page);
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.evaluate(dark => { document.body.classList.toggle('dark', dark); (window as any).goPage('pageProximamente'); }, dark);
    const card = page.locator('#pageProximamente [data-feature-id="clientes-frecuencia"]');
    await expect(card).toHaveClass(/is-enabled/);
    await expect(card).toContainText('Disponible');
    await card.click();
    const screen = page.locator('#pageClientesFrecuencia');
    await expect(screen).toBeVisible();
    await expect(screen.locator('[data-cf-period]')).toHaveValue('90');
    await expect(screen.locator('.cf-summary-card').nth(0)).toContainText('4');
    await expect(screen.locator('.cf-summary-card').nth(1)).toContainText('7');
    await expect(screen.locator('.cf-summary-card').nth(2)).toContainText('2');
    await expect(screen.locator('.cf-summary-card').nth(3)).toContainText('S/ 70.00');
    const rows = screen.locator('tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute('data-cf-state', 'Inactivo');
    await expect(rows.nth(1)).toHaveAttribute('data-cf-state', 'Por volver');
    await expect(rows.nth(2)).toHaveAttribute('data-cf-state', 'Al día');
    await expect(rows.nth(3)).toHaveAttribute('data-cf-state', 'Una sola compra');
    await expect(rows.nth(1)).toContainText('José Álvarez <img src=x onerror=alert(1)> & "Cliente"');
    await expect(rows.nth(1).locator('[data-label="Cada (días)"]')).toHaveText('10');
    await expect(rows.nth(1).locator('[data-label="Días sin comprar"]')).toHaveText('15');
    await expect(rows.nth(1).locator('[data-label="Última compra"]')).toHaveText(await page.evaluate(() => {
      const today = (window as any).NA_CLIENTES_FRECUENCIA.periodRange(90).to;
      return new Date(Date.parse(today + 'T00:00:00Z') - 15 * 86400000).toISOString().slice(0, 10).split('-').reverse().join('/');
    }));
    await expect(rows.nth(3).locator('[data-label="Cada (días)"]')).toHaveText('—');
    await expect(screen.locator('img,script')).toHaveCount(0);
    await expect(screen).not.toContainText('Consumidor final');
    await expect(screen).not.toContainText('Cliente solo con venta anulada');
    await expect(screen).toHaveCSS('background-color', dark ? 'rgb(15, 23, 42)' : 'rgb(248, 250, 252)');
    await noOverflow(page);
    const search = screen.locator('[data-cf-search]');
    await search.fill('jose alv');
    await expect(rows).toHaveCount(1);
    await expect(screen.locator('.cf-summary-card').nth(3)).toContainText('S/ 20.00');
    await search.fill('sin coincidencia');
    await expect(rows).toHaveCount(0);
    await expect(screen).toContainText('No hay compras');
    await search.fill('');
    await screen.locator('[data-cf-period]').selectOption('180');
    await expect(rows).toHaveCount(5);
    await expect(screen.locator('.cf-summary-card').nth(3)).toContainText('S/ 80.00');
    await noOverflow(page);
    await screen.locator('[data-cf-period]').selectOption('365');
    await expect(rows).toHaveCount(6);
    await expect(screen.locator('.cf-summary-card').nth(3)).toContainText('S/ 90.00');
    await noOverflow(page);
    const refresh = screen.getByRole('button', { name: 'Actualizar reporte' });
    await refresh.scrollIntoViewIfNeeded();
    expect(await refresh.evaluate(button => {
      const r = button.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === button || button.contains(hit));
    })).toBe(true);
    await refresh.click();
    expect(await readState(page)).toEqual(before);
    expect(writes).toEqual([]);
    if (width === 390) {
      await page.evaluate(() => (window as any).goMenu());
      await page.locator('#naMobileMenuToggle').click();
      await expect(page.locator('#naMobileDrawer [data-page="pageClientesFrecuencia"]')).toHaveCount(0);
      await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageProximamente'); });
      await card.click();
      await expect(screen).toBeVisible();
      await expect(rows).toHaveCount(6);
      expect(await readState(page)).toEqual(before);
      expect(writes).toEqual([]);
    }
  });
}

for (const width of [650, 1000]) {
  test(`owner sees every customer frequency cell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await rolePage(page, 'owner');
    await seed(page);
    await page.evaluate(() => (window as any).goPage('pageProximamente'));
    await page.locator('#pageProximamente [data-feature-id="clientes-frecuencia"]').click();
    const screen = page.locator('#pageClientesFrecuencia');
    await expect(screen).toBeVisible();
    const tables = screen.locator('table');
    expect(await tables.count()).toBeGreaterThan(0);
    for (const table of await tables.all()) {
      await expect(table.locator('tbody tr')).toHaveCount(4);
      await expect(table).toHaveCSS('display', width === 650 ? 'block' : 'table');
      // At 650px the column headers are intentionally clipped for cards;
      // row headers and every data cell must still have visible content.
      const cells = table.locator(width === 650 ? 'tbody :is(th, td)' : 'th, td');
      await expect(cells).toHaveCount(width === 650 ? 28 : 35);
      for (const cell of await cells.all()) {
        await expect(cell).toBeVisible();
        await expect.poll(() => cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
      }
    }
  });
}

async function openFrequency(page: Page, width: number, dark = false) {
  await page.setViewportSize({ width, height: 900 });
  await rolePage(page, 'owner');
  await seed(page);
  if (dark) await page.evaluate(() => document.body.classList.add('dark'));
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  await page.locator('#pageProximamente [data-feature-id="clientes-frecuencia"]').click();
  const screen = page.locator('#pageClientesFrecuencia');
  await expect(screen.locator('.cf-table')).toBeVisible();
  return screen;
}
for (const width of [650, 700, 1000]) {
  test(`${width}px: Última compra and Días sin comprar remain visible in customer frequency`, async ({ page }) => {
    const screen = await openFrequency(page, width);
    await expect(screen.locator('.cf-table')).toHaveCSS('display', width < 900 ? 'block' : 'table');
    await expect(screen.locator('tbody tr')).toHaveCount(4);
    for (const label of ['Última compra', 'Días sin comprar']) {
      const cells = screen.locator(`.cf-table tbody td[data-label="${label}"]`);
      await expect(cells).toHaveCount(4);
      for (const cell of await cells.all()) {
        await expect(cell).toBeVisible();
        await expect(cell).toHaveCSS('display', width < 900 ? 'block' : 'table-cell');
        await expect.poll(() => cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
      }
    }
    if (width === 1000) {
      const cells = screen.locator('.cf-table :is(th, td):is(:nth-child(4), :nth-child(5))');
      await expect(cells).toHaveCount(10);
      for (const cell of await cells.all()) {
        await expect(cell).toBeVisible();
        await expect(cell).toHaveCSS('display', 'table-cell');
        await expect.poll(() => cell.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
      }
    }
  });
}
test('1366px: numeric headers Compras, Días sin comprar e Importe align right like their numbers', async ({ page }) => {
  const screen = await openFrequency(page, 1366);
  for (const label of ['Compras', 'Días sin comprar', 'Importe']) {
    await expect(screen.locator('.cf-table thead th', { hasText: new RegExp('^' + label + '$') })).toHaveCSS('text-align', 'right');
  }
  await expect(screen.locator('.cf-table thead th', { hasText: /^Cliente$/ })).toHaveCSS('text-align', 'left');
});
test('650px card: «S/» stays joined to the amount with a non-breaking space', async ({ page }) => {
  const screen = await openFrequency(page, 650);
  const texts = await screen.locator('.cf-table td[data-label="Importe"], .cf-summary-card strong').allTextContents();
  const money = texts.filter(t => t.startsWith('S/'));
  expect(money.length).toBeGreaterThan(0);
  for (const t of money) expect(t).toMatch(/^S\/\u00a0\d/);
});
test('650px Nocturno card: customer name meets WCAG AA contrast', async ({ page }) => {
  const screen = await openFrequency(page, 650, true);
  const ratios = await screen.locator('.cf-table tbody th').evaluateAll(nodes => nodes.map(node => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let el: HTMLElement | null = node as HTMLElement, bg = 'rgba(0, 0, 0, 0)';
    while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
    const a = lum(rgb(getComputedStyle(node).color)), b = lum(rgb(bg));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }));
  expect(ratios.length).toBeGreaterThan(0);
  for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
});

test('employee cannot see the card or open frequency; direct rendering exposes no customer data', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await rolePage(page, 'empleado');
  await seed(page);
  const before = await readState(page);
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
  await page.locator('#naMobileMenuToggle').click();
  await expect(page.locator('#naMobileDrawer [data-page="pageClientesFrecuencia"]')).toHaveCount(0);
  await page.evaluate(() => { (window as any).NA_MENU_NAVIGATION.closeMobileDrawer(); (window as any).goPage('pageProximamente'); });
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  await expect(page.locator('[data-feature-id="clientes-frecuencia"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).goPage('pageClientesFrecuencia'));
  await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
  const screen = page.locator('#pageClientesFrecuencia');
  await expect(screen).not.toHaveClass(/\bactive\b/);
  await page.evaluate(() => (window as any).NA_CLIENTES_FRECUENCIA.render());
  await expect(screen.locator('[data-cf-content]')).toBeEmpty();
  await expect(screen.locator('[data-cf-status]')).toContainText('Sin permiso');
  await expect(screen.locator('[data-cf-controls]')).toBeHidden();
  expect(await readState(page)).toEqual(before);
  expect(writes).toEqual([]);
});

test('revoking owner access clears already-rendered customer amounts', async ({ page }) => {
  await rolePage(page, 'owner');
  await seed(page);
  await page.evaluate(() => (window as any).goPage('pageProximamente'));
  await page.locator('[data-feature-id="clientes-frecuencia"]').click();
  await expect(page.locator('#pageClientesFrecuencia tbody tr')).toHaveCount(4);
  await page.route('https://permissions.test/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
    { pos_role: 'empleado', owner_pin_set: true, roles_ready: true, device_id: 'frequency-test-device' }) }));
  await page.evaluate(() => (window as any).NA_ROLES.refresh());
  await page.waitForFunction(() => (window as any).NA_ROLES.role === 'empleado');
  await expect(page.locator('#pageClientesFrecuencia [data-cf-content]')).toBeEmpty();
  await expect(page.locator('#pageClientesFrecuencia [data-cf-controls]')).toBeHidden();
});
