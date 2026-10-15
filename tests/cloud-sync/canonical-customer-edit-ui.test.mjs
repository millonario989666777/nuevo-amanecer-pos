import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { docHelpers } from '../helpers/doc-helpers.mjs';

// QA CANON: "DATOS DEL CLIENTE" only showed "Clientes está protegido". The contact editor
// already saves through canonical customer.contact.set, so in CANON it is a canonical
// customer UI; user/master/read-only locks must still block it.
const contactUi = fs.readFileSync(new URL('../../POS/js/modules/ticket/share-receipt-ui.js', import.meta.url), 'utf8');
const bridgeSrc = fs.readFileSync(new URL('../../POS/js/sync/canonical-customer-bridge.js', import.meta.url), 'utf8');
const inline03 = fs.readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js', import.meta.url), 'utf8');
const lockSource = inline03.split('\n').find(line => line.startsWith('isModuleLocked=function'));

function dom() {
  const nodes = new Map();
  const listeners = [];
  function el(tag) {
    const n = { tagName: String(tag).toUpperCase(), children: [], classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      style: {}, dataset: {}, value: '', textContent: '', disabled: false, attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, append(...xs) { xs.forEach(x => { this.children.push(x); if (x && x.id) nodes.set(x.id, x); }); }, focus() {},
      set id(v) { this._id = v; nodes.set(v, this); }, get id() { return this._id; } };
    return n;
  }
  const document = {
    createElement: el, getElementById: id => nodes.get(id) || null, querySelector: () => null,
    body: { append(x) { if (x && x.id) nodes.set(x.id, x); } },
    addEventListener(type, fn) { listeners.push([type, fn]); },
  };
  return { document, nodes, listeners, el };
}

function contactHarness({ canonicalOn, userLock = false }) {
  const d = dom();
  const toasts = [];
  const store = new Map(userLock ? [['na_lock_clientes', 'true']] : []);
  const ctx = vm.createContext({ ...docHelpers,
    document: d.document, console,
    clientes: [{ id: 'C-1', nombre: 'Luis', tel: '' }],
    toast: (m, t) => toasts.push([m, t]),
    storage: { getItem: k => store.has(k) ? store.get(k) : null },
    LOCK_KEYS: { master: 'na_lock_master', readOnly: 'na_lock_readonly', modules: { clientes: 'na_lock_clientes' } },
    securityIsLocked: () => false,
    NuevoAmanecerCanonical: canonicalOn ? { enabled: () => true, setCustomerContact: async () => ({ status: 'created' }), pendingSnapshot: () => null, refresh: async () => ({}) } : undefined,
  });
  ctx.globalThis = ctx;
  vm.runInContext('var isModuleLocked;' + lockSource, ctx);
  vm.runInContext(contactUi, ctx);
  return { ctx, d, toasts };
}

test('CANON contact editor opens through the canonical customer UI instead of the legacy guard', () => {
  const h = contactHarness({ canonicalOn: true });
  h.ctx.NAReceiptUI.editContact('C-1');
  assert.deepEqual(h.toasts, []);
  assert.equal(h.d.nodes.get('naCustomerContact').classList.contains('open'), true);
  assert.equal(h.d.nodes.get('naContactName').value, 'Luis');
  assert.match(h.d.nodes.get('naContactStatus').textContent, /CANON[\s\S]*DNI \(8 dígitos\) o RUC \(11 dígitos\)/);
});

test('a user lock on Clientes still blocks the CANON contact editor', () => {
  const h = contactHarness({ canonicalOn: true, userLock: true });
  h.ctx.NAReceiptUI.editContact('C-1');
  assert.deepEqual(h.toasts, [['Clientes está protegido', 'error']]);
  assert.equal(h.d.nodes.get('naCustomerContact'), undefined);
});

test('the guard still protects CANON from non-canonical customer UIs', () => {
  const h = contactHarness({ canonicalOn: true });
  assert.equal(h.ctx.isModuleLocked('clientes'), true);
  assert.equal(h.ctx.isModuleLocked('clientes', { canonicalCustomerUi: true }), false);
});

function bridgeHarness({ lineValue = '', policyResult = true, createFails = false } = {}) {
  const d = dom();
  for (const [id, v] of [['cNombre', 'Ana Pérez'], ['cDni', ''], ['cTel', ''], ['cDir', ''], ['cLinea', lineValue]]) { const n = d.el('input'); n.id = id; n.value = v; }
  const calls = [];
  const toasts = [];
  const ctx = vm.createContext({ ...docHelpers,
    document: d.document, console,
    toast: (m, t) => toasts.push([m, t]),
    cerrarModal: id => calls.push(['close', id]),
    _naCashierSnapshot: () => ({ id: 'K-1', nombre: 'Rosa' }),
    cajEstado: { cajeroId: 'K-1' }, appConfig: {},
    NuevoAmanecerCanonical: {
      enabled: () => true, pendingSnapshot: () => null, refresh: async () => { calls.push(['refresh']); return {}; },
      snapshot: () => ({ customers: [] }),
      createCustomer: async input => { calls.push(['customer.create', input]); if (createFails) throw new Error('CANONICAL_READ_500'); return { status: 'created', operation_id: 'op-1', customer_id: 'C-NEW' }; },
    },
    NuevoAmanecerCanonicalCustomerCreditPolicyBridge: { saveManual: async input => { calls.push(['credit-policy', input]); return policyResult; } },
  });
  ctx.globalThis = ctx;
  vm.runInContext(bridgeSrc, ctx);
  return { ctx, d, calls, toasts };
}

test('new customer with a credit line: create first, then the existing credit-policy command, then reset form', async () => {
  const h = bridgeHarness({ lineValue: '40' });
  assert.equal(await h.ctx.NuevoAmanecerCanonicalCustomerBridge.save(), true);
  const kinds = h.calls.map(c => c[0]);
  assert.ok(kinds.indexOf('customer.create') < kinds.indexOf('credit-policy'));
  const policy = h.calls.find(c => c[0] === 'credit-policy')[1];
  assert.equal(policy.customer_id, 'C-NEW');
  assert.equal(policy.manual_limit_cents, 4000);
  assert.equal(policy.administrator_name, 'Rosa');
  assert.ok(!('operation_id' in policy), 'the policy bridge/client mints its own operation_id');
  for (const id of ['cNombre', 'cDni', 'cTel', 'cDir', 'cLinea']) assert.equal(h.d.nodes.get(id).value, '', id + ' must be cleared after save');
});

test('empty credit line keeps the automatic line and sends no policy command', async () => {
  const h = bridgeHarness();
  assert.equal(await h.ctx.NuevoAmanecerCanonicalCustomerBridge.save(), true);
  assert.equal(h.calls.some(c => c[0] === 'credit-policy'), false);
});

test('invalid credit line is rejected before any canonical command', async () => {
  const h = bridgeHarness({ lineValue: '-5' });
  assert.equal(await h.ctx.NuevoAmanecerCanonicalCustomerBridge.save(), false);
  assert.equal(h.calls.some(c => c[0] === 'customer.create'), false);
  assert.match(h.toasts.at(-1)[0], /Línea de crédito inválida/);
  assert.equal(h.d.nodes.get('cNombre').value, 'Ana Pérez', 'keeps typed data so the user can fix it');
});

test('failed credit line after a confirmed customer is reported, never retried as a new customer', async () => {
  const h = bridgeHarness({ lineValue: '25.50', policyResult: false });
  assert.equal(await h.ctx.NuevoAmanecerCanonicalCustomerBridge.save(), true);
  assert.equal(h.calls.filter(c => c[0] === 'customer.create').length, 1);
  assert.equal(h.calls.find(c => c[0] === 'credit-policy')[1].manual_limit_cents, 2550);
  assert.match(h.toasts.at(-1)[0], /Cliente registrado, pero la línea de crédito NO se guardó/);
});

test('failed customer.create never applies a credit line and keeps the form', async () => {
  const h = bridgeHarness({ lineValue: '40', createFails: true });
  assert.equal(await h.ctx.NuevoAmanecerCanonicalCustomerBridge.save(), false);
  assert.equal(h.calls.some(c => c[0] === 'credit-policy'), false);
  assert.equal(h.d.nodes.get('cLinea').value, '40');
});

test('closing the new-customer form clears it', () => {
  const h = bridgeHarness({ lineValue: '40' });
  const click = h.d.listeners.find(([type]) => type === 'click')[1];
  click({ target: { closest: sel => sel.includes('#mCli .mbtn-cancel') ? {} : null } });
  for (const id of ['cNombre', 'cLinea']) assert.equal(h.d.nodes.get(id).value, '');
});

test('new-customer form exposes the optional credit line field and opening resets it', () => {
  const html = fs.readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="mCli"[\s\S]*?Línea de crédito \(opcional\)[\s\S]*?id="cLinea"/);
  const inline01 = fs.readFileSync(new URL('../../POS/js/legacy-inline/inline-01.js', import.meta.url), 'utf8');
  assert.match(inline01, /function _naResetClienteForm\(\)\{\['cNombre','cDni','cTel','cDir','cLinea'\]/);
  assert.match(inline01, /function abrirModalCli\(\)\{[^}]*_naResetClienteForm\(\)/);
});

// DNI/RUC + dirección in the same "Datos del cliente" form (CANON customer.contact.set, migration 0023).
function identityHarness({ setResult, pendingAfter = null } = {}) {
  const d = dom();
  const toasts = [], calls = [];
  let pending = null;
  const ctx = vm.createContext({ ...docHelpers,
    document: d.document, console,
    clientes: [{ id: 'C-1', nombre: 'Luis', tel: '', dni: '12345678', dir: 'Jr. Uno 1' }, { id: 'C-2', nombre: 'Rosa Bodega', tel: '', dni: '20111111111', dir: '' }],
    toast: (m, t) => toasts.push([m, t]),
    isModuleLocked: () => false,
    NAReceiptShare: { normalizePhone: (v) => String(v || '').replace(/\D/g, '') || null },
    NuevoAmanecerCanonical: {
      enabled: () => true, refresh: async () => ({}), pendingSnapshot: () => pending,
      discardRejectedCustomerContact: async () => { calls.push(['discard']); pending = null; return true; },
      setCustomerContact: async (input) => { calls.push(['set', input]); if (setResult) { pending = setResult(input); throw new Error('CANONICAL_FINANCIAL_REJECTED_409'); } return { status: 'created' }; },
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(contactUi, ctx);
  return { ctx, d, toasts, calls, set: (id, v) => { d.nodes.get(id).value = v; } };
}

test('contact form shows and saves DNI/RUC + address; unchanged identity is not sent', async () => {
  const h = identityHarness();
  h.ctx.NAReceiptUI.editContact('C-1');
  assert.equal(h.d.nodes.get('naContactDoc').value, '12345678');
  assert.equal(h.d.nodes.get('naContactAddress').value, 'Jr. Uno 1');
  h.set('naContactName', 'Luis Nuevo');
  await h.d.nodes.get('naContactSave').onclick();
  const first = h.calls.find((c) => c[0] === 'set')[1];
  assert.equal(JSON.stringify(first), JSON.stringify({ customer_id: 'C-1', name: 'Luis Nuevo', phone: null }), 'name-only edit sends no identity');
  h.ctx.NAReceiptUI.editContact('C-1');
  h.set('naContactDoc', '20 123.456-789'); h.set('naContactAddress', '  Av.  Sungaro  45 ');
  await h.d.nodes.get('naContactSave').onclick();
  const second = h.calls.filter((c) => c[0] === 'set')[1][1];
  assert.equal(second.document, '20123456789');
  assert.equal(second.address, 'Av. Sungaro 45');
  h.ctx.NAReceiptUI.editContact('C-1');
  h.set('naContactDoc', ''); h.set('naContactAddress', '');
  await h.d.nodes.get('naContactSave').onclick();
  const third = h.calls.filter((c) => c[0] === 'set')[2][1];
  assert.equal(third.document, null);
  assert.equal(third.address, null);
});

test('invalid or locally duplicated DNI/RUC is refused before any command, naming the other customer', async () => {
  const h = identityHarness();
  h.ctx.NAReceiptUI.editContact('C-1');
  h.set('naContactDoc', '1234567');
  await h.d.nodes.get('naContactSave').onclick();
  assert.match(h.toasts.at(-1)[0], /DNI\/RUC inválido: el DNI tiene 8 dígitos y el RUC 11/);
  h.set('naContactDoc', '20111111111');
  await h.d.nodes.get('naContactSave').onclick();
  assert.match(h.toasts.at(-1)[0], /El RUC 20111111111 ya pertenece a «Rosa Bodega»/);
  assert.equal(h.calls.length, 0);
});

test('server document conflict names the other customer and discards the rejected edit', async () => {
  const h = identityHarness({ setResult: (input) => ({ command: 'customer.contact.set', state: 'PENDING', payload: input, last_status: 409, last_error: 'customer_document_conflict', last_conflict: { customer_id: 'C-9', customer_name: 'Otro Equipo SAC' } }) });
  h.ctx.NAReceiptUI.editContact('C-1');
  h.set('naContactDoc', '20999999999');
  await h.d.nodes.get('naContactSave').onclick();
  assert.match(h.d.nodes.get('naContactStatus').textContent, /El RUC 20999999999 ya pertenece a «Otro Equipo SAC»\. No se guardaron los cambios\./);
  assert.ok(h.calls.some((c) => c[0] === 'discard'));
});
