// Credits / payments audit fixes (P1-1, P1-2, P1-3, P1-5, P2-1, P2-3). Synthetic data only.
process.env.TZ = 'America/Lima';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { activeCanon, device, storage } from './canon-browser-harness.mjs';
import { intercept } from './a6-fixture.mjs';
import { normalizePaymentReference } from '../../tools/cloudflare-lab/src/a6-financial.js';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const bridge = read('POS/js/sync/canonical-credit-payment-bridge.js');
const scripts = [['canonical-credit-payment-bridge.js', bridge]];
const CREDIT = 'CR:001';
const CUSTOMER = '000C';
const REFS = ['0021_canonical_payment_references.sql'];
const LIVE = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql',
  '0017_canonical_live_customers.sql', '0018_canonical_customer_credit_policy.sql'];

function pay(f, extra = {}) {
  const c = f.control();
  const credit = f.sql('SELECT revision FROM canonical_credit_balances WHERE credit_id=?', extra.credit_id || CREDIT);
  return { operation_id: randomUUID(), promotion_id: c.active_promotion_id, client_contract: 'a6-gate-c-v1',
    authority_epoch: c.authority_epoch, expected_control_revision: c.revision, created_at: new Date().toISOString(),
    credit_id: CREDIT, expected_credit_revision: credit.revision, amount_cents: 100, payment_method: 'yape', ...extra };
}
const post = (f, body, route = 'payment.create', token = 'device-a-token') => f.fetch('http://localhost/commands/' + route, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
const fill = (tab, amount, method, reference = '') => { tab.context.pagoCredId = CREDIT; tab.el('pagoMonto').value = amount; tab.el('pagoMetodo').value = method; tab.el('pagoOperacion').value = reference; };
const payments = (f) => f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n;

// ---------------- P1-1: one voucher number settles debt only once ----------------

test('P1-1 normalization: trim, no whitespace, ASCII lower-case (same rule as migration 0021)', () => {
  assert.equal(normalizePaymentReference('  PRUEBA OP\t001 '), 'pruebaop001');
  assert.equal(normalizePaymentReference('pruebaop001'), 'pruebaop001');
  assert.equal(normalizePaymentReference(''), '');
  assert.equal(normalizePaymentReference(undefined), '');
  const db = new DatabaseSync(':memory:');
  const sqlNorm = db.prepare("SELECT lower(replace(replace(replace(replace(trim(?),' ',''),char(9),''),char(10),''),char(13),'')) v").get('  PRUEBA OP\t001 ').v;
  assert.equal(sqlNorm, normalizePaymentReference('  PRUEBA OP\t001 '));
});

test('P1-1 Worker: the same Yape number (any case/spacing) is rejected 409 reference_already_used; balance untouched', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const r1 = await post(f, pay(f, { reference: 'PRUEBAOP001' }));
  assert.equal(r1.status, 201);
  const before = f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?', CREDIT).b;
  for (const reference of ['PRUEBAOP001', 'pruebaop001', ' Prueba OP001 ']) {
    const r = await post(f, pay(f, { reference }));
    assert.equal(r.status, 409, reference);
    assert.equal((await r.json()).error, 'reference_already_used');
  }
  // Transferencia with the same number is the same voucher.
  const tr = await post(f, pay(f, { reference: 'pruebaop001', payment_method: 'transferencia' }));
  assert.equal(tr.status, 409);
  assert.equal(payments(f), 1);
  assert.equal(f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?', CREDIT).b, before);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_payment_references').n, 1);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n, 0, 'no leaked guards');
});

test('P1-1 Worker: idempotent replay of the same operation_id still returns the original receipt', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const body = pay(f, { reference: 'OP-IDEM-1' });
  assert.equal((await post(f, body)).status, 201);
  const again = await post(f, body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, 'already_processed');
  assert.equal(payments(f), 1);
});

test('P1-1 Worker: cash payments and empty references are never blocked', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  await tab.api.openCash({ session_id: 'ref-session', opening_cents: 0 });
  for (let i = 0; i < 2; i++) {
    const r = await post(f, pay(f, { payment_method: 'efectivo', session_id: 'ref-session', reference: 'CAJA' }));
    assert.equal(r.status, 201);
  }
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_payment_references').n, 0);
});

test('P1-1 Worker: a batch (cobro múltiple) consumes the voucher once and later reuse is rejected', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const receipt = await tab.api.createPaymentBatch([{ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'LOTE-001' }]);
  assert.ok(receipt);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_payment_references').n, 1, 'a batch counts as one use');
  const r = await post(f, pay(f, { reference: 'lote-001' }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'reference_already_used');
  await tab.api.refresh();
  const again = await tab.api.createPaymentBatch([{ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'LOTE-001' }]);
  assert.equal(again.ok, false);
  assert.equal(again.rejected, true);
  assert.equal(tab.api.pendingSnapshot().last_error, 'reference_already_used');
  assert.equal(payments(f), 1);
});

test('P1-1 two devices: the server blocks the duplicate even when the second device has a stale replica', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const a = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts });
  const b = await device(f, { token: 'device-a-token', scripts, localStorage: storage() });
  fill(a, '1.00', 'yape', 'PRUEBAOP001');
  assert.equal(await a.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  fill(b, '1.00', 'yape', 'pruebaop001');
  // B's replica is stale: first attempt gets stale_credit (released + refreshed at once, P2-3).
  assert.equal(await b.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  // After the refresh the local check sees the voucher; even without it the Worker would refuse.
  assert.equal(await b.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  assert.equal(payments(f), 1);
  // Without the bridge's local check (direct client API) the Worker still refuses.
  const c = await device(f, { token: 'device-a-token', localStorage: storage() });
  await assert.rejects(c.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'PRUEBAOP001' }));
  assert.equal(c.api.pendingSnapshot().last_error, 'reference_already_used');
  assert.equal(payments(f), 1);
});

test('P1-1 bridge: reference_already_used shows a plain message and frees the slot', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts,
    async onFetch(url) {
      if (url.endsWith('/commands/payment.create')) return new Response(JSON.stringify({ error: 'reference_already_used' }), { status: 409 });
      return null;
    } });
  fill(tab, '1.00', 'yape', 'NUEVO-123');
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  assert.ok(tab.toasts.some(([m]) => /Ese número de operación ya fue usado en otro abono/.test(m)), JSON.stringify(tab.toasts));
  assert.equal(tab.api.pendingSnapshot(), null);
});

test('P1-1 before migration 0021 the Worker keeps the legacy behaviour (no failure, no enforcement)', async (t) => {
  const f = await activeCanon(t);
  await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  assert.equal((await post(f, pay(f, { reference: 'SIN-MIG-1' }))).status, 201);
  assert.equal((await post(f, pay(f, { reference: 'SIN-MIG-1' }))).status, 201);
});

test('P1-1 migration 0021 is additive and does not fail on historical duplicates (earliest keeps the voucher)', async (t) => {
  const f = await activeCanon(t);
  await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const first = pay(f, { reference: 'HIST-DUP', created_at: '2026-10-01T10:00:00.000Z' });
  assert.equal((await post(f, first)).status, 201);
  assert.equal((await post(f, pay(f, { reference: ' hist-dup ', created_at: '2026-10-02T10:00:00.000Z' }))).status, 201);
  assert.equal((await post(f, pay(f, { reference: 'OTRO-1' }))).status, 201);
  const eventsBefore = f.sql('SELECT COUNT(*) n FROM canonical_financial_events').n;
  f.database.exec(read('infra/database/migrations/0021_canonical_payment_references.sql'));
  f.database.exec(read('infra/database/migrations/0021_canonical_payment_references.sql')); // idempotent re-run
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_financial_events').n, eventsBefore, 'no existing row touched');
  assert.equal(f.sql("SELECT operation_id o FROM canonical_payment_references WHERE reference_norm='hist-dup'").o, first.operation_id);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_payment_references').n, 2);
  const r = await post(f, pay(f, { reference: 'HIST-DUP' }));
  assert.equal(r.status, 409);
  assert.throws(() => f.exec('DELETE FROM canonical_payment_references'), /immutable_payment_reference/);
});

// ---------------- P1-2: the Worker enforces the MANUAL credit line ----------------

async function creditShop(t, { migrations = LIVE } = {}) {
  const f = await activeCanon(t, { migrations });
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const pid = 'LIM-' + randomUUID().slice(0, 6);
  await tab.api.createProduct({ product_id: pid, name: 'Prod lim', sku: pid + 's', barcode: pid + 'b', alternate_codes: [], category: 't', brand: 'T', description: null, icon: '📦', image: null, unit: 'unidad', purchase_unit: 'unidad', purchase_factor: 1, cost_cents: 100, price_cents: 1000, box_price_cents: null, units_per_box: null, initial_stock_quantity: 100, stock_min_quantity: 0, expiry_date: null, includes_igv: true, tax_type: 'gravado', complementary_tax: '', tracks_inventory: true });
  await tab.api.refresh();
  const debt = () => f.sql(`SELECT COALESCE(SUM(b.current_balance_cents),0) d FROM canonical_credit_balances b JOIN (
    SELECT credit_id,'IMPORT' p FROM credits WHERE customer_id=?1 UNION ALL SELECT credit_id,'LIVE' FROM live_credits WHERE customer_id=?1) o
    ON o.credit_id=b.credit_id AND o.p=b.provenance`, CUSTOMER).d;
  const sell = async (quantity) => { await tab.api.refresh(); return tab.api.createSale({ items: [{ product_id: pid, quantity }], payment_method: 'credito', customer_id: CUSTOMER, credit_due: '2099-12-31' }); };
  const policy = async (input) => { await tab.api.refresh(); return tab.api.setCustomerCreditPolicy({ customer_id: CUSTOMER, reason: 'Prueba de línea manual', administrator_id: 'a', administrator_name: 'Admin', ...input }); };
  return { f, tab, pid, debt, sell, policy };
}

test('P1-2 MANUAL line: a credit sale above (open balance + total > limit) is rejected 409 credit_limit_exceeded', async (t) => {
  const { f, tab, debt, sell, policy } = await creditShop(t);
  const open = debt();
  assert.ok(open > 0, 'customer has imported debt');
  await policy({ mode: 'MANUAL', manual_limit_cents: open + 2500 });
  await assert.rejects(sell(3));
  const pending = tab.api.pendingSnapshot();
  assert.equal(pending.last_error, 'credit_limit_exceeded');
  assert.equal(pending.last_status, 409);
  assert.equal(f.sql('SELECT COUNT(*) n FROM live_credits').n, 0);
  assert.equal(debt(), open);
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n, 0);
  // The rejected journal can be released (definitive 4xx), and a sale that fits is accepted.
  assert.equal(await tab.api.releaseRejectedSaleJournal(pending.payload.operation_id), true);
  const ok = await sell(2);
  assert.equal(ok.status, 'created');
  assert.equal(debt(), open + 2000);
  // Exactly at the limit is allowed; one cent more is not.
  await assert.rejects(sell(1));
});

test('P1-2 the Worker reports how much line is available', async (t) => {
  const { f, debt, policy } = await creditShop(t);
  const open = debt();
  await policy({ mode: 'MANUAL', manual_limit_cents: open + 500 });
  const captured = [];
  const tab2 = await device(f, { token: 'device-b-token', deviceId: 'device-b', async onFetch(url, rest, next) {
    if (!url.endsWith('/commands/sale.create')) return null;
    const res = await next(); captured.push({ status: res.status, body: await res.clone().json() }); return res; } });
  await tab2.api.refresh();
  const pid = f.sql('SELECT product_id p FROM canonical_live_products LIMIT 1').p;
  await assert.rejects(tab2.api.createSale({ items: [{ product_id: pid, quantity: 1 }], payment_method: 'credito', customer_id: CUSTOMER, credit_due: '2099-12-31' }));
  assert.equal(captured[0].status, 409);
  assert.deepEqual({ ...captured[0].body }, { error: 'credit_limit_exceeded', customer_id: CUSTOMER, limit_cents: open + 500, debt_cents: open, available_cents: 500, requested_cents: 1000 });
});

test('P1-2 AUTOMATIC / no policy keeps today\'s behaviour (no server limit)', async (t) => {
  const { sell, policy } = await creditShop(t);
  assert.equal((await sell(5)).status, 'created');
  await policy({ mode: 'MANUAL', manual_limit_cents: 100 });
  await policy({ mode: 'AUTOMATIC' });
  assert.equal((await sell(5)).status, 'created');
});

test('P1-2 race: debt or policy changing between the read and the atomic batch is caught inside the batch', async (t) => {
  const { f, tab, debt, sell, policy } = await creditShop(t);
  const open = debt();
  await policy({ mode: 'MANUAL', manual_limit_cents: open + 3000 });
  // Another device's credit sale (fits alone) lands after our pre-check read and before
  // our atomic batch: both together exceed the line, so ours must fail inside the batch.
  const other = await device(f, { token: 'device-b-token', deviceId: 'device-b' });
  await other.api.refresh();
  const pid = f.sql('SELECT product_id p FROM canonical_live_products LIMIT 1').p;
  let fired = false, otherSale = null;
  const restore = intercept(f, async (event) => {
    if (fired || event.when !== 'before' || event.method !== 'batch' || !event.entries.some((e) => e && /INSERT INTO live_credits/.test(e.sql))) return;
    fired = true;
    otherSale = await other.api.createSale({ items: [{ product_id: pid, quantity: 2 }], payment_method: 'credito', customer_id: CUSTOMER, credit_due: '2099-12-31' });
  });
  t.after(restore);
  await assert.rejects(sell(2));
  assert.ok(fired);
  assert.equal(otherSale.status, 'created');
  assert.equal(tab.api.pendingSnapshot().last_error, 'credit_limit_exceeded');
  assert.equal(f.sql('SELECT COUNT(*) n FROM live_credits').n, 1, 'only the sale that fit');
  assert.ok(debt() <= open + 3000, 'the line is never exceeded');
  assert.equal(f.sql('SELECT COUNT(*) n FROM canonical_assertions').n, 0);
});

test('P1-2 policy CAS: a switch to MANUAL between read and commit is not bypassed by an AUTOMATIC-time sale', async (t) => {
  const { f, tab, sell } = await creditShop(t);
  let fired = false;
  const restore = intercept(f, async (event) => {
    if (fired || event.when !== 'before' || event.method !== 'batch' || !event.entries.some((e) => e && /INSERT INTO live_credits/.test(e.sql))) return;
    fired = true;
    const c = f.control();
    f.database.prepare(`INSERT INTO canonical_customer_credit_policies(promotion_id,customer_id,mode,manual_limit_cents,revision,operation_id,reason,administrator_id,administrator_name,created_at,updated_at)
      VALUES(?,?,'MANUAL',1,1,'race-policy','Carrera de prueba','a','Admin','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')`).run(c.active_promotion_id, CUSTOMER);
  });
  t.after(restore);
  await assert.rejects(sell(1));
  assert.ok(fired);
  assert.equal(f.sql('SELECT COUNT(*) n FROM live_credits').n, 0);
  void tab;
});

test('P1-2 with debt-reconciliation (0019) the reconciled credits count toward the line', async (t) => {
  const { f, debt, sell, policy } = await creditShop(t, { migrations: [...LIVE, '0019_canonical_debt_reconciliation.sql', '0020_canonical_customer_contacts.sql', ...REFS] });
  const open = debt();
  await policy({ mode: 'MANUAL', manual_limit_cents: open + 1000 });
  assert.equal((await sell(1)).status, 'created');
  await assert.rejects(sell(1));
  void f;
});

test('P1-2 queue: credit_limit_exceeded is a sale-level rejection (quarantine + manual retry), never a stalled head', () => {
  const outbox = read('POS/js/sync/canonical-sale-outbox.js');
  const client = read('POS/js/sync/canonical-client.js');
  assert.match(outbox, /var SALE_REJECTIONS = \[[^\]]*'credit_limit_exceeded'\]/);
  assert.match(outbox, /var RETRYABLE = DETERMINISTIC\.concat\(\[[^\]]*'credit_limit_exceeded'\]\)/);
  assert.match(client, /'cash_session_required', 'cash_session_closed', 'credit_limit_exceeded'\]/);
  assert.match(read('POS/js/sync/canonical-cash-bridge.js'), /credit_limit_exceeded' \? 'el crédito supera la línea disponible del cliente/);
});

// ---------------- P1-3: business-local dates ----------------

test('P1-3 an abono at 20:46 Lima is dated that day (not the next UTC day) in Clientes, like Caja', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  const createdAt = new Date('2026-10-11T20:46:00-05:00').toISOString();
  assert.equal(createdAt.slice(0, 10), '2026-10-12', 'UTC day differs');
  await tab.api.openCash({ session_id: 'tz-session', opening_cents: 0 });
  await tab.api.refresh();
  assert.equal((await post(f, pay(f, { reference: 'TZ-1', amount_cents: 150, created_at: createdAt }))).status, 201);
  assert.equal((await post(f, pay(f, { payment_method: 'efectivo', session_id: 'tz-session', amount_cents: 100, created_at: createdAt }))).status, 201);
  await tab.api.refresh();
  const snap = tab.api.legacySnapshot();
  const pagos = snap.credits.find((c) => c.id === CREDIT).pagos.filter((p) => p.timestamp === createdAt);
  assert.deepEqual(JSON.parse(JSON.stringify(pagos.map((p) => p.fecha))), ['2026-10-11', '2026-10-11']);
  const movs = snap.cashMovements.filter((m) => m.timestamp === createdAt);
  assert.ok(movs.length >= 1 && movs.every((m) => m.fecha === '2026-10-11'), 'Caja and Clientes agree');
  const cobradoHoy = snap.credits.reduce((s, cr) => s + cr.pagos.filter((p) => p.canonicalDateKnown && p.fecha === '2026-10-11' && p.status !== 'REVERTED').reduce((a, p) => a + Number(p.monto || 0), 0), 0);
  assert.equal(cobradoHoy.toFixed(2), '2.50');
  // Historical rows without a zone keep their stored date.
  const imported = snap.credits.find((c) => c.id === CREDIT).pagos.filter((p) => p.timestamp !== createdAt && p.canonicalDateKnown);
  for (const p of imported) if (!/(Z|[+-]\d{2}:\d{2})$/.test(String(p.timestamp || ''))) assert.equal(p.fecha, String(p.timestamp || p.fecha).slice(0, 10));
});

test('P1-3 live credit issue date and receipt projection use the local day; Cobrado hoy shows cents and explicit labels', () => {
  const adapter = read('POS/js/adapters/canonical-ui-adapter.js');
  assert.match(adapter, /fecha: known \? localDateOf\(p\.payment_timestamp, p\.payment_date\) : ''/);
  assert.match(adapter, /fecha: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\/\.test\(issued\) \? localDateOf\(issued, issued\.slice\(0, 10\)\) : ''/);
  const v2 = read('POS/js/modules/client-credit-accounts-v2.js');
  assert.match(v2, /fecha: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\/\.test\(timestamp\) \? localDay\(timestamp\) : ''/);
  for (const file of ['inline-01.js', 'inline-03.js', 'inline-04.js', 'inline-12.js']) {
    const src = read('POS/js/legacy-inline/' + file);
    assert.doesNotMatch(src, /cobradoHoy\.toFixed\(0\)/, file);
  }
  assert.match(read('POS/js/legacy-inline/inline-03.js'), /'Cobrado hoy \(todos los medios\)'/);
  assert.match(read('POS/js/legacy-inline/inline-12.js'), /'Cobrado hoy \(todos los medios\)'/);
  assert.match(read('POS/js/legacy-inline/inline-11.js'), /'Cobros en efectivo'/);
  assert.match(read('POS/js/legacy-inline/inline-11.js'), /'Cobros crédito \(efectivo\)'/);
  // Shared LAB/CANON markup is unchanged (labels are set by JS).
  assert.match(read('POS/index.html'), /<div class="ss-lbl">Cobrado hoy<\/div>/);
});

test('P1-3 localDateOf: zoned instants -> local calendar day; date-only values verbatim', () => {
  const adapter = read('POS/js/adapters/canonical-ui-adapter.js');
  const start = adapter.indexOf('  function localDateOf(');
  const end = adapter.indexOf('  function groupBy(');
  const ctx = { String, Date, Number, out: null };
  vm.runInNewContext(`function text(v,f){return v==null||v===''?(f||''):String(v);}\n${adapter.slice(start, end)}\nout={localDateOf};`, ctx);
  assert.equal(ctx.out.localDateOf('2026-10-12T01:46:00.000Z', '2026-10-12'), '2026-10-11');
  assert.equal(ctx.out.localDateOf('2026-10-11T23:59:00-05:00', 'x'), '2026-10-11');
  assert.equal(ctx.out.localDateOf('2026-10-11', '2026-10-11'), '2026-10-11');
  assert.equal(ctx.out.localDateOf('2026-10-11T20:46:00', '2026-10-11'), '2026-10-11', 'unzoned historical value kept');
  assert.equal(ctx.out.localDateOf(null, '2026-09-30'), '2026-09-30');
});

// ---------------- P1-5: PIN + free-text reason ----------------

function manualLineHarness({ pinEnabled, pinOk = true, reason = '' }) {
  const src = read('POS/js/legacy-inline/inline-04.js');
  const start = src.indexOf('// P1-5: a manual credit line');
  const end = src.indexOf('async function restaurarLineaCreditoAutomatica');
  const calls = { saved: [], toasts: [], pins: [] };
  const elements = new Map();
  const anchor = { parentNode: { insertBefore(node) { elements.set(node.children?.[1]?.id || node.id, node.children?.[1]); } }, nextSibling: null };
  const make = (tag) => ({ tag, children: [], className: '', textContent: '', value: '', append(...n) { this.children.push(...n); }, appendChild(n) { this.children.push(n); }, focus() {} });
  const document = {
    getElementById(id) {
      if (id === 'lineaManualAdvertencia') return anchor;
      if (id === 'lineaManualMonto') return { value: '150' };
      return elements.get(id) || null;
    },
    createElement(tag) { const el = make(tag); Object.defineProperty(el, 'id', { get() { return this._id; }, set(v) { this._id = v; if (v) elements.set(v, this); } }); return el; },
  };
  const ctx = {
    document, Math, String, Number, globalThis: null,
    _naSecurity: { pinEnabled },
    _naVerifyPin(reasonText) { calls.pins.push(reasonText); return pinOk; },
    _naManualCreditClientId: 'C1',
    _naEvaluateClientCredit() { return { exists: true, client: { id: 'C1', nombre: 'Ana' } }; },
    _naNumber: (v) => Number(v) || 0,
    toast(m, k) { calls.toasts.push([m, k]); },
    _naCanonicalCreditPolicyAuthority: () => true,
    _naCashierSnapshot: () => ({ id: 'cj1', nombre: 'Dueño' }),
    cajEstado: {}, appConfig: {},
    NuevoAmanecerCanonicalCustomerCreditPolicyBridge: { async saveManual(input) { calls.saved.push(input); return true; } },
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(src.slice(start, end) + `\n;globalThis.run=async()=>{_naEnsureManualLineReasonField().value=${JSON.stringify(reason)};return guardarLineaCreditoManual();};`, ctx);
  return { ctx, calls };
}

test('P1-5 manual line: reason of at least 8 characters is required', async () => {
  const { ctx, calls } = manualLineHarness({ pinEnabled: false, reason: 'corto' });
  await ctx.run();
  assert.equal(calls.saved.length, 0);
  assert.match(calls.toasts.at(-1)[0], /motivo del cambio/);
});

test('P1-5 manual line: with a master PIN configured, a wrong/cancelled PIN blocks the change', async () => {
  const { ctx, calls } = manualLineHarness({ pinEnabled: true, pinOk: false, reason: 'Cliente puntual de años' });
  await ctx.run();
  assert.equal(calls.pins.length, 1);
  assert.match(calls.pins[0], /Cambiar línea de crédito de Ana/);
  assert.equal(calls.saved.length, 0);
});

test('P1-5 manual line: valid PIN + reason saves with the typed reason (not a fixed text)', async () => {
  const { ctx, calls } = manualLineHarness({ pinEnabled: true, pinOk: true, reason: '  Cliente   puntual de años ' });
  await ctx.run();
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0].reason, 'Cliente puntual de años');
  assert.equal(calls.saved[0].manual_limit_cents, 15000);
});

test('P1-5 manual line: without a configured PIN only the reason is required', async () => {
  const { ctx, calls } = manualLineHarness({ pinEnabled: false, reason: 'Acordado con el dueño' });
  await ctx.run();
  assert.equal(calls.pins.length, 0);
  assert.equal(calls.saved.length, 1);
});

// ---------------- P2-1: monthly installment dates ----------------

test('P2-1 monthly installments never skip a month (31-01 -> 28/29-02 -> 31-03)', () => {
  const src = read('POS/js/modules/client-credit-accounts-v2.js');
  const start = src.indexOf('  function labMonthlyDates(');
  const end = src.indexOf('  function labRenderInstallmentDates(');
  const ctx = { out: null };
  vm.runInNewContext(src.slice(start, end) + '\nout=labMonthlyDates;', ctx);
  const dates = (first, count) => JSON.parse(JSON.stringify(ctx.out(first, count)));
  assert.deepEqual(dates('2026-01-31', 4), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(dates('2028-01-31', 2), ['2028-01-31', '2028-02-29']);
  assert.deepEqual(dates('2026-11-30', 3), ['2026-11-30', '2026-12-30', '2027-01-30']);
  assert.deepEqual(dates('2026-10-15', 2), ['2026-10-15', '2026-11-15']);
});

// ---------------- 0021 owner-run maintenance (not executed against prod here) ----------------
import { migrationPath as refsPath, migrationUnits as refsUnits, preflight as refsPreflight, verify as refsVerify } from '../../tools/cloudflare-prod/scripts/turso-payment-references-maintenance.mjs';
function sqliteAdapter(database) {
  return { prepare(sql) { return { sql, args: [], bind(...args) { this.args = args; return this; } }; },
    async batch(statements) { return statements.map((s) => ({ results: database.prepare(s.sql).all(...s.args) })); } };
}
test('0021 maintenance: preflight reports historical duplicates read-only; migrate is atomic, idempotent and verified', async (t) => {
  const f = await activeCanon(t);
  await device(f, { token: 'device-a-token', deviceId: 'device-a' });
  assert.equal((await post(f, pay(f, { reference: 'DUP-X' }))).status, 201);
  assert.equal((await post(f, pay(f, { reference: 'dup-x' }))).status, 201);
  const source = read(refsPath);
  const db = sqliteAdapter(f.database);
  const report = await refsPreflight(db);
  assert.equal(report.duplicated_vouchers, 1);
  assert.equal(report.extra_uses, 1);
  await assert.rejects(() => refsVerify(db, source), /schema mismatch/);
  const units = refsUnits(source);
  assert.equal(units.length, 4);
  for (let run = 0; run < 2; run++) { f.database.exec('BEGIN'); for (const sql of units) f.database.exec(sql); f.database.exec('COMMIT'); }
  await refsVerify(db, source);
  assert.throws(() => refsUnits(source + '\nDELETE FROM sales;'), /hash mismatch/);
});
