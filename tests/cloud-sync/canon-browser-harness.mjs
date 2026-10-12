// Test-only harness: real Worker + in-memory SQLite (D1 contract) + the real
// browser scripts (canonical-client, UI adapter, bridges) evaluated in a VM
// context that behaves like one POS tab/device. Synthetic data only.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import { a6Fixture, response } from './a6-fixture.mjs';
import { webLocks } from './web-locks-sim.mjs';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
export const SOURCES = {
  client: read('POS/js/sync/canonical-client.js'),
  adapter: read('POS/js/adapters/canonical-ui-adapter.js'),
};

const ACTIVE_MIGRATIONS = [
  '0008_canonical_commerce.sql',
  '0009_canonical_financial.sql',
  '0011_canonical_session_runtime.sql',
  '0012_credit_accounts_v2.sql',
  '0013_canonical_expenses.sql',
];

export async function activeCanon(t, { migrations = [] } = {}) {
  const f = await a6Fixture(t);
  await response(await f.freeze(), 201);
  await response(await f.promote(), 201);
  // Test-only transition; production activation remains separately gated.
  f.database.exec('DROP TRIGGER canonical_control_no_legacy');
  f.exec("UPDATE canonical_control SET mode='ACTIVE',revision=revision+1,authority_epoch=authority_epoch+1,minimum_client_contract='a6-gate-c-v1' WHERE id=1");
  for (const name of [...ACTIVE_MIGRATIONS, ...migrations]) f.database.exec(read('infra/database/migrations/' + name));
  return f;
}

export function storage(initial) {
  const values = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
    dump() { return Object.fromEntries(values); },
  };
}

function element(id, value = '') {
  return {
    id, value, textContent: '', disabled: false, hidden: false, checked: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    focus() {}, setAttribute() {}, removeAttribute() {}, append() {}, replaceChildren() {}, querySelector() { return null; },
  };
}

// One VM context == one browser tab. `localStorage` survives F5 when reused.
export async function device(f, { token, deviceId, localStorage = storage(), scripts = [], globals = {}, onFetch } = {}) {
  if (deviceId) f.addDevice(deviceId, 'writer', 'active', token);
  const ids = new Map();
  const toasts = [];
  const listeners = new Map();
  const fetchLog = [];
  const document = {
    getElementById(id) { if (!ids.has(id)) ids.set(id, element(id)); return ids.get(id); },
    querySelector() { return null; }, querySelectorAll() { return []; }, createElement: (tag) => element(tag), addEventListener() {},
  };
  const context = vm.createContext({
    URL, console, Headers, Request, Response, TextEncoder, TextDecoder, setTimeout, clearTimeout, AbortController,
    crypto: { ...webcrypto, randomUUID }, localStorage, sessionStorage: storage(), document,
    location: { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:' },
    navigator: { onLine: true, locks: webLocks() },
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach((fn) => fn(event)); return true; },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    async fetch(url, options = {}) {
      const { cache, signal, ...rest } = options; void cache;
      fetchLog.push({ url: String(url), method: rest.method || 'GET', body: rest.body });
      const abortError = () => { const error = new Error('The operation was aborted.'); error.name = 'AbortError'; return error; };
      if (signal && signal.aborted) throw abortError();
      const work = (async () => {
        if (onFetch) { const hooked = await onFetch(String(url), rest, () => f.fetch(url, rest)); if (hooked) return hooked; }
        return f.fetch(url, rest);
      })();
      if (!signal) return work;
      // Like a browser: abort rejects the caller, the server may still commit.
      return Promise.race([work, new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))]);
    },
    ...globals,
  });
  context.globalThis = context;
  context.window = context;
  // Mirrors inline-01: toast/cerrarModal are top-level `const` (NOT window props).
  vm.runInContext(`const toast=(m,t)=>globalThis.__toasts.push([m,t||'']);const cerrarModal=(id)=>globalThis.__closed.push(id);`, context);
  context.__toasts = toasts;
  context.__closed = [];
  vm.runInContext(SOURCES.client, context, { filename: 'canonical-client.js' });
  vm.runInContext(SOURCES.adapter, context, { filename: 'canonical-ui-adapter.js' });
  for (const [name, source] of scripts) vm.runInContext(source, context, { filename: name });
  const api = context.NuevoAmanecerCanonical;
  if (!localStorage.getItem('na_canonical_binding')) {
    const c = f.control();
    await api.configure({ endpoint: 'http://localhost', promotion_id: c.active_promotion_id, authority_epoch: c.authority_epoch, revision: c.revision, token });
  }
  await api.refresh();
  return { context, api, localStorage, ids, toasts, fetchLog, el: (id) => document.getElementById(id) };
}
