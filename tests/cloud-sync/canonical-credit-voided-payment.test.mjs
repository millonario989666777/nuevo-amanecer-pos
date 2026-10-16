// Worker real: POST /commands/payment.create y POST /commands/payment.batch rechazan (409 credit_voided) un abono a un
// crédito importado cuyo source_status empieza por 'anul' (sin distinguir mayúsculas), sin aplicar nada.
// Créditos no anulados, LIVE y replays idempotentes: mismo contrato que antes. Datos sintéticos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activeCanon, device } from './canon-browser-harness.mjs';

const LIVE = ['0014_canonical_live_products.sql', '0015_canonical_inventory_adjust.sql', '0016_canonical_generic_sale_lines.sql', '0017_canonical_live_customers.sql'];
const CREDIT = 'CR:001';
const TOKEN = 'device-a-token';

const balance = (f, id) => f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?', id).b;
const events = f => f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n;
// Los créditos importados son inmutables (trigger credits_no_update): el estado de origen se fija al importar.
// Solo en esta base de prueba se suelta el trigger para simular un crédito que llegó anulado en la importación.
const setSource = (f, value) => { f.database.exec('DROP TRIGGER IF EXISTS credits_no_update'); setSourceRaw(f, value); };
const setSourceRaw = (f, value) => f.exec(`UPDATE credits SET source_status=${value === null ? 'NULL' : "'" + value.replace(/'/g, "''") + "'"} WHERE credit_id='${CREDIT}'`);
function payment(f, credit, amount, extra = {}) {
  const c = f.control();
  return { operation_id:randomUUID(), promotion_id:c.active_promotion_id, client_contract:'a6-gate-c-v1', authority_epoch:c.authority_epoch,
    expected_control_revision:c.revision, created_at:new Date().toISOString(), credit_id:credit,
    expected_credit_revision:f.sql('SELECT revision FROM canonical_credit_balances WHERE credit_id=?', credit).revision,
    amount_cents:amount, payment_method:'yape', ...extra };
}
function batch(f, payments) {
  const c = f.control();
  return { operation_id:randomUUID(), promotion_id:c.active_promotion_id, client_contract:'a6-gate-c-v1', authority_epoch:c.authority_epoch,
    expected_control_revision:c.revision, created_at:new Date().toISOString(), payments };
}
const post = (f, route, body) => f.fetch('http://localhost/commands/' + route, { method:'POST',
  headers:{ 'content-type':'application/json', authorization:'Bearer ' + TOKEN }, body:JSON.stringify(body) });

async function liveCredit(tab) {
  const id = 'LIVE-VOID-' + randomUUID().slice(0, 8);
  assert.equal((await tab.api.createProduct({ product_id:id, name:'Producto ' + id, sku:id + '-SKU', barcode:id + '-BAR', alternate_codes:[], category:'test',
    brand:'Test', description:null, icon:'📦', image:null, unit:'unidad', purchase_unit:'unidad', purchase_factor:1, cost_cents:100, price_cents:500,
    box_price_cents:null, units_per_box:null, initial_stock_quantity:10, stock_min_quantity:0, expiry_date:null, includes_igv:true, tax_type:'gravado',
    complementary_tax:'', tracks_inventory:true })).status, 'created');
  await tab.api.refresh();
  const before = new Set(tab.api.snapshot().credits.map(r => r.credit_id));
  assert.equal((await tab.api.createSale({ items:[{ product_id:id, quantity:1 }], payment_method:'credito', customer_id:'000C', credit_due:'2099-12-31' })).status, 'created');
  await tab.api.refresh();
  return tab.api.snapshot().credits.find(r => r.provenance === 'LIVE' && !before.has(r.credit_id)).credit_id;
}

for (const value of ['ANULADO', 'anulado', ' Anulada ']) {
  test(`payment.create: crédito importado con source_status ${JSON.stringify(value)} → 409 credit_voided, nada se aplica`, async (t) => {
    const f = await activeCanon(t, { migrations:LIVE });
    await device(f, { token:TOKEN, deviceId:'device-a' });
    setSource(f, value);
    const b0 = balance(f, CREDIT), e0 = events(f);
    const r = await post(f, 'payment.create', payment(f, CREDIT, 100));
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error:'credit_voided', credit_id:CREDIT });
    assert.equal(balance(f, CREDIT), b0);
    assert.equal(events(f), e0);
  });
}

for (const value of ['VIGENTE', 'VENCIDO', 'no anulado', null]) {
  test(`payment.create: control source_status ${JSON.stringify(value)} → 201 como siempre`, async (t) => {
    const f = await activeCanon(t, { migrations:LIVE });
    await device(f, { token:TOKEN, deviceId:'device-a' });
    setSource(f, value);
    const b0 = balance(f, CREDIT);
    const r = await post(f, 'payment.create', payment(f, CREDIT, 100));
    assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
    assert.equal((await r.json()).current_balance_cents, b0 - 100);
    assert.equal(balance(f, CREDIT), b0 - 100);
  });
}

test('payment.create: el replay idempotente de un abono hecho antes de anular sigue devolviendo el recibo original', async (t) => {
  const f = await activeCanon(t, { migrations:LIVE });
  await device(f, { token:TOKEN, deviceId:'device-a' });
  const body = payment(f, CREDIT, 100);
  assert.equal((await post(f, 'payment.create', body)).status, 201);
  setSource(f, 'ANULADO');
  const again = await post(f, 'payment.create', body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, 'already_processed');
  assert.equal(events(f), 1);
  const fresh = await post(f, 'payment.create', payment(f, CREDIT, 50));
  assert.equal(fresh.status, 409, 'un abono nuevo sí se rechaza');
});

test('payment.batch: si un crédito del lote está anulado, se rechaza el lote entero (409 credit_voided) y ningún saldo cambia', async (t) => {
  const f = await activeCanon(t, { migrations:LIVE });
  const tab = await device(f, { token:TOKEN, deviceId:'device-a' });
  const live = await liveCredit(tab);
  setSource(f, 'ANULADO');
  const b0 = [balance(f, live), balance(f, CREDIT)], e0 = events(f);
  const r = await post(f, 'payment.batch', batch(f, [payment(f, live, 100), payment(f, CREDIT, 100)]));
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error:'credit_voided', credit_id:CREDIT });
  assert.deepEqual([balance(f, live), balance(f, CREDIT)], b0);
  assert.equal(events(f), e0);
  // Sin el anulado, el mismo reparto pasa y los saldos cuadran.
  const ok = await post(f, 'payment.batch', batch(f, [payment(f, live, 100)]));
  assert.equal(ok.status, 201);
  assert.equal(balance(f, live), b0[0] - 100);
});

test('payment.batch: control con el importado VIGENTE + LIVE → 201 y ambos saldos bajan', async (t) => {
  const f = await activeCanon(t, { migrations:LIVE });
  const tab = await device(f, { token:TOKEN, deviceId:'device-a' });
  const live = await liveCredit(tab);
  setSource(f, 'VIGENTE');
  const b0 = [balance(f, live), balance(f, CREDIT)];
  const r = await post(f, 'payment.batch', batch(f, [payment(f, live, 100), payment(f, CREDIT, 150)]));
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  assert.deepEqual([balance(f, live), balance(f, CREDIT)], [b0[0] - 100, b0[1] - 150]);
});

// ── compensation.create (anular abono) y adjustment.create ─────────────────────────────────────────────
function compensation(f, compensates, extra = {}) {
  const c = f.control();
  return { operation_id:randomUUID(), promotion_id:c.active_promotion_id, client_contract:'a6-gate-c-v1', authority_epoch:c.authority_epoch,
    expected_control_revision:c.revision, created_at:new Date().toISOString(), reason:'Prueba de anulación', compensates_operation_id:compensates,
    expected_credit_revision:f.sql('SELECT revision FROM canonical_credit_balances WHERE credit_id=?', CREDIT).revision, credit_id:CREDIT, ...extra };
}
const compensations = f => f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='COMPENSATION'").n;
async function paidCredit(f) {
  const body = payment(f, CREDIT, 100);
  assert.equal((await post(f, 'payment.create', body)).status, 201);
  return body.operation_id;
}

for (const value of ['ANULADO', 'anulado', ' Anulada ']) {
  test(`compensation.create: anular un abono de un crédito importado con source_status ${JSON.stringify(value)} → 409 credit_voided`, async (t) => {
    const f = await activeCanon(t, { migrations:LIVE });
    await device(f, { token:TOKEN, deviceId:'device-a' });
    const paid = await paidCredit(f);
    setSource(f, value);
    const b0 = balance(f, CREDIT);
    const r = await post(f, 'compensation.create', compensation(f, paid));
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error:'credit_voided', credit_id:CREDIT });
    assert.equal(balance(f, CREDIT), b0);
    assert.equal(compensations(f), 0);
  });
}

for (const value of ['VIGENTE', 'no anulado', null]) {
  test(`compensation.create: control source_status ${JSON.stringify(value)} → 201 y el saldo se restaura como siempre`, async (t) => {
    const f = await activeCanon(t, { migrations:LIVE });
    await device(f, { token:TOKEN, deviceId:'device-a' });
    const b0 = balance(f, CREDIT);
    const paid = await paidCredit(f);
    setSource(f, value);
    const r = await post(f, 'compensation.create', compensation(f, paid));
    assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
    assert.equal(balance(f, CREDIT), b0);
    assert.equal(compensations(f), 1);
  });
}

test('compensation.create: el replay idempotente de una anulación hecha antes va antes del rechazo', async (t) => {
  const f = await activeCanon(t, { migrations:LIVE });
  await device(f, { token:TOKEN, deviceId:'device-a' });
  const paid = await paidCredit(f);
  const body = compensation(f, paid);
  assert.equal((await post(f, 'compensation.create', body)).status, 201);
  setSource(f, 'ANULADO');
  const again = await post(f, 'compensation.create', body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, 'already_processed');
  assert.equal(compensations(f), 1);
});

test('adjustment.create no lleva crédito: credit_id es un campo no permitido (400), así que no puede tocar un anulado', async (t) => {
  const f = await activeCanon(t, { migrations:LIVE });
  await device(f, { token:TOKEN, deviceId:'device-a' });
  setSource(f, 'ANULADO');
  const c = f.control();
  const r = await post(f, 'adjustment.create', { operation_id:randomUUID(), promotion_id:c.active_promotion_id, client_contract:'a6-gate-c-v1',
    authority_epoch:c.authority_epoch, expected_control_revision:c.revision, created_at:new Date().toISOString(), session_id:'S-1',
    expected_session_revision:0, amount_cents:100, reason:'Ajuste', credit_id:CREDIT });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'unexpected_field');
});
