// Arranque sin internet: todo lo que index.html carga al abrir debe estar en PRECACHE_URLS de sw.js,
// y si la tabla de permisos (pos-permissions.js) no cargó, pos-roles-client.js falla cerrado sin romper la venta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const index = readFileSync('POS/index.html', 'utf8');
const sw = readFileSync('POS/sw.js', 'utf8');
const BASE = 'https://pos.test/POS/index.html';
// Fuera de la caché a propósito: configuración por entorno, sin caché (CANON-HOSTED-RUNTIME-CONFIG-001).
const NOT_PRECACHED_BY_DESIGN = new Set(['/runtime-config.js']);
// Cargados por JS al arrancar (no aparecen como etiqueta en index.html).
const STARTUP_INJECTED = ['js/config/build-info.js'];

function list(name, next) {
  const start = sw.indexOf(`const ${name} = [`);
  const end = sw.indexOf(`const ${next}`, start);
  assert.ok(start >= 0 && end > start, name);
  return new Set([...sw.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => new URL(m[1], BASE).pathname));
}
const precache = list('PRECACHE_URLS', 'LAZY_URLS');
const lazy = new Set([...list('LAZY_URLS', 'VENDOR_URLS'), ...list('VENDOR_URLS', 'PRECACHE_URLS_ABSOLUTE')]);

function startupAssets() {
  const html = index.replace(/<!--[\s\S]*?-->/g, '').replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  const assets = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const ref = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!ref) continue;
    if (/^<link/i.test(tag) && !/\brel\s*=\s*["'](?:stylesheet|manifest|icon|apple-touch-icon|modulepreload|preload)["']/i.test(tag)) continue;
    const url = new URL(ref[1], BASE);
    if (url.origin !== new URL(BASE).origin) continue;
    assets.push({ path: url.pathname, lazy: /type\s*=\s*["']text\/x-na-lazy["']/i.test(tag), tag: tag.slice(0, 120) });
  }
  return assets;
}

test('every same-origin script and stylesheet index.html loads at startup is precached', () => {
  const assets = startupAssets();
  assert.ok(assets.length > 100, 'index.html parse found too few assets');
  const missing = assets.filter((a) => !a.lazy && !NOT_PRECACHED_BY_DESIGN.has(a.path) && !precache.has(a.path)).map((a) => a.path);
  assert.deepEqual([...new Set(missing)], [], 'Faltan en PRECACHE_URLS de POS/sw.js (el POS no arrancaría sin internet)');
  const lazyMissing = assets.filter((a) => a.lazy && !lazy.has(a.path) && !precache.has(a.path)).map((a) => a.path);
  assert.deepEqual(lazyMissing, [], 'Recursos diferidos sin LAZY_URLS/VENDOR_URLS');
  for (const file of STARTUP_INJECTED) assert.ok(precache.has(new URL(file, BASE).pathname), file);
});

test('the startup files found missing offline are precached and exist', () => {
  for (const file of ['css/theme-dark.css', 'css/inventory-form-polish.css', 'js/core/theme-state.js', 'js/config/pos-permissions.js', 'js/perf/cash-perf-probe.js', 'js/config/build-info.js']) {
    assert.ok(precache.has(new URL(file, BASE).pathname), file);
    assert.ok(existsSync(`POS/${file}`), file);
  }
  for (const p of precache) assert.ok(existsSync('POS' + p.slice('/POS'.length)), `precached file missing on disk: ${p}`);
  assert.equal(new Set([...sw.slice(sw.indexOf('const PRECACHE_URLS = ['), sw.indexOf('const LAZY_URLS')).matchAll(/'([^']+)'/g)].map((m) => m[1])).size, precache.size, 'duplicates in PRECACHE_URLS');
  assert.match(sw, /const CACHE_NAME = `\$\{CACHE_PREFIX\}__BUILD_HASH__`;/, 'cache name still versioned by build hash');
});

// --- pos-roles-client.js sin NA_PERMISSIONS -------------------------------------------------------
const rolesSource = readFileSync('POS/js/config/pos-roles-client.js', 'utf8');
const permsSource = readFileSync('POS/js/config/pos-permissions.js', 'utf8');
const EMPLOYEE = ['pageMenu', 'pagePOS', 'pageInventario', 'pageVentas', 'pageClientes', 'pageCaja'];
const OWNER = ['pageGastos', 'pageConfig', 'pageValorizacion', 'pageKardex', 'pageReporteArqueo', 'pageHistorialCompras', 'pageRotacionAbc', 'pageReporteDeuda', 'pageCodigosDuplicados', 'pageDesconocida'];

function classList(initial = []) {
  const set = new Set(initial);
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); } };
}
function harness({ cachedRole, cloud = true, permissions = false, online = false }) {
  const pages = [...EMPLOYEE, ...OWNER].map((id) => ({ id, classList: classList() }));
  const overlays = [];
  const listeners = {};
  const store = new Map();
  if (cloud) store.set('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://api.test', token: 't' }));
  if (cachedRole) store.set('na_pos_role_v1', JSON.stringify({ role: cachedRole }));
  const node = () => ({ className: '', id: '', setAttribute() {}, addEventListener() {}, set innerHTML(_) {}, querySelector: () => ({ onclick: null }), remove() { overlays.splice(overlays.indexOf(this), 1); } });
  const doc = {
    readyState: 'complete',
    documentElement: { classList: classList(), dataset: {} },
    body: { appendChild: (o) => overlays.push(o) },
    createElement: node,
    getElementById: (id) => overlays.find((o) => o.id === id) || null,
    querySelector: (sel) => (sel === '.na-offline-cfg' ? overlays.find((o) => /na-offline-cfg/.test(o.className)) || null : null),
    querySelectorAll: (sel) => (sel === '.page.active' ? pages.filter((p) => p.classList.contains('active')) : sel === '.page' ? pages : []),
    addEventListener() {}
  };
  const show = (id) => { pages.forEach((p) => p.classList.remove('active')); const p = pages.find((x) => x.id === id); if (p) p.classList.add('active'); return true; };
  const root = {
    document: doc,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    dispatchEvent() { return true; },
    fetch: async () => (online ? { ok: true, json: async () => ({ pos_role: cachedRole, owner_pin_set: true }) } : Promise.reject(new TypeError('offline'))),
    goPage: show,
    ventasSetTab: () => true,
    toast() {}
  };
  root.window = root; root.globalThis = root;
  const context = vm.createContext({ window: root, globalThis: root, CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } }, setTimeout, Promise, JSON, Date, Error });
  if (permissions) vm.runInContext(permsSource.replace(/\}\)\(globalThis\);\s*$/, '})(window);'), context);
  vm.runInContext(rolesSource, context);
  return { root, pages, overlays, active: () => pages.filter((p) => p.classList.contains('active')).map((p) => p.id), listeners };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

for (const cachedRole of ['empleado', 'owner']) {
  test(`offline without NA_PERMISSIONS (${cachedRole}): selling and employee screens work, owner screens fail closed, no throw`, async () => {
    const h = harness({ cachedRole });
    await flush();
    assert.equal(h.root.NA_PERMISSIONS, undefined);
    assert.equal(h.root.NA_ROLES.canConfigure(), false, 'unconfirmed cached role never configures');
    for (const id of EMPLOYEE) {
      assert.doesNotThrow(() => h.root.goPage(id), id);
      assert.deepEqual(h.active(), [id], id);
    }
    for (const id of OWNER) {
      h.root.goPage('pagePOS');
      let result;
      assert.doesNotThrow(() => { result = h.root.goPage(id); }, id);
      assert.equal(result, false, id);
      assert.deepEqual(h.active(), ['pagePOS'], id);
    }
    assert.doesNotThrow(() => assert.equal(h.root.ventasSetTab({}, 'reportes'), false));
    assert.equal(h.root.ventasSetTab({}, 'hoy'), true);
  });

  test(`guardConfig without NA_PERMISSIONS (${cachedRole}) closes every owner screen left open, not just the first`, async () => {
    const h = harness({ cachedRole });
    await flush();
    for (const id of ['pageGastos', 'pageKardex', 'pageConfig', 'pageValorizacion']) h.pages.find((p) => p.id === id).classList.add('active');
    assert.doesNotThrow(() => h.listeners['na:role'].forEach((fn) => fn()));
    assert.deepEqual(h.active(), ['pagePOS']);
  });
}

test('the fallback never grants more than the shared policy gives an employee', async () => {
  const withTable = harness({ cachedRole: 'empleado', permissions: true });
  const without = harness({ cachedRole: 'empleado' });
  await flush();
  assert.equal(typeof withTable.root.NA_PERMISSIONS.canAccessScreen, 'function');
  const ids = [...Object.keys(withTable.root.NA_PERMISSIONS.SCREENS), 'pageDesconocida'];
  for (const id of ids) {
    const a = withTable.root.goPage(id) !== false; withTable.root.goPage('pagePOS');
    const b = without.root.goPage(id) !== false; without.root.goPage('pagePOS');
    assert.equal(b, a, id);
    assert.equal(a, withTable.root.NA_PERMISSIONS.canAccessScreen('empleado', id), id);
  }
});

test('local mode (no cloud) is still the owner device even without NA_PERMISSIONS', async () => {
  const h = harness({ cloud: false });
  await flush();
  assert.equal(h.root.NA_ROLES.role, 'owner');
  for (const id of [...EMPLOYEE, ...OWNER.filter((id) => id !== 'pageDesconocida')]) {
    assert.notEqual(h.root.goPage(id), false, id);
  }
});
