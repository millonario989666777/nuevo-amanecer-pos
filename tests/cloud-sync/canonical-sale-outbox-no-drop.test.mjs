// RED (CANON close-409): a definitive 409 that is NOT stale_stock must never
// remove a durable sale intent without a server receipt (owner rule 1), on
// both the background drain and the cash-close barrier paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('../../POS/js/sync/canonical-sale-outbox.js', import.meta.url), 'utf8');
const intentSource = readFileSync(new URL('../../POS/js/sync/canonical-sale-intent.js', import.meta.url), 'utf8');
const KEY = 'na_canonical_sale_outbox_v1';
const copy = v => JSON.parse(JSON.stringify(v));
function cash(id) { return { version: 1, operation_id: `op-${id}`, sale_id: `sale-${id}`, created_at: '2026-10-11T03:04:05.000Z', items: [{ product_id: 'p1', quantity: 1, unit_price_cents: 250, line_total_cents: 250 }], payment_method: 'efectivo', total_cents: 250, payment: { cash_cents: 250, digital_cents: 0, credit_cents: 0, digital_method: null, reference: '' } }; }
function credit(id) { return { ...cash(id), payment_method: 'credito', customer_id: 'cust-local-only', credit_due: '2026-11-11', payment: { cash_cents: 0, digital_cents: 0, credit_cents: 250, digital_method: null, reference: '' } }; }
function storage() { const values = new Map(); return { values, getItem: k => values.get(k) ?? null, setItem(k, v) { values.set(k, String(v)); }, removeItem(k) { values.delete(k); } }; }
function locks() { let held = false; return { async request(n, o, cb) { if (held) return cb(null); held = true; try { return await cb({ name: n }); } finally { held = false; } } }; }
// canonical mimics canonical-client.js: createSale journals the payload, the
// Worker answers 409 <reason>, discardRejectedSale clears the journal (allowlist).
function fixture(reason, { preJournal = false } = {}) {
  const local = storage(), state = { pending: null, receipt: null, discards: 0 };
  const context = vm.createContext({ localStorage: local, navigator: { locks: locks(), onLine: true }, crypto: { randomUUID } });
  vm.runInContext(intentSource, context); vm.runInContext(source, context);
  context.NuevoAmanecerCanonical = {
    async refresh() {}, async retryPending() { throw Error('unexpected retryPending'); },
    async createSale(i) {
      if (preJournal) { const e = Error(reason); e.code = reason; throw e; }
      state.pending = { state: 'PENDING', command: 'sale.create', payload: copy(i), last_error: reason, last_status: 409 };
      throw Error('CANONICAL_FINANCIAL_REJECTED_409');
    },
    async discardRejectedSale() { if (!state.pending) return false; state.pending = null; state.discards++; return true; },
    pendingSnapshot: () => copy(state.pending), receiptSnapshot: () => copy(state.receipt),
  };
  const api = context.NuevoAmanecerCanonicalSaleOutbox;
  const ids = () => api.snapshot().intents.map(x => x.operation_id);
  return { api, state, ids, local, ctx: context };
}

for (const reason of ['product_not_found', 'cash_session_closed', 'sale_id_conflict']) {
  test(`RED drain: 409 ${reason} keeps the head and every sale behind it`, async () => {
    const f = fixture(reason);
    for (const x of [credit('V-085'), credit('V-086'), cash('V-090')]) await f.api.enqueue(x);
    const before = f.ids();
    const out = await f.api.sync();
    assert.deepEqual(f.ids(), before, 'no intent may leave the outbox without a server receipt');
    assert.notEqual(out.status, 'DRAINED');
    assert.match(String(out.reason), new RegExp(reason));
  });
  test(`RED close barrier: 409 ${reason} never closes cash and never drops the sale`, async () => {
    const f = fixture(reason);
    await f.api.enqueue(credit('V-085'));
    const before = f.ids();
    let closed = false;
    await assert.rejects(f.api.withCashCloseBarrier(async () => { closed = true; }), /CASH_CLOSE_PENDING_SALES/);
    assert.equal(closed, false, 'cash must stay open while a sale is unresolved');
    assert.deepEqual(f.ids(), before);
  });
}

test('RED close barrier exposes the blocking sale and real reason (pre-journal credit failure)', async () => {
  const f = fixture('INVALID_CANONICAL_CUSTOMER', { preJournal: true });
  await f.api.enqueue(credit('V-085'));
  const error = await f.api.withCashCloseBarrier(async () => {}).then(() => null, e => e);
  assert.ok(error);
  assert.equal(error.code, 'CASH_CLOSE_PENDING_SALES');
  assert.equal(error.reason, 'INVALID_CANONICAL_CUSTOMER');
  assert.equal(error.sale_id, f.api.snapshot().intents[0].sale_id);
  assert.equal(f.ids().length, 1);
});

test('GUARD pre-journal credit failure leaves the intent queued with no journal (current behavior)', async () => {
  const f = fixture('INVALID_CANONICAL_CUSTOMER', { preJournal: true });
  await f.api.enqueue(credit('V-085')); await f.api.enqueue(cash('V-090'));
  const out = await f.api.sync();
  assert.equal(out.status, 'WAITING');
  assert.equal(out.reason, 'INVALID_CANONICAL_CUSTOMER');
  assert.equal(f.ids().length, 2);
  assert.equal(f.state.pending, null);
});

// GREEN criteria (Forense + Auditor)
test('GREEN quarantine survives reload and keeps blocking close with sale_id + 409 reason', async () => {
  const f = fixture('product_not_found');
  await f.api.enqueue(credit('V-085')); await f.api.enqueue(cash('V-090'));
  await f.api.sync();
  const raw = f.local.getItem(KEY);
  const g = fixture('product_not_found');
  g.local.setItem(KEY, raw); g.state.pending = copy(f.state.pending);
  assert.equal(g.state.pending.last_error, 'product_not_found', 'journal evidence kept');
  const error = await g.api.withCashCloseBarrier(async () => { throw Error('must not close'); }).then(() => null, e => e);
  assert.equal(error.code, 'CASH_CLOSE_PENDING_SALES');
  assert.equal(error.reason, 'product_not_found');
  assert.equal(error.sale_id, g.api.snapshot().intents[0].sale_id);
  assert.equal(error.remaining, 2);
  assert.equal(g.ids().length, 2);
});
for (const reason of ['sale_id_conflict', 'operation_id_conflict']) {
  test(`GREEN ${reason}: remote record of same operation settles once, no charge-again notice`, async () => {
    const f = fixture(reason), notes = [];
    await f.api.enqueue(credit('V-085')); await f.api.enqueue(cash('V-090'));
    const [head] = f.api.snapshot().intents;
    const ctxCanon = f.ctx.NuevoAmanecerCanonical;
    let remoteSales = [];
    ctxCanon.snapshot = () => ({ sales: copy(remoteSales) });
    ctxCanon.sourceState = () => ({ validation: 'current' });
    f.ctx.NuevoAmanecerCanonicalUIAdapter = { runtime: { notify: m => notes.push(m) } };
    const first = await f.api.sync();
    assert.equal(first.status, 'BLOCKED_PENDING_REJECTED');
    assert.equal(f.ids().length, 2, 'not proven remotely: nothing removed');
    remoteSales = [{ sale_id: head.sale_id, operation_id: head.operation_id }];
    f.ctx.NuevoAmanecerCanonical.createSale = async i => { f.state.receipt = { operation_id: i.operation_id, sale_id: i.sale_id }; };
    const second = await f.api.sync();
    assert.equal(second.status, 'DRAINED');
    assert.equal(second.processed, 2);
    assert.equal(f.ids().length, 0);
    assert.equal(notes.filter(n => /vuelve a cobrarla/i.test(n)).length, 0);
  });
}
