// Cola del cliente: un lote (payment.batch) rechazado con credit_voided se descarta y avisa, igual que el pago individual.
// Datos sintéticos; worker real del harness.
process.env.TZ = 'America/Lima';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const bridge = readFileSync(new URL('../../POS/js/sync/canonical-credit-payment-bridge.js', import.meta.url), 'utf8');
const scripts = [['canonical-credit-payment-bridge.js', bridge]];
const CREDIT = 'CR:001';
const TOKEN = 'device-a-token';
const payments = f => f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n;
const voidCredit = f => { f.database.exec('DROP TRIGGER IF EXISTS credits_no_update'); f.exec(`UPDATE credits SET source_status='ANULADO' WHERE credit_id='${CREDIT}'`); };
const batchReq = ref => ({ allocations:[{ credit_id:CREDIT, amount_cents:100 }], payment_method:'yape', reference:ref });
const forced = (route, error) => async url => url.endsWith('/commands/' + route)
  ? new Response(JSON.stringify({ error, credit_id:CREDIT }), { status:409 }) : null;
const voidedToast = tab => tab.toasts.some(([m]) => /crédito está anulado y no acepta abonos/.test(m));

test('lote rechazado con credit_voided (worker real): se descarta de la cola y avisa', async t => {
  const f = await activeCanon(t);
  voidCredit(f);
  const tab = await device(f, { token:TOKEN, deviceId:'device-a', scripts });
  const r = await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirmBatch(batchReq('LOTE-V1'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BATCH_PAYMENT_REJECTED');
  assert.equal(tab.api.pendingSnapshot(), null, 'el lote rechazado no queda bloqueando la cola');
  assert.ok(voidedToast(tab), JSON.stringify(tab.toasts));
  assert.equal(payments(f), 0);
});

test('lote rechazado con credit_voided (respuesta forzada): se descarta y avisa', async t => {
  const f = await activeCanon(t);
  const tab = await device(f, { token:TOKEN, deviceId:'device-a', scripts, onFetch:forced('payment.batch', 'credit_voided') });
  const r = await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirmBatch(batchReq('LOTE-V2'));
  assert.equal(r.ok, false);
  assert.equal(tab.api.pendingSnapshot(), null);
  assert.ok(voidedToast(tab), JSON.stringify(tab.toasts));
});

test('control: un lote rechazado por otro motivo mantiene el contrato anterior (queda pendiente para revisión)', async t => {
  const f = await activeCanon(t);
  const tab = await device(f, { token:TOKEN, deviceId:'device-a', scripts, onFetch:forced('payment.batch', 'reference_already_used') });
  const r = await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirmBatch(batchReq('LOTE-V3'));
  assert.equal(r.ok, false);
  const pending = tab.api.pendingSnapshot();
  assert.equal(pending && pending.command, 'payment.batch');
  assert.equal(pending.last_error, 'reference_already_used');
  assert.ok(!voidedToast(tab));
});

test('control: lote sobre crédito vigente se confirma igual que antes', async t => {
  const f = await activeCanon(t);
  const tab = await device(f, { token:TOKEN, deviceId:'device-a', scripts });
  const r = await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirmBatch(batchReq('LOTE-V4'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(payments(f), 1);
  assert.equal(tab.api.pendingSnapshot(), null);
});
