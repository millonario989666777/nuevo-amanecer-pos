import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('POS/js/modules/proximamente.js', 'utf8');
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(source, context);
const registry = context.NA_PROXIMAMENTE;
const ids = ['creditos-vencimiento', 'gastos', 'reportes', 'cotizaciones', 'cuentas-pagar', 'compartir-pdf-whatsapp', 'filtro-fechas-export'];

test('registry has seven ordered, frozen, disabled features and lookup helpers', () => {
  assert.deepEqual(Array.from(registry.FEATURES, f => f.id), ids);
  assert.equal(new Set(registry.FEATURES.map(f => f.id)).size, 7);
  assert.ok(Object.isFrozen(registry.FEATURES));
  assert.equal(context.module.exports, registry);
  assert.equal(registry.list(), registry.FEATURES);
  for (const feature of registry.list()) {
    assert.ok(Object.isFrozen(feature));
    assert.equal(feature.enabled, false);
    assert.equal(feature.page, null);
    assert.equal(registry.get(feature.id), feature);
    assert.equal(registry.isEnabled(feature.id), false);
    assert.equal(registry.isUnlocked(feature), false);
    assert.ok(['form', 'table'].includes(feature.preview.type));
    assert.ok(!feature.description.includes('\n'));
  }
  assert.equal(registry.get('missing'), undefined);
  assert.equal(registry.isEnabled('missing'), false);
  assert.equal(registry.isUnlocked(null), false);
  assert.equal(registry.isUnlocked({ enabled: true, page: null }), false);
  assert.equal(registry.isUnlocked({ enabled: true, page: 'pageGastos' }), true);
  assert.equal(registry.isUnlocked({ enabled: false, page: 'pageGastos' }), false);
});

test('Próximamente is explicitly owner-only and registry has no network APIs', () => {
  vm.runInContext(readFileSync('POS/js/config/pos-permissions.js', 'utf8'), context);
  const p = context.NA_PERMISSIONS;
  assert.deepEqual(Array.from(p.SCREENS.pageProximamente), ['owner']);
  assert.equal(p.canAccessScreen('owner', 'pageProximamente'), true);
  assert.equal(p.canAccessScreen('empleado', 'pageProximamente'), false);
  assert.doesNotMatch(source, /fetch|XMLHttpRequest|sendBeacon/);
});

function renderHarness(featuresJson, config = false) {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attrs = {};
      this.events = {};
      this.className = '';
      this.dataset = {};
      this.type = '';
      this.id = '';
      this._text = '';
      this.disabled = false;
      this.readOnly = false;
      this.placeholder = '';
      this.scope = '';
    }
    set textContent(v) { this._text = String(v ?? ''); this.children = []; }
    get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    appendChild(n) { n.parent = this; this.children.push(n); return n; }
    insertBefore(n, before) {
      n.parent = this;
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(n); else this.children.splice(index, 0, n);
      return n;
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); }
    addEventListener(k, f) { this.events[k] = f; }
    querySelector(s) {
      const category = s.match(/^\[data-cfgcat="([^"]+)"\]$/);
      if (category) return this.children.find(n => n.dataset.cfgcat === category[1]) || null;
      if (s === '.na-prox-grid') return this.children.find(n => (n.className || '').includes('na-prox-grid')) || null;
      if (s.startsWith('.')) {
        const cls = s.slice(1);
        const walk = n => {
          if ((n.className || '').split(/\s+/).includes(cls)) return n;
          for (const c of n.children) { const hit = walk(c); if (hit) return hit; }
          return null;
        };
        return walk(this);
      }
      return null;
    }
    querySelectorAll(s) {
      const out = [];
      const cls = s.startsWith('.') ? s.slice(1).split('.')[0] : null;
      const walk = n => {
        if (cls && (n.className || '').split(/\s+/).includes(cls)) out.push(n);
        n.children.forEach(walk);
      };
      walk(this);
      return out;
    }
    showModal() { this._open = true; }
    close() { this._open = false; if (this.events.close) this.events.close(); }
  }
  const navigated = [];
  const doc = {
    readyState: 'complete',
    body: new Node('body'),
    createElement: tag => new Node(tag),
    getElementById: id => {
      const walk = n => {
        if (n.id === id) return n;
        for (const c of n.children) { const hit = walk(c); if (hit) return hit; }
        return null;
      };
      return walk(doc.body);
    },
    addEventListener() {}
  };
  const observations = [];
  if (config) {
    const page = new Node('div'); page.id = 'pageConfig';
    const sidebar = new Node('div'); sidebar.id = 'cfgSidebar';
    const info = new Node('button'); info.dataset.cfgcat = 'info';
    sidebar.appendChild(info); page.appendChild(sidebar); doc.body.appendChild(page);
  }
  const patched = source.replace(
    /var FEATURES = freeze\(\[[\s\S]*?\]\);/,
    `var FEATURES = freeze(${featuresJson});`
  );
  const ctx = vm.createContext({
    module: { exports: {} },
    document: doc,
    MutationObserver: function (callback) { this.observe = function (node) { observations.push({ node, callback }); }; },
    goPage: id => navigated.push(id),
    NA_ROLES: { canConfigure: () => true }
  });
  vm.runInContext(patched, ctx);
  const container = new Node('div');
  container.className = 'na-prox-grid';
  ctx.NA_PROXIMAMENTE.render(container);
  return { container, navigated, api: ctx.NA_PROXIMAMENTE, doc, ctx, observations };
}

test('enabled card without page stays locked; enabled with page unlocks and navigates', () => {
  const locked = renderHarness(JSON.stringify([
    { id: 'gastos', name: 'Gastos', description: 'Desc', icon: '🧾', enabled: true, preview: { type: 'form', fields: ['Categoría'] } },
    { id: 'reportes', name: 'Reportes', description: 'Desc', icon: '📊', enabled: true, page: 'pageVentas', preview: { type: 'table', columns: ['Día'] } },
    { id: 'cotizaciones', name: 'Cotizaciones', description: 'Desc', icon: '📋', enabled: false, page: 'pagePOS', preview: { type: 'form', fields: ['Cliente'] } }
  ]));
  assert.equal(locked.api.isEnabled('gastos'), false);
  assert.equal(locked.api.isEnabled('reportes'), true);
  assert.equal(locked.api.isEnabled('cotizaciones'), false);
  const cards = locked.container.children;
  assert.equal(cards.length, 3);

  assert.equal(cards[0].className, 'na-prox-card');
  assert.ok(cards[0].children.some(n => (n.className || '') === 'na-prox-badge'));
  cards[0].events.click();
  assert.equal(locked.navigated.length, 0);
  const preview = locked.doc.getElementById('naProxPreview');
  assert.ok(preview);
  preview.close();
  assert.equal(locked.doc.getElementById('naProxPreview'), null);

  assert.equal(cards[1].className, 'na-prox-card is-enabled');
  assert.ok(!cards[1].children.some(n => (n.className || '') === 'na-prox-badge'));
  cards[1].events.click();
  assert.deepEqual(locked.navigated, ['pageVentas']);
  assert.equal(locked.doc.getElementById('naProxPreview'), null);

  assert.equal(cards[2].className, 'na-prox-card');
  assert.ok(cards[2].children.some(n => (n.className || '') === 'na-prox-badge'));
  cards[2].events.click();
  assert.deepEqual(locked.navigated, ['pageVentas']);
  assert.ok(locked.doc.getElementById('naProxPreview'));
});

test('configuration shortcut precedes info and rechecks owner permission on page activation', () => {
  const h = renderHarness('[]', true);
  const sidebar = h.doc.getElementById('cfgSidebar');
  const button = sidebar.querySelector('[data-cfgcat="proximamente"]');
  assert.equal(sidebar.children.length, 2);
  assert.equal(sidebar.children[0], button);
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '🔒PróximamenteFunciones en preparación');
  assert.equal(button.hidden, false);
  button.events.click();
  assert.deepEqual(h.navigated, ['pageProximamente']);
  const observer = h.observations.find(o => o.node.id === 'pageConfig');
  for (const roles of [undefined, { canConfigure: () => false }]) {
    h.ctx.NA_ROLES = roles;
    observer.callback();
    assert.equal(button.hidden, true);
    button.events.click();
    assert.deepEqual(h.navigated, ['pageProximamente']);
  }
  h.ctx.NA_ROLES = { canConfigure: () => true };
  observer.callback();
  assert.equal(button.hidden, false);
});
