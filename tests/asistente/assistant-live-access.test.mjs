// Permiso que cambia con la app abierta (Bot 3, 4 y 5 sobre 50b6716b): el cargador vuelve a preguntar al ENTRAR A INICIO y al reconectar
// (máx. una vez cada 10 s), el empleado en Apagado sigue sin bajar nada hasta que el servidor diga «sí»; la UI quita burbuja/panel con un 403
// de permiso; y la cuenta del relleno bajo la burbuja (C.padOverlap) con los números que midió Bot 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');
const LOADER = readFileSync(new URL('../../POS/js/modules/asistente/asistente-loader.js', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
const ASSETS = ['css/asistente.css', 'js/modules/asistente/asistente-core.js', 'js/modules/asistente/asistente-ui.js'];

// Cargador con Inicio (#pageMenu) que se activa/desactiva, reloj y respuestas del servidor controlados.
function loader({ replies, cache = {} }) {
  let T = 1_000_000; const store = new Map(Object.entries(cache)); store.set('na_asistente_proto', '1');
  const added = [], calls = [], listeners = {}, observers = [];
  const menuCls = new Set(['active']);
  const menu = { classList: { contains: (c) => menuCls.has(c), add: (c) => menuCls.add(c), remove: (c) => menuCls.delete(c) }, querySelector: () => null };
  const mk = (tag) => ({ tag, set src(v) { added.push(v); }, set href(v) { added.push(v); } });
  const document = { readyState: 'complete', hidden: false, documentElement: { classList: { add() {}, remove() {} } }, createElement: mk,
    getElementById: (id) => (id === 'pageMenu' ? menu : null), head: { appendChild() {} }, body: { appendChild: (e) => { if (e.onload) e.onload(); } },
    addEventListener: (n, f) => { listeners['doc:' + n] = f; } };
  class MO { constructor(f) { this.f = f; observers.push(this); } observe() {} disconnect() { this.f = null; } }
  const window = { location: { search: '' }, document, navigator: { onLine: true }, MutationObserver: MO,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    requestIdleCallback: (f) => f(), addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); }, AbortController,
    fetch: async (url, init) => { calls.push({ url, init }); const r = replies.shift() || { status: 403, body: { error: 'assistant_off' } }; if (r.fail) throw new Error('red'); return { status: r.status, json: async () => r.body }; } };
  vm.runInNewContext(LOADER, { window, URLSearchParams, setTimeout, clearTimeout, Date: { now: () => T }, JSON, String, Array });
  const flip = () => { observers.forEach((o) => o.f && o.f()); };
  return { added, calls, store, window, fire: (n) => (listeners[n] || []).forEach((f) => f()), advance: (ms) => { T += ms; },
    leaveInicio: () => { menuCls.delete('active'); flip(); }, enterInicio: () => { menuCls.add('active'); flip(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('Apagado -> el dueño lo enciende: al ENTRAR A INICIO (>= 10 s después) se pregunta otra vez y recién ahí se baja el asistente', async () => {
  const L = loader({ replies: [{ status: 403, body: { error: 'assistant_off' } }, { status: 200, body: { ok: true, role: 'empleado', level: 'consultas' } }] });
  await tick(); assert.equal(L.calls.length, 1); assert.deepEqual(L.added, [], 'Apagado: 0 archivos del asistente');
  L.advance(4000); L.leaveInicio(); L.enterInicio(); await tick();
  assert.equal(L.calls.length, 1, 'antes de 10 s no se vuelve a preguntar'); assert.deepEqual(L.added, []);
  L.advance(6500); L.leaveInicio(); L.enterInicio(); await tick();
  assert.equal(L.calls.length, 2); assert.equal(L.calls[1].init.body, '{"ping":true}');
  assert.deepEqual(L.added, ASSETS, 'el servidor dijo «sí»: recién ahora css + core + ui'); assert.equal(L.store.get('na_asistente_acc'), 'on');
});

test('reconectar: si se cortó internet, al volver se pregunta ENSEGUIDA (sin esperar 10 s); un pedido fallido tampoco cuenta', async () => {
  const L = loader({ replies: [{ status: 403, body: { error: 'assistant_off' } }, { status: 200, body: { ok: true, role: 'empleado', level: 'consultas' } }] });
  await tick(); assert.equal(L.calls.length, 1);
  L.advance(1500); L.fire('online'); await tick(); assert.equal(L.calls.length, 1, 'un «online» suelto dentro de 10 s no repite');
  L.window.navigator.onLine = false; L.fire('offline'); L.advance(500); L.window.navigator.onLine = true; L.fire('online'); await tick();
  assert.equal(L.calls.length, 2); assert.deepEqual(L.added, ASSETS);
  const F = loader({ replies: [{ fail: true }, { status: 403, body: { error: 'assistant_off' } }] });
  await tick(); assert.equal(F.calls.length, 1); F.advance(800); F.fire('online'); await tick();
  assert.equal(F.calls.length, 2, 'sin respuesta: al reconectar se pregunta otra vez'); assert.deepEqual(F.added, []);
});

test('entrar a Inicio sin cambios: sigue Apagado y sigue sin bajar nada; ya cargado, el cargador deja de mirar Inicio (lo hace la UI)', async () => {
  const L = loader({ replies: [] });
  await tick(); for (let i = 0; i < 3; i++) { L.advance(11000); L.leaveInicio(); L.enterInicio(); await tick(); }
  assert.equal(L.calls.length, 4); assert.deepEqual(L.added, []);
  assert.match(LOADER, /var ASK_EVERY_MS = 10000, ASK_TIMEOUT_MS = 3000;/); assert.doesNotMatch(LOADER, /< 30000/);
  assert.match(LOADER, /if \(now && !was\) \{ if \(loaded\) mo\.disconnect\(\); else ask\(\); \}/);
});

test('UI: 403 assistant_off / forbidden_role / admin_only en chat o confirm quita panel, burbuja y tarjeta, borra el rol guardado y avisa neutro', () => {
  assert.match(UI, /var ACCESS_LOST = \{ assistant_off: 1, forbidden_role: 1, admin_only: 1 \}, OFF_NOTICE = 'El asistente fue desactivado por el dueño';/);
  // aviso con el toast del POS SIN tipo (sin color de error) y sin emoji
  assert.match(UI, /function posNotice\(msg\) \{ try \{ if \(typeof root\.toast === 'function'\) root\.toast\(msg\); \} catch \(_\) \{\} \}/);
  assert.doesNotMatch('El asistente fue desactivado por el dueño', /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u);
  // se QUITAN del DOM (no solo se ocultan) y se borra el rol guardado: un recargo no reserva hueco
  const drop = UI.slice(UI.indexOf('function dropUi()'), UI.indexOf('function accessLost('));
  assert.match(drop, /if \(panelEl\) panelEl\.remove\(\); if \(rootEl\) rootEl\.remove\(\);/); assert.match(drop, /padded\.forEach\(unpad\)/);
  const lost = UI.slice(UI.indexOf('function accessLost('), UI.indexOf('function levelLowered('));
  assert.match(lost, /root\.localStorage\.removeItem\('na_asistente_acc'\)/); assert.match(lost, /dropUi\(\); renderHero\(\);/);
  assert.match(lost, /if \(code === 'assistant_off'\) posNotice\(OFF_NOTICE\);/);
  assert.match(lost, /else \{ adminOff = false; lastPing = 0; refreshAccess\(\); \}/, 'rol cambiado: se pregunta el nuevo enseguida');
  // en el chat y en el confirm
  assert.match(UI, /if \(!d\.ok && ACCESS_LOST\[d\.error\]\) \{ accessLost\(d\.error\); return; \}/);
  assert.match(UI, /if \(r && ACCESS_LOST\[r\.code\]\) \{ accessLost\(r\.code\); return; \}/);
  // la burbuja se puede volver a armar sin duplicar escuchas de la ventana
  assert.match(UI, /if \(wired\) return; wired = true;/);
});

test('UI: 403 forbidden_document deja el panel abierto, quita las tarjetas de documento y baja el nivel guardado', () => {
  const f = UI.slice(UI.indexOf('function levelLowered('), UI.indexOf('var ERRORS = {'));
  assert.match(f, /access\.level === 'consultas_documentos'\) access\.level = 'consultas';/);
  assert.match(f, /\.na-asst-card\[data-type="documento"\]/); assert.match(f, /c\.remove\(\)/); assert.match(f, /doc\.querySelector\('\.na-asst-doc'\)/);
  assert.doesNotMatch(f, /closePanel|dropUi/); assert.match(f, /syncPanelForAccess\(\);/);
  assert.match(UI, /if \(!d\.ok && d\.error === 'forbidden_document'\) \{ levelLowered\(\);/);
});

test('UI: re-chequeo del permiso al entrar a Inicio, al reconectar y al volver a la app (máx. 1 cada 10 s); sin permiso se quita la UI', () => {
  assert.match(UI, /var pinging = null, lastPing = 0, PING_EVERY_MS = 10000, PING_TIMEOUT_MS = 3000;/);
  assert.match(UI, /if \(opts && opts\.throttle && Date\.now\(\) - lastPing < PING_EVERY_MS\) return Promise\.resolve\(access\);/);
  assert.match(UI, /if \(menu\.classList\.contains\('active'\)\) idleRefresh\(\)/); assert.match(UI, /root\.addEventListener\('online', idleRefresh\);/);
  assert.match(UI, /function idleRefresh\(\) \{ \(root\.requestIdleCallback \|\|/); assert.match(UI, /PING_TIMEOUT_MS = 3000/);
  assert.match(UI, /post\('\/auth\/assistant\/chat', \{ ping: true \}, null, PING_TIMEOUT_MS\)/);
  assert.match(UI, /root\.addEventListener\('offline', function \(\) \{ lastPing = 0; renderHero\(\); \}\)/);
  assert.match(UI, /else if \(rootEl \|\| panelEl\) \{ dropUi\(\); if \(hadUi && offNow\) posNotice\(OFF_NOTICE\); \}/);
});

test('relleno bajo la burbuja (Bot 4, 360 px): Clientes con 3 filas «rebota» arriba; se pide lo que falta para seguir desplazable', () => {
  // Medido con el POS: vh 780, burbuja desde y=694 (limit = 694 - 12), última fila hasta y=732, documento 845 px con la página en 101 px de
  // relleno, cabecera que se achica 129 px al desplazar (NA_MOTION.scroll). Antes (104 px fijos) la fila quedaba debajo de la burbuja.
  const base = { vh: 780, limit: 682, rowBottom: 732, sy: 0, sh: 845, collapse: 129 };
  const over = C.padOverlap(base); assert.equal(over, 129 + 24 - 65);
  const pb = 101 + over + 8; assert.ok(pb >= 190 && pb <= 205, 'cerca de lo que probó Bot 4 (~200 px): ' + pb);
  // con ese relleno, desplazada al fondo con la cabecera achicada: la fila queda en vh - tail, por encima de la burbuja - 12
  const sh2 = 845 + over + 8, tail = sh2 - base.rowBottom; assert.ok(780 - tail <= 682, 'fila termina en ' + (780 - tail));
  assert.equal(C.padOverlap({ ...base, sh: sh2 }), 0, 'ya alcanza: no se agrega más');
  // lista larga (40 clientes): lo de debajo de la fila no cambia al desplazar; solo falta lo que la tapa
  assert.equal(C.padOverlap({ vh: 780, limit: 682, rowBottom: 4708, sy: 0, sh: 4807, collapse: 129 }), 0);
  assert.equal(C.padOverlap({ vh: 780, limit: 682, rowBottom: 4730, sy: 0, sh: 4807, collapse: 129 }), 21);
  // contenedor interno cuyo borde visible queda por encima de la burbuja: nunca la tapa
  assert.equal(C.padOverlap({ rowBottom: 900, limit: 682, sc: { visBottom: 650, rest: 0 } }), 0);
  assert.equal(C.padOverlap({ rowBottom: 760, limit: 682, sc: { visBottom: 780, rest: 40 } }), 38);
  // contenido corto que entra entero por encima de la burbuja: 0 (no se toca nada)
  assert.equal(C.padOverlap({ vh: 800, limit: 702, rowBottom: 398, sy: 0, sh: 800, collapse: 0 }), 0);
});

test('relleno: medido (no fijo), solo si tapa, nunca #pageMenu en tableta/PC, nada antes de saber el permiso, misma franja que la burbuja', () => {
  const pad = UI.slice(UI.indexOf('function padPage(bottom)'), UI.indexOf('function place()'));
  assert.match(pad, /shown = !!access && rootEl/); assert.match(pad, /if \(over <= 0\) return;/);
  assert.match(pad, /pg\.id === 'pageMenu' && root\.innerWidth >= 700\) \{ var ms = pg\.querySelector\('\.main-scroll'\); if \(!ms \|\| !scrollable\(ms\) \|\| !ms\.contains\(last\.el\)\) return; target = ms; \}/);
  assert.doesNotMatch(UI, /need = Math\.round\(h \+ bottom \+ 24\)/, 'ya no hay relleno fijo de 112 px');
  assert.match(UI, /if \(r\.right < x0 \|\| r\.left > x1\) continue;/);
  assert.match(UI, /root\.NA_MOTION\.scroll\.inspect\(pgId\(\)\)/, 'solo lectura de NA_MOTION');
});

test('ping del cargador: corto (3 s, AbortController), en un momento libre DESPUÉS de abrir el POS; con mala señal queda lo que había', async () => {
  // se corta a los 3 s: el fetch recibe la señal y se aborta; no se carga nada ni se borra lo guardado
  const T = 1_000_000; const timers = []; const store = new Map([['na_asistente_proto', '1'], ['na_asistente_acc', 'on']]); const added = []; let signal = null, idleUsed = false, loadCb = null;
  const document = { readyState: 'loading', hidden: false, documentElement: { classList: { add() {}, remove() {} } }, createElement: () => ({ set src(v) { added.push(v); }, set href(v) { added.push(v); } }),
    getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {} };
  const window = { location: { search: '' }, document, navigator: { onLine: true }, AbortController,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    requestIdleCallback: (f) => { idleUsed = true; f(); }, addEventListener: (n, f) => { if (n === 'load') loadCb = f; },
    fetch: (url, init) => { signal = init.signal; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))); } };
  const fakeSetTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
  vm.runInNewContext(LOADER, { window, URLSearchParams, setTimeout: fakeSetTimeout, clearTimeout: () => {}, Date: { now: () => T }, JSON, String, Array });
  assert.equal(signal, null, 'antes del load del POS no se pregunta nada'); assert.ok(loadCb);
  loadCb(); assert.ok(idleUsed, 'se agenda en un momento libre'); assert.ok(signal, 'recién ahora el ping');
  const abort = timers.find((x) => x.ms === 3000); assert.ok(abort, 'corte a los 3 s'); abort.f(); await tick();
  assert.equal(signal.aborted, true); assert.deepEqual(added, [], 'empleado: con mala señal no se baja nada'); assert.equal(store.get('na_asistente_acc'), 'on', 'falla: queda lo que había');
});
