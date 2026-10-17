import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';

const read = path => readFileSync(path, 'utf8');
const source = read('POS/js/modules/catalogo-desde-pos.js');
const plain = value => JSON.parse(JSON.stringify(value));
const pageId = 'pageCatalogoDesdePos';
function context(extra = {}, withLima = true) {
  const c = vm.createContext(extra);
  if (withLima) vm.runInContext(read('POS/js/core/lima-time.js'), c);
  vm.runInContext(source, c);
  return c;
}
const api = context().NA_CATALOGO_DESDE_POS;
const products = Object.freeze([
  Object.freeze({ name: 'Paracetamol', cat: 'farmacia', presentacion: 'Blíster de 10', precio: 3.5, costo: 9876.54, stock: 0 }),
  Object.freeze({ name: 'Arroz', cat: 'abarrotes', unidad: 'kilogramo', precio: 4.25, costo: 8765.43, stock: -2222 }),
  Object.freeze({ name: 'Sin presentación', cat: 'farmacia', precio: 0 }),
  Object.freeze({ name: 'Sin categoría', precio: 7 })
]);
const categories = Object.freeze([
  Object.freeze({ value: 'farmacia', label: 'Farmacia' }),
  Object.freeze({ value: 'abarrotes', label: 'Abarrotes' }),
  Object.freeze({ value: 'cuidado_personal', label: 'Cuidado personal' })
]);

test('category selector uses existing labels, includes empty categories; category filter and Todas keep every product regardless of availability', () => {
  const all = api.buildCatalog(products, { categories, category: '*' });
  assert.deepEqual(plain(all.rows.map(row => row.name)), ['Arroz', 'Paracetamol', 'Sin categoría', 'Sin presentación']);
  assert.deepEqual(plain(all.categories), [
    { value: 'abarrotes', label: 'Abarrotes' }, { value: 'cuidado_personal', label: 'Cuidado personal' },
    { value: 'farmacia', label: 'Farmacia' }, { value: '', label: 'Sin categoría' }
  ]);
  assert.deepEqual(plain(api.buildCatalog(products, { category: 'FÁRMACIA' }).rows), [
    { name: 'Paracetamol', presentation: 'Blíster de 10', price: 3.5 },
    { name: 'Sin presentación', presentation: '', price: 0 }
  ]);
  assert.equal(api.buildCatalog(products, { category: 'cuidado_personal' }).rows.length, 0);
  assert.equal(api.buildCatalog(products, { category: '' }).rows[0].name, 'Sin categoría');
  assert.deepEqual(plain(api.buildCatalog(products).rows), plain(all.rows));
});

test('projection returns only name, presentation and sale price, never reads costs or availability and does not mutate inputs', () => {
  const before = JSON.stringify({ products, categories });
  const sensitive = { name: 'Prueba', presentation: 'Caja', precio: '12.50', cat: 'prueba',
    get costo() { throw new Error('Must not read cost'); }, get stock() { throw new Error('Must not read stock'); } };
  const report = api.buildCatalog([...products, sensitive], { categories });
  for (const row of report.rows) assert.deepEqual(Object.keys(row).sort(), ['name', 'presentation', 'price']);
  assert.doesNotMatch(JSON.stringify(report), /costo|stock|9876\.54|8765\.43|-2222/);
  report.rows[0].name = 'Changed projection'; report.categories.push({ value: 'new', label: 'New' });
  assert.equal(JSON.stringify({ products, categories }), before);
  assert.deepEqual(plain(api.buildCatalog(null)), { categories: [], rows: [] });
  assert.equal(api.buildCatalog([null, [], 'invalid', sensitive]).rows.length, 1);
  assert.deepEqual(plain(api.buildCatalog([{ nombre: 'Alias', unit: 'litro', precio: 1 }]).rows[0]),
    { name: 'Alias', presentation: 'litro', price: 1 });
});

test('money uses non-breaking soles prefix, zero is valid and missing/invalid sale prices are unspecified', () => {
  assert.equal(api.money(3.5), 'S/\u00a03.50');
  assert.equal(api.money(0), 'S/\u00a00.00');
  for (const precio of [undefined, null, '', 'invalid', -1, Infinity]) {
    assert.equal(api.buildCatalog([{ name: 'Prueba', precio }]).rows[0].price, null);
  }
});

test('date is the Lima day at the UTC boundary, with and without the shared time utility', () => {
  for (const candidate of [api, context({}, false).NA_CATALOGO_DESDE_POS]) {
    assert.equal(candidate.limaDay('2026-10-16T04:59:59Z'), '2026-10-15');
    assert.equal(candidate.limaDay('2026-10-16T05:00:00Z'), '2026-10-16');
    assert.equal(candidate.limaDay(Date.parse('2026-10-16T04:59:59Z')), '2026-10-15');
    assert.equal(candidate.limaDay('invalid'), '');
  }
});

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.events = {}; this.value = ''; this.hidden = false; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(event, callback) { this.events[event] = callback; }
  set innerHTML(_) { throw new Error('Product data must never be parsed as HTML'); }
}
function harness() {
  const nodes = Object.fromEntries(['content', 'status', 'controls', 'category', 'date', 'print'].map(key => [key, new Node(key)]));
  nodes.category.appendChild(new Node('option')); nodes.category.value = '*';
  let owner = true, active = true, prints = 0;
  const page = { querySelector: selector => nodes[selector.match(/data-cdp-(\w+)/)?.[1]] || null,
    classList: { contains: () => active } };
  const events = {};
  const c = context({ document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === pageId ? page : null, createElement: tag => new Node(tag) },
    NA_ROLES: { isOwner: () => owner }, NA_PERMISSIONS: PERMISSIONS,
    productos: products, _naBaseCategories: categories, appConfig: Object.freeze({ customCategories: Object.freeze([{ value: 'prueba', label: 'Prueba' }]) }),
    _naAllCategories() { throw new Error('Mutating category helper'); },
    print() { prints++; }, addEventListener(event, callback) { events[event] = callback; },
    fetch() { throw new Error('No network'); },
    localStorage: { getItem() { throw new Error('No storage reads'); }, setItem() { throw new Error('No storage writes'); } }
  });
  return { c, nodes, events, page, get prints() { return prints; }, setOwner: value => { owner = value; }, setActive: value => { active = value; } };
}

test('render uses textContent, category changes/Todas/empty filter work, only public fields reach the page', () => {
  const h = harness(); const { nodes, c } = h;
  const name = '<img src=x onerror=alert(1)> & "Producto"';
  c.productos = [...products, { name, cat: 'farmacia', presentacion: '<b>Blíster</b>', precio: 5.25, costo: 9876.54, stock: 3333 }];
  c.NALimaTime = { parts: () => ({ date: '2026-10-15' }) };
  assert.equal(c.NA_CATALOGO_DESDE_POS.render(), true);
  assert.ok(nodes.content.textContent.includes(name));
  assert.ok(nodes.content.textContent.includes('<b>Blíster</b>'));
  assert.ok(nodes.content.textContent.includes('S/\u00a05.25'));
  assert.doesNotMatch(nodes.content.textContent, /costo|stock|9876\.54|8765\.43|3333|-2222/i);
  assert.equal(nodes.date.textContent, '15/10/2026 · Lima');
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.equal(walk(nodes.content).filter(node => node.tagName === 'img' || node.tagName === 'b').length, 0);
  assert.equal(nodes.category.children[0].textContent, 'Todas');
  assert.ok(nodes.category.children.some(node => node.value === 'prueba'));
  assert.equal(nodes.controls.hidden, false);
  nodes.category.value = 'abarrotes'; c.NA_CATALOGO_DESDE_POS.render();
  assert.ok(nodes.content.textContent.includes('Arroz')); assert.ok(!nodes.content.textContent.includes('Paracetamol'));
  nodes.category.value = ''; c.NA_CATALOGO_DESDE_POS.render();
  assert.ok(nodes.content.textContent.includes('Sin categoría')); assert.ok(!nodes.content.textContent.includes('Arroz'));
  nodes.category.value = '*'; c.NA_CATALOGO_DESDE_POS.render();
  assert.ok(nodes.content.textContent.includes('Arroz')); assert.ok(nodes.content.textContent.includes('Paracetamol'));
  nodes.category.value = 'cuidado_personal'; c.NA_CATALOGO_DESDE_POS.render();
  assert.match(nodes.content.textContent, /No hay productos/);
});

test('owner guard denies before memory reads and clears already rendered products/categories on role revocation', () => {
  const h = harness(); h.c.NA_CATALOGO_DESDE_POS.init();
  assert.ok(h.nodes.content.textContent.includes('Paracetamol'));
  h.setOwner(false);
  for (const key of ['productos', '_naBaseCategories', 'appConfig']) Object.defineProperty(h.c, key, { get() { throw new Error('Unauthorized state read'); } });
  h.events['na:role']();
  assert.equal(h.nodes.content.textContent, ''); assert.equal(h.nodes.category.children.length, 0);
  assert.equal(h.nodes.date.textContent, ''); assert.equal(h.nodes.controls.hidden, true);
  assert.match(h.nodes.status.textContent, /Sin permiso/);
  assert.equal(h.c.NA_CATALOGO_DESDE_POS.render(), false);
  assert.equal(h.c.NA_CATALOGO_DESDE_POS.print(), false); assert.equal(h.prints, 0);
  for (const roles of [undefined, { role: 'owner', confirmed: false }, { isOwner: () => false }]) {
    assert.equal(context({ NA_ROLES: roles, NA_PERMISSIONS: PERMISSIONS }).NA_CATALOGO_DESDE_POS.ownerAllowed(), false);
  }
  assert.equal(context({ NA_ROLES: { isOwner: () => true } }).NA_CATALOGO_DESDE_POS.ownerAllowed(), false);
});

test('Imprimir / PDF calls window.print only for the active owner page; no data or storage writes', () => {
  const h = harness(); const before = JSON.stringify({ products: h.c.productos, config: h.c.appConfig });
  h.c.NA_CATALOGO_DESDE_POS.init();
  h.nodes.print.events.click(); assert.equal(h.prints, 1);
  assert.equal(JSON.stringify({ products: h.c.productos, config: h.c.appConfig }), before);
  h.setActive(false); assert.equal(h.c.NA_CATALOGO_DESDE_POS.print(), false); assert.equal(h.prints, 1);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|indexedDB|\.setItem\s*\(|\.innerHTML\s*=|saveAppState|saveAllData|\b(?:POST|PUT|PATCH|DELETE)\b/);
});

test('feature stays locked and pending with an owner-only page and unchanged owner-only feature routes', async () => {
  const c = context();
  vm.runInContext(read('POS/js/config/pos-permissions.js'), c);
  vm.runInContext(read('POS/js/modules/proximamente-registry.js'), c);
  vm.runInContext(read('POS/js/modules/proximamente.js'), c);
  await c.NA_PROXIMAMENTE.load();
  const feature = c.NA_PROXIMAMENTE.get('catalogo-desde-pos');
  assert.equal(feature.page, pageId); assert.equal(feature.pending, true); assert.equal(feature.module, 'Ventas');
  assert.equal(c.NA_PROXIMAMENTE.isEnabled(feature.id), false);
  for (const policy of [PERMISSIONS, c.NA_PERMISSIONS]) {
    assert.equal(policy.FEATURE_LOCKS[feature.id], true); assert.equal(policy.featureLocked(feature.id), true);
    assert.deepEqual(Array.from(policy.SCREENS[pageId]), ['owner']);
    assert.deepEqual(Array.from(policy.FEATURE_ROLES[feature.id]), ['owner']);
    for (const role of ['empleado', 'unknown', '', null]) assert.equal(policy.canAccessScreen(role, pageId), false);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.deepEqual(Array.from(policy.routeRoles('/features/' + feature.id, method)), ['owner']);
  }
});

test('navigation whitelist/fallback denies employee or unconfirmed identities, with no drawer item; assets wired/pre-cached', () => {
  const navigation = read('POS/js/navigation/menu-navigation.js');
  const c = vm.createContext({ document: { readyState: 'loading', addEventListener() {} }, innerWidth: 390 });
  c.window = c; vm.runInContext(navigation, c);
  assert.ok(c.NA_MENU_NAVIGATION.pages.includes(pageId));
  for (const permissions of [undefined, PERMISSIONS]) {
    c.NA_PERMISSIONS = permissions;
    for (const roles of [undefined, { role: 'owner', confirmed: false }, { role: 'empleado', confirmed: true, isOwner: () => false }]) {
      c.NA_ROLES = roles; assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage(pageId), false);
    }
    c.NA_ROLES = { isOwner: () => true }; assert.equal(c.NA_MENU_NAVIGATION.canShowDrawerPage(pageId), true);
  }
  assert.ok(!navigation.slice(navigation.indexOf('function renderDrawerItems()'), navigation.indexOf('function openMobileDrawer')).includes(pageId));
  const html = read('POS/index.html'), sw = read('POS/sw.js');
  assert.ok(html.includes(`id="${pageId}"`));
  for (const asset of ['css/catalogo-desde-pos.css', 'js/modules/catalogo-desde-pos.js']) {
    assert.ok(html.includes(asset)); assert.ok(sw.includes("'./" + asset + "'"));
  }
});

test('table cells override global mobile hiding before cards; every print selector is scoped to the active catalog page', () => {
  const css = read('POS/css/catalogo-desde-pos.css');
  const cells = css.indexOf('#pageCatalogoDesdePos .cdp-table :is(th, td) { display: table-cell; }');
  assert.ok(cells >= 0 && cells < css.indexOf('@media'));
  assert.match(css, /@media \(max-width: 599px\)[\s\S]*#pageCatalogoDesdePos \.cdp-table :is\(th, td\) \{ display: block;/);
  const print = css.slice(css.indexOf('@media print'));
  // Look at each complete selector prelude without splitting commas inside :is().
  const rules = print.slice(print.indexOf('{') + 1);
  const selectors = [...rules.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].map(match => match[1].trim());
  assert.ok(selectors.length >= 10);
  for (const selector of selectors) {
    assert.ok(selector.includes('#pageCatalogoDesdePos.active'), selector);
    assert.doesNotMatch(selector, /#pagePOS|#pageMenu|#ticketBody/);
  }
  assert.match(print, /body:has\(#pageCatalogoDesdePos\.active\)[^{]+\{ display: none !important;/);
  assert.match(print, /\.cdp-controls, \.cdp-status\) \{ display: none !important;/);
  assert.match(print, /\.cdp-table :is\(th, td\) \{ display: table-cell !important;/);
});
