import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon, device } from './canon-browser-harness.mjs';

// P1-1 / P1-2 (móvil, Clientes · Abonos · Caja): después de un abono o un cierre
// confirmado se releen solo las colecciones que ese comando puede cambiar, y un
// cierre con la réplica "stale" solo necesita status + credit-accounts + cash-sessions.
const CREDIT = 'CR:001';
const routes = (log) => log.filter((x) => x.method === 'GET' && x.url.includes('/read/canonical/'))
  .map((x) => new URL(x.url).pathname.replace('/read/canonical/', ''));
const COLLECTIONS = ['products', 'customers', 'credits', 'payments', 'creditAccounts', 'sales', 'saleItems', 'inventoryMovements', 'cashMovements', 'cashSessions', 'financialEvents', 'expenses'];
function pick(snapshot) { return JSON.parse(JSON.stringify(Object.fromEntries(COLLECTIONS.map((key) => [key, snapshot[key]])))); }
async function openCash(tab) {
  await tab.api.openCash({ session_id: 'targeted-cash', opening_cents: 5000 });
  await tab.api.refresh();
}

test('abono confirmado: relee 7 rutas (no 13) y la réplica queda idéntica a una lectura completa', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  await openCash(tab);
  assert.equal(tab.api.sourceState().validation, 'current');
  const before = tab.fetchLog.length;
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'efectivo' });
  await tab.api.refresh();
  assert.deepEqual(routes(tab.fetchLog.slice(before)).sort(),
    ['cash-movements', 'cash-sessions', 'credit-accounts', 'credit-payments', 'credits', 'financial-events', 'status']);
  assert.equal(tab.api.sourceState().validation, 'current');
  const fresh = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  assert.deepEqual(pick(tab.api.snapshot()), pick(fresh.api.snapshot()), 'targeted == full authority read');
  assert.equal(tab.api.snapshot().credits.find((c) => c.credit_id === CREDIT).current_balance_cents, 600);
  // The next abono reuses the targeted replica (no full read in between).
  const second = tab.fetchLog.length;
  await tab.api.prepareCommand('payment.create');
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'TGT-2' });
  await tab.api.refresh();
  assert.equal(routes(tab.fetchLog.slice(second)).length, 7);
  const fresh2 = await device(f, { token: 'device-c-token', deviceId: 'device-c' });
  assert.deepEqual(pick(tab.api.snapshot()), pick(fresh2.api.snapshot()));
});

test('si otro equipo escribió entre medio (financial_revision salta más de lo propio) se relee TODO', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const other = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  await other.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'OTHER-1' });
  const before = tab.fetchLog.length;
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'MINE-1' }).catch((e) => e);
  await tab.api.refresh();
  const read = routes(tab.fetchLog.slice(before));
  for (const route of ['products', 'customers', 'sales', 'sale-items', 'inventory-movements', 'expenses']) assert.ok(read.includes(route), route + ' must be re-read');
  const fresh = await device(f, { token: 'device-c-token', deviceId: 'device-c' });
  assert.deepEqual(pick(tab.api.snapshot()), pick(fresh.api.snapshot()));
});

test('cierre de caja confirmado: relee status, credit-accounts, cash-sessions y cash-movements', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  await openCash(tab);
  const before = tab.fetchLog.length;
  const receipt = await tab.api.closeCash({ counted_cents: 5000 });
  assert.equal(receipt.difference_cents, 0);
  await tab.api.refresh();
  assert.deepEqual(routes(tab.fetchLog.slice(before)).sort(), ['cash-movements', 'cash-sessions', 'credit-accounts', 'status']);
  const fresh = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  assert.deepEqual(pick(tab.api.snapshot()), pick(fresh.api.snapshot()));
});

test('P1-2: con la réplica "stale" el cierre revalida solo status + credit-accounts + cash-sessions y cierra', async (t) => {
  const f = await activeCanon(t);
  let failProducts = false;
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a',
    async onFetch(url) { if (failProducts && url.includes('/read/canonical/products')) return new Response('{"error":"busy"}', { status: 503 }); return null; } });
  await openCash(tab);
  // Another device moves the authority, then this device's refresh fails -> stale.
  const other = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  await other.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'OTHER-CLOSE' });
  failProducts = true;
  await assert.rejects(tab.api.refresh());
  assert.equal(tab.api.sourceState().validation, 'stale');
  const before = tab.fetchLog.length;
  await tab.api.prepareCommand('cash.close');
  assert.deepEqual(routes(tab.fetchLog.slice(before)).sort(), ['cash-sessions', 'credit-accounts', 'status']);
  assert.throws(() => tab.api.assertAction('payment.create'), /CANONICAL_COMMERCE_CLOSED/, 'only the close is allowed on the partial read');
  const receipt = await tab.api.closeCash({ counted_cents: 5000 });
  assert.equal(receipt.command, 'cash.close');
  failProducts = false;
  await tab.api.refresh();
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(tab.api.snapshot().cashSessions.find((s) => s.session_id === 'targeted-cash').status, 'CLOSED');
});

function scaledTimers(scale) {
  return { setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, Math.round((ms || 0) / scale))), clearTimeout };
}
function trickle(text, chunks, everyMs, stallAfter) {
  const bytes = new TextEncoder().encode(text), size = Math.ceil(bytes.length / chunks);
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (stallAfter !== undefined && index >= stallAfter) return new Promise(() => {});
      await new Promise((r) => setTimeout(r, everyMs));
      const part = bytes.slice(index * size, (index + 1) * size); index += 1;
      if (!part.length) { controller.close(); return; }
      controller.enqueue(part);
    }
  });
}

test('lectura lenta pero con progreso termina; sin bytes durante el plazo de inactividad se aborta', async (t) => {
  const f = await activeCanon(t);
  // 1 ms real = 200 ms de la app: 8 s de inactividad = 40 ms reales.
  let mode = 'none';
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', globals: { ...scaledTimers(200), ReadableStream },
    async onFetch(url, options, forward) {
      if (mode === 'none' || !url.includes('/read/canonical/products')) return null;
      const response = await forward(), text = await response.text();
      // 20 chunks x 25 ms reales = 100 s de la app, siempre con bytes cada 5 s.
      return new Response(trickle(text, 20, 25, mode === 'stall' ? 1 : undefined), { status: response.status, headers: response.headers });
    } });
  mode = 'slow';
  await tab.api.refresh({});
  assert.equal(tab.api.sourceState().validation, 'current', 'a progressing 100 s read is not cut at 8 s');
  // Force a full read so products is requested again.
  await f.fetch; mode = 'stall';
  const other = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  await other.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'STALL-1' });
  await assert.rejects(tab.api.refresh(), /CANONICAL_READ_TIMEOUT/);
});

test('como máximo 4 lecturas CANON en vuelo a la vez', async (t) => {
  const f = await activeCanon(t);
  let inFlight = 0, max = 0, active = false;
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', globals: { ReadableStream },
    async onFetch(url, options, forward) {
      if (!active || !url.includes('/read/canonical/')) return null;
      inFlight += 1; max = Math.max(max, inFlight);
      const response = await forward(), text = await response.text();
      return new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 5)); c.enqueue(new TextEncoder().encode(text)); c.close(); inFlight -= 1; } }), { status: response.status, headers: response.headers });
    } });
  const other = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  await other.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'CONC-1' });
  active = true;
  await tab.api.refresh();
  assert.ok(max <= 4 && max >= 2, 'max in flight ' + max);
  assert.equal(tab.api.sourceState().validation, 'current');
});
