import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../POS/js/sync/canonical-sale-intent.js', import.meta.url), 'utf8');
const context = vm.createContext({ crypto, Date, Number, Object, Array, Set, String, Error, RegExp });
vm.runInContext(source, context);
const api = context.NuevoAmanecerCanonicalSaleIntent;
const base = () => ({ payment_method: 'efectivo', items: [
  { product_id: 'p1', quantity: 2, unit_price_cents: 125 },
  { product_id: 'p2', quantity: 1, unit_price_cents: 300 },
] });

test('venta retail efectivo conserva economía, IDs y timestamp estables', () => {
  const input = base();
  const first = api.build(input);
  const second = api.build({ ...input, operation_id: first.operation_id, sale_id: first.sale_id, created_at: first.created_at });
  assert.equal(api.VERSION, 1);
  assert.equal(first.total_cents, 550);
  assert.deepEqual(JSON.parse(JSON.stringify(first.items)), [
    { product_id: 'p1', quantity: 2, unit_price_cents: 125, line_total_cents: 250 },
    { product_id: 'p2', quantity: 1, unit_price_cents: 300, line_total_cents: 300 },
  ]);
  assert.equal(first.operation_id, second.operation_id);
  assert.equal(first.sale_id, second.sale_id);
  assert.equal(first.created_at, second.created_at);
  assert.match(first.operation_id, /^[0-9a-f-]{36}$/i);
});

test('Yape, Plin y transferencia conservan referencia digital opcional', () => {
  for (const method of ['yape', 'plin', 'transferencia']) {
    const intent = api.build({ ...base(), payment_method: method, payment: { reference: 'ref-42' } });
    assert.equal(intent.payment.digital_cents, intent.total_cents);
    assert.equal(intent.payment.digital_method, method);
    assert.equal(intent.payment.reference, 'ref-42');
  }
});

test('mixto conserva efectivo, digital y método; valida suma exacta', () => {
  const intent = api.build({ ...base(), payment_method: 'mixto', payment: { cash_cents: 200, digital_cents: 350, digital_method: 'plin' } });
  assert.equal(intent.payment.cash_cents + intent.payment.digital_cents, intent.total_cents);
  assert.equal(intent.payment.digital_method, 'plin');
  assert.throws(() => api.build({ ...base(), payment_method: 'mixto', payment: { cash_cents: 200, digital_cents: 349, digital_method: 'plin' } }), { code: 'MIXED_PAYMENT_INVALID' });
});

test('crédito conserva cliente y fecha debida válida', () => {
  const intent = api.build({ ...base(), payment_method: 'credito', customer_id: 'c-1', credit_due: '2026-10-10' });
  assert.equal(intent.customer_id, 'c-1');
  assert.equal(intent.credit_due, '2026-10-10');
  assert.equal(intent.payment.credit_cents, intent.total_cents);
});

test('descuento conserva el precio efectivo entregado por el carrito', () => {
  const intent = api.build({ payment_method: 'efectivo', items: [{ product_id: 'sale-item', quantity: 1, precio: 8.5 }] });
  assert.equal(intent.items[0].unit_price_cents, 850);
  assert.equal(intent.total_cents, 850);
  assert.equal(api.build({ payment_method: 'efectivo', items: [{ product_id: 'decimal', quantity: 1, precio: 1.15 }] }).total_cents, 115);
});

test('admite línea VARIOS trazable y sigue bloqueando modos no soportados', () => {
  assert.throws(() => api.build({ ...base(), ventaLibre: true }), { code: 'VENTA_LIBRE_UNSUPPORTED' });
  const generic=api.build({ payment_method:'efectivo', items:[{
    quantity:2,unit_price_cents:125,ventaLibre:true,name:'  Recarga   libre  ',codigoIngresado:'REC-01'
  }]});
  assert.match(generic.items[0].product_id,/^GENERIC:[0-9a-f-]{36}$/i);
  assert.deepEqual(JSON.parse(JSON.stringify(generic.items[0].generic_line)),{name:'Recarga libre',code:'REC-01'});
  assert.equal(generic.items[0].line_total_cents,250);
  assert.equal(generic.total_cents,250);
  const rebuilt=api.build(generic);
  assert.equal(rebuilt.items[0].product_id,generic.items[0].product_id);
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt.items[0].generic_line)),{name:'Recarga libre',code:'REC-01'});
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10, ventaModo: 'caja', unitsPerQty: 1 }] }), { code: 'VENTA_MODO_CAJA_UNSUPPORTED' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10, modo: 'mayorista', unitsPerQty: 1 }] }), { code: 'VENTA_MODO_CAJA_UNSUPPORTED' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10, ventaSinStock: true }] }), { code: 'VENTA_SIN_STOCK' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10, unidadesSinStock: 1 }] }), { code: 'STOCK_NEGATIVO' });
  assert.throws(() => api.build({ ...base(), ventaModo: 'caja' }), { code: 'VENTA_MODO_CAJA_UNSUPPORTED' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10, unitsPerQty: 12 }] }), { code: 'UNITS_PER_QTY_UNSUPPORTED' });
  assert.throws(() => api.build({ ...base(), unidadesSinStock: 1 }), { code: 'STOCK_NEGATIVO' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10 }, { product_id: 'p', quantity: 2, unit_price_cents: 12 }] }), { code: 'PRODUCT_ID_DUPLICATE_PRICE' });
});

test('mismo producto en dos líneas con el mismo precio: se une en una línea (cantidad sumada, total igual)', () => {
  const intent = api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: 10 }, { product_id: 'q', quantity: 1, unit_price_cents: 5 }, { product_id: 'p', quantity: 2, unit_price_cents: 10 }] });
  const items = intent.items || intent.payload?.items;
  assert.equal(JSON.stringify(items.map(i => [i.product_id, i.quantity, i.line_total_cents])), JSON.stringify([['p', 3, 30], ['q', 1, 5]]));
});

test('rechaza cantidad/precio ambiguos, centavos inseguros y método inválido', () => {
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, precio: 1.001 }] }), { code: 'PRICE_INVALID' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 1, unit_price_cents: Number.MAX_SAFE_INTEGER + 1 }] }), { code: 'PRICE_INVALID' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 2, unit_price_cents: Number.MAX_SAFE_INTEGER }] }), { code: 'TOTAL_UNSAFE' });
  assert.throws(() => api.build({ ...base(), payment_method: 'bitcoin' }), { code: 'PAYMENT_METHOD_INVALID' });
  assert.throws(() => api.build({ payment_method: 'efectivo', items: [{ product_id: 'p', quantity: 0, unit_price_cents: 10 }] }), { code: 'QUANTITY_INVALID' });
});

test('crédito incompleto y referencia de control inválida fallan cerrados', () => {
  assert.throws(() => api.build({ ...base(), payment_method: 'credito', customer_id: 'c-1' }), { code: 'CREDIT_CUSTOMER_OR_DUE_REQUIRED' });
  assert.throws(() => api.build({ ...base(), payment_method: 'yape', payment: { reference: 'bad\nref' } }), { code: 'REFERENCE_INVALID' });
});

test('intención serializable omite autoridad, promociones y secretos', () => {
  const intent = api.build({ ...base(), promotion_id: 'promo', authority_epoch: 4, expected_control_revision: 2,
    expected_stock_revision: 9, token: 'secret', credential: 'secret', device_credential: 'secret' });
  const json = JSON.stringify(intent);
  for (const key of ['promotion_id', 'authority_epoch', 'expected_control_revision', 'expected_stock_revision', 'token', 'credential', 'device_credential']) {
    assert.equal(Object.hasOwn(intent, key), false);
    assert.equal(json.includes(key), false);
  }
  assert.doesNotThrow(() => JSON.parse(json));
});
