import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeCanon, device } from './canon-browser-harness.mjs';
import { deferred, intercept } from './a6-fixture.mjs';

// Real path: bridge -> canonical-client.createPayment -> Worker -> SQLite(D1
// contract) -> receipt -> refresh -> UI adapter. Synthetic data only.
const bridge = readFileSync('POS/js/sync/canonical-credit-payment-bridge.js', 'utf8');
const scripts = [['canonical-credit-payment-bridge.js', bridge]];
const CREDIT = 'CR:001';

function creditOf(tab) {
  return tab.api.legacySnapshot().credits.find((credit) => credit.id === CREDIT);
}
function fill(tab, { amount, method = 'efectivo', reference = '' }) {
  tab.context.pagoCredId = CREDIT;
  tab.el('pagoMonto').value = amount;
  tab.el('pagoMetodo').value = method;
  tab.el('pagoOperacion').value = reference;
}
async function openCash(tab) {
  await tab.api.openCash({ session_id: 'e2e-cash-session', opening_cents: 5000 });
  await tab.api.refresh();
}

test('one-debt cobro múltiple uses the specialized batch endpoint but persists one payment.create child', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token:'device-a-token', deviceId:'device-a', scripts });
  const before = tab.fetchLog.length;
  const result = await tab.api.createPaymentBatch([
    { credit_id:CREDIT, amount_cents:100, payment_method:'yape', reference:'ONE-DEBT-LEAN-1' }
  ]);
  assert.equal(result.ok,true);
  assert.equal(result.receipts.length,1);
  assert.equal(result.receipts[0].command,'payment.create');
  assert.deepEqual(
    tab.fetchLog.slice(before).map(row => row.method + ' ' + new URL(row.url).pathname),
    ['POST /commands/payment.batch'],
    'one selected debt must use the same lean transport as larger multi-payments'
  );
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n,1);
  assert.equal(f.sql("SELECT command FROM canonical_financial_operations LIMIT 1").command,'payment.create');
  assert.equal(f.sql("SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?",CREDIT).b,600);
});

test('payment latency: one POST before receipt; full HTTP reconciliation and renders never hold Procesando', async (t) => {
  const f = await activeCanon(t);
  const gate = deferred();
  const stages = {};
  const restore = intercept(f, async (event) => {
    if (event.method !== 'batch' || !event.entries?.some(row => row.sql.includes('INSERT INTO canonical_financial_operations('))) return;
    stages.d1 ??= {};
    stages.d1[event.when] = performance.now();
  });
  t.after(restore);
  let posted = false;
  const renders = [];
  const tab = await device(f, {
    token: 'device-a-token', deviceId: 'device-a', scripts,
    globals: {
      cliRender() { renders.push('clients'); },
      cajRender() { renders.push('cash'); },
      updateDashboard() { renders.push('dashboard'); },
    },
    async onFetch(url, options, forward) {
      if (url.endsWith('/commands/payment.create')) {
        posted = true;
        stages.postStart = performance.now();
        const reply = await forward();
        stages.postEnd = performance.now();
        return reply;
      }
      if (posted && url.includes('/read/canonical/')) {
        stages.refreshStart ??= performance.now();
        if (url.endsWith('/status')) await gate.promise;
      }
      return null;
    },
  });
  const close = tab.context.__closed.push.bind(tab.context.__closed);
  tab.context.__closed.push = (...ids) => { stages.modalClosed = performance.now(); return close(...ids); };
  fill(tab, { amount: '1', method: 'yape', reference: 'LATENCY-1' });
  const before = tab.fetchLog.length;
  stages.tap = performance.now();
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  stages.uiReleased = performance.now();
  assert.equal(tab.api.receiptSnapshot().status, 'created');
  assert.equal(tab.el('pagoConfirmBtn').disabled, false);
  assert.notEqual(tab.el('pagoConfirmBtn').textContent, 'Procesando…');
  assert.deepEqual([...tab.context.__closed], ['mPagoCred']);
  // The targeted reconciliation (P1-1) may already have its first reads in flight (at most
  // 4 at once), but it never holds the receipt and never touches unrelated collections.
  const receiptPath = tab.fetchLog.slice(before).map(x => x.method + ' ' + new URL(x.url).pathname);
  assert.deepEqual(receiptPath.slice(0, 3), ['POST /commands/payment.create', 'GET /read/canonical/status', 'GET /read/canonical/credit-accounts']);
  assert.ok(receiptPath.length <= 5, receiptPath.join(', '));
  assert.ok(receiptPath.slice(3).every(x => /^GET \/read\/canonical\/(?:credits|credit-payments|cash-sessions|cash-movements|financial-events)$/.test(x)), receiptPath.join(', '));
  assert.deepEqual(renders, [], 'no bridge-driven full renders on the receipt path');
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 1);
  assert.ok(stages.d1.before >= stages.postStart && stages.d1.after <= stages.postEnd);
  gate.resolve();
  await tab.api.refresh();
  stages.refreshEnd = performance.now();
  const after = tab.fetchLog.slice(before);
  assert.equal(after.filter(x => x.method === 'POST').length, 1);
  // P1-1: only this device's payment happened since the validated base, so the
  // reconciliation re-reads exactly what payment.create can change (no products,
  // customers, sales, sale items, inventory or expenses).
  assert.deepEqual(after.filter(x => x.method === 'GET').map(x => new URL(x.url).pathname.replace('/read/canonical/', '')).sort(),
    ['cash-movements', 'cash-sessions', 'credit-accounts', 'credit-payments', 'credits', 'financial-events', 'status']);
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(creditOf(tab).saldo, 6);
  assert.deepEqual(renders, [], 'the canonical-updated listener, not the bridge, owns page rendering');
  t.diagnostic(JSON.stringify({
    httpBeforeReceipt: 1, httpAfterReceipt: after.length - 1,
    tapToPostMs: +(stages.postStart - stages.tap).toFixed(2),
    workerAndD1Ms: +(stages.postEnd - stages.postStart).toFixed(2),
    d1BatchMs: +(stages.d1.after - stages.d1.before).toFixed(2),
    receiptToModalCloseMs: +(stages.modalClosed - stages.postEnd).toFixed(2),
    postToUiReleaseMs: +(stages.uiReleased - stages.postEnd).toFixed(2),
    backgroundRefreshMs: +(stages.refreshEnd - stages.refreshStart).toFixed(2),
  }));
});

test('durable receipt event is emitted before full reconciliation and never before confirmed journal storage', async (t) => {
  const f = await activeCanon(t);
  const gate = deferred();
  let posted = false;
  const tab = await device(f, {
    token:'device-a-token', deviceId:'device-a', scripts,
    async onFetch(url, options, forward) {
      if (url.endsWith('/commands/payment.create')) {
        posted = true;
        return forward();
      }
      if (posted && url.endsWith('/read/canonical/status')) await gate.promise;
      return null;
    }
  });

  const events = [];
  tab.context.addEventListener('na:canonical-payment-receipt', (event) => {
    const journal = JSON.parse(tab.localStorage.getItem('na_canonical_sale_journal'));
    events.push({ detail:event.detail, journalState:journal && journal.state, journalOperation:journal && journal.payload && journal.payload.operation_id });
  });

  fill(tab,{amount:'1',method:'yape',reference:'INSTANT-RECEIPT-1'});
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(),true);
  assert.equal(events.length,1,'receipt event must not wait for background reconciliation');
  assert.equal(events[0].journalState,'CONFIRMED','event is allowed only after durable confirmed journal');
  assert.equal(events[0].detail.command,'payment.create');
  assert.equal(events[0].detail.payload.operation_id,events[0].detail.receipt.operation_id);
  assert.equal(events[0].journalOperation,events[0].detail.payload.operation_id);
  assert.equal(events[0].detail.payload.credit_id,CREDIT);
  assert.equal(events[0].detail.payload.amount_cents,100);
  assert.equal(events[0].detail.receipt.current_balance_cents,600);
  assert.equal(f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?',CREDIT).b,600);
  assert.equal(creditOf(tab).saldo,7,'full replica is intentionally still stale while the background GET is blocked');

  gate.resolve();
  await tab.api.refresh();
  assert.equal(creditOf(tab).saldo,6);
});

test('Registrar pago (efectivo) persists through payment.create, survives F5 and is seen by a second device', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts });
  assert.equal(creditOf(tab).saldo, 7);
  await openCash(tab);

  fill(tab, { amount: '2.50' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  await tab.api.refresh();

  const events = f.all("SELECT * FROM canonical_financial_events WHERE event_type='PAYMENT'");
  assert.equal(events.length, 1);
  assert.equal(events[0].credit_id, CREDIT);
  assert.equal(events[0].credit_delta_cents, -250);
  assert.equal(events[0].cash_delta_cents, 250);
  assert.equal(events[0].session_id, 'e2e-cash-session');
  assert.equal(f.sql("SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?", CREDIT).b, 450);
  assert.equal(f.sql("SELECT expected_cents e FROM canonical_cash_state WHERE session_id='e2e-cash-session'").e, 5250);

  // Visible projection after the post-commit refresh.
  const credit = creditOf(tab);
  assert.equal(credit.saldo, 4.5);
  assert.ok(credit.pagos.some((p) => p.id === events[0].event_id && p.monto === 2.5 && p.metodo === 'efectivo'));
  assert.equal(tab.api.legacySnapshot().cashState.esperado, 52.5);
  assert.deepEqual(tab.context.__closed, ['mPagoCred']);
  assert.ok(tab.toasts.some(([m, tone]) => /Pago CANON de S\/ 2\.50 CONFIRMADO/.test(m) && tone === 'success'));

  // F5: same localStorage, brand-new runtime.
  const reloaded = await device(f, { token: 'device-a-token', localStorage: tab.localStorage, scripts });
  assert.equal(creditOf(reloaded).saldo, 4.5);
  assert.equal(creditOf(reloaded).pagos.filter((p) => p.id === events[0].event_id).length, 1);

  // Second device with its own storage and session.
  const other = await device(f, { token: 'device-b-token', deviceId: 'device-b', scripts });
  assert.equal(creditOf(other).saldo, 4.5);
  assert.equal(other.api.legacySnapshot().cashState.esperado, 52.5);
});

test('digital payment keeps the reference, attaches no cash session and duplicate reference is rejected', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts });
  fill(tab, { amount: '1', method: 'yape', reference: 'YAPE-7788' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  await tab.api.refresh();
  const event = f.sql("SELECT * FROM canonical_financial_events WHERE event_type='PAYMENT'");
  assert.equal(event.reference, 'YAPE-7788');
  assert.equal(event.session_id, null);
  assert.equal(event.cash_delta_cents, 0);
  assert.equal(creditOf(tab).pagos.find((p) => p.id === event.event_id).numeroOperacion, 'YAPE-7788');

  fill(tab, { amount: '1', method: 'transferencia', reference: 'yape-7788' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 1);
  assert.ok(tab.toasts.some(([m]) => /ya fue registrado/.test(m)));
});

test('lost ACK after commit: retry reuses the same operation_id and never duplicates the payment', async (t) => {
  const f = await activeCanon(t);
  let dropAck = true;
  const tab = await device(f, {
    token: 'device-a-token', deviceId: 'device-a', scripts,
    async onFetch(url, options, forward) {
      if (url.endsWith('/commands/payment.create') && dropAck) { dropAck = false; await forward(); throw new TypeError('network lost after commit'); }
      return null;
    },
  });
  fill(tab, { amount: '3', method: 'yape', reference: 'OP-ACK-1' });
  const initialStatusReads = tab.fetchLog.filter(x => x.url.endsWith('/read/canonical/status')).length;
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  const afterFirstStatusReads = tab.fetchLog.filter(x => x.url.endsWith('/read/canonical/status')).length;
  assert.equal(afterFirstStatusReads - initialStatusReads, 0, 'no additional status GET before first payment POST');
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 1, 'server committed');
  assert.ok(tab.toasts.some(([m]) => /NO lo registres de nuevo/.test(m)));
  assert.deepEqual(tab.context.__closed, [], 'modal stays open while unconfirmed');
  const pending = tab.api.pendingSnapshot();
  assert.equal(pending.command, 'payment.create');

  // The user taps again (even with other values): the SAME operation is retried.
  fill(tab, { amount: '5', method: 'yape', reference: 'OP-OTHER' });
  const statusBeforeRetry = tab.fetchLog.filter(x => x.url.endsWith('/read/canonical/status')).length;
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  const rows = f.all("SELECT * FROM canonical_financial_events WHERE event_type='PAYMENT'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation_id, pending.payload.operation_id);
  assert.equal(rows[0].credit_delta_cents, -300);
  assert.equal(tab.api.pendingSnapshot(), null);
  assert.equal(tab.api.receiptSnapshot().status, 'already_processed');
  assert.ok(tab.toasts.some(([m]) => /Pago CANON pendiente de S\/ 3\.00/.test(m)));
  assert.equal(tab.fetchLog.filter(x => x.url.endsWith('/commands/payment.create')).length, 2);
  assert.ok(tab.fetchLog.filter(x => x.url.endsWith('/read/canonical/status')).length > statusBeforeRetry,
    'authority status is checked before retrying the same operation');
  await tab.api.refresh();
  assert.equal(creditOf(tab).saldo, 4);
});

test('committed payment whose post-commit refresh fails is reported as CONFIRMED, not as a failure', async (t) => {
  const f = await activeCanon(t);
  let failReads = false;
  const tab = await device(f, {
    token: 'device-a-token', deviceId: 'device-a', scripts,
    async onFetch(url) {
      if (url.includes('/commands/payment.create')) { failReads = true; return null; }
      if (failReads && url.includes('/read/canonical/')) return new Response(JSON.stringify({ error: 'boom' }), { status: 503 });
      return null;
    },
  });
  fill(tab, { amount: '1', method: 'transferencia', reference: 'TRF-0001' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 1);
  assert.deepEqual(tab.context.__closed, ['mPagoCred']);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(tab.toasts.some(([m]) => /CONFIRMADO/.test(m) && /NO repitas el pago/.test(m)));
  assert.equal(tab.toasts.some(([m]) => /No se registró/.test(m)), false);
  assert.equal(tab.api.receiptSnapshot().status, 'created');
});

test('server rejection is definitive; the slot is released at once (friendly message) and the next tap starts a new operation', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, {
    token: 'device-a-token', deviceId: 'device-a', scripts,
    async onFetch(url) {
      if (url.endsWith('/commands/payment.create')) return new Response(JSON.stringify({ error: 'stale_credit' }), { status: 409 });
      return null;
    },
  });
  const receiptEvents=[];
  tab.context.addEventListener('na:canonical-payment-receipt',event=>receiptEvents.push(event.detail));
  fill(tab, { amount: '1', method: 'yape', reference: 'REJ-0001' });

  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  assert.equal(receiptEvents.length,0,'rejected command must never project a confirmed payment');
  // P2-3: plain-language message, and the definitive 409 frees the slot immediately.
  assert.ok(tab.toasts.some(([m]) => /El saldo de este crédito cambió en otro equipo.*No se registró ningún abono/.test(m)));
  assert.ok(!tab.toasts.some(([m]) => /rechazó el pago \(stale_credit\)/.test(m)));
  assert.equal(tab.api.pendingSnapshot(),null,'the definitively rejected journal is released without a second tap');
  const firstOperations=tab.fetchLog.filter((x) => x.url.endsWith('/commands/payment.create')).map(x=>JSON.parse(x.body||'{}').operation_id);
  const before = firstOperations.length;

  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  const calls = tab.fetchLog.filter((x) => x.url.endsWith('/commands/payment.create'));
  assert.equal(calls.length, before + 1,'the next explicit tap creates exactly one fresh intent');
  const secondOperation=JSON.parse(calls.at(-1).body||'{}').operation_id;
  assert.ok(secondOperation&&!firstOperations.includes(secondOperation),'a definitively rejected intent must never be replayed as if its outcome were uncertain');
  assert.equal(tab.api.pendingSnapshot(),null);
  assert.equal(receiptEvents.length,0,'neither rejected intent may project success');
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events").n, 0,'409 rejections must leave D1 financial state unchanged');
});

test('second device with an old credit revision cannot overwrite the new balance (stale_credit)', async (t) => {
  const f = await activeCanon(t);
  const first = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts });
  const second = await device(f, { token: 'device-b-token', deviceId: 'device-b', scripts });
  fill(first, { amount: '1', method: 'yape', reference: 'DEVICE-A-1' });
  assert.equal(await first.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  fill(second, { amount: '1', method: 'transferencia', reference: 'DEVICE-B-1' });
  assert.equal(await second.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false);
  assert.ok(second.toasts.some(([m]) => /El saldo de este crédito cambió en otro equipo/.test(m)));
  assert.equal(second.api.pendingSnapshot(), null, 'stale_credit is definitive: released and refreshed at once (P2-3)');
  assert.deepEqual(second.context.__closed, []);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 1);
  assert.equal(f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?', CREDIT).b, 600);
  // The refreshed replica carries the new revision: one more tap registers the (different) voucher.
  assert.equal(await second.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 2);
  assert.equal(f.sql('SELECT current_balance_cents b FROM canonical_credit_balances WHERE credit_id=?', CREDIT).b, 500);
});

test('reference dedupe matches legacy scope (sales) and ignores payments reversed by COMPENSATION', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts });
  await tab.api.createSale({ items: [{ product_id: '00002', quantity: 1 }], payment_method: 'yape', reference: 'SALE-REF-1' });
  await tab.api.refresh();
  fill(tab, { amount: '1', method: 'yape', reference: 'sale-ref-1' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), false, 'reference already used by a sale');
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 0);

  fill(tab, { amount: '1', method: 'yape', reference: 'WRONG-CREDIT-9' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true);
  await tab.api.refresh();
  const paid = f.sql("SELECT operation_id FROM canonical_financial_events WHERE event_type='PAYMENT'");
  await tab.api.createCompensation({ compensates_operation_id: paid.operation_id, reason: 'Registrado por error' });
  await tab.api.refresh();
  assert.equal(creditOf(tab).saldo, 7);

  fill(tab, { amount: '1', method: 'yape', reference: 'WRONG-CREDIT-9' });
  assert.equal(await tab.context.NuevoAmanecerCanonicalCreditPaymentBridge.confirm(), true, 'reversed reference is not a false positive');
  await tab.api.refresh();
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 2);
  assert.equal(creditOf(tab).saldo, 6);
});

test('double tap on the real stack produces exactly one payment.create request', async (t) => {
  const f = await activeCanon(t);
  const tab = await device(f, { token: 'device-a-token', deviceId: 'device-a', scripts });
  fill(tab, { amount: '1', method: 'yape', reference: 'TAP-0001' });
  const bridgeApi = tab.context.NuevoAmanecerCanonicalCreditPaymentBridge;
  const [first, second] = await Promise.all([bridgeApi.confirm(), bridgeApi.confirm()]);
  assert.deepEqual([first, second], [true, false]);
  assert.equal(tab.fetchLog.filter((x) => x.url.endsWith('/commands/payment.create')).length, 1);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n, 1);
});


test('unanswered batch transport returns pending and replay keeps the exact operation IDs',async t=>{
  const f=await activeCanon(t);
  let block=false,requestBody=null;
  const tab=await device(f,{token:'timeout-token',deviceId:'timeout-device',onFetch:async(url,init,next)=>{
    if(block && new URL(url).pathname==='/commands/payment.batch') {
      requestBody=init.body;
      return new Promise(()=>{});
    }
    return next();
  }});
  const originalTimer=tab.context.setTimeout;
  tab.context.setTimeout=(fn,ms)=>originalTimer(fn,ms===8000?5:ms);
  block=true;
  let timer;
  const result=await Promise.race([
    tab.api.createPaymentBatch([{credit_id:CREDIT,amount_cents:100,payment_method:'yape',reference:'TIMEOUT-SYNTHETIC'}]),
    new Promise(resolve=>{timer=setTimeout(()=>resolve({hung:true}),150);})
  ]);
  clearTimeout(timer);
  assert.equal(result.hung,undefined,'payment must stop waiting when its transport times out');
  assert.equal(result.pending_unresolved,true);
  const pending=tab.api.pendingSnapshot();
  assert.equal(pending.state,'PENDING');
  assert.equal(JSON.stringify(pending.payload),requestBody);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n,0);
  block=false;
  tab.context.setTimeout=originalTimer;
  await tab.api.retryPending();
  await tab.api.refresh();
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n,1);
  assert.equal(creditOf(tab).saldo,6);
});


test('committed batch with a stalled receipt body replays once after bounded status body timeout',async t=>{
  const f=await activeCanon(t);
  let blockBody=false,blockStatus=false;
  const tab=await device(f,{token:'body-timeout-token',deviceId:'body-timeout-device',onFetch:async(url,init,next)=>{
    const path=new URL(url).pathname;
    const response=await next();
    if((blockBody && path==='/commands/payment.batch') || (blockStatus && path==='/read/canonical/status'))
      return {ok:response.ok,status:response.status,json:()=>new Promise(()=>{})};
    return response;
  }});
  const originalTimer=tab.context.setTimeout;
  tab.context.setTimeout=(fn,ms)=>originalTimer(fn,ms===8000?20:ms);
  blockBody=true;
  const result=await tab.api.createPaymentBatch([{credit_id:CREDIT,amount_cents:100,payment_method:'yape',reference:'BODY-TIMEOUT-SYNTHETIC'}]);
  assert.equal(result.pending_unresolved,true);
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n,1);
  const originalPayload=JSON.stringify(tab.api.pendingSnapshot().payload);
  blockBody=false;blockStatus=true;
  let timer;
  const retry=await Promise.race([tab.api.retryPending().then(()=>({ok:true}),e=>({error:e.message})),
    new Promise(resolve=>{timer=setTimeout(()=>resolve({hung:true}),250);})]);
  clearTimeout(timer);
  assert.equal(retry.hung,undefined,'retry status body must also have a deadline');
  assert.equal(retry.error,'CANONICAL_READ_TIMEOUT');
  assert.equal(JSON.stringify(tab.api.pendingSnapshot().payload),originalPayload);
  blockStatus=false;tab.context.setTimeout=originalTimer;
  const receipt=await tab.api.retryPending();
  assert.equal(receipt.status,'already_processed');
  await tab.api.refresh();
  assert.equal(f.sql("SELECT COUNT(*) n FROM canonical_financial_events WHERE event_type='PAYMENT'").n,1);
  assert.equal(creditOf(tab).saldo,6);
});
