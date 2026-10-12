// Regression tests for the caja/connection audit (C-P0-1, C-P1 boot recovery).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device, storage } from './canon-browser-harness.mjs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SCRIPTS = ['canonical-sale-intent', 'canonical-sale-outbox'].map((n) => [n, read('POS/js/sync/' + n + '.js')]);
const BRIDGE = ['cash-bridge', read('POS/js/sync/canonical-cash-bridge.js')];
const MIGS = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql'];
const UI = { cajRender() {}, _naAuthorize() { return true; }, _naF10AuthorizePermission() { return true; }, _naFindCashier() { return { id: 'c1', nombre: 'C1' }; } };
function intentFor(d, sale_id) {
  const p = d.api.snapshot().products.find((x) => Number(x.current_stock_quantity) >= 5) || d.api.snapshot().products[0];
  return d.context.NuevoAmanecerCanonicalSaleIntent.build({ sale_id, payment_method: 'efectivo', items: [{ product_id: p.product_id, quantity: 1, precio: p.price_cents / 100 }] });
}

for (const variant of ['lost-ack', 'rejected-409']) {
  test(`C-P0-1 cash.open ${variant}: never freezes the POS; retry is idempotent and sales keep flowing`, async (t) => {
    const f = await activeCanon(t, { migrations: MIGS });
    let mode = 'ok';
    const d = await device(f, { token: 'o-a', deviceId: 'o-a', scripts: [...SCRIPTS, BRIDGE], globals: UI,
      onFetch: async (url, _o, real) => {
        if (url.endsWith('/commands/cash.open') && mode === 'lost') { await real(); throw new TypeError('Failed to fetch'); }
        if (url.endsWith('/commands/cash.open') && mode === '409') return Response.json({ error: 'financial_conflict' }, { status: 409 });
        return null;
      } });
    mode = variant === 'lost-ack' ? 'lost' : '409';
    d.el('cajFondo').value = '10'; d.el('cajCajero').value = 'c1';
    assert.equal(await d.context.abrirCaja(), false);
    assert.equal(d.api.pendingSnapshot().command, 'cash.open');
    assert.match(d.toasts.at(-1)[0], variant === 'lost-ack' ? /sin confirmación del servidor.*no se duplica/ : /CANON lo rechazó \(financial_conflict\)/);
    mode = 'ok';
    assert.equal(await d.context.abrirCaja(), true, 'the second attempt recovers');
    assert.equal(d.api.pendingSnapshot(), null);
    assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_cash_sessions').n, 1, 'exactly one till, never two');
    if (variant === 'lost-ack') assert.match(d.toasts.at(-1)[0], /La apertura anterior sí llegó/);
    else assert.ok(JSON.parse(d.localStorage.getItem('na_canonical_rejected_operations')).some((r) => r.command === 'cash.open'), 'rejection archived, never silently dropped');
    await d.api.refresh();
    const outbox = d.context.NuevoAmanecerCanonicalSaleOutbox;
    await outbox.enqueue(intentFor(d, 'V-100'));
    assert.equal((await outbox.sync()).status, 'DRAINED');
  });
}

test('C-P0-1: a stranded non-sale operation is settled by the sale drain (replay same id / release 4xx), never blocking sales', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS });
  let lost = true;
  const d = await device(f, { token: 'o-b', deviceId: 'o-b', scripts: [...SCRIPTS, BRIDGE], globals: UI,
    onFetch: async (url, _o, real) => { if (lost && url.endsWith('/commands/adjustment.create')) { await real(); throw new TypeError('Failed to fetch'); } return null; } });
  await d.api.openCash({ session_id: 'S1', opening_cents: 1000 }); await d.api.refresh();
  await assert.rejects(d.api.createAdjustment({ amount_cents: 500, reason: 'Ingreso test' }));
  lost = false;
  const outbox = d.context.NuevoAmanecerCanonicalSaleOutbox;
  await outbox.enqueue(intentFor(d, 'V-200'));
  for (let i = 0; i < 3 && outbox.snapshot().intents.length; i++) await outbox.sync();
  assert.equal(outbox.snapshot().intents.length, 0);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_operations WHERE command='adjustment.create'").n, 1, 'replayed once, never duplicated');
});

function replicaStore() { let s = null; return { _naReadCanonicalReplica: async () => s && JSON.parse(JSON.stringify(s)), _naWriteCanonicalReplica: async (v) => { s = JSON.parse(JSON.stringify(v)); return true; } }; }
test('C-P1: a boot 500 while online recovers by itself (no "online" event needed) and drains the queue', async (t) => {
  const f = await activeCanon(t, { migrations: MIGS }); const rep = replicaStore(); const ls = storage();
  const a = await device(f, { token: 'f-a', deviceId: 'f-a', localStorage: ls, scripts: SCRIPTS, globals: rep });
  await a.api.openCash({ session_id: 'F1', opening_cents: 1000 }); await a.api.refresh();
  let fail = false;
  const tab = await device(f, { token: 'f-a', localStorage: ls, scripts: SCRIPTS, globals: rep, onFetch: async (url) => (fail && url.includes('/read/canonical/status') ? new Response('{}', { status: 500 }) : null) });
  fail = true;
  await tab.api.startPOS(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(tab.api.sourceState().validation, 'stale', 'a 500 online is stale, not offline');
  fail = false;
  const ob = tab.context.NuevoAmanecerCanonicalSaleOutbox; await ob.enqueue(intentFor(tab, 'V-900'));
  await ob.start();
  for (let i = 0; i < 40 && ob.snapshot().intents.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(ob.snapshot().intents.length, 0);
  assert.equal(f.sql("SELECT COUNT(*) n FROM sales WHERE sale_id='V-900'").n, 1);
});
