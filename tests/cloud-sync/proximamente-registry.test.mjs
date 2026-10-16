import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('POS/js/modules/proximamente.js', 'utf8');
const registrySource = readFileSync('POS/js/modules/proximamente-registry.js', 'utf8');
const permissionsSource = readFileSync('POS/js/config/pos-permissions.js', 'utf8');
const indexHtml = readFileSync('POS/index.html', 'utf8');
const unlocked = { 'creditos-vencimiento': 'pageClientes', gastos: 'pageGastos', reportes: 'pageVentas', 'filtro-fechas-export': 'pageVentas', 'clientes-filtro-deuda': 'pageClientes' };
const MODULES = ['Ventas', 'Caja', 'Inventario', 'Clientes', 'Comprobantes', 'Extras'];

function loaded() {
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(permissionsSource, context);
  vm.runInContext(registrySource, context);
  context.module = { exports: {} };
  vm.runInContext(source, context);
  return context;
}

test('registry data loads lazily and lock state comes only from pos-permissions FEATURE_LOCKS', async () => {
  const c = loaded(); const api = c.NA_PROXIMAMENTE; const P = c.NA_PERMISSIONS;
  assert.equal(api.list().length, 0, 'nothing built until load()');
  await api.load();
  const ids = api.list().map(f => f.id);
  assert.equal(ids.length, 96);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(api.list().map(f => f.name.toLowerCase())).size, ids.length, 'no duplicate titles');
  assert.equal(JSON.stringify(Object.keys(P.FEATURE_LOCKS).sort()), JSON.stringify(ids.slice().sort()), 'every registry id has exactly one server lock entry');
  assert.doesNotMatch(registrySource, /enabled\s*:/, 'registry carries no lock state');
  assert.doesNotMatch(registrySource, /casamarket|https?:\/\//i, 'no third-party URLs or copied text');
  assert.doesNotMatch(indexHtml, /proximamente-registry\.js/, 'registry is not in the main bundle');
  for (const f of api.list()) {
    assert.ok(Object.isFrozen(f));
    assert.ok(MODULES.includes(f.module), f.id);
    assert.ok(['form', 'table'].includes(f.preview.type));
    assert.ok(f.name && f.description && !f.description.includes('\n'));
    if (unlocked[f.id]) {
      assert.equal(P.FEATURE_LOCKS[f.id], false); assert.equal(f.page, unlocked[f.id]);
      assert.ok(indexHtml.includes(`id="${f.page}"`)); assert.equal(api.isUnlocked(f), true);
    } else {
      assert.equal(P.FEATURE_LOCKS[f.id], true, f.id); assert.equal(f.page, null); assert.equal(api.isUnlocked(f), false); assert.ok(f.pending || ['cotizaciones', 'cuentas-pagar', 'compartir-pdf-whatsapp'].includes(f.id));
    }
  }
  const prioritized = api.list().filter(f => f.priority);
  assert.equal(prioritized.length, 44);
  assert.deepEqual(Array.from(api.list().filter(f=>f.uncertain).map(f=>f.id)).sort(), 'app-android-nativa cpe-sin-internet venta-granel gaveta-dinero comprobante-por-correo app-almaceneros equipos-pos shopify-woocommerce bandeja-multicanal plan-distribuidor multi-ruc balanza calendario-gastos gasto-a-cuenta tipo-cierre firma-digital sunat-comprobantes'.split(' ').sort());
  for (const id of ['cuotas', 'cobro-multiple', 'lista-ventas', 'precios-mayor', 'limite-credito', 'compras', 'stock-lotes-fefo']) assert.equal(api.get(id), undefined, id + ' already exists in the POS');
});

test('server lock is keyed by feature id, default-deny, and unlocking is a one-line change', () => {
  const c = loaded(); const P = c.NA_PERMISSIONS;
  assert.equal(P.featureLocked('kardex'), true);
  assert.equal(P.featureLocked('no-such-feature'), true);
  assert.equal(P.featureLocked('gastos'), false);
  assert.deepEqual(Array.from(P.routeRoles('/features/kardex', 'POST')), ['owner', 'empleado']);
  assert.deepEqual(Array.from(P.routeRoles('/features/no-such-feature/items', 'GET')), ['owner', 'empleado']);
  assert.deepEqual(Array.from(P.routeRoles('/features/gastos', 'GET')), ['owner']);
  for (const id of Object.keys(P.FEATURE_LOCKS)) assert.match(permissionsSource, new RegExp(`^    '${id}': (true|false),?$`, 'm'), id + ' lock is one line');
  const worker = readFileSync('tools/cloudflare-lab/src/worker.js', 'utf8');
  assert.match(worker, /startsWith\('\/features\/'\)[\s\S]{0,400}PERMISSIONS\.featureLocked\(id\)\) return json\(\{ error: 'feature_locked'/);
});

test('Próximamente is explicitly owner-only and the module has no network APIs besides loading its own registry', () => {
  const c = loaded(); const p = c.NA_PERMISSIONS;
  assert.deepEqual(Array.from(p.SCREENS.pageProximamente), ['owner']);
  assert.equal(p.canAccessScreen('empleado', 'pageProximamente'), false);
  assert.doesNotMatch(source + registrySource, /fetch|XMLHttpRequest|sendBeacon/);
});

function renderHarness(rows, locks, config = false) {
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
  const ctx = vm.createContext({
    module: { exports: {} },
    document: doc,
    MutationObserver: function (callback) { this.observe = function (node) { observations.push({ node, callback }); }; },
    goPage: id => navigated.push(id),
    NA_ROLES: { canConfigure: () => true },
    NA_PROXIMAMENTE_REGISTRY: rows,
    NA_PERMISSIONS: { featureLocked: id => locks[id] !== false }
  });
  vm.runInContext(source, ctx);
  return { navigated, api: ctx.NA_PROXIMAMENTE, doc, ctx, observations };
}
const cardsOf = node => { const out = []; const walk = n => { if ((n.className || '').split(/\s+/).includes('na-prox-card')) out.push(n); n.children.forEach(walk); }; walk(node); return out; };

test('unlock needs lock=false AND a page; sections group by module with counters; filters work', async () => {
  const rows = [
    { id: 'gastos', module: 'Caja', name: 'Gastos', description: 'Desc', icon: '🧾', preview: { type: 'form', fields: ['Categoría'] } },
    { id: 'reportes', module: 'Ventas', name: 'Reportes', description: 'Desc', icon: '📊', page: 'pageVentas', preview: { type: 'table', columns: ['Día'] } },
    { id: 'cotizaciones', module: 'Ventas', name: 'Cotizaciones', description: 'Desc', icon: '📋', page: 'pagePOS', priority: 'alta', preview: { type: 'form', fields: ['Cliente'] } },
    { id: 'gaveta', module: 'Caja', name: 'Gaveta', description: 'Cajón', icon: '🗄️', priority: 'media', uncertain: true, preview: { type: 'form', fields: ['X'] } }
  ];
  const h = renderHarness(rows, { gastos: false, reportes: false, cotizaciones: true, gaveta: true });
  const container = new h.doc.body.constructor('div'); container.className = 'na-prox-grid';
  await h.api.render(container);
  assert.equal(h.api.isEnabled('gastos'), false, 'unlocked lock without page stays locked');
  assert.equal(h.api.isEnabled('reportes'), true);
  assert.equal(h.api.isEnabled('cotizaciones'), false, 'locked even with a page');
  const summaries = []; const walk = n => { if (n.className === 'na-prox-summary') summaries.push(n.textContent); n.children.forEach(walk); }; walk(container);
  assert.deepEqual(summaries, ['Disponible (1)', 'Ventas (1)', 'Caja (2)']);
  const cards = cardsOf(container);
  assert.deepEqual(cards.map(c => c.dataset.featureId), ['reportes', 'cotizaciones', 'gaveta', 'gastos'], 'unlocked first, then alta/media/baja');
  const badge = n => n.children.find(x => x.className === 'na-prox-badge');
  assert.equal(badge(cards[1]).textContent, '🔒 Próximamente · Prioridad alta');
  assert.ok(cards[2].children.some(x => x.className === 'na-prox-tag' && x.textContent === 'por confirmar'));
  cards[1].events.click(); assert.equal(h.navigated.length, 0); assert.ok(h.doc.getElementById('naProxPreview'));
  h.doc.getElementById('naProxPreview').close();
  assert.equal(cards[0].children.find(x=>x.className==='na-prox-available').textContent,'Disponible');
  cards[0].events.click(); assert.deepEqual(h.navigated, ['pageVentas']);
  const chips = []; const walk2 = n => { if ((n.className || '').startsWith('na-prox-chip')) chips.push(n); n.children.forEach(walk2); }; walk2(container);
  chips.find(c => c.dataset.priority === 'media').events.click();
  assert.deepEqual(cardsOf(container).map(c => c.dataset.featureId), ['gaveta']);
  chips.find(c => c.dataset.priority === '').events.click();
  const search = []; const walk3 = n => { if (n.className === 'na-prox-search') search.push(n); n.children.forEach(walk3); }; walk3(container);
  search[0].value = 'cotiz'; search[0].events.input();
  assert.deepEqual(cardsOf(container).map(c => c.dataset.featureId), ['cotizaciones']);
});

test('configuration shortcut lives in the owner-only Configuración nav', () => {
  const v9 = readFileSync(new URL('../../POS/js/config/config-v9.js', import.meta.url), 'utf8');
  const gate = v9.indexOf('if (!canEdit())'), entry = v9.indexOf('data-go="pageProximamente"'), reset = v9.indexOf('data-top="reset">', entry);
  assert.ok(gate > 0 && entry > gate, 'the entry is rendered only after the owner gate');
  assert.ok(reset > entry, 'the entry precedes Reseteo');
  assert.match(v9, /Próximamente<small>Funciones en preparación<\/small>/);
  assert.match(v9, /var go = t\.closest\('#na9Nav \[data-go\]'\); if \(go\) \{ if \(canEdit\(\) && typeof root\.goPage === 'function'\) root\.goPage\(go\.dataset\.go\); return; \}/);
});

const addedIds = ['venta-exitosa-comprobante', 'clonar-venta', 'nota-credito-parcial-compras', 'clientes-dias-credito', 'credito-cuotas', 'reparto-abono-multiples-deudas'];
test('new candidates stay locked and attendance keeps its owner policy when unlocked', async () => {
  const c = loaded(); await c.NA_PROXIMAMENTE.load();
  for (const id of addedIds) {
    const entry = c.NA_PROXIMAMENTE.get(id);
    assert.ok(entry, id);
    assert.equal(c.NA_PERMISSIONS.FEATURE_LOCKS[id], true, id);
    assert.equal(entry.page, null);
    assert.ok(['alta', 'media', 'baja'].includes(entry.priority));
  }
  assert.deepEqual(Array.from(c.NA_PROXIMAMENTE.get('asistencia-empleados').roles), ['owner']);
  assert.deepEqual(Array.from(c.NA_PERMISSIONS.FEATURE_ROLES['asistencia-empleados']), ['owner']);
  assert.deepEqual(Array.from(c.NA_PERMISSIONS.routeRoles('/features/asistencia-empleados', 'GET')), ['owner']);
  assert.deepEqual(Array.from(c.NA_PERMISSIONS.API_ROUTES.find(r => r.path === '/features/:id').roles), ['owner', 'empleado']);
  const h = renderHarness([c.NA_PROXIMAMENTE.get('asistencia-empleados')], { 'asistencia-empleados': false });
  h.ctx.NA_ROLES.canConfigure = () => false;
  const host = new h.doc.body.constructor('div');
  await h.api.render(host);
  h.api.openPreview('asistencia-empleados');
  h.api.openFeature({ id: 'asistencia-empleados', enabled: true, page: 'pageAsistencia', roles: ['owner'] });
  assert.deepEqual(h.navigated, []);
  assert.equal(cardsOf(host).length, 0);
  assert.equal(h.doc.getElementById('naProxPreview'), null);
});
