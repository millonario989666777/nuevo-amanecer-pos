import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../../POS/js/sync/canonical-sale-view.js', import.meta.url), 'utf8');

function harness({ intents = [], enabled = true, storageKey = 'na_canonical_sale_outbox_v1' } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const originalProduct = { id: 'p1', name: 'Arroz <premium>', stock: 10 };
  const remoteSnapshot = { products: [{ id: 'p1', stock: 10 }], customers: [{ id: 'c1' }], credits: [] };
  const globals = {
    productos: [{ id: 'old', stock: 99 }], ventas: [], creditos: [], clientes: [], cajMovs: [], inventoryMovements: [],
    calls: { pos: 0, inv: 0, ventas: 0, cli: 0, sync: 0, fetch: 0, save: 0, storageWrite: 0 },
    console: { error() { } },
    localStorage: { setItem() { globals.calls.storageWrite++; throw Error('storage write forbidden'); } },
    document: {
      createElement(tag) { return node(tag); },
      getElementById(id) { return nodes.get(id) || [...nodes.values()].flatMap(n => [n, ...descendants(n)]).find(n => n.id === id) || null; },
      addEventListener(name, fn) { listeners.set(name, fn); }
    },
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatchEvent(event) { const fn = listeners.get(event.type); if (fn) fn(event); },
    CustomEvent: function (type, opts = {}) { this.type = type; this.detail = opts.detail; },
    NuevoAmanecerCanonical: {
      enabled: () => enabled,
      snapshot: () => remoteSnapshot,
      legacySnapshot: () => ({ products: [originalProduct], sales: [], customers: [{ id:'c1', nombre:'Cliente Uno' }] })
    },
    NuevoAmanecerCanonicalSaleOutbox: { KEY: storageKey, snapshot: () => ({ version: 1, intents }), sync() { globals.calls.sync++; throw Error('sync forbidden'); } },
    NuevoAmanecerCanonicalSaleProjection: { project(base, outbox) {
      const products = structuredClone(base.products);
      const sales = outbox.intents.map(i => ({ id: i.sale_id, sale_id: i.sale_id, total_cents: i.total_cents, payment_method: i.payment_method, created_at: i.created_at, status: 'PENDING_SYNC', conflict: !!i.conflict, reason: i.reason }));
      const credits = outbox.intents.filter(i => i.payment_method === 'credito').map(i => ({ sale_id: i.sale_id, customer_id: i.customer_id, amount_cents: i.total_cents, due: i.credit_due, source: 'CANONICAL_OUTBOX' }));
      for (const i of outbox.intents) for (const item of i.items) {
        const p = products.find(x => String(x.id) === String(item.product_id));
        p.projected_stock = (p.projected_stock ?? p.stock) - item.quantity;
      }
      return { products, sales, credits };
    } },
    posRender() { this.calls.pos++; }, invRender() { this.calls.inv++; },
    ventasRender() { this.calls.ventas++; }, cliRender() { this.calls.cli++; },
    fetch() { this.calls.fetch++; throw Error('fetch forbidden'); }, saveAllData() { this.calls.save++; throw Error('save forbidden'); }
  };
  function node(tag) {
    return { tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, style: {}, _text: '', parentNode: null,
      set textContent(value) { this._text = String(value); this.replaceChildren(); },
      get textContent() { return this._text + this.children.map(x => x.textContent).join(''); },
      set id(value) { this._id = value; }, get id() { return this._id; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      append(...xs) { xs.forEach(x => this.appendChild(x)); },
      removeChild(child) { this.children = this.children.filter(x => x !== child); child.parentNode = null; },
      replaceChildren(...xs) { this.children.forEach(x => x.parentNode = null); this.children = []; this.append(...xs); },
      setAttribute(k, v) { this.attributes[k] = String(v); }, addEventListener() { },
      get innerHTML() { return ''; }, set innerHTML(_) { throw Error('innerHTML forbidden'); },
      querySelectorAll(selector) { return descendants(this).filter(x => selector === 'button' ? x.tagName === 'BUTTON' : selector === '[onclick]' ? 'onclick' in x.attributes : selector === '[data-na-credit-action]' ? 'data-na-credit-action' in x.attributes : false); }
    };
  }
  function descendants(n) { return n.children.flatMap(c => [c, ...descendants(c)]); }
  nodes.set('ventasContent', node('div')); nodes.set('cliList', node('div'));
  const context = vm.createContext(globals);
  vm.runInContext(script, context);
  return { globals, nodes, listeners, originalProduct, remoteSnapshot, node, run: () => globals.NuevoAmanecerCanonicalSaleView.rebuild(), descendants };
}

function intent(id, qty = 2, extra = {}) { return { sale_id: id, operation_id: `op-${id}`, version: 1, created_at: '2026-09-23T00:00:00Z', payment_method: 'efectivo', total_cents: 1250, payment: {}, items: [{ product_id: 'p1', quantity: qty, unit_price_cents: 625, line_total_cents: 625 * qty }], ...extra }; }

test('empty outbox restores remote stock and has no pending panels', () => {
  const h = harness(); h.run();
  assert.equal(h.globals.productos[0].stock, 10);
  assert.equal(h.nodes.get('ventasContent').children.length, 0);
  assert.equal(h.nodes.get('cliList').children.length, 0);
});

test('pending sales project stock and render safe read-only sales and credits', () => {
  const h = harness({ intents: [intent('S-1', 2, { payment_method: 'credito', customer_id: 'c1', credit_due: '2026-10-01' })] });
  h.run();
  assert.equal(h.globals.productos[0].stock, 8);
  assert.equal(h.globals.productos[0]._canonicalRemoteStock, 10);
  assert.equal(h.originalProduct.stock, 10);
  assert.equal(h.remoteSnapshot.products[0].stock, 10);
  assert.match(h.nodes.get('ventasContent').children[0].textContent, /Pendiente de sincronización/);
  assert.match(h.nodes.get('cliList').children[0].textContent, /Crédito pendiente de sincronización/);
  assert.equal(h.globals.ventas.length, 0); assert.equal(h.globals.creditos.length, 0);
  for (const id of ['ventasContent', 'cliList']) {
    const all = h.descendants(h.nodes.get(id));
    assert.equal(all.some(n => n.tagName === 'BUTTON'), false);
    assert.equal(all.some(n => 'onclick' in n.attributes || 'data-na-credit-action' in n.attributes), false);
  }
});

test('durable sale receipt becomes a normal completed sale immediately and hides pending card', () => {
  const pending = intent('V-004', 1, { total_cents:500, items:[{ product_id:'p1', quantity:1, unit_price_cents:500, line_total_cents:500 }] });
  const h = harness({ intents:[pending] });
  h.globals.dispatchEvent({
    type:'na:canonical-sale-receipt',
    detail:{
      version:1,
      command:'sale.create',
      payload:{
        operation_id:pending.operation_id,
        sale_id:pending.sale_id,
        created_at:'2026-10-01T02:24:37.744Z',
        payment_method:'efectivo',
        total_cents:500,
        payment:{cash_cents:500,digital_cents:0,credit_cents:0,reference:''},
        items:[{product_id:'p1',quantity:1,unit_price_cents:500,line_total_cents:500}]
      },
      receipt:{status:'created',operation_id:pending.operation_id,sale_id:pending.sale_id,idempotent:false}
    }
  });
  assert.equal(h.globals.ventas.length,1);
  assert.equal(h.globals.ventas[0].id,'V-004');
  assert.equal(h.globals.ventas[0].total,5);
  assert.equal(h.globals.ventas[0].estado,'completada');
  assert.equal(h.globals.ventas[0].canonicalReceiptProjection,true);
  assert.equal(h.globals.calls.ventas,1,'main Ventas renderer must run on the receipt path');
  assert.equal(h.nodes.get('ventasContent').children.length,0,'same sale must not flash as pending after receipt');
  assert.equal(h.globals.productos[0].stock,9,'receipt and still-present outbox must not double-decrement stock');
});

test('cumulative rebuild is idempotent and clearing outbox restores remote stock', () => {
  const h = harness({ intents: [intent('S-1', 2), intent('S-2', 3)] });
  h.run(); h.run(); assert.equal(h.globals.productos[0].stock, 5);
  h.globals.NuevoAmanecerCanonicalSaleOutbox.snapshot = () => ({ version: 1, intents: [] });
  h.run(); assert.equal(h.globals.productos[0].stock, 10);
  assert.equal(h.nodes.get('ventasContent').children.length, 0);
});

test('reload and rebuild from same remote base and outbox returns the same view', () => {
  const first = harness({ intents: [intent('S-1', 2)] }); first.run();
  const second = harness({ intents: [intent('S-1', 2)] }); second.run();
  assert.deepEqual(JSON.parse(JSON.stringify(second.globals.NuevoAmanecerCanonicalSaleView.lastView())), JSON.parse(JSON.stringify(first.globals.NuevoAmanecerCanonicalSaleView.lastView())));
  const defensive = second.globals.NuevoAmanecerCanonicalSaleView.lastView(); defensive.sales[0].id = 'mutated';
  assert.equal(second.globals.NuevoAmanecerCanonicalSaleView.lastView().sales[0].id, 'S-1');
});

test('conflicts are visible and events rebuild only for canonical signals or outbox key', () => {
  const h = harness({ intents: [intent('S-1', 2, { conflict: true, reason: 'STOCK_CONFLICT' })] }); h.run();
  assert.match(h.nodes.get('ventasContent').children[0].textContent, /Conflicto pendiente: STOCK_CONFLICT/);
  const before = h.globals.calls.pos;
  h.globals.dispatchEvent({ type: 'na:canonical-sale-projection', detail: { forged: true } });
  h.globals.dispatchEvent({ type: 'na:canonical-updated' });
  h.globals.dispatchEvent({ type: 'storage', key: 'other' }); assert.equal(h.globals.calls.pos, before + 2);
  h.globals.dispatchEvent({ type: 'storage', key: h.globals.NuevoAmanecerCanonicalSaleOutbox.KEY }); assert.equal(h.globals.calls.pos, before + 3);
});

test('canonical off does not replace products or render pending panels', () => {
  const h = harness({ enabled: false, intents: [intent('S-1')] }); const products = h.globals.productos;
  h.run(); assert.equal(h.globals.productos, products);
  assert.equal(h.nodes.get('ventasContent').children.length, 0);
});

test('DOMContentLoaded rebuilds only when canonical is enabled with a valid base', () => {
  const valid = harness(); valid.listeners.get('DOMContentLoaded')();
  assert.equal(valid.globals.calls.pos, 1);
  const invalid = harness(); invalid.globals.NuevoAmanecerCanonical.snapshot = () => ({ products: [] });
  invalid.listeners.get('DOMContentLoaded')();
  assert.equal(invalid.globals.calls.pos, 0);
});

test('rebuild never invokes sync, network or financial persistence side effects', () => {
  const h = harness({ intents: [intent('S-1')] }); h.run(); h.run();
  assert.deepEqual(h.globals.calls, { pos: 2, inv: 2, ventas: 0, cli: 0, sync: 0, fetch: 0, save: 0, storageWrite: 0 });
});

test('index script order keeps canonical view after dependencies and inline-18', () => {
  const html = fs.readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(x => x[1]);
  const at = value => srcs.indexOf(value);
  assert.ok(at('js/sync/canonical-sale-projection.js') < at('js/sync/canonical-sale-view.js'));
  assert.ok(at('js/sync/canonical-sale-intent.js') < at('js/sync/canonical-sale-view.js'));
  assert.ok(at('js/sync/canonical-sale-outbox.js') < at('js/sync/canonical-sale-view.js'));
  assert.ok(at('js/sync/canonical-sale-integration.js') < at('js/sync/canonical-sale-view.js'));
  assert.ok(at('js/legacy-inline/inline-18.js') < at('js/sync/canonical-sale-view.js'));
  assert.ok(at('js/sync/canonical-sale-view.js') < at('js/compat/legacy-globals.js'));
  assert.ok(at('js/compat/legacy-globals.js') < at('js/app.js'));
  assert.ok(at('js/sync/canonical-client.js') < at('js/sync/canonical-sale-view.js'));
});


test('canonical sale view composes through lifecycle events without taking renderer ownership', () => {
  const h = harness({ intents: [intent('S-EVENT', 1, { payment_method:'credito', customer_id:'c1', credit_due:'2026-10-01' })] });
  const ventasIdentity = h.globals.ventasRender;
  const clientesIdentity = h.globals.cliRender;
  h.run();
  assert.equal(h.globals.ventasRender, ventasIdentity);
  assert.equal(h.globals.cliRender, clientesIdentity);

  h.nodes.get('ventasContent').replaceChildren();
  h.nodes.get('cliList').replaceChildren();
  h.globals.dispatchEvent({ type:'na:sales-rendered' });
  h.globals.dispatchEvent({ type:'na:clients-rendered' });
  assert.match(h.nodes.get('ventasContent').children[0].textContent, /Pendiente de sincronización/);
  assert.match(h.nodes.get('cliList').children[0].textContent, /Crédito pendiente de sincronización/);
});

test('authoritative sales and clients renderers emit post-render lifecycle events', () => {
  const clients = fs.readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js', import.meta.url), 'utf8');
  const sales = fs.readFileSync(new URL('../../POS/js/legacy-inline/inline-10.js', import.meta.url), 'utf8');
  assert.match(clients,/new CustomEvent\('na:clients-rendered'\)/);
  assert.match(sales,/new CustomEvent\('na:sales-rendered'\)/);
  assert.doesNotMatch(script,/root\[name\]\s*=/);
  assert.doesNotMatch(script,/installRenderHooks/);
});
