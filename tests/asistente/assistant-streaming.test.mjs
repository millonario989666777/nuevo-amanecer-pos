// Respuesta en partes (primeras palabras en 1-2 s). Servidor: las puertas van antes de abrir el canal; el texto sale en «text»,
// las tarjetas SOLO en «final» (validadas como siempre). Celular: tandas de ~100 ms, primer trozo ~10 s, 30 s desde el último trozo,
// corte a mitad = «Respuesta incompleta» + «Reintentar» (sin reintento automático), y vuelta al JSON si no hay partes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assistantChatRoute, createMemoryUsageStore, createTextEmitter, STREAM_HOLDBACK, redactText } from '../../tools/cloudflare-lab/src/pos-assistant.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');
const UI = readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');

const SECRET = 'secreto-de-prueba-0123456789abcdef';
const jsonR = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTX = { products: [{ id: 'A', nombre: 'Arroz', precio: 4, costo: 3, stock: 50 }, { id: 'S', nombre: 'Recarga', precio: 5, stock: 0 }] };
const READER = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: true }, { id: 'S', nombre: 'Recarga', controla: false }] };
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const delta = (d, fin) => sse({ choices: [{ delta: d, ...(fin ? { finish_reason: fin } : {}) }] });
// DeepSeek en partes, de mentira: manda cada trozo con una pausa.
function dsStream(chunks, { gap = 0, end = true, calls } = {}) {
  return async (_url, init) => {
    if (calls) calls.push(JSON.parse(init.body));
    let i = 0;
    return new Response(new ReadableStream({ async pull(c) { if (i < chunks.length) { if (gap) await sleep(gap); c.enqueue(enc.encode(chunks[i++])); } else { if (end) c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}
async function chat(body, { env = {}, role = 'owner', fetch, audit, store, mockChunkMs } = {}) {
  const rows = [];
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: SECRET, ...env }, { principalId: 'session:x', posRole: role === 'owner' ? 'owner' : 'empleado' }, jsonR,
    { store: store || createMemoryUsageStore(), resolveRole: async () => role, fetch, reader: READER, audit: audit || (async (_d, x) => { rows.push(...x); }), mockChunkMs });
  return { r, rows };
}
// Lee el SSE del servidor con la hora de llegada de cada evento.
async function events(r) {
  const t0 = Date.now(), out = []; const p = C.createSseParser((ev, d) => out.push({ ev, d, ms: Date.now() - t0 }));
  const rd = r.body.getReader(), dec = new TextDecoder();
  for (;;) { const { value, done } = await rd.read(); if (done) break; p.feed(dec.decode(value, { stream: true })); }
  return out;
}

test('servidor: primeras palabras enseguida (DeepSeek en partes de mentira, 40 trozos cada 40 ms); la respuesta completa llega después', async () => {
  const words = Array.from({ length: 40 }, (_, i) => 'palabra' + i + ' ');
  const { r } = await chat({ text: 'hola', context: CTX, stream: true }, { env: { DEEPSEEK_API_KEY: 'k' }, fetch: dsStream([...words.map((w) => delta({ content: w })), delta({}, 'stop')], { gap: 40 }) });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const ev = await events(r);
  assert.equal(ev[0].ev, 'open'); assert.ok(ev[0].ms < 200, 'open enseguida: ' + ev[0].ms);
  const firstText = ev.find((e) => e.ev === 'text'), fin = ev.find((e) => e.ev === 'final');
  assert.ok(firstText && fin); assert.ok(firstText.ms < 700, 'primer texto en ' + firstText.ms + ' ms'); assert.ok(fin.ms > 1400, 'final en ' + fin.ms + ' ms');
  assert.equal(ev.filter((e) => e.ev === 'text').map((e) => e.d.t).join(''), words.join(''), 'sin perder ni repetir texto');
  assert.equal(fin.d.reply, words.join('').trim()); assert.equal(ev[ev.length - 1].ev, 'final');
});

test('servidor: demostración (ASSISTANT_DEMO=1) también en partes; sin clave y sin demo sigue 503 en JSON', async () => {
  const { r } = await chat({ text: 'merma de 1 Arroz', context: CTX, stream: true }, { env: { ASSISTANT_DEMO: '1' }, mockChunkMs: 5 });
  const ev = await events(r);
  assert.deepEqual([...new Set(ev.map((e) => e.ev))], ['open', 'text', 'final']);
  assert.ok(ev.filter((e) => e.ev === 'text').length >= 1); assert.equal(ev.at(-1).d.mode, 'mock');
  const off = await chat({ text: 'hola', context: CTX, stream: true });
  assert.equal(off.r.status, 503); assert.match(off.r.headers.get('content-type'), /json/); assert.equal((await off.r.json()).error, 'assistant_not_configured');
});

test('servidor: las tarjetas SOLO llegan en «final», validadas igual (tarjeta repetida fuera, sin control de inventario fuera, firmadas)', async () => {
  const args1 = JSON.stringify({ product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' });
  const chunks = [delta({ content: 'Preparé la salida de Arroz. Revisa la tarjeta y pulsa Confirmar cuando estés listo. ' }),
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'proponer_ajuste_stock', arguments: args1.slice(0, 20) } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: args1.slice(20) } }] }),
    delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'proponer_ajuste_stock', arguments: JSON.stringify({ product_id: 'A', tipo: 'salida', cantidad: 2, motivo: 'Vencido' }) } }] }),
    delta({ tool_calls: [{ index: 2, id: 'c3', function: { name: 'proponer_ajuste_stock', arguments: JSON.stringify({ product_id: 'S', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' }) } }] }), delta({}, 'tool_calls')];
  const { r } = await chat({ text: 'merma', context: CTX, stream: true }, { env: { DEEPSEEK_API_KEY: 'k' }, fetch: dsStream(chunks) });
  const ev = await events(r);
  for (const e of ev.filter((x) => x.ev !== 'final')) assert.ok(!/confirm_token|proposals|product_id|proponer_/.test(JSON.stringify(e.d)), 'nada de tarjetas antes de final: ' + JSON.stringify(e.d));
  const fin = ev.find((e) => e.ev === 'final').d;
  assert.deepEqual(fin.proposals.map((p) => p.type + ':' + p.product_id + ':' + p.cantidad), ['ajuste:A:1']);
  assert.ok(fin.proposals[0].confirm_token);
  const why = fin.dropped.map((d) => d.reason).sort(); assert.ok(why.includes('duplicate_action') && why.includes('sin_control_stock'), JSON.stringify(why));
});

test('servidor: corte a mitad (DeepSeek se cae sin terminar): llega lo recibido y un «error» (sin final ni tarjetas); bitácora como siempre', async () => {
  const args = JSON.stringify({ product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' });
  const chunks = [delta({ content: 'Estoy revisando el inventario de la botica para preparar la salida que pediste. ' }), delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'proponer_ajuste_stock', arguments: args } }] })];
  const { r, rows } = await chat({ text: 'merma', context: CTX, stream: true }, { env: { DEEPSEEK_API_KEY: 'k' }, fetch: dsStream(chunks, { end: false }) });
  const ev = await events(r);
  assert.ok(ev.some((e) => e.ev === 'text')); assert.ok(!ev.some((e) => e.ev === 'final'));
  const err = ev.find((e) => e.ev === 'error'); assert.equal(err.d.error, 'upstream_error'); assert.equal(err.d.status, 502);
  assert.ok(!JSON.stringify(ev).includes('confirm_token'), 'herramienta a medias: nunca tarjeta');
  assert.ok(rows.some((x) => x.outcome === 'rejected:upstream_error'));
});

test('servidor: las puertas del empleado no cambian con stream:true (foto, apagado, sin rol, cupo: JSON 403/429 sin DeepSeek)', async () => {
  let calls = 0; const f = async (...a) => { calls++; return dsStream([delta({ content: 'x' }, 'stop')])(...a); };
  const env = { DEEPSEEK_API_KEY: 'k' };
  const img = await chat({ text: 'lee', image: 'data:image/jpeg;base64,AAAA', stream: true }, { env, role: 'empleado:consultas', fetch: f });
  assert.equal(img.r.status, 403); assert.match(img.r.headers.get('content-type'), /json/); assert.equal((await img.r.json()).error, 'image_owner_only');
  for (const role of ['sin_rol', 'empleado:off']) { const x = await chat({ text: 'hola', stream: true }, { env, role, fetch: f }); assert.equal(x.r.status, 403); assert.equal((await x.r.json()).error, 'assistant_off'); }
  const lim = await chat({ text: 'hola', stream: true }, { env: { ...env, ASSISTANT_PER_MINUTE: '0' }, role: 'empleado:consultas', fetch: f });
  assert.equal(lim.r.status, 429); assert.match(lim.r.headers.get('content-type'), /json/);
  assert.equal(calls, 0, 'DeepSeek nunca se llamó');
  // con permiso, el empleado sí recibe en partes
  const ok = await chat({ text: 'hola', context: CTX, stream: true }, { env, role: 'empleado:consultas', fetch: f });
  assert.match(ok.r.headers.get('content-type'), /event-stream/); assert.equal(calls, 1);
});

test('servidor: sin stream:true el chat responde el JSON de siempre (vuelta atrás)', async () => {
  const { r } = await chat({ text: 'hola', context: CTX }, { env: { ASSISTANT_DEMO: '1' } });
  assert.match(r.headers.get('content-type'), /json/); const b = await r.json(); assert.equal(b.ok, true); assert.ok(typeof b.reply === 'string');
});

test('Bot 5: un «data:» pegado en el texto no llega a DeepSeek (se cambia por «[imagen omitida]»)', async () => {
  const calls = [];
  const uri = 'data:image/png;base64,' + 'iVBORw0KGgo' + 'A1b2C3d4'.repeat(200) + '==';
  await chat({ text: 'mira esto ' + uri + ' y dime', context: CTX }, { env: { DEEPSEEK_API_KEY: 'k' }, fetch: async (_u, init) => { calls.push(JSON.parse(init.body)); return jsonR({ choices: [{ message: { content: 'ok' } }] }); } });
  const sent = JSON.stringify(calls[0].messages);
  assert.ok(sent.includes('[imagen omitida]')); assert.ok(!/base64,|iVBORw0KGgo/.test(sent));
  assert.equal(redactText('a data:text/plain;charset=utf-8,hola%20mundo b'), 'a [imagen omitida] b');
  assert.equal(redactText('sin datos'), 'sin datos');
});

test('servidor: el texto que sale ya va tapado (DNI a medio llegar no sale sin tapar: cola de ' + STREAM_HOLDBACK + ')', () => {
  const out = []; const e = createTextEmitter((d) => out.push(d.t));
  for (const ch of 'El cliente con DNI 45678912 pidió su lista de precios de hoy en la botica.'.split('')) e.push(ch);
  e.flush();
  const all = out.join(''); assert.ok(!all.includes('45678912')); assert.match(all, /DNI \*\*\*\*8912/);
});

// ---------- Celular ----------
const resp = (chunks, { gap = 0, end = true, type = 'text/event-stream' } = {}) => async () => { let i = 0;
  return new Response(new ReadableStream({ async pull(c) { if (i < chunks.length) { if (gap) await sleep(gap); c.enqueue(enc.encode(chunks[i++])); } else if (end) c.close(); else await new Promise(() => {}); } }), { status: 200, headers: { 'content-type': type } }); };
const ev = (e, d) => 'event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n';

test('celular: lector SSE con trozos partidos y CRLF', () => {
  const got = []; const p = C.createSseParser((e, d) => got.push([e, d]));
  const s = ev('open', { ok: true }) + ev('text', { t: 'Hola ' }).replace(/\n/g, '\r\n') + ev('final', { ok: true, reply: 'Hola' }) + 'data: {roto\n\n';
  for (let i = 0; i < s.length; i += 7) p.feed(s.slice(i, i + 7));
  assert.deepEqual(got, [['open', { ok: true }], ['text', { t: 'Hola ' }], ['final', { ok: true, reply: 'Hola' }]]);
});

test('celular: pinta por tandas de ~100 ms (no letra por letra), sin perder ni repetir texto', () => {
  let now = 0; const q = []; const wrote = [];
  const p = C.createTextPainter((t) => wrote.push(t), { now: () => now, schedule: (cb, wait) => q.push({ at: now + wait, cb }) });
  const run = () => { q.sort((a, b) => a.at - b.at); while (q.length && q[0].at <= now) q.shift().cb(); };
  const text = 'Hay cinco productos por reponer: arroz, azúcar, aceite, fideos y leche. '.repeat(3);
  for (const ch of text) { p.push(ch); now += 5; run(); } // una letra cada 5 ms durante ~1,1 s
  p.finish();
  assert.equal(wrote.join(''), text, 'sin perder ni repetir');
  assert.ok(p.paints() <= Math.ceil((text.length * 5) / 100) + 2, 'tandas: ' + p.paints()); assert.ok(p.paints() >= 5);
  assert.equal(C.STREAM.paintMs, 100);
  assert.match(UI, /C\.createTextPainter\(function \(t\)/); assert.match(UI, /onText: function \(t\) \{ painter\.push\(t\); \}/);
  const core = readFileSync(new URL('../../POS/js/modules/asistente/asistente-core.js', import.meta.url), 'utf8'); assert.match(core, /requestAnimationFrame\(cb\)/);
});

test('celular: primer trozo ~10 s; si no llega nada (ni cabeceras ni cuerpo), corta con «timeout» para mostrar «Reintentar»', async () => {
  assert.equal(C.STREAM.firstMs, 10000); assert.equal(C.STREAM.idleMs, 30000);
  // el servidor no contesta nunca
  await assert.rejects(C.streamChat(() => new Promise(() => {}), 'u', {}, { firstMs: 60, idleMs: 500 }), (e) => e.timeout === true && e.stage === 'first');
  // contesta las cabeceras pero no manda ningún trozo
  const t0 = Date.now(); const r = await C.streamChat(resp([], { end: false }), 'u', {}, { firstMs: 80, idleMs: 2000 });
  assert.equal(r.timeout, 'first'); assert.equal(r.cut, true); assert.equal(r.text, ''); assert.ok(Date.now() - t0 < 1000);
  assert.equal(C.friendlyError('timeout').retry, true);
});

test('celular: 30 s contados desde el ÚLTIMO trozo (no desde el inicio); si se queda quieto, corta y guarda lo recibido', async () => {
  // 12 trozos cada 40 ms (~0,5 s en total) con idle de 100 ms: no corta aunque el total pase el idle
  const chunks = [ev('open', { ok: true }), ...Array.from({ length: 10 }, (_, i) => ev('text', { t: 'p' + i + ' ' })), ev('final', { ok: true, reply: 'listo', proposals: [] })];
  const ok = await C.streamChat(resp(chunks, { gap: 40 }), 'u', {}, { firstMs: 100, idleMs: 100 });
  assert.equal(ok.timeout, null); assert.equal(ok.final.reply, 'listo'); assert.equal(ok.cut, false);
  // se queda quieto después de algo de texto
  const texts = []; const st = await C.streamChat(resp([ev('open', { ok: true }), ev('text', { t: 'Hay tres ' }), ev('text', { t: 'productos' })], { end: false }), 'u', {}, { firstMs: 100, idleMs: 120, onText: (t) => texts.push(t) });
  assert.equal(st.timeout, 'idle'); assert.equal(st.cut, true); assert.equal(st.text, 'Hay tres productos'); assert.equal(texts.join(''), 'Hay tres productos'); assert.equal(st.final, null);
});

test('celular: corte a mitad = texto guardado, «Respuesta incompleta» + «Reintentar», sin reintento automático', async () => {
  let n = 0; const f = async (...a) => { n++; return resp([ev('open', { ok: true }), ev('text', { t: 'Hay cinco productos ' }), ev('text', { t: 'por reponer' })])(...a); };
  const st = await C.streamChat(f, 'u', {}, { firstMs: 200, idleMs: 200 });
  assert.equal(st.cut, true); assert.equal(st.timeout, null); assert.equal(st.text, 'Hay cinco productos por reponer'); assert.equal(n, 1, 'una sola vez: nada automático');
  assert.match(UI, /function incomplete\(m, t, img\) \{[\s\S]{0,120}lab\.textContent = 'Respuesta incompleta';[\s\S]{0,200}b\.textContent = 'Reintentar';[\s\S]{0,300}m\.remove\(\);[\s\S]{0,160}send\(t, img\); \};/);
  assert.match(UI, /else if \(st\.text && bubble && \(!st\.error \|\| \/\^upstream_\/\.test/);
  assert.match(UI, /painter\.finish\(\); \/\/ lo que quedaba/);
  // la única llamada a send dentro de incomplete es la del botón
  const inc = UI.slice(UI.indexOf('function incomplete('), UI.indexOf('function canStream('));
  assert.equal((inc.match(/send\(/g) || []).length, 1); assert.match(inc, /b\.onclick = function \(\) \{ if \(busy\) return;/);
});

test('celular: tarjetas SOLO desde el evento final, nunca de un texto a medias', async () => {
  const fake = '{"proposals":[{"type":"ajuste","confirm_token":"x"}]}';
  const st = await C.streamChat(resp([ev('open', { ok: true }), ev('text', { t: fake }), ev('final', { ok: true, reply: 'Listo', proposals: [{ id: 'p1', type: 'ajuste' }] })]), 'u', {}, { firstMs: 200, idleMs: 200 });
  assert.equal(st.final.proposals.length, 1); assert.equal(st.text, fake);
  const cut = await C.streamChat(resp([ev('open', { ok: true }), ev('text', { t: fake })]), 'u', {}, { firstMs: 200, idleMs: 200 });
  assert.equal(cut.final, null, 'sin final no hay tarjetas');
  // en la UI, addCard solo se llama con d.proposals después de tener d (final o JSON); onText solo pinta texto
  const sendFn = UI.slice(UI.indexOf('  async function send(text, image) {'), UI.indexOf('  // Comprime en el aparato'));
  assert.equal((sendFn.match(/addCard\(/g) || []).length, 1); assert.match(sendFn, /\(d\.proposals \|\| \[\]\)\.forEach\(function \(x\) \{ addCard\(x, text\); \}\);/);
  assert.match(sendFn, /if \(st\.final\) d = st\.final;/);
  assert.match(sendFn, /if \(bubble\.textContent\.trim\(\) !== d\.reply\) bubble\.textContent = d\.reply;/, 'el texto definitivo reemplaza al pintado (si cambió)');
});

test('celular: vuelta al JSON si el servidor responde JSON (puertas) o el navegador no puede leer en partes', async () => {
  const j = await C.streamChat(async () => jsonR({ error: 'image_owner_only' }, 403), 'u', {}, { firstMs: 200 });
  assert.equal(j.kind, 'json'); assert.equal(j.status, 403); assert.equal(j.data.error, 'image_owner_only');
  assert.match(UI, /function canStream\(\) \{ return typeof root\.ReadableStream === 'function' && typeof root\.TextDecoder === 'function' && typeof root\.AbortController === 'function'/);
  assert.match(UI, /if \(streaming\) body\.stream = true;/);
  assert.match(UI, /\} else \{ d = await post\('\/auth\/assistant\/chat', body, null, C\.TIMEOUTS\.chat\);/);
  // sin cabeceras nuevas (CORS del Worker sin cambios; las fotos del dueño siguen igual)
  const w = readFileSync(new URL('../../tools/cloudflare-lab/src/worker.js', import.meta.url), 'utf8');
  assert.match(w, /'authorization, content-type, x-activation-secret, x-session-token, x-owner-approval'/);
});
