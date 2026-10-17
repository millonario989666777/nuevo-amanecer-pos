// Respuesta en partes, segunda vuelta: aviso «buscando» mientras corre una búsqueda (Bot 3 a), tope duro de 90 s (Bot 3 b),
// datos del dueño fuera ANTES de cualquier trozo para el empleado (Bot 5) y la vista del chat mientras llega el texto (Bot 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assistantChatRoute, createMemoryUsageStore, createStatusBeat, employeeQueryResult, STATUS_EVERY_MS } from '../../tools/cloudflare-lab/src/pos-assistant.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');
const UI = readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../POS/css/asistente.css', import.meta.url), 'utf8');

const SECRET = 'secreto-de-prueba-0123456789abcdef';
const jsonR = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const delta = (d, fin) => sse({ choices: [{ delta: d, ...(fin ? { finish_reason: fin } : {}) }] });
// Trozos con pausa propia: [ms, texto]. Se respeta la señal de corte.
function stream(parts, { end = true } = {}) {
  let i = 0;
  return new ReadableStream({ async pull(c) { if (i < parts.length) { const [ms, t] = parts[i++]; if (ms) await sleep(ms); c.enqueue(enc.encode(t)); } else { if (end) c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } } });
}
const ev = (e, d) => 'event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n';
const sseResp = (body) => async (_u, init) => new Response(body(init), { status: 200, headers: { 'content-type': 'text/event-stream' } });
// DeepSeek de mentira con una respuesta distinta por llamada (la 1.ª pide la consulta, la 2.ª explica).
function dsSeq(seq, bodies) { let n = 0; return async (_url, init) => { bodies.push(init.body); const parts = seq[Math.min(n++, seq.length - 1)]; return new Response(stream(parts), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }; }
async function chat(body, { role = 'owner', fetch, reader, statusEveryMs } = {}) {
  return assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: SECRET, DEEPSEEK_API_KEY: 'k' }, { principalId: 'session:x', posRole: role === 'owner' ? 'owner' : 'empleado' }, jsonR,
    { store: createMemoryUsageStore(), resolveRole: async () => role, fetch, reader, audit: async () => {}, statusEveryMs });
}
async function events(r) {
  const t0 = Date.now(), out = []; const p = C.createSseParser((e, d) => out.push({ ev: e, d, ms: Date.now() - t0 }));
  const rd = r.body.getReader(), dec = new TextDecoder();
  for (;;) { const { value, done } = await rd.read(); if (done) break; p.feed(dec.decode(value, { stream: true })); }
  return out;
}
const READER = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: true, stock: 40, min: 5, precio: 4, costo: 3 }] };
const consulta = (id, tipo, extra = {}) => delta({ tool_calls: [{ index: 0, id, function: { name: 'consultar', arguments: JSON.stringify({ tipo, producto: 'Arroz', ...extra }) } }] });

// ---------- (a) aviso «buscando» ----------
test('a) servidor: herramienta antes de cualquier texto -> «status» enseguida y cada pocos segundos hasta el primer texto; nunca después de texto ni de final', async () => {
  const bodies = [];
  const first = [[0, consulta('c1', 'stock_producto')], [0, delta({}, 'tool_calls')]];
  const second = [[260, delta({ content: 'Tiene 40 unidades de Arroz, ' })], [20, delta({ content: 'está bien de stock.' })], [0, delta({}, 'stop')]];
  const r = await chat({ text: '¿cuánto arroz hay?', stream: true }, { fetch: dsSeq([first, second], bodies), reader: READER, statusEveryMs: 60 });
  const e = await events(r);
  const kinds = e.map((x) => x.ev), firstText = kinds.indexOf('text'), fin = kinds.indexOf('final');
  assert.equal(kinds[0], 'open'); assert.ok(firstText > 0 && fin > firstText, kinds.join(','));
  const st = e.filter((x) => x.ev === 'status');
  assert.ok(st.length >= 3, 'aviso al empezar y repetido mientras espera: ' + st.length);
  assert.deepEqual(st[0].d, { s: 'buscando' }); assert.ok(st[0].ms < 150, 'aviso enseguida: ' + st[0].ms);
  assert.ok(kinds.slice(firstText).every((k) => k !== 'status'), 'sin avisos después del primer texto');
  for (let i = 1; i < st.length; i++) assert.ok(st[i].ms - st[i - 1].ms < 200, 'cada aviso a tiempo (reloj del celular vuelve a cero)');
  assert.equal(e.at(-1).ev, 'final'); assert.match(e.at(-1).d.reply, /40 unidades/);
  assert.equal(STATUS_EVERY_MS < C.STREAM.idleMs / 2, true, 'el aviso llega mucho antes de los 30 s del celular');
});

test('a) servidor: si el texto ya empezó (o es demostración), no hay «status»; las puertas siguen en JSON', async () => {
  const args = JSON.stringify({ product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' });
  const parts = [[0, delta({ content: 'Preparé la salida de Arroz, revisa la tarjeta y pulsa Confirmar cuando estés listo, gracias. ' })], [0, delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'proponer_ajuste_stock', arguments: args } }] })], [0, delta({}, 'tool_calls')]];
  const r = await chat({ text: 'merma de 1 arroz', context: { products: [{ id: 'A', nombre: 'Arroz', precio: 4, stock: 40 }] }, stream: true }, { fetch: dsSeq([parts], []), reader: READER, statusEveryMs: 20 });
  const e = await events(r);
  assert.ok(!e.some((x) => x.ev === 'status'), e.map((x) => x.ev).join(','));
  assert.equal(e.at(-1).ev, 'final'); assert.equal(e.at(-1).d.proposals.length, 1);
});

test('a) createStatusBeat: solo sin texto, con freno de 1 s para los avisos por trozo de herramienta y se para', async () => {
  const sent = []; let n = 0; const fake = { send: (e, d) => sent.push([e, d]) }, emit = { sent: () => n };
  const b = createStatusBeat(fake, emit, 30);
  b.tick(true); b.tick(true); b.tick(true); assert.equal(sent.length, 1, 'freno para los trozos de herramienta');
  b.start(); await sleep(75); const k = sent.length; assert.ok(k >= 3, String(k));
  n = 5; await sleep(70); assert.equal(sent.length, k, 'con texto ya no avisa');
  n = 0; b.stop(); await sleep(70); assert.equal(sent.length, k, 'parado no avisa');
  assert.ok(sent.every(([e, d]) => e === 'status' && d.s === 'buscando'));
});

test('a) celular: los «status» vuelven a cero el reloj de 30 s (sin ellos se corta) y se avisan con onStatus', async () => {
  const keep = () => stream([[0, ev('open', { ok: true })], ...Array.from({ length: 6 }, () => [90, ev('status', { s: 'buscando' })]), [90, ev('text', { t: 'Hay 40.' })], [0, ev('final', { ok: true, reply: 'Hay 40.', proposals: [] })]], { end: false });
  let seen = 0;
  const ok = await C.streamChat(sseResp(keep), 'u', {}, { firstMs: 200, idleMs: 200, onStatus: (d) => { if (d.s === 'buscando') seen++; } });
  assert.equal(ok.timeout, null); assert.ok(ok.final); assert.equal(ok.text, 'Hay 40.'); assert.equal(seen, 6);
  const quiet = () => stream([[0, ev('open', { ok: true })], [600, ev('text', { t: 'tarde' })]], { end: false });
  const cut = await C.streamChat(sseResp(quiet), 'u', {}, { firstMs: 200, idleMs: 200 });
  assert.equal(cut.timeout, 'idle'); assert.equal(cut.final, null);
  assert.equal(C.STREAM.firstMs, 10000, 'se mantiene el primer byte a 10 s'); assert.equal(C.STREAM.idleMs, 30000);
});

test('a) celular: «Buscando en su inventario…» en la misma burbuja de «Pensando», solo si todavía no hay texto', () => {
  const sendFn = UI.slice(UI.indexOf('  async function send(text, image) {'), UI.indexOf('  // Comprime en el aparato'));
  assert.match(sendFn, /function searching\(\) \{ if \(bubble \|\|/); assert.match(sendFn, /'Buscando en su inventario'/); assert.match(sendFn, /onStatus: searching/);
});

// ---------- (b) tope de 90 s ----------
test('b) celular: tope duro por respuesta aunque sigan llegando trozos; queda el texto (Respuesta incompleta + Reintentar)', async () => {
  const endless = (init) => { let i = 0; return new ReadableStream({ async pull(c) { if (init.signal?.aborted) return c.close(); await sleep(40); c.enqueue(enc.encode(i++ ? ev('text', { t: 'p' + i + ' ' }) : ev('open', { ok: true }))); }, cancel() {} }); };
  const t0 = Date.now();
  const r = await C.streamChat(sseResp(endless), 'u', {}, { firstMs: 200, idleMs: 200, maxMs: 400 });
  const ms = Date.now() - t0;
  assert.equal(r.timeout, 'max'); assert.equal(r.cut, true); assert.equal(r.final, null);
  assert.ok(ms >= 380 && ms < 900, 'cortó al tope: ' + ms); assert.match(r.text, /^p2 p3 /, 'lo recibido se queda');
  assert.equal(C.STREAM.maxMs, 90000);
  const sendFn = UI.slice(UI.indexOf('  async function send(text, image) {'), UI.indexOf('  // Comprime en el aparato'));
  assert.match(sendFn, /else if \(st\.text && bubble && \(!st\.error[^\n]*incomplete\(bubble, text, image\)/, 'con texto: «Respuesta incompleta» + «Reintentar»');
});

test('b) celular: el tope también corta si solo llegan avisos «status» (nunca un «Buscando…» sin fin)', async () => {
  const pings = () => { let i = 0; return new ReadableStream({ async pull(c) { await sleep(40); c.enqueue(enc.encode(i++ ? ev('status', { s: 'buscando' }) : ev('open', { ok: true }))); }, cancel() {} }); };
  const r = await C.streamChat(sseResp(pings), 'u', {}, { firstMs: 200, idleMs: 200, maxMs: 300 });
  assert.equal(r.timeout, 'max'); assert.equal(r.text, ''); assert.equal(r.final, null);
});

test('b) celular: una respuesta normal antes del tope no se ve afectada (y el reloj se limpia)', async () => {
  const quick = () => stream([[0, ev('open', { ok: true })], [20, ev('text', { t: 'Listo.' })], [0, ev('final', { ok: true, reply: 'Listo.', proposals: [] })]], { end: false });
  const r = await C.streamChat(sseResp(quick), 'u', {}, { firstMs: 200, idleMs: 200, maxMs: 150 });
  assert.equal(r.timeout, null); assert.ok(r.final); await sleep(200);
});

// ---------- Bot 5: datos del dueño fuera para el empleado ----------
const CANARY = ['777.77', '313.13', '919.19', '42.42'];
const OWNER_READER = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: true, stock: 40, min: 5, precio: 4, costo: 313.13, margen: 919.19, ganancia: 42.42 }] };
test('Bot 5: empleado en partes -> ni el modelo ni ningún trozo (status, text, final) lleva costos, márgenes ni ganancia', async () => {
  const bodies = [];
  const first = [[0, consulta('c1', 'stock_producto')], [0, delta({}, 'tool_calls')]];
  const second = [[30, delta({ content: 'Hay 40 unidades de Arroz.' })], [0, delta({}, 'stop')]];
  const r = await chat({ text: '¿cuánto arroz hay?', stream: true, context: { products: [{ id: 'A', nombre: 'Arroz', precio: 4, costo: 777.77, stock: 40 }] } },
    { role: 'empleado:consultas', fetch: dsSeq([first, second], bodies), reader: OWNER_READER, statusEveryMs: 50 });
  assert.match(r.headers.get('content-type'), /event-stream/);
  const raw = await new Response(r.body).text();
  for (const c of CANARY) { assert.ok(!raw.includes(c), 'trozo con dato del dueño ' + c); for (const b of bodies) assert.ok(!b.includes(c), 'al modelo llegó ' + c); }
  assert.ok(!/costo|margen|ganancia/i.test(raw), 'ninguna llave de costo en el canal');
  assert.equal(bodies.length, 2); assert.ok(!/"costo"|margen|ganancia/.test(bodies[1]), 'resultado de la herramienta para el modelo ya sin datos del dueño');
  assert.match(raw, /event: final/);
});

test('Bot 5: empleado pide una consulta del dueño (sin_costo, ventas, deudas) -> se descarta antes de leer la base; nada sale en partes', async () => {
  for (const tipo of ['sin_costo', 'ventas_periodo', 'deudas_clientes']) {
    let reads = 0; const reader = { products: async () => { reads++; return OWNER_READER.products(); }, all: async () => { reads++; return []; } };
    const bodies = [];
    const r = await chat({ text: 'dime', stream: true }, { role: 'empleado:consultas', fetch: dsSeq([[[0, consulta('c1', tipo)], [0, delta({}, 'tool_calls')]]], bodies), reader });
    const raw = await new Response(r.body).text();
    assert.equal(reads, 0, tipo + ': no se leyó la base'); assert.equal(bodies.length, 1, tipo + ': sin segunda llamada con datos');
    for (const c of CANARY) assert.ok(!raw.includes(c));
    assert.match(raw, /event: final/); assert.match(raw, /forbidden_query/);
  }
});

test('Bot 5: employeeQueryResult deja solo la lista blanca (columnas y resumen), aunque la consulta traiga más', () => {
  const r = employeeQueryResult({ tipo: 'stock_producto', titulo: 'Stock', columnas: ['Producto', 'Stock', 'Costo S/', 'Margen', 'Precio S/'], filas: [['Arroz', 40, 313.13, 919.19, 4]],
    texto: 'Arroz: 40 unid.', total: 1, resumen: { encontrados: 1, productos: [{ nombre: 'Arroz', stock: 40, minimo: 5, costo: 313.13, ganancia: 42.42 }], inversion: 777.77, valorizado: 1 } });
  assert.deepEqual(r.columnas, ['Producto', 'Stock', 'Precio S/']); assert.deepEqual(r.filas, [['Arroz', 40, 4]]);
  assert.deepEqual(r.resumen, { encontrados: 1, productos: [{ nombre: 'Arroz', stock: 40, minimo: 5 }] });
  for (const c of CANARY) assert.ok(!JSON.stringify(r).includes(c));
  assert.deepEqual(employeeQueryResult({ error: 'x' }), { error: 'x' });
  const src = readFileSync(new URL('../../tools/cloudflare-lab/src/pos-assistant.js', import.meta.url), 'utf8');
  const i = src.indexOf('runAssistantQuery(reader, p.query, now)'), j = src.indexOf("if (role !== 'owner') r = employeeQueryResult(r);"), k = src.indexOf("toolMsgs.push({ role: 'tool'");
  assert.ok(i > 0 && j > i && k > j, 'se filtra justo después de leer y antes de pantalla y modelo');
});

// ---------- Bot 4: la vista mientras llega el texto ----------
test('Bot 4: se baja sola solo si la persona estaba abajo; si no, «Ver nuevo». Las tarjetas no fuerzan el salto', () => {
  const sendFn = UI.slice(UI.indexOf('  async function send(text, image) {'), UI.indexOf('  // Comprime en el aparato'));
  assert.match(UI, /function atBottom\(\) \{[^\n]*scrollHeight - msgsEl\.scrollTop - msgsEl\.clientHeight <= 24/);
  assert.match(UI, /function follow\(stick\) \{ if \(stick\) scrollEnd\(\); else showNew\(\); \}/);
  assert.match(sendFn, /C\.createTextPainter\(function \(t\) \{ if \(panelEl !== mine\) return; var stick = atBottom\(\); ensureBubble\(\)\.appendChild\(doc\.createTextNode\(t\)\); follow\(stick\);/, 'mira ANTES de pintar');
  assert.match(UI, /newBtn\.textContent = 'Ver nuevo ↓'/); assert.match(CSS, /\.na-asst-new\{position:sticky;bottom:4px/); assert.match(CSS, /\.na-asst-new\[hidden\]\{display:none\}/);
  const addCard = UI.slice(UI.indexOf('  function addCard(p, prompt) {'), UI.indexOf('  function addDenied('));
  assert.ok(!/scrollEnd\(\)/.test(addCard), 'la tarjeta no salta la vista');
  assert.match(sendFn, /msgsEl\.scrollTop = Math\.max\(0, Math\.min\(end, top\)\)/, 'nunca más abajo que el inicio de la respuesta');
});

test('Bot 4: «Pensando…» se vuelve la respuesta en el mismo lugar; mascota «hablando»; el lector anuncia una sola vez al final', () => {
  const sendFn = UI.slice(UI.indexOf('  async function send(text, image) {'), UI.indexOf('  // Comprime en el aparato'));
  assert.match(sendFn, /function ensureBubble\(\) \{ if \(!bubble\) \{ bubble = thinking;[^\n]*setState\('hablando'\);/);
  assert.ok(!/class="na-asst-msgs" aria-live/.test(UI), 'la lista de mensajes no lee trozo por trozo');
  assert.match(UI, /<div class="na-asst-live" aria-live="polite" aria-atomic="true"><\/div>/);
  const painter = sendFn.slice(sendFn.indexOf('C.createTextPainter('), sendFn.indexOf('var st = await C.streamChat'));
  assert.ok(!/announce/.test(painter), 'nada se anuncia por trozo');
  assert.equal((sendFn.match(/announce\(d\.reply\)/g) || []).length, 1, 'se anuncia la respuesta completa una vez');
  assert.match(sendFn, /bubble\.setAttribute\('aria-busy', 'true'\)/); assert.match(sendFn, /bubble\.removeAttribute\('aria-busy'\)/);
  assert.match(CSS, /\.na-asst-live\{position:absolute;width:1px;height:1px/);
});
