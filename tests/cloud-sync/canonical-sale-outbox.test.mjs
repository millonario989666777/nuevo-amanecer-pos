import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('../../POS/js/sync/canonical-sale-outbox.js', import.meta.url), 'utf8');
const intentSource = readFileSync(new URL('../../POS/js/sync/canonical-sale-intent.js', import.meta.url), 'utf8');
const KEY = 'na_canonical_sale_outbox_v1';
const copy = value => JSON.parse(JSON.stringify(value));
function makeIntent(id) { return { version: 1, operation_id: `op-${id}`, sale_id: `sale-${id}`, created_at: '2026-01-02T03:04:05.000Z', items: [{ product_id: 'fake-product', quantity: 1, unit_price_cents: 250, line_total_cents: 250 }], payment_method: 'efectivo', total_cents: 250, payment: { cash_cents: 250, digital_cents: 0, credit_cents: 0, digital_method: null, reference: '' } }; }
function storage(initial) {
  const values = new Map(initial ? [[KEY, initial]] : []);
  return { values, fail: false, drop: false, getItem(k) { return values.get(k) ?? null; }, setItem(k, v) { if (this.fail) throw Error('storage unavailable'); if (!this.drop) values.set(k, String(v)); }, removeItem(k) { values.delete(k); } };
}
function locks() {
  let held = false;
  return { async request(name, options, callback) {
    assert.equal(name, 'na-canonical-sale-outbox'); assert.deepEqual(copy(options), { mode: 'exclusive', ifAvailable: true });
    if (held) return callback(null);
    held = true; try { return await callback({ name }); } finally { held = false; }
  } };
}
function fixture({ local = storage(), lock = locks(), canonical = {} } = {}) {
  const context = vm.createContext({ localStorage: local, navigator: { locks: lock }, crypto: { randomUUID }, fetch() { throw Error('direct fetch forbidden'); } });
  vm.runInContext(intentSource, context); vm.runInContext(source, context);
  const calls = [];
  const api = { async refresh() { calls.push('refresh'); if (canonical.refresh) return canonical.refresh(); }, async createSale(i) { calls.push(['createSale', copy(i)]); if (canonical.createSale) return canonical.createSale(i); canonical.receipt = { operation_id: i.operation_id, sale_id: i.sale_id }; return canonical.receipt; }, async retryPending() { calls.push('retryPending'); if (canonical.retryPending) return canonical.retryPending(); canonical.receipt = { operation_id: canonical.pending.payload.operation_id, sale_id: canonical.pending.payload.sale_id }; canonical.pending = null; return canonical.receipt; }, async discardRejectedSale() { calls.push('discardRejectedSale'); if (canonical.discardRejectedSale) return canonical.discardRejectedSale(); return false; }, pendingSnapshot() { return copy(canonical.pending ?? null); }, receiptSnapshot() { return copy(canonical.receipt ?? null); } };
  context.NuevoAmanecerCanonical = api;
  return { context, local, canonical, calls, api: context.NuevoAmanecerCanonicalSaleOutbox };
}
async function enqueueAll(f, ...items) { for (const item of items) await f.api.enqueue(item); }

test('FIFO durable across reconstructed context', async () => {
  const first = fixture(); await enqueueAll(first, makeIntent('A'), makeIntent('B'), makeIntent('C'));
  const second = fixture({ local: first.local });
  assert.deepEqual(copy(second.api.snapshot().intents), [makeIntent('A'), makeIntent('B'), makeIntent('C')]);
});
test('sale submission failure leaves FIFO untouched for durable retry', async () => {
  const f = fixture({ canonical: { createSale() { throw Error('offline'); } } }); await enqueueAll(f, makeIntent('A'), makeIntent('B'));
  const result = await f.api.sync(); assert.equal(result.status, 'WAITING'); assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'createSale').length, 1); assert.equal(f.api.snapshot().intents.length, 2);
});
test('drains FIFO without forcing a full refresh in front of each sale', async () => {
  const f = fixture(); await enqueueAll(f, makeIntent('A'), makeIntent('B'));
  const result = await f.api.sync(); assert.equal(result.status, 'DRAINED');
  await Promise.resolve();
  assert.deepEqual(f.calls, [['createSale', makeIntent('A')], ['createSale', makeIntent('B')], 'refresh']);
  assert.equal(f.api.snapshot().intents.length, 0);
});
test('lost ACK is not retried in same execution; reload retries same pending once', async () => {
  const state = { pending: null };
  const f = fixture({ canonical: { ...state, createSale(i) { state.pending = { state: 'PENDING', command: 'sale.create', payload: copy(i) }; throw Error('lost ack'); }, pendingSnapshot() { return state.pending; }, retryPending() { state.pending = null; return { operation_id: 'op-A', sale_id: 'sale-A' }; } } }); await f.api.enqueue(makeIntent('A'));
  await f.api.sync(); assert.equal(f.calls.includes('retryPending'), false); assert.equal(f.api.snapshot().intents.length, 1);
  const reloadCanonical = { pending: state.pending, retryPending() { state.pending = null; reloadCanonical.pending = null; reloadCanonical.receipt = { operation_id: 'op-A', sale_id: 'sale-A' }; return reloadCanonical.receipt; }, pendingSnapshot() { return reloadCanonical.pending; } };
  const reload = fixture({ local: f.local, canonical: reloadCanonical });
  assert.equal((await reload.api.sync()).status, 'DRAINED'); assert.equal(reload.calls.filter(x => x === 'retryPending').length, 1); assert.equal(reload.calls.some(x => Array.isArray(x) && x[0] === 'createSale'), false);
});
test('hard pending rejection blocks queue without retry or create', async () => {
  const pending = { state: 'PENDING', command: 'sale.create', payload: makeIntent('A'), last_error: 'stale_stock' };
  const f = fixture({ canonical: { pending } }); await enqueueAll(f, makeIntent('A'), makeIntent('B'));
  assert.equal((await f.api.sync()).status, 'BLOCKED_PENDING_REJECTED'); assert.deepEqual(copy(f.api.snapshot().intents), [makeIntent('A'), makeIntent('B')]); assert.equal(f.calls.includes('retryPending'), false); assert.equal(f.calls.some(x => Array.isArray(x)), false);
});
test('stale-stock recovery never drops the durable intent when the retry becomes an unsafe 5xx rejection', async () => {
  let attempt = 0;
  const canonical = {
    pending: null,
    async createSale(i) {
      attempt += 1;
      if (attempt === 1) {
        canonical.pending = { state: 'PENDING', command: 'sale.create', payload: copy(i), last_error: 'stale_stock', last_status: 409 };
        throw Error('CANONICAL_FINANCIAL_REJECTED_409');
      }
      canonical.pending = { state: 'PENDING', command: 'sale.create', payload: copy(i), last_error: 'financial_storage_error', last_status: 503 };
      throw Error('CANONICAL_FINANCIAL_REJECTED_503');
    },
    async discardRejectedSale() {
      if (canonical.pending?.last_status === 409 && canonical.pending?.last_error === 'stale_stock') {
        canonical.pending = null;
        return true;
      }
      return false;
    }
  };
  const f = fixture({ canonical });
  await f.api.enqueue(makeIntent('A'));
  const result = await f.api.sync();
  assert.equal(result.status, 'WAITING');
  assert.equal(result.reason, 'financial_storage_error');
  assert.deepEqual(copy(f.api.snapshot().intents), [makeIntent('A')], 'unsafe retry must keep the durable sale intent');
  assert.equal(canonical.pending?.last_status, 503);
  assert.equal(canonical.pending?.payload?.operation_id, 'op-A');
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'createSale').length, 2);
});

test('foreign operation or command pending blocks without touching it', async () => {
  for (const pending of [{ state: 'PENDING', command: 'sale.create', payload: makeIntent('X') }, { state: 'PENDING', command: 'payment.create', payload: makeIntent('A') }]) {
    const f = fixture({ canonical: { pending } }); await f.api.enqueue(makeIntent('A')); assert.equal((await f.api.sync()).status, 'BLOCKED_FOREIGN_PENDING'); assert.equal(f.calls.includes('retryPending'), false); assert.equal(f.calls.some(x => Array.isArray(x)), false);
  }
});
test('confirmed receipt dequeues after storage failure and reload without duplicate sale', async () => {
  const f = fixture(); await f.api.enqueue(makeIntent('A')); f.canonical.createSale = i => { f.canonical.receipt = { operation_id: i.operation_id, sale_id: i.sale_id }; f.local.fail = true; return f.canonical.receipt; };
  await assert.rejects(f.api.sync()); assert.equal(f.api.snapshot().intents.length, 1); f.local.fail = false;
  const reload = fixture({ local: f.local, canonical: { receipt: f.canonical.receipt } }); assert.equal((await reload.api.sync()).status, 'DRAINED'); assert.equal(reload.calls.some(x => x === 'retryPending' || Array.isArray(x)), false); assert.equal(reload.api.snapshot().intents.length, 0);
});
test('duplicate operation id, corrupt state, unwritable storage and nested authority keys fail closed', async () => {
  const f = fixture(); await f.api.enqueue(makeIntent('A')); await assert.rejects(f.api.enqueue(makeIntent('A')));
  for (const bad of ['{', JSON.stringify({ version: 2, intents: [] }), JSON.stringify({ version: 1, intents: [null] })]) { const c = fixture({ local: storage(bad) }); assert.throws(() => c.api.snapshot()); await assert.rejects(c.api.enqueue(makeIntent('B'))); await assert.rejects(c.api.sync()); assert.equal(c.local.values.get(KEY), bad); }
  for (const mode of ['fail', 'drop']) { const s = storage(); s[mode] = true; await assert.rejects(fixture({ local: s }).api.enqueue(makeIntent(mode))); }
  for (const key of ['token', 'credential', 'device_credential', 'deviceCredential', 'readToken', 'promotion_id', 'authority_epoch', 'expected_control_revision', 'expected_stock_revision', 'device_id']) { const value = makeIntent(key); value.nested = { [key]: 'secret' }; await assert.rejects(f.api.enqueue(value)); }
});
test('mixed and credit intents survive durable FIFO and reach createSale unchanged', async () => {
  const f = fixture();

  const mixed = {
    ...makeIntent('MIXED'),
    payment_method: 'mixto',
    payment: {
      cash_cents: 100,
      digital_cents: 150,
      credit_cents: 0,
      digital_method: 'yape',
      reference: 'mix-ref'
    }
  };

  const credit = {
    ...makeIntent('CREDIT'),
    payment_method: 'credito',
    payment: {
      cash_cents: 0,
      digital_cents: 0,
      credit_cents: 250,
      digital_method: null,
      reference: ''
    },
    customer_id: 'customer-1',
    credit_due: '2099-12-31'
  };

  await enqueueAll(f, mixed, credit);

  assert.deepEqual(
    copy(f.api.snapshot().intents),
    [mixed, credit]
  );

  const result = await f.api.sync();

  assert.equal(result.status, 'DRAINED');

  const sent = f.calls
    .filter(x => Array.isArray(x) && x[0] === 'createSale')
    .map(x => x[1]);

  assert.deepEqual(sent, [mixed, credit]);
  assert.equal(f.api.snapshot().intents.length, 0);
});

test('two concurrent syncs use one exclusive lock and second returns BUSY', async () => {
  let release; let held = false;
  const f = fixture(); await f.api.enqueue(makeIntent('A'));
  const sharedLock = { request(name, options, callback) { assert.equal(name, 'na-canonical-sale-outbox'); if (held) return callback(null); held = true; return new Promise((resolve, reject) => { release = async () => { try { resolve(await callback({ name })); } catch (error) { reject(error); } finally { held = false; } }; }); } };
  f.context.navigator.locks = sharedLock; const one = f.api.sync(); await new Promise(resolve => setImmediate(resolve)); const two = await f.api.sync(); assert.equal(two.status, 'WAITING'); assert.equal(two.reason, 'BUSY'); await release(); await one;
});
test('missing Web Locks fails closed and module never calls fetch', async () => {
  const f = fixture({ lock: null }); f.context.navigator = {}; await assert.rejects(f.api.enqueue(makeIntent('A'))); assert.equal(f.api.VERSION, 1); assert.equal(f.api.KEY, KEY); assert.doesNotMatch(source, /\bfetch\s*\(/);
});
