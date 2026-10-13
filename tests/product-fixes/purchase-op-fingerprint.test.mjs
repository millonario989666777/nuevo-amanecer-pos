import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load(statusById) {
  const store = new Map(), calls = [];
  let n = 0;
  const root = {
    document: { getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    crypto: { randomUUID: () => 'u' + (++n) },
    NA_ROLES: { api: async (path) => { calls.push(path); const id = decodeURIComponent(path.split('id=')[1] || ''); if (statusById[id] === 'offline') throw new Error('net'); return { status: statusById[id] || 'not_found' }; } },
    NuevoAmanecerCanonical: { refresh: async () => { calls.push('refresh'); } },
  };
  root.window = root;
  vm.runInNewContext(readFileSync(new URL('../../POS/js/config/pos-purchases-client.js', import.meta.url), 'utf8'), { globalThis: root, window: root, ...root });
  return { P: root.NA_PURCHASES, store, calls };
}
const L1 = [{ line: 1, product_id: 'A', quantity: 2, unit_cost_cents: 100 }];
const L2 = [{ line: 1, product_id: 'A', quantity: 5, unit_cost_cents: 100 }];
const M = { supplier: 'Sol', documentRef: 'F1' };

test('compra sin confirmar: mismo contenido reutiliza el id; sin consultar al servidor', async () => {
  const { P, calls } = load({});
  const a = await P._opFor(L1, M), b = await P._opFor(L1, M);
  assert.equal(a.id, b.id); assert.deepEqual(calls, []);
});

test('Bot 6 caso A: compra nueva con id viejo ya aplicado -> avisa "sí se registró", refresca y luego usa un id nuevo', async () => {
  const { P, calls } = load({ 'PUR-u1': 'applied' });
  const a = await P._opFor(L1, M);
  const b = await P._opFor(L2, { supplier: 'Otro', documentRef: 'F2' });
  assert.match(b.stop, /sí se registró/); assert.ok(calls.includes('refresh'));
  const c = await P._opFor(L2, { supplier: 'Otro', documentRef: 'F2' });
  assert.ok(c.id && c.id !== a.id, 'new id');
});

test('Bot 6 caso B: línea editada tras compra a medias -> avisa y usa id nuevo (nunca el viejo con otras líneas)', async () => {
  const { P } = load({ 'PUR-u1': 'in_progress' });
  const a = await P._opFor(L1, M);
  const b = await P._opFor(L2, M);
  assert.match(b.stop, /a medias/);
  const c = await P._opFor(L2, M);
  assert.notEqual(c.id, a.id);
});

test('sin red no se puede comprobar el id viejo: no se crea uno nuevo', async () => {
  const { P, store } = load({ 'PUR-u1': 'offline' });
  const a = await P._opFor(L1, M);
  const b = await P._opFor(L2, M);
  assert.match(b.stop, /sin conexión/);
  assert.equal(JSON.parse(store.get('na_purchase_pending_op_v1')).id, a.id);
});

test('formato viejo (solo id) se comprueba antes de reutilizarse', async () => {
  const { P, store } = load({ 'PUR-old': 'not_found' });
  store.set('na_purchase_pending_op_v1', 'PUR-old');
  const a = await P._opFor(L1, M);
  assert.ok(a.id && a.id !== 'PUR-old');
});
