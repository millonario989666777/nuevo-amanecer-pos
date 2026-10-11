import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// QA CANON: 📥 on a product row showed "Módulo de productos bloqueado" and #mMovInv never opened,
// although stock entries are saved only through canonical inventory.adjust (inventory bridge).
const inline02 = fs.readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8').split('\n');
const inline03 = fs.readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js', import.meta.url), 'utf8').split('\n');
const helper = inline02.find(l => l.startsWith('function _naCanonicalInventoryUi'));
const opener = inline02.find(l => l.startsWith('abrirMovInv=function'));
const lock = inline03.find(l => l.startsWith('isModuleLocked=function'));

function harness({ canonical = true, bridge = true, userLock = false } = {}) {
  const nodes = new Map();
  const el = id => { if (!nodes.has(id)) nodes.set(id, { id, textContent: '', value: 'x', classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } }, dataset: {} }); return nodes.get(id); };
  const toasts = [];
  const store = new Map(userLock ? [['na_lock_productos', 'true']] : []);
  const ctx = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [] },
    toast: (m, t) => toasts.push([m, t]),
    productos: [{ id: 'P1', name: 'Arroz', icon: '🍚', stock: 3, unidad: 'unidad' }],
    _naTracksStock: () => true, _naCategoryTitle: x => x,
    storage: { getItem: k => store.has(k) ? store.get(k) : null },
    LOCK_KEYS: { master: 'm', readOnly: 'r', modules: { productos: 'na_lock_productos' } },
    securityIsLocked: () => false,
    NuevoAmanecerCanonical: canonical ? { enabled: () => true } : undefined,
    NuevoAmanecerCanonicalInventoryBridge: bridge ? { enabled: () => canonical, save: async () => true } : undefined,
  });
  ctx.globalThis = ctx;
  vm.runInContext(`var isModuleLocked,abrirMovInv,invMovId,invMovT;${lock}\n${helper}\n${opener}`, ctx);
  return { ctx, nodes, toasts };
}

test('CANON stock entry opens the movement modal (canonical inventory.adjust UI)', () => {
  const h = harness();
  h.ctx.abrirMovInv('P1', 'entrada');
  assert.deepEqual(h.toasts, []);
  assert.equal(h.nodes.get('mMovInv').classList.contains('open'), true);
  assert.equal(h.nodes.get('mMovCant').value, '');
});

test('user lock on Productos still blocks the CANON stock entry', () => {
  const h = harness({ userLock: true });
  h.ctx.abrirMovInv('P1', 'entrada');
  assert.deepEqual(h.toasts, [['Módulo de productos bloqueado', 'error']]);
  assert.equal(h.nodes.has('mMovInv'), false);
});

test('without the canonical inventory bridge the CANON guard keeps blocking legacy writes', () => {
  const h = harness({ bridge: false });
  h.ctx.abrirMovInv('P1', 'entrada');
  assert.deepEqual(h.toasts, [['Módulo de productos bloqueado', 'error']]);
});

test('legacy (non-CANON) mode is unchanged', () => {
  const h = harness({ canonical: false });
  h.ctx.abrirMovInv('P1', 'salida');
  assert.equal(h.nodes.get('mMovInv').classList.contains('open'), true);
});
