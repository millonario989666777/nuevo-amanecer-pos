import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../POS/js/modules/client-credit-accounts-v2.js', import.meta.url), 'utf8');

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function harness({ locked = false, permissionsMissing = false } = {}) {
  const listeners = new Map();
  const nodes = {};
  function element(tag = 'div') {
    const classes = new Set(['active']);
    return {
      tag, dataset: {}, children: [], attributes: {}, hidden: false, textContent: '', style: {},
      classList: { contains: name => classes.has(name), add(...names) { names.forEach(n => classes.add(n)); },
        remove(...names) { names.forEach(n => classes.delete(n)); }, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) {
        if (child.tag === 'fragment') child.children.forEach(c => this.appendChild(c));
        else { this.children.push(child); child.parentNode = this; }
      },
      append(...children) { children.forEach(c => this.appendChild(c)); },
      replaceChildren() { this.children = []; },
      insertBefore(child) { this.appendChild(child); },
      querySelector(selector) {
        if (selector === '.filter-bar') return this.children.find(c => c.className === 'filter-bar') || null;
        if (selector === '.na-client-debt-filter') return this.children.find(c => c.className === 'na-client-debt-filter') || null;
        return null;
      },
      querySelectorAll(selector) { return selector === 'button' ? this.children.filter(c => c.tag === 'button') : []; },
      addEventListener(name, fn) { this['on' + name] = fn; }
    };
  }
  nodes.pageClientes = element();
  nodes.cliList = element();
  const bar = element(); bar.className = 'filter-bar'; nodes.pageClientes.appendChild(bar);
  const ctx = {
    console, clientes: [], creditos: [],
    document: { getElementById: id => nodes[id] || nodes.pageClientes.children.find(c => c.id === id) || null, querySelector: () => null,
      createElement: element, createDocumentFragment: () => element('fragment') },
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach(fn => fn(event)); },
    setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame(fn) { fn(); },
    matchMedia: () => ({ matches: true }),
    _naSyncCreditStatus: cr => cr.status,
    _naCreditOutstanding: cr => cr.saldo,
    _naDocumentValue: value => String(value || ''),
    _naClientDebtFast: () => 999, // Deliberately disagrees: the filter must use V2's summary.
    cliRender() { throw new Error('The filter must not invoke the data-normalizing legacy renderer'); }
  };
  if (!permissionsMissing) ctx.NA_PERMISSIONS = { featureLocked: id => id === 'clientes-filtro-deuda' ? locked : true };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  return { ctx, api: ctx.NA_CLIENT_CREDIT_ACCOUNTS_V2, nodes,
    ids: () => nodes.cliList.children.filter(c => c.dataset.clientId).map(c => c.dataset.clientId),
    group: () => nodes.pageClientes.querySelector('.na-client-debt-filter') };
}

function payment(creditId, amount, operationId = 'TEST-PAY-1') {
  return { credit_id: creditId, amount_cents: amount, operation_id: operationId };
}
function pending(payload, command = 'payment.create', extra = {}) {
  return { state: 'PENDING', command, payload, ...extra };
}
function summary(debt = 10, id = 'TEST-CR-1', extra = {}) {
  const credit = { credit_id: id, pagos: [] };
  return { debt, all: [credit], active: [credit], ...extra };
}
const { api } = harness();
const { effectiveBalance, filter } = api.debtFilter;

test('Con deuda / Sin deuda / Todos use the supplied existing summary and preserve order', () => {
  const rows = freeze([{ id: 'a', summary: summary(1) }, { id: 'b', summary: summary(0) }, { id: 'c', summary: summary(2) }]);
  assert.deepEqual(Array.from(filter(rows, 'con-deuda'), r => r.id), ['a', 'c']);
  assert.deepEqual(Array.from(filter(rows, 'sin-deuda'), r => r.id), ['b']);
  assert.deepEqual(Array.from(filter(rows, 'todos'), r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(filter(rows, 'unknown'), r => r.id), ['a', 'b', 'c']);
  assert.equal(filter(rows, 'todos')[0], rows[0]);
});

test('a full offline payment removes the client from Con deuda without changing canonical balance', () => {
  const rows = freeze([{ id: 'test-client', summary: summary(10) }]);
  const queue = freeze(pending(payment('TEST-CR-1', 1000)));
  assert.equal(effectiveBalance(rows[0].summary, queue), 0);
  assert.equal(filter(rows, 'con-deuda', queue).length, 0);
  assert.equal(filter(rows, 'sin-deuda', queue).length, 1);
  assert.equal(rows[0].summary.debt, 10);
});

test('partial payments and one-cent balances remain Con deuda; overpayments clamp to zero', () => {
  assert.equal(effectiveBalance(summary(10), pending(payment('TEST-CR-1', 999))), 0.01);
  assert.equal(effectiveBalance(summary(10), pending(payment('TEST-CR-1', 2000))), 0);
  assert.equal(effectiveBalance(summary(0.3), pending(payment('TEST-CR-1', 10))), 0.2);
  assert.equal(filter([{ summary: summary(0.01) }], 'con-deuda').length, 1);
});

test('batch deducts only credits belonging to the supplied client summary', () => {
  const credits = [{ id: 1, pagos: [] }, { credit_id: 'TEST-CR-2', pagos: [] }];
  const existing = freeze(summary(10, '', { all: credits, active: credits }));
  const queue = freeze(pending({ payments: [payment('1', 300), payment('TEST-CR-2', 700, 'TEST-PAY-2'),
    payment('OTHER-CLIENT-CR', 9000, 'TEST-PAY-3')] }, 'payment.batch'));
  assert.equal(effectiveBalance(existing, queue), 0);
  assert.equal(effectiveBalance(summary(20, 'OTHER-CLIENT-CR'), queue), 0);
  assert.equal(effectiveBalance(summary(7, 'UNRELATED-CR'), queue), 7);
});

test('unrelated intents, confirmed records, invalid and rejected payments do not lower debt', () => {
  for (const command of ['sale.create', 'cash.close', 'compensation.create', 'customer.create']) {
    assert.equal(effectiveBalance(summary(), pending(payment('TEST-CR-1', 1000), command)), 10);
  }
  for (const extra of [{ state: 'CONFIRMED' }, { invalid: true }, { last_error: 'stale_credit', last_status: 409 }]) {
    assert.equal(effectiveBalance(summary(), pending(payment('TEST-CR-1', 1000), 'payment.create', extra)), 10);
  }
  assert.equal(effectiveBalance(summary(), pending(payment('WRONG-CR', 1000))), 10);
});

test('malformed amounts and absent durable operation identities are ignored', () => {
  for (const amount of [-1, 0, 1.5, NaN, Infinity, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(effectiveBalance(summary(), pending(payment('TEST-CR-1', amount))), 10);
  }
  assert.equal(effectiveBalance(summary(), pending(payment('TEST-CR-1', 1000, ''))), 10);
  assert.equal(effectiveBalance(summary(), pending({}, 'payment.batch')), 10);
  assert.equal(effectiveBalance(summary(), null), 10);
  assert.equal(filter(null, 'todos').length, 0);
});

test('duplicate child intents or repeated snapshots deduct each operation only once', () => {
  const p = payment('TEST-CR-1', 400);
  const batch = pending({ payments: [p, p] }, 'payment.batch');
  assert.equal(effectiveBalance(summary(), freeze([batch, pending(p)])), 6);
});

test('payments already present in the summary or receipt projection are never deducted twice', () => {
  for (const identity of ['operation_id', 'operationId', 'pagoId', 'id']) {
    const credit = { id: 'TEST-CR-1', pagos: [{ [identity]: 'TEST-PAY-1' }] };
    assert.equal(effectiveBalance(freeze(summary(6, '', { all: [credit], active: [credit] })),
      freeze(pending(payment('TEST-CR-1', 400)))), 6);
  }
});

test('an intent against a closed credit cannot erase debt on another active credit', () => {
  const closed = { id: 'TEST-CLOSED', pagos: [] };
  const active = { id: 'TEST-ACTIVE', pagos: [] };
  assert.equal(effectiveBalance(summary(10, '', { all: [closed, active], active: [active] }),
    pending(payment('TEST-CLOSED', 1000))), 10);
});

test('native UI defaults to Todos, uses V2 balance, updates offline and composes with incoming rows', () => {
  const h = harness();
  const clients = freeze([{ id: 'test-debt', nombre: 'Prueba deuda' }, { id: 'test-paid', nombre: 'Prueba pagada' }]);
  const credit = freeze({ id: 'TEST-CR-1', cliId: 'test-debt', monto: 999, pagado: 0, saldo: 10, status: 'vigente', pagos: [] });
  h.ctx.creditos = [credit];
  let queue = null;
  h.ctx.NuevoAmanecerCanonical = { pendingSnapshot: () => queue };
  h.api.renderClientList(clients, h.nodes.cliList);
  h.ctx._naSyncCreditStatus = cr => { cr.status = cr.status || 'vigente'; return cr.status; };
  let evaluationCalls = 0;
  h.ctx._naEvaluateClientCredit = () => { evaluationCalls++; return {}; };
  h.ctx._naClientCreditsFast = () => { throw new Error('Filter must not rebuild the live legacy credit index'); };
  assert.deepEqual(h.ids(), ['test-debt', 'test-paid']);
  assert.equal(h.group().children[2].attributes['aria-pressed'], 'true');
  assert.equal(h.api.debtFilter.select('con-deuda'), true);
  assert.deepEqual(h.ids(), ['test-debt']);
  queue = freeze(pending(payment('TEST-CR-1', 1000)));
  h.ctx.dispatchEvent({ type: 'offline' });
  assert.deepEqual(h.ids(), []);
  h.group().children[1].onclick();
  assert.deepEqual(h.ids(), ['test-debt', 'test-paid']);
  assert.equal(evaluationCalls, 0, 'segment switches must not run legacy credit evaluation');
  h.api.renderClientList([clients[1]], h.nodes.cliList); // prior search/tab has already narrowed rows
  assert.deepEqual(h.ids(), ['test-paid']);
  assert.equal(h.group().children[1].attributes['aria-pressed'], 'true');
  assert.equal(credit.saldo, 10);
  assert.equal(credit.pagado, 0);
});

test('locked, missing or throwing permissions fail closed, hide controls and restore Todos', () => {
  for (const options of [{ locked: true }, { permissionsMissing: true }]) {
    const h = harness(options);
    h.api.renderClientList([], h.nodes.cliList);
    assert.equal(h.group(), null);
    assert.equal(h.api.debtFilter.select('con-deuda'), false);
  }
  const h = harness();
  h.api.renderClientList([{ id: 'test-zero', nombre: 'Prueba cero' }], h.nodes.cliList);
  h.api.debtFilter.select('con-deuda');
  h.ctx.NA_PERMISSIONS.featureLocked = () => { throw new Error('unavailable'); };
  h.api.renderClientList([{ id: 'test-zero', nombre: 'Prueba cero' }], h.nodes.cliList);
  assert.equal(h.group().hidden, true);
  assert.deepEqual(h.ids(), ['test-zero']);
  h.ctx.NA_PERMISSIONS.featureLocked = () => false;
  h.api.renderClientList([], h.nodes.cliList);
  assert.equal(h.group().hidden, false);
  assert.equal(h.group().children[2].attributes['aria-pressed'], 'true');
});
