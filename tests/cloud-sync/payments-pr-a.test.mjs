// PR A: reintento automático del abono pendiente, rechazos locales, deudas elegidas, permisos y DNI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const banner = readFileSync('POS/js/sync/canonical-status-banner.js', 'utf8');
const v2 = readFileSync('POS/js/modules/client-credit-accounts-v2.js', 'utf8');
const in02 = readFileSync('POS/js/legacy-inline/inline-02.js', 'utf8');
const in07 = readFileSync('POS/js/legacy-inline/inline-07.js', 'utf8');
const dni = readFileSync('POS/js/config/pos-dni-lookup-client.js', 'utf8');

function loadBanner(pendingRef, sends) {
  const root = { navigator: { onLine: true }, setTimeout, clearTimeout,
    NuevoAmanecerCanonical: {
      enabled: () => true,
      pendingSnapshot: () => pendingRef.value,
      retryPending: async () => { sends.push(pendingRef.value.payload.operation_id); await new Promise(r => setTimeout(r, 20)); if (pendingRef.resolveOn === sends.length) pendingRef.value = null; },
      refresh: async () => {}
    } };
  vm.runInNewContext(banner, { globalThis: root, Date, Promise, Set, setTimeout, clearTimeout });
  return root.NuevoAmanecerStatusBanner;
}

test('abono pendiente con conexión: se reintenta al arrancar y con espera 2, 5, 15, 30 s, mismo operation_id', async () => {
  const pend = { value: { command: 'payment.batch', payload: { operation_id: 'op-1' }, last_error: 'HTTP_503', last_status: 503 }, resolveOn: 99 };
  const sends = []; const b = loadBanner(pend, sends);
  const t0 = 1_000_000;
  const at = async ms => b.retryPendingPayment(t0 + ms);
  assert.equal(await at(0), true);       // al arrancar
  assert.equal(await at(1000), false);
  assert.equal(await at(2000), true);    // +2 s
  assert.equal(await at(6000), false);
  assert.equal(await at(7000), true);    // +5 s
  assert.equal(await at(21000), false);
  assert.equal(await at(22000), true);   // +15 s
  assert.equal(await at(52000), true);   // +30 s
  assert.equal(await at(81000), false);
  assert.equal(await at(82000), true);   // sigue cada 30 s
  assert.deepEqual([...new Set(sends)], ['op-1']);
  assert.equal(sends.length, 6);
});

test('un solo envío a la vez: temporizador y «online» juntos mandan una sola petición', async () => {
  const pend = { value: { command: 'payment.batch', payload: { operation_id: 'op-2' } }, resolveOn: 1 };
  const sends = []; const b = loadBanner(pend, sends);
  await Promise.all([b.retryPendingPayment(5_000_000), b.retryOnReconnect(), b.retryOnReconnect(), b.retryPendingPayment(5_000_000)]);
  assert.equal(sends.length, 1);
  assert.equal(await b.retryPendingPayment(9_000_000), false, 'ya confirmado: no hay más envíos');
  assert.equal(sends.length, 1);
});

test('rechazo definitivo o venta pendiente: el reintento automático no envía', async () => {
  for (const value of [{ command: 'payment.batch', payload: { operation_id: 'x' }, last_error: 'E', last_status: 409 }, { command: 'sale.create', payload: { operation_id: 'y' } }]) {
    const sends = []; const b = loadBanner({ value }, sends);
    assert.equal(await b.retryPendingPayment(1), false);
    assert.equal(sends.length, 0);
  }
  assert.match(banner, /setInterval\(tick, 1000\)/);
  assert.match(banner, /retryPendingPayment\(\)\.catch\(function \(\) \{\}\); \/\/ al arrancar/);
});

test('PRIOR_CANONICAL_PAYMENT_CONFIRMED es rechazo local y el formulario vuelve lleno', () => {
  assert.match(v2, /BATCH_CASH_SESSION_REQUIRED\|PRIOR_CANONICAL_PAYMENT_CONFIRMED\)\$\//);
  assert.match(v2, /sd\.submitted = false; delete sd\.batch; naV2StoredWrite\(sd\);\s*\/\/[^\n]*\n\s*root\.setTimeout\(function \(\) \{ var sc = labScreen\(\); if \(sc && sc\.querySelector\) naV2DraftRestore\(sc, sd\); \}, 0\);/);
  assert.match(v2, /if \(!labBatchSubmitInFlight && !naV2PendingBatch\(\)\) naV2StoredWrite\(null, d\.clientId\);/, 'en vuelo no se borra el borrador');
});

test('redibujo en segundo plano conserva las deudas elegidas y avisa si cambiaron', () => {
  const cap = v2.slice(v2.indexOf('function naV2DraftCapture'), v2.indexOf('// Borrador del abono guardado'));
  assert.match(cap, /\.na-v2-batch-check:checked/);
  assert.match(cap, /st\.checks\.slice\(\)/, 'si no hay casillas, usa las del borrador guardado');
  assert.ok(v2.includes("toast('La deuda elegida ya fue pagada o cambió; revisa el abono','error')"));
});

test('aparato de empleado: sin permisos de dueño aunque el cajero local sea admin', () => {
  const ctx = { window: { NA_ROLES: { canConfigure: () => false } }, toasts: [] };
  ctx.toast = m => ctx.toasts.push(m);
  vm.runInNewContext(in02.match(/function _naEmployeeDevice\(\)\{[^\n]*\n/)[0] + in02.match(/function _naOwnerOnlyBlocked\(\)\{[^\n]*\n/)[0] + 'globalThis.e=_naEmployeeDevice;globalThis.b=_naOwnerOnlyBlocked;', ctx);
  assert.equal(ctx.e(), true); assert.equal(ctx.b(), true); assert.equal(ctx.toasts.length, 1);
  ctx.window.NA_ROLES.canConfigure = () => true; assert.equal(ctx.b(), false);
  for (const fn of ['cashierSelectActive(id)', 'cashierAddFromConfig()', 'cashierRenameFromConfig(id)', 'cashierToggleFromConfig(id)'])
    assert.ok(in02.includes('async function ' + fn + '{if(_naOwnerOnlyBlocked())return;'), fn);
  assert.match(in07, /_NA_F10_OWNER_PERMS=\['manageCashiers','configuration','accessControl','resetData','backups'\]/);
  assert.match(in07, /function _naF10HasPermission\(permission,cashier\)\{if\(!permission\)return true;if\(_NA_F10_OWNER_PERMS\.indexOf\(permission\)!==-1&&typeof _naEmployeeDevice==='function'&&_naEmployeeDevice\(\)\)return false;/);
  assert.match(in07, /cashierRenameFromConfig=async function\(\.\.\.args\)\{if\(typeof _naOwnerOnlyBlocked==='function'&&_naOwnerOnlyBlocked\(\)\)return;/);
});

test('DNI: «Reintentar» no se recrea con el blur y el aviso de límite no se pisa', () => {
  assert.match(dni, /el\.dataset\.naRetry === dni && el\.querySelector\('button'\)\) return;/);
  assert.match(dni, /btn\.addEventListener\('pointerdown', go\)/);
  assert.match(dni, /if \(failedAt\[dni\]\.limit\) hint\(limitMsg\(dni\)\); else retryHint\(dni\);/);
});
