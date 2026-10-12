// CANON H2 (preview #518): when a locally registered sale is rejected and held,
// the cashier gets exactly one error notice per operation_id (also after a
// reload), with the sale_id, the reason and a no-recharge warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../../POS/js/sync/canonical-sale-outbox.js', import.meta.url), 'utf8');
const intentSource = readFileSync(new URL('../../POS/js/sync/canonical-sale-intent.js', import.meta.url), 'utf8');
const copy = v => JSON.parse(JSON.stringify(v));
function sale(id) { return { version: 1, operation_id: `op-${id}`, sale_id: `sale-${id}`, created_at: '2026-10-11T03:04:05.000Z', items: [{ product_id: 'p1', quantity: 1, unit_price_cents: 250, line_total_cents: 250 }], payment_method: 'efectivo', total_cents: 250, payment: { cash_cents: 250, digital_cents: 0, credit_cents: 0, digital_method: null, reference: '' } }; }
function storage(values = new Map()) { return { values, getItem: k => values.get(k) ?? null, setItem(k, v) { values.set(k, String(v)); }, removeItem(k) { values.delete(k); } }; }
function locks() { let held = false; return { async request(n, o, cb) { if (held) return cb(null); held = true; try { return await cb({ name: n }); } finally { held = false; } } }; }
function boot(local, state, reason, notes) {
  const context = vm.createContext({ localStorage: local, navigator: { locks: locks(), onLine: true }, crypto: { randomUUID } });
  vm.runInContext(intentSource, context); vm.runInContext(source, context);
  context.NuevoAmanecerCanonicalUIAdapter = { runtime: { notify: (m, kind) => notes.push([kind, m]) } };
  context.NuevoAmanecerCanonical = { async refresh() {}, async retryPending() { throw Error('unexpected'); },
    async createSale(i) { state.posts++; state.pending = { state: 'PENDING', command: 'sale.create', payload: copy(i), last_error: reason, last_status: 409 }; throw Error('CANONICAL_FINANCIAL_REJECTED_409'); },
    async discardRejectedSale() { state.pending = null; return true; }, pendingSnapshot: () => copy(state.pending), receiptSnapshot: () => null };
  return context.NuevoAmanecerCanonicalSaleOutbox;
}
test('rejected sale notifies once per operation_id across syncs, close attempts and reload', async () => {
  const local = storage(), state = { pending: null, posts: 0 }, notes = [];
  const api = boot(local, state, 'product_not_found', notes);
  await api.enqueue(sale('A')); await api.enqueue(sale('B'));
  const head = api.snapshot().intents[0];
  for (let i = 0; i < 3; i++) await api.sync();
  for (let i = 0; i < 2; i++) await api.withCashCloseBarrier(async () => {}).catch(() => {});
  const again = boot(local, state, 'product_not_found', notes);
  await again.sync();
  const errors = notes.filter(([kind]) => kind === 'error');
  assert.equal(errors.length, 1, JSON.stringify(notes));
  assert.equal(errors[0][1], 'Venta ' + head.sale_id + ' en revisión: el producto no existe en CANON. No la cobres de nuevo y no entregues el crédito hasta resolverla en Caja › Ventas en revisión. Las demás ventas siguen funcionando.');
  assert.equal(notes.filter(([, m]) => /vuelve a cobrarla/i.test(m)).length, 0);
  assert.equal(notes.filter(([kind]) => kind === 'success').length, 0, 'no green toast after the rejection');
  assert.equal(again.snapshot().intents.length, 2);
  assert.equal(state.posts, 1, 'rejected sale is not re-posted');
});
