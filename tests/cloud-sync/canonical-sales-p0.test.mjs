// Regression tests for the CANON sales P0/P1 fixes, end to end against the real
// Worker over the Turso protocol adapter (tests/cloud-sync/canon-browser-harness).
// Each case reproduces a bug found by the sales/caja/inventory audits.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { tursoSqlite } from './turso-sqlite-protocol.mjs';

const source = (name) => readFileSync(new URL('../../POS/js/' + name, import.meta.url), 'utf8');
const SALE_SCRIPTS = ['canonical-sale-intent', 'canonical-sale-outbox', 'canonical-sale-projection', 'canonical-sale-integration', 'canonical-sale-view'];
const MIGRATIONS = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql', '0017_canonical_live_customers.sql', '0018_canonical_customer_credit_policy.sql'];
// The legacy app declares these helpers as top-level `const`, which are NOT
// window properties (P1-2): the integration must find them lexically.
const LEXICAL = `let cart=[],productos=[],ventas=[],clientes=[],creditos=[],cajEstado={},cajMovs=[],posProc=false,posPayM='efectivo';
const _naSessionOpen=()=>true,_naTracksStock=()=>true,_naUnitsSold=i=>Number(i.qty)*(Number(i.unitsPerQty)||1),_naUnitsPerQty=i=>Number(i.unitsPerQty)||1;`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const salePosts = (tab) => tab.fetchLog.filter((r) => new URL(r.url).pathname === '/commands/sale.create').length;

async function seller(f, { token, deviceId, onFetch, globals = {} }) {
  const tab = await device(f, { token, deviceId, onFetch, scripts: [['lexical-runtime', LEXICAL], ...SALE_SCRIPTS.map((n) => [n, source('sync/' + n + '.js')])],
    globals: { isModuleLocked: () => false, _naPaymentState: () => ({ valid: true }), posUpdateCart() {}, posRender() {}, ...globals } });
  // Background drains are driven manually by the tests.
  tab.context.setTimeout = (fn, ms) => (ms === 0 ? 0 : setTimeout(fn, ms));
  return tab;
}
function loadLegacy(tab) {
  tab.context.__legacy = tab.api.legacySnapshot();
  vm.runInContext('productos=__legacy.products;ventas=__legacy.sales;clientes=__legacy.customers;', tab.context);
}
async function fixture(t, { production = false, onFetch, stock = 5 } = {}) {
  const f = await activeCanon(t, { migrations: MIGRATIONS });
  const turso = tursoSqlite(f.database);
  f.env.DB = turso.adapter;
  f.env.nuevo_amanecer_lab = { prepare() { throw Error('no D1'); } };
  if (production) f.env.RUNTIME_ENVIRONMENT = 'production';
  const tab = await seller(f, { token: 'p0-session', deviceId: 'p0-device', onFetch });
  await tab.api.adjustInventory({ product_id: '00001', movement_type: 'ENTRADA', quantity: stock, reason: 'Synthetic P0 stock' });
  await tab.api.refresh();
  await tab.api.openCash({ session_id: 'cash-p0', opening_cents: 0 });
  await tab.api.refresh();
  loadLegacy(tab);
  const add = (qty = 1, target = tab) => vm.runInContext(`cart=[{...productos.find(p=>p.id==='00001'),qty:${qty},precio:2}];`, target.context);
  const sell = (target = tab) => vm.runInContext('confirmarVenta()', target.context);
  return { f, tab, add, sell, turso, queue: tab.context.NuevoAmanecerCanonicalSaleOutbox };
}

for (const production of [false, true]) {
  test(`P0-1 (${production ? 'fast path' : 'ruta normal'}): stock vendido por otro equipo -> insufficient_stock, a revisión, y la siguiente venta funciona`, async (t) => {
    const { f, tab, add, sell, queue } = await fixture(t, { production });
    const other = await seller(f, { token: 'other-session', deviceId: 'other-device' });
    await other.api.adjustInventory({ product_id: '00001', movement_type: 'SALIDA', quantity: 5, reason: 'Otro equipo vendio todo' });
    await other.api.refresh();
    add(1); assert.ok(await sell(), 'captured locally');
    for (let i = 0; i < 3; i++) await queue.sync();
    const entries = queue.quarantine().entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, 'insufficient_stock');
    assert.equal(tab.api.pendingSnapshot(), null, 'journal released');
    assert.ok(salePosts(tab) <= 2, 'bounded: at most one retry, no infinite loop');
    // Restock: the next sale is NOT blocked by the one under review.
    await other.api.adjustInventory({ product_id: '00001', movement_type: 'ENTRADA', quantity: 3, reason: 'Repone' });
    await other.api.refresh();
    await tab.api.refresh(); loadLegacy(tab);
    add(1); assert.ok(await sell(), 'next sale is captured');
    assert.equal((await queue.sync()).status, 'DRAINED');
    assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n, 1);
    // The review list keeps blocking the till close.
    assert.equal(queue.quarantine().entries.filter((e) => e.status === 'QUARANTINED').length, 1);
    assert.match(tab.toasts.map((x) => x[0]).join('\n'), /en revisión: no había stock suficiente/);
  });
}

test('P0-1: stale_stock with enough stock retries once after refresh and confirms', async (t) => {
  const { f, tab, add, sell, queue } = await fixture(t);
  add(1); await sell();
  const other = await seller(f, { token: 'other-session', deviceId: 'other-device' });
  await other.api.adjustInventory({ product_id: '00001', movement_type: 'SALIDA', quantity: 1, reason: 'Merma' });
  assert.equal((await queue.sync()).status, 'DRAINED');
  assert.equal(queue.quarantine().entries.length, 0);
  assert.equal(f.sql("SELECT current_stock_quantity n FROM products WHERE product_id='00001'").n, 3);
  assert.equal(salePosts(tab), 2);
});

test('P0-2: a second sale while the first POST is in flight is enqueued (no BUSY)', async (t) => {
  let slow = false;
  const { add, sell, tab, queue } = await fixture(t, { onFetch: async (url, _o, next) => { if (slow && new URL(url).pathname === '/commands/sale.create') { await sleep(400); return next(); } } });
  slow = true;
  add(1); await sell();
  const drain = queue.sync();
  await sleep(50);
  add(1); const second = await sell();
  assert.ok(second, 'second sale captured while the first is sending');
  assert.doesNotMatch(tab.toasts.map((x) => x[0]).join('\n'), /No se guardó/);
  await drain; await queue.sync();
  assert.equal(queue.snapshot().intents.length, 0);
});

test('P0-2: a hung sale.create times out, releases the drain and replays the SAME operation_id', async (t) => {
  let hang = true;
  const { f, add, sell, tab, queue } = await fixture(t, { onFetch: async (url) => { if (hang && new URL(url).pathname === '/commands/sale.create') return new Promise(() => {}); } });
  tab.context.setTimeout = (fn, ms) => (ms === 0 ? 0 : setTimeout(fn, ms >= 15000 ? 60 : ms));
  add(1); await sell();
  const [intent] = queue.snapshot().intents;
  const first = await queue.sync();
  assert.equal(first.status, 'WAITING');
  add(1); assert.ok(await sell(), 'not blocked by the hung POST');
  hang = false;
  for (let i = 0; i < 3 && queue.snapshot().intents.length; i++) await queue.sync();
  assert.equal(queue.snapshot().intents.length, 0);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?', intent.operation_id).n, 1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n, 2);
});

test('P0-3: two devices number V-001 at once -> renumbered with the SAME operation_id, never archived', async (t) => {
  const { f, tab: a, add, sell, queue: qa } = await fixture(t);
  const b = await seller(f, { token: 'b-session', deviceId: 'b-device' }); loadLegacy(b);
  add(1, a); await sell(a);
  add(1, b); const local = await sell(b);
  const qb = b.context.NuevoAmanecerCanonicalSaleOutbox;
  const [pending] = qb.snapshot().intents;
  assert.equal((await qa.sync()).status, 'DRAINED');
  for (let i = 0; i < 3 && qb.snapshot().intents.length; i++) await qb.sync();
  assert.equal(qb.quarantine().entries.length, 0);
  const row = f.sql('SELECT sale_id FROM sales WHERE operation_id=?', pending.operation_id);
  assert.ok(row, 'B sale confirmed');
  assert.notEqual(row.sale_id, local.sale_id || pending.sale_id);
  assert.match(b.toasts.map((x) => x[0]).join('\n'), /se registra como V-\d+: otro equipo ya había usado ese número\. Es la misma venta/);
});

test('P1-4: three queued sales drain with one POST each and no full refresh between them', async (t) => {
  const { tab, add, sell, queue } = await fixture(t);
  tab.context.navigator.onLine = false;
  for (let i = 0; i < 3; i++) { add(1); await sell(); }
  tab.context.navigator.onLine = true;
  const start = tab.fetchLog.length;
  assert.equal((await queue.sync()).status, 'DRAINED');
  const seq = tab.fetchLog.slice(start).map((r) => r.method + ' ' + new URL(r.url).pathname);
  const posts = seq.map((s, i) => (s.startsWith('POST') ? i : -1)).filter((i) => i >= 0);
  assert.equal(posts.length, 3);
  assert.equal(posts[1] - posts[0], 1, 'no reads between POST 1 and POST 2: ' + seq.join(', '));
  assert.equal(posts[2] - posts[1], 1, 'no reads between POST 2 and POST 3: ' + seq.join(', '));
  assert.ok(seq.length <= 12, 'was 31 requests before: ' + seq.length);
});

test('P0-4: a 503 on sale.create and an unrelated rejected abono never gate new sales', async (t) => {
  let down = true;
  const { add, sell, tab, queue } = await fixture(t, { onFetch: async (url) => { if (down && new URL(url).pathname === '/commands/sale.create') return Response.json({ error: 'upstream' }, { status: 503 }); } });
  add(1); await sell(); await queue.sync();
  add(1); assert.ok(await sell(), 'a transient 503 does not gate');
  assert.equal(queue.quarantine().entries.length, 0);
  down = false;
  for (let i = 0; i < 3 && queue.snapshot().intents.length; i++) await queue.sync();
  assert.equal(queue.snapshot().intents.length, 0);
});

test('C-P0-2: 401/stale_authority holds the queue with the journal released and resumes after reauth with the same id', async (t) => {
  let deny = true;
  const { f, add, sell, tab, queue } = await fixture(t, { onFetch: async (url) => { if (deny && new URL(url).pathname === '/commands/sale.create') return Response.json({ error: 'unauthorized' }, { status: 401 }); } });
  add(1); await sell();
  const [intent] = queue.snapshot().intents;
  const out = await queue.sync();
  assert.equal(out.status, 'WAITING');
  assert.match(String(out.reason), /^SESSION_/);
  assert.equal(tab.api.pendingSnapshot(), null, 'journal released: the gate does not jam');
  assert.equal(queue.quarantine().entries.length, 0);
  assert.match(tab.toasts.map((x) => x[0]).join('\n'), /Sesión vencida/);
  add(1); assert.ok(await sell(), 'capture keeps working');
  deny = false;
  for (let i = 0; i < 3 && queue.snapshot().intents.length; i++) await queue.sync();
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?', intent.operation_id).n, 1);
});

test('C-P0-3: a cash sale carries the open session_id; after the close it goes to review (never annullable) and retry rebinds', async (t) => {
  const { f, add, sell, tab, queue } = await fixture(t);
  tab.context.navigator.onLine = false;
  add(1); await sell();
  const [intent] = queue.snapshot().intents;
  assert.equal(intent.session_id, 'cash-p0');
  tab.context.navigator.onLine = true;
  // Another device closes the till before this sale arrives.
  const other = await seller(f, { token: 'other-session', deviceId: 'other-device' });
  await other.api.closeCash({ counted_cents: 0 });
  await queue.sync();
  const [entry] = queue.quarantine().entries;
  assert.ok(entry && /^cash_session_(closed|required)$/.test(entry.reason), JSON.stringify(entry));
  assert.equal(queue.quarantineAnnullable(entry), false);
  assert.equal(queue.quarantineRebindsOnRetry(entry.reason), true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n, 0);
});

test('Etapa 1.3: la venta de una caja cerrada NUNCA se re-asigna en silencio; solo con la caja destino confirmada y queda registrado el origen', async (t) => {
  const { f, add, sell, tab, queue } = await fixture(t);
  tab.context.navigator.onLine = false;
  add(1); await sell();
  const [intent] = queue.snapshot().intents;
  tab.context.navigator.onLine = true;
  const other = await seller(f, { token: 'other-session', deviceId: 'other-device' });
  await other.api.closeCash({ counted_cents: 0 });
  await queue.sync();
  await tab.api.refresh();
  // Sin caja abierta: no se puede re-asignar.
  await assert.rejects(queue.resolveQuarantined(intent.operation_id, 'retry'), /QUARANTINE_REBIND_NO_OPEN_CASH/);
  await other.api.openCash({ session_id: 'cash-p0-new', opening_cents: 0 });
  await tab.api.refresh();
  assert.equal(queue.rebindTarget().session_id, 'cash-p0-new');
  // Sin confirmación explícita de la caja destino: rechazado, sigue en revisión.
  await assert.rejects(queue.resolveQuarantined(intent.operation_id, 'retry'), /QUARANTINE_REBIND_NEEDS_CONFIRMATION/);
  await assert.rejects(queue.resolveQuarantined(intent.operation_id, 'retry', { targetSessionId: 'cash-p0' }), /QUARANTINE_REBIND_NEEDS_CONFIRMATION/);
  assert.equal(queue.quarantine().entries[0].status, 'QUARANTINED');
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales').n, 0);
  const done = await queue.resolveQuarantined(intent.operation_id, 'retry', { targetSessionId: 'cash-p0-new', by: 'dueño' });
  assert.equal(done.status, 'REQUEUED');
  const [entry] = queue.quarantine().entries;
  assert.equal(entry.rebound_from_session_id, 'cash-p0');
  assert.equal(entry.rebound_to_session_id, 'cash-p0-new');
  assert.equal(queue.snapshot().intents.find((x) => x.operation_id === intent.operation_id).session_id, 'cash-p0-new', 'reenvío atado a la caja confirmada (el servidor exige que siga OPEN)');
  for (let i = 0; i < 3 && queue.snapshot().intents.length; i++) await queue.sync();
  assert.equal(f.sql('SELECT COUNT(*) n FROM sales WHERE operation_id=?', intent.operation_id).n, 1);
});

test('Inventario R11: a manual SALIDA is validated against stock minus pending sales', async (t) => {
  const { tab, add, sell } = await fixture(t, { stock: 3 });
  tab.context.navigator.onLine = false;
  add(2); await sell();
  tab.context.navigator.onLine = true;
  await assert.rejects(tab.api.adjustInventory({ product_id: '00001', movement_type: 'SALIDA', quantity: 2, reason: 'Merma' }), /INSUFFICIENT_PROJECTED_STOCK/);
});

test('P2-2: mixed payment in integer cents (digital = total - cash, cash max 2 decimals)', async (t) => {
  const { tab, queue } = await fixture(t);
  // The real legacy helper (inline-02), not a copy.
  const legacy = readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8');
  const helper = legacy.match(/^function _naMixedPaymentData\(\)\{.*\}$/m)[0];
  vm.runInContext('function _naNumber(v){const n=Number(v);return Number.isFinite(n)?n:0;}function _naClean(v){return String(v==null?\'\':v).trim();}' + helper, tab.context);
  vm.runInContext("cart=[{...productos.find(p=>p.id==='00001'),qty:3,precio:0.1}];posPayM='mixto';", tab.context);
  tab.context.document.getElementById('mMixedCash').value = '0.1';
  tab.context.document.getElementById('mMixedDigitalMethod').value = 'yape';
  tab.context.document.getElementById('mMixedRef').value = 'REF-1';
  await vm.runInContext('confirmarVenta()', tab.context);
  const [intent] = queue.snapshot().intents;
  assert.ok(intent, tab.toasts.map((x) => x[0]).join('\n'));
  assert.equal(intent.total_cents, 30);
  assert.equal(intent.payment.cash_cents, 10);
  assert.equal(intent.payment.digital_cents, 20);
});

for (const production of [false, true]) {
  test(`Worker budget (${production ? 'fast path' : 'ruta normal'}): sale.create success and every new explicit rejection stay far below 50 subrequests`, async (t) => {
    const { f, tab, turso } = await fixture(t, { production });
    const I = tab.context.NuevoAmanecerCanonicalSaleIntent;
    const measure = async (input) => {
      const before = turso.calls.length;
      const start = tab.fetchLog.length;
      let error = null;
      try { await tab.api.createSale(I.build(input)); } catch (e) { error = e; }
      const subrequests = turso.calls.length - before;
      const requests = tab.fetchLog.slice(start).map((r) => r.method + ' ' + new URL(r.url).pathname);
      const pending = tab.api.pendingSnapshot();
      const reason = pending && pending.last_error;
      if (pending) await tab.api.discardRejectedSale().catch(() => {});
      await tab.api.refresh();
      // Exactly one Worker invocation (the POST): the refresh runs after.
      assert.deepEqual([...requests], ['POST /commands/sale.create'], JSON.stringify(requests));
      return { reason, error: error && error.message, subrequests };
    };
    const ok = await measure({ sale_id: 'V-700', payment_method: 'efectivo', session_id: 'cash-p0', items: [{ product_id: '00001', quantity: 1, precio: 2 }] });
    const short = await measure({ sale_id: 'V-701', payment_method: 'efectivo', items: [{ product_id: '00001', quantity: 99, precio: 2 }] });
    const taken = await measure({ sale_id: 'V-700', payment_method: 'efectivo', items: [{ product_id: '00001', quantity: 1, precio: 2 }] });
    for (const [label, r] of Object.entries({ ok, short, taken })) assert.ok(r.subrequests <= 50, label + ' ' + JSON.stringify(r));
    // Measured: success 4 (normal) / 1 (fast path); each explicit rejection 2.
    // The new conflict/session reads ride inside existing batches.
    assert.ok(ok.subrequests <= 4, JSON.stringify(ok));
    assert.ok(short.subrequests <= 3 && taken.subrequests <= 3, JSON.stringify({ short, taken }));
    assert.equal(short.reason, 'insufficient_stock', JSON.stringify(short));
    assert.equal(taken.reason, 'sale_id_conflict', JSON.stringify(taken));
    t.diagnostic('turso subrequests per sale.create: ' + JSON.stringify({ ok: ok.subrequests, insufficient_stock: short.subrequests, sale_id_conflict: taken.subrequests }));
    void f;
  });
}

test('P1-B (móvil): a sale right after another is POSTed without waiting for a full reload; reconciliation runs once when idle', async (t) => {
  const { tab, add, sell, queue } = await fixture(t);
  const start = tab.fetchLog.length;
  add(1); await sell(); assert.equal((await queue.sync()).status, 'DRAINED');
  add(1); await sell(); assert.equal((await queue.sync()).status, 'DRAINED');
  const seq = tab.fetchLog.slice(start).map((r) => r.method + ' ' + new URL(r.url).pathname);
  assert.deepEqual(seq.filter((s) => s.startsWith('POST')), ['POST /commands/sale.create', 'POST /commands/sale.create']);
  assert.equal(seq.filter((s) => s.startsWith('GET')).length, 0, 'no 15-GET reload between consecutive sales: ' + seq.join(', '));
  await sleep(1800);
  const after = tab.fetchLog.slice(start).filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/read/canonical/status').length;
  assert.equal(after, 1, 'one deferred reconciliation once the queue is idle');
  assert.equal(tab.api.sourceState().validation, 'current');
});
