import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../POS/js/modules/valorizacion-inventario.js', import.meta.url), 'utf8');
const lotsSource = readFileSync(new URL('../../POS/js/inventory/stock-lots.js', import.meta.url), 'utf8');
const permissionsSource = readFileSync(new URL('../../POS/js/config/pos-permissions.js', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../../POS/js/modules/proximamente-registry.js', import.meta.url), 'utf8');
const proximamenteSource = readFileSync(new URL('../../POS/js/modules/proximamente.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const api = context.NA_VALORIZACION;
const plain = value => JSON.parse(JSON.stringify(value));
const product = overrides => ({ cat: 'abarrotes', stock: 2, costo: 1, precio: 3, ...overrides });

test('groups by inventory category, uses physical units and reconciles category totals', () => {
  const result = api.calculate([
    product({ cat: 'Farmácia', stock: 5, costo: 1.25, precio: 2, unidCaja: 12, precioCaja: 18 }),
    product({ cat: 'farmacia', stock: 0.5, costo: 2, precio: 4 }),
    product({ cat: 'abarrotes', stock: 3, costo: 0.2, precio: 0.5 }),
    product({ cat: null, stock: 1 })
  ]);
  assert.deepEqual(plain(result.rows.map(r => [r.category, r.units, r.costValue, r.saleValue])), [
    ['Abarrotes', 3, 0.6, 1.5], ['Farmacia', 5.5, 7.25, 12], ['Sin categoría', 1, 1, 3]
  ]);
  assert.equal(result.totals.units, 9.5);
  assert.equal(result.totals.costValue, 8.85);
  assert.equal(result.totals.saleValue, 16.5);
});

test('missing, blank, malformed, negative and zero costs (catalog normalizes missing to 0) count as sin costo', () => {
  const missing = [undefined, null, '', '  ', 'sin costo', 'S/ —', NaN, Infinity, -1, false];
  const result = api.calculate([...missing.map(costo => product({ costo })), product({ costo: 0 }), product({ costo: '0' })]);
  assert.equal(result.totals.noCostProducts, 12);
  assert.equal(result.totals.noCostUnits, 24);
  assert.equal(result.totals.units, 24);
  assert.equal(result.totals.costValue, 0);
  assert.equal(result.totals.saleValue, 72, 'missing cost must not exclude units or sale value');
});

test('negative and invalid stock never contribute; untracked products are excluded', () => {
  const result = api.calculate([
    product({ stock: -4 }), product({ stock: '-1,5' }),
    ...[null, undefined, '', NaN, Infinity, 'desconocido'].map(stock => product({ stock })),
    product({ controlInventario: false, stock: 99, costo: null }), product({ stock: 0 }), product({ stock: 3 })
  ]);
  assert.equal(result.totals.units, 3);
  assert.equal(result.totals.costValue, 3);
  assert.equal(result.totals.saleValue, 9);
  assert.equal(result.totals.negativeStockProducts, 2);
  assert.equal(result.totals.invalidStockProducts, 6);
  assert.equal(result.untrackedProducts, 1);
  assert.equal(result.totals.noCostProducts, 0);
});

test('handles inventory decimal strings, fractions and rounding without lost sub-cent contributions', () => {
  const result = api.calculate([
    product({ stock: '0,1', costo: '0,05', precio: 'S/ 1.234,50' }),
    product({ stock: '0.2', costo: '0.05', precio: '1,234.50' })
  ]);
  assert.equal(result.totals.units, 0.3);
  assert.equal(result.totals.costValue, 0.02);
  assert.equal(result.totals.saleValue, 370.35);
  const rounded = api.calculate([product({ cat: 'a', stock: 0.1, costo: 0.05 }), product({ cat: 'b', stock: 0.1, costo: 0.05 })]);
  assert.equal(rounded.totals.costValue, 0.02, 'total reconciles to rounded rows');
  assert.match(api.formatMoney(370.35), /^S\/ 370\.35$/);
  assert.equal(api.formatMoney(0), 'S/ 0.00');
});

test('stock includes batches, expired and unbatched units; pending projection is authoritative', () => {
  vm.runInContext(lotsSource, context);
  const lots = Object.freeze([{ quantity: 6, expiry_date: '2025-01-01' }, { quantity: 2, expiry_date: '2028-01-01' }].map(Object.freeze));
  const products = Object.freeze([
    Object.freeze(product({ stock: 7, lots, _canonicalRemoteStock: 10, _canonicalPendingStock: true, _canonicalPendingDelta: 3 })),
    Object.freeze(product({ stock: 5, lots_json: JSON.stringify([{ quantity: 4 }]) })),
    Object.freeze(product({ stock: -2, lots_json: 'malformed', _canonicalPendingStock: true }))
  ]);
  const before = JSON.stringify(products);
  const result = api.calculate(products, { roundUnits: context.NA_STOCK_LOTS.round });
  assert.equal(result.totals.units, 12);
  assert.equal(result.totals.costValue, 12);
  assert.equal(result.totals.pendingStockProducts, 2);
  assert.equal(JSON.stringify(products), before);
});

test('empty/malformed input is safe; unknown categories and prototype-like names stay distinct', () => {
  assert.equal(api.calculate(null).rows.length, 0);
  const result = api.calculate([null, false, [], product({ cat: '__proto__' }), product({ cat: 'constructor' }), product({ cat: 'toString' })]);
  assert.equal(result.rows.length, 3);
  assert.equal(result.totals.units, 6);
});

test('invalid sale prices are visible in the report rather than used as a value', () => {
  const result = api.calculate([product({ precio: null }), product({ precio: -1 }), product({ precio: 0 })]);
  assert.equal(result.totals.noPriceProducts, 2);
  assert.equal(result.totals.saleValue, 0);
  assert.equal(result.totals.costValue, 6);
});

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, callback) { this.events[key] = callback; }
}
function harness(initialRole = 'owner') {
  const host = new Node(), refresh = new Node('button'), observers = [], events = {};
  let role = initialRole, reads = 0, active = true;
  const page = {
    classList: { contains: () => active },
    querySelector: selector => selector === '[data-valorizacion-report]' ? host : refresh
  };
  const ctx = vm.createContext({
    document: { readyState: 'complete', createElement: tag => new Node(tag), getElementById: id => id === 'pageValorizacion' ? page : null },
    NA_ROLES: { isOwner: () => role === 'owner' },
    NA_PERMISSIONS: { canAccessScreen: (r, id) => r === 'owner' && id === 'pageValorizacion' },
    MutationObserver: function (callback) { observers.push(callback); this.observe = () => {}; },
    addEventListener: (event, callback) => { events[event] = callback; },
    _naTracksStock: p => p.controlInventario !== false,
    _naCategoryLabel: () => { throw new Error('mutating helper called'); },
    localStorage: new Proxy({}, { get() { throw new Error('storage accessed'); } }),
    fetch: () => { throw new Error('network accessed'); },
    saveAllData: () => { throw new Error('persistence called'); }
  });
  vm.runInContext(`
    const _naBaseCategories = Object.freeze([{value:'cuidado', label:'Cuidado personal'}]);
    const appConfig = Object.freeze({ customCategories: Object.freeze([{value:'farmacia', label:'Farmacia <img src=x onerror=alert(1)>'}]) });
    const data = Object.freeze([Object.freeze({cat:'farmacia', stock:3, costo:null, precio:2}), Object.freeze({cat:'cuidado', stock:1, costo:4, precio:5})]);
    let productos = data;
  `, ctx);
  Object.defineProperty(ctx, 'productos', { get() { reads++; throw new Error('window.productos must not shadow lexical productos'); } });
  vm.runInContext(source, ctx);
  return { ctx, host, refresh, observers, events, reads: () => reads, role: value => { role = value; }, active: value => { active = value; } };
}

test('renders lexical productos without storage, network or data mutations; category text is safe', () => {
  const h = harness();
  assert.match(h.host.textContent, /1 producto\(s\) sin costo/);
  assert.match(h.host.textContent, /Cuidado personal/);
  assert.match(h.host.textContent, /Farmacia <img src=x onerror=alert\(1\)>/);
  assert.match(h.host.textContent, /Costo incompleto/);
  const before = vm.runInContext('JSON.stringify({productos, appConfig})', h.ctx);
  h.refresh.events.click(); h.observers[0]();
  assert.equal(vm.runInContext('JSON.stringify({productos, appConfig})', h.ctx), before);
  assert.equal(h.reads(), 0);
  h.active(false);
  h.role('empleado'); h.events['na:role']();
  assert.equal(h.host.textContent, 'Sin permiso. Pídele acceso al dueño.');
});

test('employee, unknown or unconfirmed identity cannot render valuation; absent policies fail closed', () => {
  for (const role of ['empleado', 'unknown', 'unconfirmed']) {
    const h = harness(role);
    assert.equal(h.ctx.NA_VALORIZACION.render(), false);
    assert.equal(h.reads(), 0);
    assert.equal(h.host.textContent, 'Sin permiso. Pídele acceso al dueño.');
  }
  const h = harness();
  h.ctx.NA_ROLES = undefined;
  assert.equal(h.ctx.NA_VALORIZACION.render(), false);
  h.ctx.NA_ROLES = { isOwner: () => true }; h.ctx.NA_PERMISSIONS = undefined;
  assert.equal(h.ctx.NA_VALORIZACION.render(), false);
});

test('proposed integrator wiring enables only the owner in the shared browser/Worker policy and registry', async () => {
  // Prohibited files stay untouched: verify the exact proposed edit in memory.
  const patchedPermissions = permissionsSource.replace("'pageProximamente', 'ventas:reportes'", "'pageProximamente', 'pageValorizacion', 'ventas:reportes'")
    .replace("'valorizacion-inventario': true", "'valorizacion-inventario': false");
  const patchedRegistry = registrySource.replace(/(id: 'valorizacion-inventario'[^\n]*?)page: null/, "$1page: 'pageValorizacion'").replace(/(id: 'valorizacion-inventario'[^\n]*?)pending: true, /, '$1');
  const ctx = vm.createContext({});
  vm.runInContext(patchedPermissions, ctx); vm.runInContext(patchedRegistry, ctx); vm.runInContext(proximamenteSource, ctx);
  await ctx.NA_PROXIMAMENTE.load();
  const p = ctx.NA_PERMISSIONS;
  assert.equal(p.canAccessScreen('owner', 'pageValorizacion'), true);
  for (const role of ['empleado', 'unknown', null]) assert.equal(p.canAccessScreen(role, 'pageValorizacion'), false);
  assert.deepEqual(Array.from(p.routeRoles('/features/valorizacion-inventario', 'GET')), ['owner']);
  assert.deepEqual(Array.from(p.routeRoles('/features/valorizacion-inventario', 'POST')), ['owner']);
  assert.equal(p.featureLocked('valorizacion-inventario'), false);
  assert.equal(ctx.NA_PROXIMAMENTE.isEnabled('valorizacion-inventario'), true);
  assert.equal(ctx.NA_PROXIMAMENTE.get('valorizacion-inventario').page, 'pageValorizacion');
});

test('drawer valuation row uses the shared policy and denies unconfirmed identities in its fallback', () => {
  const nav = readFileSync(new URL('../../POS/js/navigation/menu-navigation.js', import.meta.url), 'utf8');
  const start = nav.indexOf('  function canShowDrawerPage('), end = nav.indexOf('\n  function ', start + 1);
  const ctx = vm.createContext({}); ctx.root = ctx;
  const canShow = vm.runInContext('(' + nav.slice(start, end).trim() + ')', ctx);
  for (const roles of [undefined, { role: 'owner' }, { isOwner: () => false }]) {
    ctx.NA_ROLES = roles;
    assert.equal(canShow('pageValorizacion'), false);
  }
  ctx.NA_ROLES = { isOwner: () => true };
  assert.equal(canShow('pageValorizacion'), true);
  ctx.NA_PERMISSIONS = { canAccessScreen: (role, page) => role === 'owner' && page !== 'pageValorizacion' };
  assert.equal(canShow('pageValorizacion'), false, 'a configured policy is authoritative');
});
