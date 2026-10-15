import { test, expect } from '@playwright/test';

async function rolePage(page, role) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname === '/auth/me' ? { pos_role: role, owner_pin_set: true, roles_ready: true, device_id: 'employee-device' } : {}) });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(role => {
    localStorage.setItem('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://permissions.test', token: 'synthetic' }));
    localStorage.setItem('na_pos_role_v1', JSON.stringify({ role }));
  }, role);
  await page.reload();
  await page.waitForFunction(role => window.NA_ROLES?.role === role && window.NA_ROLES.confirmed, role);
}

test('employee navigation to owner screens shows a friendly permission overlay', async ({ page }) => {
  await rolePage(page, 'empleado');
  for (const id of ['pageGastos', 'pageConfig']) {
    await page.evaluate(id => window.goPage(id), id);
    await expect(page.locator('#naNoPermission')).toBeVisible();
    await expect(page.locator('#naNoPermission')).toContainText('Sin permiso');
    await expect(page.locator('#naNoPermission')).toContainText('Pídele acceso al dueño');
    await expect(page.locator('#naNoPermission .na-permission-lock')).toBeVisible();
    await expect(page.locator('#' + id)).not.toHaveClass(/\bactive\b/);
    await page.getByRole('button', { name: 'Volver a la venta', exact: true }).click();
    await expect(page.locator('#pagePOS')).toHaveClass(/\bactive\b/);
  }
  // Direct restoration/class changes are guarded even when navigation bypasses goPage.
  await page.evaluate(() => { document.getElementById('pageGastos').classList.add('active'); });
  await expect(page.locator('#naNoPermission')).toBeVisible();
  await expect(page.locator('#pageGastos')).not.toHaveClass(/\bactive\b/);
  await page.getByRole('button', { name: 'Volver a la venta', exact: true }).click();
  await page.evaluate(() => window.ventasSetTab(document.querySelector('#pageVentas .tab'), 'reportes'));
  await expect(page.locator('#naNoPermission')).toBeVisible();
});

test('owner can open expenses without a permission overlay', async ({ page }) => {
  await rolePage(page, 'owner');
  await page.evaluate(() => window.goPage('pageGastos'));
  await expect(page.locator('#pageGastos')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#naNoPermission')).toHaveCount(0);
});

test('employee cash flow offers expense creation only with their open shift', async ({ page }) => {
  await rolePage(page, 'empleado');
  await page.evaluate(() => {
    const cash = { abierta:true, sessionId:'own-shift', openedByDeviceId:'employee-device' };
    window.NuevoAmanecerCanonical = { enabled:()=>true, legacySnapshot:()=>({cashState:cash}) };
    Object.assign(cajEstado, { abierta: true, cerrada: false });
    window.goPage('pageCaja');
    window.cajRender();
  });
  const button = page.locator('#pageCaja .btn-cjac.gas');
  await expect(button).toBeVisible();
  await expect(button).toContainText('Registrar gasto / salida de caja');
  await button.click();
  await expect(page.locator('#mGasto')).toHaveClass(/\bopen\b/);
  await page.evaluate(() => {
    window.NuevoAmanecerCanonical.legacySnapshot = ()=>({cashState:{abierta:true,sessionId:'other',openedByDeviceId:'owner-device'}});
    document.querySelector('#pageCaja .cj-acciones').appendChild(document.createElement('span'));
  });
  await expect(button).toBeHidden();
});

test('permission feedback covers the viewport with a blocking backdrop on mobile', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await rolePage(page,'empleado');
  await page.evaluate(()=>window.goPage('pageGastos'));
  const overlay=page.locator('#naNoPermission');
  await expect(overlay).toBeVisible();
  const bounds=await overlay.boundingBox();
  expect(bounds.y).toBe(0);
  expect(bounds.height).toBeGreaterThanOrEqual(844);
  expect(await overlay.evaluate(el=>getComputedStyle(el).backgroundColor)).toMatch(/rgba\(15, 23, 42, 0\.55\)/);
  expect(await page.evaluate(()=>document.elementFromPoint(20,820)?.id)).toBe('naNoPermission');
  const box=await overlay.locator('.na-pin-box').boundingBox();
  const button=await overlay.getByRole('button',{name:'Volver a la venta'}).boundingBox();
  expect(button.width).toBeGreaterThanOrEqual(box.width-48);
});

test('cached owner cannot open owner screens until retry confirms the server role', async ({ page }) => {
  let confirmed = false;
  let checks = 0;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'permissions.test') {
      if (url.pathname === '/auth/me') {
        checks++;
        if (!confirmed) return route.abort();
        return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({pos_role:'owner'}) });
      }
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('na_cloud_sync_credentials',JSON.stringify({endpoint:'https://permissions.test',token:'synthetic'}));
    localStorage.setItem('na_pos_role_v1',JSON.stringify({role:'owner'}));
  });
  await page.reload();
  await page.waitForFunction(() => window.NA_ROLES?.role === 'owner' && !window.NA_ROLES.confirmed);
  for (const id of ['pageGastos','pageConfig']) {
    await page.evaluate(id => window.goPage(id), id);
    await expect(page.locator('#'+id)).not.toHaveClass(/\bactive\b/);
    await expect(page.locator('.na-offline-cfg')).toContainText('Confirmando permisos…');
  }
  await page.evaluate(() => document.getElementById('pageGastos').classList.add('active'));
  await expect(page.locator('#pageGastos')).not.toHaveClass(/\bactive\b/);
  const before = checks;
  confirmed = true;
  await page.getByRole('button',{name:'Reintentar',exact:true}).click();
  await page.waitForFunction(() => window.NA_ROLES.confirmed);
  expect(checks).toBeGreaterThan(before);
  await expect(page.locator('.na-offline-cfg')).toHaveCount(0);
  await page.evaluate(() => window.goPage('pageGastos'));
  await expect(page.locator('#pageGastos')).toHaveClass(/\bactive\b/);
});
