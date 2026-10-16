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

test('hueco desde el primer pintado: <head> reserva el mismo alto que el hueco real (alto + márgenes + gap de 12 px) solo con dueño guardado', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
  const loader = fs.readFileSync(new URL('../../POS/js/modules/asistente/asistente-loader.js', import.meta.url), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /localStorage\.getItem\('na_asistente_proto'\)==='1'&&localStorage\.getItem\('na_asistente_acc'\)==='owner'/);
  // 320+4+16+12, 300+4+18+12, 292+4+18+12
  for (const [px, q] of [[352, ''], [334, '@media (min-width:700px)'], [326, '@media (min-width:1100px)']]) assert.ok(head.includes((q ? q + '{' : '') + 'html.na-asst-pre #pageMenu .main-scroll>.quick-stats{margin-top:' + px + 'px}'), String(px));
  assert.match(loader, /height:320px;margin:4px 0 16px/); assert.match(loader, /@media \(min-width:700px\)\{#naAsstHero\{height:300px;margin:4px 0 18px\}\}@media \(min-width:1100px\)\{#naAsstHero\{height:292px\}\}/);
  assert.match(loader, /classList\.remove\('na-asst-pre'\)/, 'el hueco real reemplaza al margen');
  assert.match(loader, /function release\(\)[^\n]*classList\.remove\('na-asst-owner', 'na-asst-pre'\)/, 'al liberar se quita todo');
  assert.equal((html.match(/asistente-loader\.js" defer/g) || []).length, 1);
});

// DOM mínimo para probar el aviso neutro (sin librerías).
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.parent = null; const self = this;
    this.classList = { set: new Set(), add(...c) { c.forEach((x) => this.set.add(x)); self.attrs.class = [...this.set].join(' '); }, remove(...c) { c.forEach((x) => this.set.delete(x)); self.attrs.class = [...this.set].join(' '); }, contains(c) { return this.set.has(c); } }; }
  get firstChild() { return this.children[0] || null; }
  get attributes() { return Object.keys(this.attrs).map((name) => ({ name })); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); this.attrs.class = v; } get className() { return this.attrs.class || ''; }
  set id(v) { this.attrs.id = v; } get id() { return this.attrs.id; }
  set textContent(v) { this.children = []; this._text = String(v); } get textContent() { return (this._text || '') + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); } removeAttribute(k) { delete this.attrs[k]; if (k === 'class') this.classList.set = new Set(); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; } removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}
function domRun({ status, body }) {
  const store = new Map([['na_asistente_proto', '1'], ['na_asistente_acc', 'owner'], ['na_cloud_sync_credentials', JSON.stringify({ endpoint: 'https://w.example', token: 't' })]]);
  const html = new El('html'), head = new El('head'), bodyEl = new El('body'), menu = new El('section'); menu.id = 'pageMenu'; menu.classList.add('page', 'active');
  const scroll = new El('div'); scroll.className = 'main-scroll'; const qs = new El('div'); qs.className = 'quick-stats'; menu.appendChild(scroll); scroll.appendChild(qs); bodyEl.appendChild(menu);
  const observers = [];
  const byId = (id) => [head, bodyEl, ...head.all(), ...bodyEl.all()].find((e) => e.id === id) || null;
  scroll.querySelector = () => qs; scroll.insertBefore = (n, ref) => { n.parent = scroll; scroll.children.splice(Math.max(0, scroll.children.indexOf(ref)), 0, n); return n; };
  menu.querySelector = () => scroll;
  const document = { readyState: 'complete', hidden: false, documentElement: html, head, body: bodyEl, createElement: (t) => new El(t), getElementById: byId, addEventListener() {} };
  const window = { location: { search: '?asistente=1' }, document, navigator: { onLine: true }, performance: { mark() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    requestIdleCallback: () => {}, addEventListener() {}, AbortController,
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } },
    fetch: async () => ({ status, json: async () => body }) };
  vm.runInNewContext(SRC, { window, URLSearchParams, setTimeout, clearTimeout, Date, JSON, String, Array });
  return { window, document, menu, html, store, observers, byId };
}

test('servidor dice «no dueño» con la tarjeta puesta: TODO su contenido sale del DOM al instante; queda un aviso del mismo alto sin datos ni botones; se libera al salir de Inicio', async () => {
  const r = domRun({ status: 200, body: { ok: true, role: 'empleado:consultas', level: 'consultas' } });
  const slot = r.byId('naAsstHero'); assert.ok(slot, 'hueco reservado por el rol guardado');
  // la UI ya había pintado la tarjeta del dueño: título, datos, campo y atajos
  for (const [tag, txt] of [['h2', 'Asistente Nuevo Amanecer'], ['p', 'Hola Carlos, dueño · S/ 1,234.50 en caja'], ['input', ''], ['button', '¿Qué falta reponer?'], ['a', 'Ver ventas']]) { const e = new El(tag); e.textContent = txt; slot.appendChild(e); }
  slot.setAttribute('data-mode', 'owner'); slot.setAttribute('aria-label', 'Asistente');
  r.window.NA_ASISTENTE_SLOT.unreserve(); // lo mismo que hace el cargador al recibir el ping
  const same = r.byId('naAsstHero');
  assert.equal(same, slot, 'el hueco sigue (mismo alto: no mueve la pantalla)');
  assert.deepEqual(slot.all().map((e) => e.tagName), ['P'], 'solo el aviso; ningún botón, enlace ni campo');
  assert.equal(slot.textContent, 'El asistente no está disponible en este aparato.');
  assert.ok(!/Carlos|1,234|reponer|ventas|Asistente Nuevo/.test(slot.textContent), 'sin datos del dueño');
  assert.deepEqual(Object.keys(slot.attrs).sort(), ['class', 'id', 'role'], 'sin data-mode ni otros restos');
  assert.equal(slot.className, 'na-asst-gone');
  // al salir de Inicio se libera
  r.menu.classList.remove('active'); r.observers.forEach((o) => !o.off && o.cb());
  assert.equal(r.byId('naAsstHero'), null); assert.equal(r.html.classList.contains('na-asst-owner'), false);
});

test('el aviso neutro tiene el MISMO alto que la tarjeta (regla #naAsstHero) y la UI vacía la tarjeta por el cargador', () => {
  assert.match(SRC, /#naAsstHero\.na-asst-gone\{display:flex/); assert.ok(!/#naAsstHero\.na-asst-gone\{[^}]*height/.test(SRC), 'no cambia el alto');
  const ui = readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /if \(Sx && Sx\.unreserve\) Sx\.unreserve\(\)/);
  assert.match(ui, /var IDLE_MS = 9000/); assert.match(ui, /root\.addEventListener\('scroll', hold, \{ passive: true, capture: true \}\)/);
  assert.match(ui, /thinking\.remove\(\); wake\(\);/);
});
