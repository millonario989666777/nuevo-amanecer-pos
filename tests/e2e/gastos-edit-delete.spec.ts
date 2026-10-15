import { test, expect } from '@playwright/test';

for (const width of [390, 768, 1366]) {
  test(`owner edits and voids expenses at ${width}px without changing cash fields`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('/index.html');
    await page.waitForFunction(() => typeof window.gasRender === 'function' && !!window.NA_ROLES);
    await page.evaluate(() => {
      const w = window as any;
      w.__expense = { id: 'fixture-expense', expenseId: 'fixture-expense', revision: 0, voided: false, desc: 'Servicio sintético', cat: 'Otro', monto: 25, metodo: 'yape', fecha: w.obtenerHoy(), nota: '' };
      w.__commands = [];
      w.NA_ROLES = { role: 'owner', confirmed: true, isOwner: () => true };
      w.NuevoAmanecerCanonical = {
        enabled: () => true,
        refresh: async () => { gastos = [{ ...w.__expense }]; },
        legacySnapshot: () => ({ expenses: [w.__expense] }),
        updateExpense: async input => {
          w.__commands.push({ command: 'expense.update', ...input });
          Object.assign(w.__expense, { desc: input.concept, cat: input.category, nota: input.note, fecha: input.expense_date, revision: 1 });
          return { revision: 1 };
        },
        voidExpense: async input => {
          w.__commands.push({ command: 'expense.void', ...input });
          Object.assign(w.__expense, { revision: 2, voided: true });
          return { revision: 2 };
        }
      };
      gastos = [{ ...w.__expense }];
      w.goPage('pageGastos');
    });
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await expect(page.locator('#mGasto')).toHaveClass(/open/);
    await expect(page.locator('#gasDesc')).toHaveValue('Servicio sintético');
    await expect(page.locator('#gasMonto')).toBeDisabled();
    await expect(page.locator('#gasMetodo')).toBeDisabled();
    await page.locator('#gasDesc').fill('Servicio corregido');
    await page.locator('#gasNota').fill('Nota corregida');
    await page.locator('#mGasto .mbtn-ok').click();
    await expect(page.locator('#gasContent')).toContainText('Servicio corregido');
    const edit = await page.evaluate(() => (window as any).__commands[0]);
    expect(edit.expected_revision).toBe(0);
    expect(edit).not.toHaveProperty('amount_cents');
    expect(edit).not.toHaveProperty('payment_method');
    const remove = page.getByRole('button', { name: 'Eliminar', exact: true });
    await expect(remove).toBeVisible();
    expect(await remove.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    page.once('dialog', dialog => dialog.dismiss());
    await remove.click();
    await expect(page.locator('#gasContent')).toContainText('Servicio corregido');
    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect(page.locator('#gasContent')).toContainText('Sin gastos');
    await expect(page.locator('#gasS0')).toHaveText('S/0');
    expect(await page.evaluate(() => (window as any).__commands[1].expected_revision)).toBe(1);
    expect(await page.locator('#pageGastos').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.evaluate(() => { const w = window as any; w.abrirModalGasto(); });
    await expect(page.locator('#gasMonto')).toBeEnabled();
    await expect(page.locator('#gasMetodo')).toBeEnabled();
  });
}

test('employee sees no expense edit or void actions', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.gasRender === 'function');
  await page.evaluate(() => {
    const w = window as any;
    w.NA_ROLES = { role: 'empleado', confirmed: true, isOwner: () => false };
    gastos = [{ expenseId: 'fixture', desc: 'Synthetic', cat: 'Otro', monto: 25, metodo: 'yape', fecha: w.obtenerHoy() }];
    w.gasRender();
  });
  await expect(page.locator('#gasContent button')).toHaveCount(0);
});
