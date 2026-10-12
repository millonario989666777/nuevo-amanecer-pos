// P1-4 "Anular abono": real path bridge -> canonical-client.createCompensation ->
// Worker -> SQLite (D1 contract) -> refresh -> UI adapter. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';

const bridge = readFileSync('POS/js/sync/canonical-payment-annul-bridge.js', 'utf8');
const scripts = [['canonical-payment-annul-bridge.js', bridge]];
const REFS = ['0021_canonical_payment_references.sql'];
const CREDIT = 'CR:001';

function owner(extra = {}) {
  return {
    prompt: () => 'Abono registrado en el crédito equivocado',
    _naConfirmAction: async () => true,
    _naF10CurrentCashier: () => ({ id: 'CAJ-001', nombre: 'Dueño', role: 'admin' }),
    _naAudit() {},
    ...extra,
  };
}
const credit = (tab) => tab.api.legacySnapshot().credits.find((c) => c.id === CREDIT);
const balance = (f) => f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?', CREDIT).b;
const lastToast = (tab) => (tab.toasts.at(-1) || [])[0] || '';

async function payYape(tab, reference = 'YAPE-ANUL-1', amount = 150) {
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: amount, payment_method: 'yape', reference });
  await tab.api.refresh();
  return credit(tab).pagos.find((p) => p.referencia === reference);
}

test('Yape abono annulled: original REVERTED, compensation not listed, balance restored, reference stays used', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const tab = await device(f, { token: 'owner-token', deviceId: 'owner', scripts, globals: owner() });
  const start = balance(f);
  const pay = await payYape(tab);
  assert.equal(balance(f), start - 150);
  assert.equal(pay.canonicalLive, true);
  assert.ok(pay.operationId);

  assert.equal(await tab.context.revertirPagoCredito(CREDIT, pay.pagoId), true, lastToast(tab));
  assert.equal(balance(f), start, 'credit balance restored');
  const comp = f.sql("SELECT * FROM canonical_financial_events WHERE event_type='COMPENSATION'");
  assert.equal(comp.compensates_operation_id, pay.operationId);
  assert.equal(comp.reason, 'Abono registrado en el crédito equivocado');
  assert.equal(comp.cash_delta_cents, 0);
  assert.equal(comp.session_id, null);

  const view = credit(tab);
  const live = view.pagos.filter((p) => p.canonicalLive);
  assert.equal(live.length, 1, 'the compensation is not shown as a second payment');
  assert.ok(view.pagos.every((p) => p.monto >= 0), 'no negative payment');
  assert.equal(live[0].status, 'REVERTED');
  assert.equal(live[0].reversalReason, 'Abono registrado en el crédito equivocado');
  assert.match(live[0].reversalFecha, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(Math.round(view.saldo * 100), start);

  // The voucher number stays registered on the server.
  await assert.rejects(tab.api.createPayment({ credit_id: CREDIT, amount_cents: 100, payment_method: 'yape', reference: 'YAPE-ANUL-1' }));
  assert.equal(tab.api.pendingSnapshot().last_error, 'reference_already_used');
});

test('cash abono requires an open till and is recorded as a cash outflow of that till', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'owner-token', deviceId: 'owner', scripts, globals: owner() });
  await tab.api.openCash({ session_id: 'S-1', opening_cents: 1000 });
  await tab.api.refresh();
  await tab.api.createPayment({ credit_id: CREDIT, amount_cents: 200, payment_method: 'efectivo', session_id: 'S-1' });
  await tab.api.refresh();
  const pay = credit(tab).pagos.find((p) => p.canonicalLive && p.metodo === 'efectivo' && p.status !== 'REVERTED');
  const expectedBefore = f.sql("SELECT expected_cents e FROM canonical_cash_state WHERE session_id='S-1'").e;
  assert.equal(expectedBefore, 1200);

  // Closed till: refused, nothing written.
  const counted = tab.api.snapshot().cashSessions.find((s) => s.session_id === 'S-1');
  await tab.api.closeCash({ session_id: 'S-1', counted_cents: counted.expected_cents });
  await tab.api.refresh();
  assert.equal(await tab.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.match(lastToast(tab), /Abre la caja/);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='COMPENSATION'").n, 0);

  // New till open: the money leaves THIS till.
  await tab.api.openCash({ session_id: 'S-2', opening_cents: 500 });
  await tab.api.refresh();
  const balBefore = balance(f);
  assert.equal(await tab.context.revertirPagoCredito(CREDIT, pay.pagoId), true, lastToast(tab));
  assert.equal(balance(f), balBefore + 200);
  const comp = f.sql("SELECT * FROM canonical_financial_events WHERE event_type='COMPENSATION'");
  assert.equal(comp.session_id, 'S-2');
  assert.equal(comp.cash_delta_cents, -200);
  assert.equal(f.sql("SELECT expected_cents e FROM canonical_cash_state WHERE session_id='S-2'").e, 300);
  const move = tab.api.legacySnapshot().cashMovements.find((m) => m.reversalOf === pay.operationId);
  assert.equal(move.tipo, 'egr');
  assert.equal(move.monto, 2);
  assert.match(move.desc, /^Anulación de abono/);
});

test('no double annul (same tab, second tab, stale replica) and idempotent replay of a lost ACK', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  let drop = false;
  const tab = await device(f, { token: 'owner-token', deviceId: 'owner', scripts, globals: owner(), onFetch: async (url, o, run) => {
    if (drop && url.endsWith('/commands/compensation.create')) { drop = false; await run(); throw new TypeError('network lost after commit'); }
  } });
  const other = await device(f, { token: 'other-token', deviceId: 'other', scripts, globals: owner() });
  const pay = await payYape(tab, 'YAPE-ACK-1');
  await other.api.refresh();

  drop = true;
  assert.equal(await tab.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.match(lastToast(tab), /MISMA operación/);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='COMPENSATION'").n, 1, 'committed once');
  const op = tab.api.pendingSnapshot().payload.operation_id;
  // Tap again: replays the SAME operation_id.
  assert.equal(await tab.context.revertirPagoCredito(CREDIT, pay.pagoId), true, lastToast(tab));
  assert.equal(tab.api.pendingSnapshot(), null);
  assert.equal(f.sql("SELECT operation_id o FROM canonical_financial_events WHERE event_type='COMPENSATION'").o, op);
  // Same tab again: already annulled locally.
  assert.equal(await tab.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.match(lastToast(tab), /ya fue anulado/);
  // Second device with the old view: refreshes and refuses.
  assert.equal(await other.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.match(lastToast(other), /ya fue anulado/);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='COMPENSATION'").n, 1);
});

test('authorization: reason >= 8 chars; non-owner needs the master PIN; without PIN and owner role it is refused', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const cashier = { _naF10CurrentCashier: () => ({ id: 'CAJ-002', nombre: 'Cajero', role: 'cajero' }) };
  const short = await device(f, { token: 'a-token', deviceId: 'a', scripts, globals: owner({ prompt: () => 'error' }) });
  const pay = await payYape(short, 'YAPE-AUTH-1');
  assert.equal(await short.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.match(lastToast(short), /mínimo 8/);

  const noPin = await device(f, { token: 'b-token', deviceId: 'b', scripts, globals: owner(cashier) });
  assert.equal(await noPin.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.match(lastToast(noPin), /PIN maestro/);

  let asked = 0;
  const wrongPin = await device(f, { token: 'c-token', deviceId: 'c', scripts, globals: owner({ ...cashier, _naSecurity: { pinEnabled: true, pinHash: 'x' }, _naF10MasterOverride: () => { asked++; return false; } }) });
  assert.equal(await wrongPin.context.revertirPagoCredito(CREDIT, pay.pagoId), false);
  assert.equal(asked, 1);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='COMPENSATION'").n, 0);

  const goodPin = await device(f, { token: 'd-token', deviceId: 'd', scripts, globals: owner({ ...cashier, _naSecurity: { pinEnabled: true, pinHash: 'x' }, _naF10MasterOverride: () => true }) });
  assert.equal(await goodPin.context.revertirPagoCredito(CREDIT, pay.pagoId), true, lastToast(goodPin));
});

test('Worker: compensation must target a payment of the stated credit; second compensation is already_compensated', async (t) => {
  const f = await activeCanon(t, { migrations: REFS });
  const tab = await device(f, { token: 'owner-token', deviceId: 'owner', scripts, globals: owner() });
  const pay = await payYape(tab, 'YAPE-W-1');
  const c = f.control();
  const base = { promotion_id: c.active_promotion_id, client_contract: 'a6-gate-c-v1', authority_epoch: c.authority_epoch, expected_control_revision: c.revision, created_at: new Date().toISOString(), reason: 'Prueba de anulación' };
  const raw = tab.api.snapshot().credits.find((x) => x.credit_id === CREDIT);
  const post = (body) => f.fetch('http://localhost/commands/compensation.create', { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res = await post({ ...base, operation_id: 'comp-mismatch', compensates_operation_id: pay.operationId, expected_credit_revision: raw.revision, credit_id: 'CR:OTHER' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'compensation_credit_mismatch');
  res = await post({ ...base, operation_id: 'comp-ok', compensates_operation_id: pay.operationId, expected_credit_revision: raw.revision, credit_id: CREDIT });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  res = await post({ ...base, operation_id: 'comp-twice', compensates_operation_id: pay.operationId, expected_credit_revision: raw.revision + 1, credit_id: CREDIT });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'already_compensated');
  // Replay of the committed operation stays idempotent.
  res = await post({ ...base, operation_id: 'comp-ok', compensates_operation_id: pay.operationId, expected_credit_revision: raw.revision, credit_id: CREDIT });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'already_processed');
});

test('imported (historical) payments cannot be annulled from the app and show no button', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'owner-token', deviceId: 'owner', scripts, globals: owner() });
  const imported = tab.api.legacySnapshot().credits.flatMap((c) => (c.pagos || []).map((p) => [c, p])).find(([, p]) => !p.canonicalLive);
  if (!imported) return t.skip('fixture has no imported payment');
  assert.equal(await tab.context.revertirPagoCredito(imported[0].id, imported[1].pagoId), false);
  assert.match(lastToast(tab), /histórico/);
  const src = readFileSync('POS/js/legacy-inline/inline-12.js', 'utf8');
  assert.match(src, /!\(payment\.canonical&&!payment\.canonicalLive\)/);
});
