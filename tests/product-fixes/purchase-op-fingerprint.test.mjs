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
    NA_ROLES: { api: async (path) => { calls.push(path); const id = decodeURIComponent(path.split('id=')[1] || ''); if (statusById[id] === 'offline') throw new Error('net'); const v = statusById[id]; if (v && typeof v === 'object') return v.purchase_id === undefined && !v.status ? v : { purchase_id: id, ...v }; return { purchase_id: id, status: v || 'not_found' }; } },
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
  assert.match(b.stop, /No se pudo comprobar/);
  assert.ok(JSON.parse(store.get('na_purchase_pending_ops_v2'))[a.id], 'old id kept');
});

test('formato viejo (solo id) se comprueba antes de reutilizarse', async () => {
  const { P, store } = load({ 'PUR-old': 'not_found' });
  store.set('na_purchase_pending_op_v1', 'PUR-old');
  const a = await P._opFor(L1, M);
  assert.ok(a.id && a.id !== 'PUR-old');
});

test('dos compras sin confirmar: la segunda no borra la primera; cada una se verifica por su id', async () => {
  const st = { 'PUR-u1': 'offline' };
  const { P, store } = load(st);
  const a = await P._opFor(L1, M);                  // compra 1, respuesta perdida
  st['PUR-u1'] = 'in_progress';
  const b1 = await P._opFor(L2, M);                 // verifica la 1 (a medias), avisa
  assert.match(b1.stop, /NO se registró/);
  const b = await P._opFor(L2, M);                  // compra 2 con id propio
  assert.ok(b.id && b.id !== a.id);
  const map = JSON.parse(store.get('na_purchase_pending_ops_v2'));
  assert.ok(map[a.id] && map[b.id], 'ambas siguen guardadas');
  assert.equal(JSON.stringify(P.pendingOps().map(x => x.id).sort()), JSON.stringify([a.id, b.id].sort()));
});

test('Bot 6 (a): una respuesta que no es el estado de ESA compra (p. ej. la lista del Worker viejo) = no comprobado; no se crea id nuevo', async () => {
  const st = {};
  const { P, store } = load(st);
  const a = await P._opFor(L1, M);
  st[a.id] = { purchases: [] };                      // Worker anterior: ignora ?id= y devuelve la lista
  const b = await P._opFor(L2, M);
  assert.match(b.stop, /No se pudo comprobar/);
  const map = JSON.parse(store.get('na_purchase_pending_ops_v2'));
  assert.deepEqual(Object.keys(map), [a.id], 'se conserva el id anterior y no hay id nuevo');
});

test('Bot 6 (b): compra anterior a medias + compra casi igual: no hay id nuevo; se listan líneas aplicadas y se ofrece terminar con el MISMO id', async () => {
  const st = {};
  const { P, store } = load(st);
  const a = await P._opFor([{ line: 1, product_id: 'A', quantity: 2, unit_cost_cents: 100 }, { line: 2, product_id: 'B', quantity: 3, unit_cost_cents: 50 }], M);
  st[a.id] = { status: 'in_progress', purchase: { supplier: 'Sol', document_ref: 'F1' }, lines: [
    { line_number: 1, product_id: 'A', quantity: 2, unit_cost_cents: 100, applied: true },
    { line_number: 2, product_id: 'B', quantity: 3, unit_cost_cents: 50, applied: false }] };
  const b = await P._opFor([{ line: 1, product_id: 'A', quantity: 2, unit_cost_cents: 100 }, { line: 2, product_id: 'B', quantity: 4, unit_cost_cents: 50 }], M);
  assert.match(b.stop, /Ya sumaron stock: A \+2\. Faltan: B \+3/);
  assert.equal(b.finish.id, a.id);
  assert.equal(JSON.stringify(b.finish.lines), JSON.stringify([{ line: 1, product_id: 'A', quantity: 2, unit_cost_cents: 100 }, { line: 2, product_id: 'B', quantity: 3, unit_cost_cents: 50 }]));
  assert.equal(b.finish.meta.supplier, 'Sol');
  const again = await P._opFor([{ line: 1, product_id: 'A', quantity: 2, unit_cost_cents: 100 }], M);
  assert.ok(again.stop && again.finish, 'sigue bloqueado hasta terminar la anterior');
  assert.deepEqual(Object.keys(JSON.parse(store.get('na_purchase_pending_ops_v2'))), [a.id]);
});
