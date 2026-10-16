// El cargador no baja NADA del asistente (ni JS ni CSS) si el servidor dice que el aparato no lo tiene (empleado en Apagado).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../POS/js/modules/asistente/asistente-loader.js', import.meta.url), 'utf8');
function run({ status, body, online = true, cache = {}, search = '?asistente=1', creds = true, fail = false, slot0 = false }) {
  const store = new Map(Object.entries(cache)); if (creds) store.set('na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://w.example', token: 't0k' }));
  const added = [], calls = [], listeners = {};
  const mk = (tag) => ({ tag, set src(v) { this._src = v; added.push(v); }, get src() { return this._src; }, set href(v) { this._href = v; added.push(v); }, get href() { return this._href; } });
  const slot = { removed: false, remove() { this.removed = true; delete ids.naAsstHero; } };
  const ids = slot0 ? { naAsstHero: slot } : {};
  const cls = new Set();
  const document = { readyState: 'complete', hidden: false, documentElement: { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } }, createElement: mk, getElementById: (id) => ids[id] || null, head: { appendChild: (e) => { if (e.id) ids[e.id] = e; return e; } }, body: { appendChild: (e) => { if (e.onload) e.onload(); return e; } }, addEventListener: () => {} };
  const window = {
    location: { search }, document, navigator: { onLine: online },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    requestIdleCallback: (f) => f(), addEventListener: (n, f) => { listeners[n] = f; }, AbortController,
    fetch: async (url, init) => { calls.push({ url, init }); if (fail) throw new Error('red'); return { status, json: async () => body }; },
  };
  vm.runInNewContext(SRC, { window, URLSearchParams, setTimeout, clearTimeout, Date, JSON, String });
  return { added, calls, store, window, slot };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const ASSETS = ['css/asistente.css', 'js/modules/asistente/asistente-core.js', 'js/modules/asistente/asistente-ui.js'];

test('empleado en Apagado: 1 ping (~14 bytes de cuerpo, sin modelo) y 0 archivos del asistente', async () => {
  const r = run({ status: 403, body: { error: 'assistant_off' } }); await tick();
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].url, 'https://w.example/auth/assistant/chat');
  assert.equal(r.calls[0].init.body, '{"ping":true}'); assert.equal(r.calls[0].init.headers.authorization, 'Bearer t0k'); assert.equal(r.calls[0].init.credentials, 'omit');
  assert.deepEqual(r.added, [], 'no se carga ni JS ni CSS del asistente');
  assert.equal(r.store.get('na_asistente_acc'), undefined);
});

test('dueño: carga css + core + ui y recuerda el rol; empleado con nivel: también (solo burbuja)', async () => {
  const o = run({ status: 200, body: { ok: true, role: 'owner', level: null } }); await tick();
  assert.deepEqual(o.added, ASSETS); assert.equal(o.store.get('na_asistente_acc'), 'owner');
  const e = run({ status: 200, body: { ok: true, role: 'empleado:consultas', level: 'consultas' } }); await tick();
  assert.deepEqual(e.added, ASSETS); assert.equal(e.store.get('na_asistente_acc'), 'on');
});

test('aparato sin rol (403 reason sin_rol): carga para mostrar «Registrar este teléfono como dueño»', async () => {
  const r = run({ status: 403, body: { error: 'admin_only', reason: 'sin_rol' } }); await tick();
  assert.deepEqual(r.added, ASSETS);
});

test('revocado: si antes era «on» y ahora el servidor dice 403, se borra lo guardado y no se carga', async () => {
  const r = run({ status: 403, body: { error: 'assistant_off' }, cache: { na_asistente_acc: 'on' } }); await tick();
  assert.deepEqual(r.added, []); assert.equal(r.store.has('na_asistente_acc'), false);
});

test('sin internet: solo el último dueño confirmado carga (para «Asistente no disponible sin internet»); empleado nada', async () => {
  const o = run({ status: 0, body: {}, online: false, cache: { na_asistente_acc: 'owner' } }); await tick();
  assert.deepEqual(o.added, ASSETS); assert.equal(o.calls.length, 0);
  const e = run({ status: 0, body: {}, online: false, cache: { na_asistente_acc: 'on' } }); await tick();
  assert.deepEqual(e.added, []);
  const n = run({ status: 0, body: {}, fail: true }); await tick();
  assert.deepEqual(n.added, [], 'red caída y sin rol guardado: nada');
});

test('sin ?asistente=1 no hay ni ping', async () => {
  const r = run({ status: 200, body: { ok: true, role: 'owner' }, search: '' }); await tick();
  assert.equal(r.calls.length, 0); assert.deepEqual(r.added, []);
});

test('hueco de la tarjeta: si el último ping decía dueño y ahora dice empleado o apagado, el hueco se quita enseguida', async () => {
  const e = run({ status: 403, body: { error: 'assistant_off' }, cache: { na_asistente_acc: 'owner' }, slot0: true }); await tick();
  assert.equal(e.slot.removed, true); assert.deepEqual(e.added, []);
  const on = run({ status: 200, body: { ok: true, role: 'empleado:consultas', level: 'consultas' }, cache: { na_asistente_acc: 'owner' }, slot0: true }); await tick();
  assert.equal(on.slot.removed, true, 'empleado encendido: solo burbuja, sin tarjeta');
  const o = run({ status: 200, body: { ok: true, role: 'owner' }, cache: { na_asistente_acc: 'owner' }, slot0: true }); await tick();
  assert.equal(o.slot.removed, false, 'dueño: el hueco queda para la tarjeta');
});
