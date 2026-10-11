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

// Moved from canonical-sale-view.test.mjs (PR #512 cherry-picks) so base test files stay untouched.


test('mobile pending sales are grouped into cards with Peru-local timestamps and no raw ISO', () => {
  const sale = intent('V-091', 1, {
    created_at:'2026-10-11T00:14:31.535Z',
    payment_method:'credito', customer_id:'c1', credit_due:'2026-10-11',
    total_cents:500
  });
  const h = harness({ intents:[sale] });
  h.run();
  const panel = h.nodes.get('ventasContent').children[0];
  const card = panel.children.find(node => node.tagName === 'ARTICLE');
  assert.ok(card);
  assert.equal(card.className, 'na-canonical-pending-item');
  assert.equal(card.children[0].className, 'na-canonical-pending-item-top');
  assert.match(card.textContent, /S\/ 5\.00/);
  assert.match(card.textContent, /Pendiente de sincronización/);
  const time = h.descendants(card).find(node => node.tagName === 'TIME');
  assert.ok(time);
  assert.match(time.textContent, /10\/10\/2026/);
  assert.doesNotMatch(time.textContent, /2026-10-11T/);

  const creditPanel = h.nodes.get('cliList').children[0];
  const creditCard = creditPanel.children.find(node => node.tagName === 'ARTICLE');
  const due = h.descendants(creditCard).find(node => node.tagName === 'TIME');
  assert.equal(due.textContent, '11/10/2026', 'credit due is a local calendar date, never converted from UTC');
});

test('the canonical pending-card stylesheet is loaded by the active POS document', () => {
  const css = fs.readFileSync(new URL('../../POS/css/experience-v2/pages/ventas.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
  assert.match(html, /css\/experience-v2\/pages\/ventas\.css/);
  for (const cls of ['na-canonical-pending', 'na-canonical-pending-item',
                     'na-canonical-pending-item-top', 'na-canonical-pending-status',
                     'na-canonical-conflict']) {
    assert.ok(css.includes(cls), cls + ' must have presentation rules');
  }
  assert.match(css, /overflow-wrap:\s*anywhere/);
});
