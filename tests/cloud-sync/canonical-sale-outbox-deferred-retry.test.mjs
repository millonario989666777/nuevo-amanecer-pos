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
    // Store lock: short, waits (never ifAvailable). Drain lock: ifAvailable.
    if (name === 'na-canonical-sale-outbox-store') { assert.equal(options.ifAvailable, undefined); return callback({ name }); }
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

// Moved from canonical-sale-outbox.test.mjs (PR #512 cherry-picks) so base test files stay untouched.


test('transient 503 pending journal resumes the SAME operation instead of remaining permanently blocked', async () => {
  const sale = makeIntent('TRANSIENT');
  const canonical = {
    pending: {
      state: 'PENDING', command: 'sale.create', payload: copy(sale),
      last_error: 'financial_storage_error', last_status: 503
    },
    async retryPending() {
      assert.equal(canonical.pending.payload.operation_id, sale.operation_id);
      canonical.pending = null;
      canonical.receipt = { operation_id: sale.operation_id, sale_id: sale.sale_id };
      return canonical.receipt;
    }
  };
  const f = fixture({ canonical });
  await f.api.enqueue(sale);
  const result = await f.api.sync();
  assert.equal(result.status, 'DRAINED');
  assert.equal(f.api.snapshot().intents.length, 0);
  assert.equal(f.calls.filter(x => x === 'retryPending').length, 1);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'createSale').length, 0);
});

test('transient 429 recovers by replaying the original identity, never inventing a second sale', async () => {
  const sale = makeIntent('RATE-LIMIT');
  const canonical = {
    pending: {
      state: 'PENDING', command: 'sale.create', payload: copy(sale),
      last_error: 'rate_limited', last_status: 429
    },
    async retryPending() {
      canonical.receipt = { operation_id: sale.operation_id, sale_id: sale.sale_id };
      canonical.pending = null;
    }
  };
  const f = fixture({ canonical });
  await f.api.enqueue(sale);
  assert.equal((await f.api.sync()).status, 'DRAINED');
  assert.equal(f.api.snapshot().intents.length, 0);
  assert.equal(f.calls.filter(x => x === 'retryPending').length, 1);
});

test('recoverable queue keeps retrying after three failures, bounded at 60s, and eventually drains', async () => {
  const sale = makeIntent('LONG-OUTAGE');
  let attempts = 0;
  const canonical = {
    createSale(i) {
      attempts += 1;
      assert.equal(i.operation_id, sale.operation_id, 'all retries must retain operation identity');
      if (attempts <= 9) throw Error('temporary_network_error');
      canonical.receipt = { operation_id: i.operation_id, sale_id: i.sale_id };
    }
  };
  const f = fixture({ canonical });
  const timers = [];
  f.context.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  f.context.addEventListener = () => {};
  f.context.navigator.onLine = true;
  f.api.enqueue && await f.api.enqueue(sale);
  await f.api.start();
  const delays = [];
  while (timers.length && attempts <= 9) {
    const next = timers.shift();
    delays.push(next.delay);
    await next.fn();
  }
  assert.equal(attempts, 10, 'automatic retry must not stop after the third failure');
  assert.equal(f.api.snapshot().intents.length, 0);
  assert.ok(delays.length >= 9);
  assert.equal(delays[0], 1000);
  assert.ok(delays.some(delay => delay === 60000), 'backoff must reach a safe ceiling');
  assert.ok(delays.every(delay => delay <= 60000), 'backoff must stay bounded');
  // Only the single deferred post-drain reconciliation (P1-B) remains; no retry loop.
  assert.deepEqual(timers.map(t => t.delay), [1500]);
});


test('fresh 429 defers replay until a later sync pass, preserving the same intent', async () => {
  const sale = makeIntent('RATE-DEFER');
  const canonical = {
    pending: null,
    createSale(i) {
      canonical.pending = {
        state: 'PENDING', command: 'sale.create', payload: copy(i),
        last_error: 'rate_limited', last_status: 429
      };
      throw Error('CANONICAL_FINANCIAL_REJECTED_429');
    },
    retryPending() {
      assert.equal(canonical.pending.payload.operation_id, sale.operation_id);
      canonical.pending = null;
      canonical.receipt = { operation_id: sale.operation_id, sale_id: sale.sale_id };
    }
  };
  const f = fixture({ canonical });
  await f.api.enqueue(sale);
  const first = await f.api.sync();
  assert.equal(first.status, 'WAITING');
  assert.equal(first.reason, 'rate_limited');
  assert.deepEqual(copy(f.api.snapshot().intents), [sale]);
  assert.equal(f.calls.filter(x => x === 'retryPending').length, 0, 'no immediate rate-limit replay');
  assert.equal((await f.api.sync()).status, 'DRAINED');
  assert.equal(f.calls.filter(x => x === 'retryPending').length, 1);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'createSale').length, 1);
});
