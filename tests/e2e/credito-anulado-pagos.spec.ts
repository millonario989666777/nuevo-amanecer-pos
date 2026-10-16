import { test, expect, type Page } from '@playwright/test';

// Crédito anulado solo por source_status (como llega de CANON), sin anulado:true. Datos sintéticos, sin servidor.
// a) no se puede elegir ni cobrar; b) un pago en cola no se aplica a él; c) el reparto automático lo salta;
// d) la ficha lo muestra ANULADO, no suma al saldo y conserva sus pagos.
const SEED = `
  clientes=[{id:'c-anul',nombre:'CLIENTE ANULADO PRUEBA',dni:'',tel:'',creditCategories:[]}];
  creditos=[
    {id:'cr-a',credit_id:'cr-a',cliId:'c-anul',clienteId:'c-anul',desc:'Crédito A',monto:100,pagado:0,saldo:100,fecha:'2026-09-01',vence:'2099-01-31',status:'vigente',estado:'vigente',anulado:false,pagos:[],items:[]},
    {id:'cr-x',credit_id:'cr-x',cliId:'c-anul',clienteId:'c-anul',desc:'Crédito anulado X',monto:70,pagado:20,saldo:50,fecha:'2026-08-01',vence:'2099-01-15',status:'ANULADO',estado:'ANULADO',source_status:'ANULADO',anulado:false,
      pagos:[{pagoId:'pg-x1',id:'pg-x1',monto:20,metodo:'efectivo',fecha:'2026-08-10',hora:'10:00',hora24:'10:00:00',timestamp:'2026-08-10T15:00:00.000Z',saldoAnterior:70,saldoActual:50}],items:[]},
    {id:'cr-b',credit_id:'cr-b',cliId:'c-anul',clienteId:'c-anul',desc:'Crédito B',monto:50,pagado:0,saldo:50,fecha:'2026-09-15',vence:'2099-02-28',status:'vigente',estado:'vigente',anulado:false,pagos:[],items:[]}
  ];`;
const snapshot = (page: Page) => page.evaluate(() => JSON.stringify((window as any).eval('creditos')));

async function open(page: Page) {
  await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/index.html');
  await page.waitForFunction(() => (window as any).NA_MENU_NAVIGATION && typeof (window as any).naCanonOpenClientAccount === 'function' && typeof (window as any)._naIsCreditVoided === 'function');
  await page.evaluate(() => (window as any).NA_MENU_NAVIGATION.navigate('pageClientes'));
  await page.evaluate(seed => { (window as any).eval(seed + 'cliRender();'); }, SEED);
}
const debt = (page: Page) => page.evaluate(() => {
  const w = window as any, c = w.eval('clientes[0]');
  return { readOnly: w.NA_CLIENT_CREDIT_ACCOUNTS_V2.summarizeClient(c, true).debt, normal: w.NA_CLIENT_CREDIT_ACCOUNTS_V2.summarizeClient(c, false).debt, index: w._naClientDebtFast(c) };
});

test('a) el crédito anulado no se puede elegir ni cobrar (Cobrar, cobro múltiple y ficha)', async ({ page }) => {
  await open(page);
  const before = await snapshot(page);
  // Cobrar (abrirPago): no abre el diálogo y avisa.
  await page.evaluate(() => (window as any).abrirPago('cr-x'));
  await expect(page.locator('#mPagoCred')).not.toHaveClass(/open/);
  await expect(page.locator('#gToast')).toContainText('No se pueden registrar pagos en un crédito anulado');
  // Confirmar un abono forzando el id del anulado: bloqueado, nada cambia.
  await page.evaluate(() => { const w = window as any; w.eval("pagoCredId='cr-x'"); (document.getElementById('pagoMonto') as HTMLInputElement).value = '10'; return w.confirmarPago(); });
  await expect(page.locator('#gToast')).toContainText('No se pueden registrar pagos en un crédito anulado');
  expect(await snapshot(page)).toBe(before);
  // Ficha V2 y cobro múltiple: el anulado no aparece entre los créditos elegibles.
  await page.evaluate(() => (window as any).naCanonOpenClientAccount('c-anul'));
  await expect(page.locator('.na-client-account-screen')).toBeVisible();
  await expect(page.locator('.na-client-account-screen')).not.toContainText('Crédito anulado X');
  const eligible = await page.evaluate(() => {
    const w = window as any, s = w.NA_CLIENT_CREDIT_ACCOUNTS_V2.summarizeClient(w.eval('clientes[0]'), false);
    return { active: s.active.map((c: any) => c.id).sort(), all: s.all.map((c: any) => c.id).sort() };
  });
  expect(eligible).toEqual({ active: ['cr-a', 'cr-b'], all: ['cr-a', 'cr-b'] });
  // Un crédito vigente sí abre Cobrar (control).
  await page.evaluate(() => (window as any).abrirPago('cr-a'));
  await expect(page.locator('#mPagoCred')).toHaveClass(/open/);
});

test('b) un pago en cola (offline/sync) dirigido al anulado no se aplica; a un vigente sí', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const w = window as any, api = w.NA_CLIENT_CREDIT_ACCOUNTS_V2, s = api.summarizeClient(w.eval('clientes[0]'), true);
    const queued = (credit: string, cents: number, op: string) => ({ command: 'payment.batch', state: 'PENDING', payload: { payments: [{ operation_id: op, credit_id: credit, amount_cents: cents }] } });
    return {
      none: api.debtFilter.effectiveBalance(s, null),
      toVoided: api.debtFilter.effectiveBalance(s, queued('cr-x', 5000, 'OP-X')),
      toLive: api.debtFilter.effectiveBalance(s, queued('cr-a', 3000, 'OP-A')),
      single: api.debtFilter.effectiveBalance(s, { command: 'payment.create', state: 'PENDING', payload: { operation_id: 'OP-X2', credit_id: 'cr-x', amount_cents: 2000 } })
    };
  });
  expect(result).toEqual({ none: 150, toVoided: 150, toLive: 120, single: 150 });
});

test('c) reparto automático (cobro múltiple): salta el anulado y los saldos cuadran', async ({ page }) => {
  await open(page);
  const plan = await page.evaluate(() => {
    const w = window as any, all = w.eval('creditos');
    return JSON.parse(JSON.stringify(w.NA_CLIENT_CREDIT_ACCOUNTS_V2.batchAllocationPlan(all, 15000)));
  });
  expect(plan.allocations).toEqual([{ credit_id: 'cr-a', amount_cents: 10000 }, { credit_id: 'cr-b', amount_cents: 5000 }]);
  expect(plan.selected_cents).toBe(15000);
  expect(plan.unallocated_cents).toBe(0);
  expect(plan.valid).toBe(true);
  // Pedir más que lo cobrable no lo reparte al anulado: queda sin asignar.
  const over = await page.evaluate(() => { const w = window as any; return JSON.parse(JSON.stringify(w.NA_CLIENT_CREDIT_ACCOUNTS_V2.batchAllocationPlan(w.eval('creditos'), 20000))); });
  expect(over.allocations.map((a: any) => a.credit_id)).toEqual(['cr-a', 'cr-b']);
  expect(over.unallocated_cents).toBe(5000);
  expect(over.valid).toBe(false);
});

test('d) la ficha muestra ANULADO, no suma al saldo y conserva el historial de pagos', async ({ page }) => {
  await open(page);
  expect(await debt(page)).toEqual({ readOnly: 150, normal: 150, index: 150 });
  await expect(page.locator('#cliList')).toContainText('150');
  await page.evaluate(() => (window as any).abrirDetalleCredito('cr-x'));
  const detail = page.locator('#creditoDetalleContent');
  await expect(detail).toContainText('ANULADO');
  await expect(detail).toContainText('Historial completo de pagos (1)');
  await expect(detail).toContainText('20.00');
  await expect(detail).not.toContainText('Registrar pago');
  await expect(detail).not.toContainText('Revertir pago');
  expect(await page.evaluate(() => (window as any).eval('creditos[1].pagos.length'))).toBe(1);
  expect(await page.evaluate(() => (window as any).eval('creditos[1].status'))).toBe('ANULADO');
});
