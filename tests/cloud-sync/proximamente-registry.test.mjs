import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('POS/js/modules/proximamente.js', 'utf8');
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(source, context);
const registry = context.NA_PROXIMAMENTE;
const original = ['creditos-vencimiento', 'gastos', 'reportes', 'cotizaciones', 'cuentas-pagar', 'compartir-pdf-whatsapp', 'filtro-fechas-export'];
const unlocked = { 'creditos-vencimiento': 'pageClientes', gastos: 'pageGastos', reportes: 'pageVentas', 'filtro-fechas-export': 'pageVentas' };
const indexHtml = readFileSync('POS/index.html', 'utf8');

test('registry keeps the original order, unlocks only shipped features and adds locked pending entries', () => {
  const ids = Array.from(registry.FEATURES, f => f.id);
  assert.deepEqual(ids.slice(0, 7), original);
  assert.equal(ids.length, 56);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(registry.FEATURES.map(f => f.name.toLowerCase())).size, ids.length, 'no duplicate titles');
  assert.ok(Object.isFrozen(registry.FEATURES));
  assert.equal(context.module.exports, registry);
  assert.equal(registry.list(), registry.FEATURES);
  for (const feature of registry.list()) {
    assert.ok(Object.isFrozen(feature));
    assert.equal(registry.get(feature.id), feature);
    assert.ok(['form', 'table'].includes(feature.preview.type));
    assert.ok(feature.name && feature.description && !feature.description.includes('\n'));
    if (unlocked[feature.id]) {
      assert.equal(feature.enabled, true);
      assert.equal(feature.page, unlocked[feature.id]);
      assert.ok(indexHtml.includes(`id="${feature.page}"`), feature.page + ' exists');
      assert.equal(registry.isUnlocked(feature), true);
    } else {
      assert.equal(feature.enabled, false, feature.id);
      assert.equal(feature.page, null, feature.id);
      assert.equal(registry.isEnabled(feature.id), false);
      assert.equal(registry.isUnlocked(feature), false);
    }
  }
  const pending = registry.FEATURES.filter(f => f.pending);
  assert.equal(pending.length, 49);
  assert.ok(pending.every(f => !f.enabled && f.page === null && !original.includes(f.id)));
  for (const id of ['ventas-espera', 'kardex', 'sunat-comprobantes', 'multi-ruc', 'cobro-qr-yape-plin']) assert.ok(registry.get(id)?.pending, id);
  for (const id of ['compras', 'alertas-vencimiento', 'precios-mayor', 'respaldo', 'stock-lotes-fefo', 'cierre-remoto-sesiones']) assert.equal(registry.get(id), undefined, id + ' already exists in the POS');
  assert.equal(registry.get('missing'), undefined);
  assert.equal(registry.isEnabled('missing'), false);
  assert.equal(registry.isUnlocked(null), false);
  assert.equal(registry.isUnlocked({ enabled: true, page: null }), false);
  assert.equal(registry.isUnlocked({ enabled: true, page: 'pageGastos' }), true);
  assert.equal(registry.isUnlocked({ enabled: false, page: 'pageGastos' }), false);
});

test('pending entries add no server write routes', () => {
  vm.runInContext(readFileSync('POS/js/config/pos-permissions.js', 'utf8'), context);
  const paths = context.NA_PERMISSIONS.API_ROUTES.map(r => r.path).join(' ');
  for (const f of registry.FEATURES.filter(f => f.pending)) assert.ok(!paths.includes(f.id), f.id);
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

test('configuration shortcut lives in the owner-only Configuración nav', () => {
  const v9 = readFileSync(new URL('../../POS/js/config/config-v9.js', import.meta.url), 'utf8');
  const gate = v9.indexOf('if (!canEdit())'), entry = v9.indexOf('data-go="pageProximamente"'), reset = v9.indexOf('data-top="reset">', entry);
  assert.ok(gate > 0 && entry > gate, 'the entry is rendered only after the owner gate');
  assert.ok(reset > entry, 'the entry precedes Reseteo');
  assert.match(v9, /Próximamente<small>Funciones en preparación<\/small>/);
  assert.match(v9, /var go = t\.closest\('#na9Nav \[data-go\]'\); if \(go\) \{ if \(canEdit\(\) && typeof root\.goPage === 'function'\) root\.goPage\(go\.dataset\.go\); return; \}/);
});
