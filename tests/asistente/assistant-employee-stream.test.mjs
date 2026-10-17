// Bot 5 sobre bce1e9d2: (1) documento del dueño pedido por un empleado -> nada sale en partes (herramientas recortadas, 403 JSON antes
// del canal si el pedido es claro, corte a mitad si el modelo igual la llama); (2) datos del dueño tapados en cada trozo para el
// empleado, corte donde sea; el dueño los sigue viendo. Y el «data:» con espacios. Sin esperar toda la respuesta: el empleado ve
// sus primeras palabras igual de rápido que el dueño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assistantChatRoute, createMemoryUsageStore, createTextEmitter, redactFor, redactText, redactOwnerData, ownerHold, toolsForRole, employeeDocDenied,
  STREAM_HOLDBACK, OWNER_DATA_LABEL, EMPLOYEE_DOC_TYPES } from '../../tools/cloudflare-lab/src/pos-assistant.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');

const SECRET = 'secreto-de-prueba-0123456789abcdef';
const jsonR = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const delta = (d, fin) => sse({ choices: [{ delta: d, ...(fin ? { finish_reason: fin } : {}) }] });
function ds(chunks, { gap = 0, calls } = {}) {
  return async (_u, init) => { if (calls) calls.push(JSON.parse(init.body)); let i = 0;
    return new Response(new ReadableStream({ async pull(c) { if (i < chunks.length) { if (gap) await sleep(gap); c.enqueue(enc.encode(chunks[i++])); } else { c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
}
async function chat(body, { role = 'empleado:consultas_documentos', fetch, env = { DEEPSEEK_API_KEY: 'k' }, mockChunkMs, rows } = {}) {
  return assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: SECRET, ...env }, { principalId: 'session:x', posRole: role === 'owner' ? 'owner' : 'empleado' }, jsonR,
    { store: createMemoryUsageStore(), resolveRole: async () => role, fetch, reader: { products: async () => [] }, audit: async (_d, x) => { if (rows) rows.push(...x); }, mockChunkMs });
}
async function events(r) {
  const t0 = Date.now(), out = []; const p = C.createSseParser((e, d) => out.push({ ev: e, d, ms: Date.now() - t0 }));
  const rd = r.body.getReader(), dec = new TextDecoder();
  for (;;) { const { value, done } = await rd.read(); if (done) break; p.feed(dec.decode(value, { stream: true })); }
  return out;
}
const painted = (ev) => { let t = ''; for (const e of ev) if (e.ev === 'text') t = e.d.reset ? '' : t + e.d.t; return t; };
const allText = (ev) => ev.filter((e) => e.ev === 'text' && e.d.t).map((e) => e.d.t).join('');

// ---------- (1) documento del dueño ----------
test('1a) empleado: el modelo no ve documentos ni consultas del dueño (enum recortado); el dueño ve todo', () => {
  const emp = toolsForRole('empleado:consultas_documentos'), own = toolsForRole('owner');
  const doc = emp.find((t) => t.function.name === 'preparar_documento'), q = emp.find((t) => t.function.name === 'consultar');
  assert.deepEqual(doc.function.parameters.properties.tipo.enum, EMPLOYEE_DOC_TYPES);
  assert.deepEqual(q.function.parameters.properties.tipo.enum, ['stock_producto', 'bajo_stock']);
  assert.ok(!/valorizado|reporte de ventas|estado de cuenta|cierre|sin costo|deudas/i.test(JSON.stringify(emp)), JSON.stringify(emp).slice(0, 300));
  assert.ok(!toolsForRole('empleado:consultas').some((t) => t.function.name === 'preparar_documento'));
  assert.ok(own.find((t) => t.function.name === 'preparar_documento').function.parameters.properties.tipo.enum.includes('inventario_valorizado'));
});

test('1b) empleado pide con todas las letras un documento del dueño -> 403 forbidden_document en JSON ANTES del canal, sin DeepSeek ni cupo', async () => {
  for (const [role, text] of [['empleado:consultas_documentos', 'Hazme el inventario valorizado para imprimir'], ['empleado:consultas_documentos', 'dame el reporte de ventas de hoy'],
    ['empleado:consultas_documentos', 'imprime el estado de cuenta de Juan'], ['empleado:consultas', 'imprime la lista de precios']]) {
    let calls = 0; const rows = [];
    const r = await chat({ text, stream: true }, { role, fetch: async () => { calls++; return jsonR({}); }, rows });
    assert.equal(r.status, 403, text); assert.match(r.headers.get('content-type'), /json/);
    const b = await r.json(); assert.equal(b.error, 'forbidden_document'); assert.ok(!/forbidden|_/.test(b.message));
    assert.equal(calls, 0, 'sin DeepSeek'); assert.ok(rows.some((x) => x.outcome === 'rejected:forbidden_document'), 'bitácora como los otros 403');
  }
  // lo permitido o dudoso sigue al modelo
  for (const t of ['dame la lista de precios', '¿cuánto stock de arroz hay?', '¿cómo hago un cierre de caja?']) assert.equal(employeeDocDenied('empleado:consultas_documentos', t), false, t);
  assert.equal(employeeDocDenied('owner', 'Hazme el inventario valorizado'), false);
});

test('1c) si el modelo igual llama al documento del dueño a mitad del texto: se corta ahí, lo pintado se borra, sale solo el mensaje simple, sin tarjeta', async () => {
  const args = JSON.stringify({ tipo: 'inventario_valorizado' });
  const pre = 'Propongo esta acción: preparar el inventario con costos para que lo revises y lo imprimas con calma, ';
  const chunks = [...pre.match(/.{1,9}/g).map((w) => delta({ content: w })),
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'preparar_documento', arguments: args.slice(0, 12) } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] }),
    delta({ content: 'y aquí más texto que nunca debe salir.' }), delta({}, 'tool_calls')];
  const r = await chat({ text: 'quiero ver cuánto vale la mercadería', stream: true }, { fetch: ds(chunks, { gap: 5 }) });
  const ev = await events(r);
  assert.equal(painted(ev), '', 'nada queda pintado');
  assert.ok(!allText(ev).includes('nunca debe salir'), 'nada después del corte');
  assert.ok(!ev.some((e) => e.ev === 'final'), 'sin final ni tarjeta'); assert.ok(!JSON.stringify(ev).includes('confirm_token'));
  const err = ev.find((e) => e.ev === 'error'); assert.equal(err.d.error, 'forbidden_document'); assert.equal(err.d.status, 403);
  if (allText(ev)) assert.ok(ev.some((e) => e.ev === 'text' && e.d.reset), 'lo que salió se borra con reset antes del error');
  assert.equal(C.friendlyError('forbidden_document', err.d.message).msg, err.d.message, 'el celular muestra la frase simple');
});

test('1c) el corte también vale para una herramienta de cambio (empleado): sin «Propongo esta acción», mensaje simple, sin tarjeta', async () => {
  const pre = 'Propongo esta acción: subir el precio del arroz, revisa y pulsa Confirmar cuando estés listo de verdad. ';
  const chunks = [...pre.match(/.{1,7}/g).map((w) => delta({ content: w })),
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'proponer_cambio_precio', arguments: JSON.stringify({ product_id: 'A', precio_nuevo: 5 }) } }] }), delta({}, 'tool_calls')];
  const ev = await events(await chat({ text: 'sube el arroz', stream: true }, { role: 'empleado:consultas', fetch: ds(chunks) }));
  const fin = ev.find((e) => e.ev === 'final').d;
  assert.equal(fin.proposals.length, 0); assert.ok(!/Propongo|Confirmar/.test(fin.reply), fin.reply); assert.ok(!/Propongo/.test(painted(ev)));
});

test('1d) primeras palabras del empleado igual de rápido que las del dueño (no se espera toda la respuesta), con demostración y con DeepSeek', async () => {
  const words = Array.from({ length: 30 }, (_, i) => 'palabra' + i + ' ');
  const first = async (role) => { const ev = await events(await chat({ text: 'hola', stream: true }, { role, fetch: ds([...words.map((w) => delta({ content: w })), delta({}, 'stop')], { gap: 30 }) }));
    return { first: ev.find((e) => e.ev === 'text').ms, fin: ev.find((e) => e.ev === 'final').ms }; };
  const o = await first('owner'), e = await first('empleado:consultas');
  assert.ok(e.first < e.fin - 300, 'el empleado ve texto mucho antes del final: ' + JSON.stringify(e));
  assert.ok(Math.abs(e.first - o.first) < 120, 'mismo tiempo a la primera palabra: dueño ' + o.first + ' / empleado ' + e.first);
  const mock = async (role) => { const ev = await events(await chat({ text: 'hola', stream: true }, { role, env: { ASSISTANT_DEMO: '1' }, mockChunkMs: 15 }));
    const t = ev.find((x) => x.ev === 'text'), f = ev.find((x) => x.ev === 'final'); return { first: t ? t.ms : null, fin: f.ms }; };
  const mo = await mock('owner'), me = await mock('empleado:consultas');
  assert.ok(mo.first != null && me.first != null, JSON.stringify({ mo, me }));
  assert.ok(Math.abs(me.first - mo.first) < 120, 'demostración: dueño ' + mo.first + ' / empleado ' + me.first);
  assert.ok(me.first < me.fin, 'en partes, no todo al final');
});

// ---------- (2) datos del dueño en los trozos ----------
const OWNER_TEXT = 'Arroz: el costo unitario es S/ 3.50, el precio de proveedor 2,80 soles y el precio de compra S/. 3.10; tu margen es del 25 % y la ganancia: S/ 1.20 por unidad. ' +
  'También S/ 4.75 de costo en Leche y un 30% de margen en Azúcar. Se vende a S/ 5.00. Hay 40 unidades. Utilidad 18 por ciento. El costo unitario de compra es de S/ 12,345.67 hoy.';
const LEAKS = ['3.50', '2,80', '3.10', '25 %', '1.20', '4.75', '30%', '18 por ciento', '12,345.67', '345.67'];
function emitSplit(text, n, role) {
  const out = []; const e = createTextEmitter((d) => out.push(d), 1200, redactFor(role), role === 'owner' ? null : ownerHold);
  for (let i = 0; i < text.length; i += n) e.push(text.slice(i, i + n));
  e.flush(); return out.map((d) => d.t).join('');
}
for (const n of [1, 2, 47, 48, 49, 100]) {
  test('2) trozos de ' + n + ' caracteres: el empleado nunca recibe costos, márgenes ni ganancia (ni a medias); el dueño sí', () => {
    const emp = emitSplit(OWNER_TEXT, n, 'empleado:consultas');
    for (const l of LEAKS) assert.ok(!emp.includes(l), 'salió ' + l + ' con trozos de ' + n + ': ' + emp);
    assert.equal(emp, redactOwnerData(redactText(OWNER_TEXT)).slice(0, 1200), 'lo enviado = texto completo tapado (sin perder ni repetir)');
    assert.ok(emp.includes('Se vende a S/ 5.00') && emp.includes('Hay 40 unidades'), 'el precio de venta y el stock sí salen');
    assert.ok((emp.match(new RegExp(OWNER_DATA_LABEL.replace(/[[\]]/g, '\\$&'), 'g')) || []).length >= 8);
    const own = emitSplit(OWNER_TEXT, n, 'owner');
    assert.equal(own, OWNER_TEXT, 'el dueño ve todo');
  });
}

test('2) empleado en partes de punta a punta: ni texto ni final llevan montos del dueño; el dueño los recibe', async () => {
  const mk = () => ds([...OWNER_TEXT.match(/.{1,5}/g).map((w) => delta({ content: w })), delta({}, 'stop')]);
  const emp = await events(await chat({ text: 'hola', stream: true }, { role: 'empleado:consultas', fetch: mk() }));
  const raw = JSON.stringify(emp);
  for (const l of LEAKS) assert.ok(!raw.includes(l), 'salió ' + l);
  assert.match(emp.find((e) => e.ev === 'final').d.reply, /\[dato del dueño\]/);
  const own = await events(await chat({ text: 'hola', stream: true }, { role: 'owner', fetch: mk() }));
  assert.ok(JSON.stringify(own).includes('3.50') && own.find((e) => e.ev === 'final').d.reply.includes('25 %'));
  // sin partes (JSON) el mismo filtro
  const j = await chat({ text: 'hola' }, { role: 'empleado:consultas', fetch: async () => jsonR({ choices: [{ message: { content: OWNER_TEXT } }] }) });
  const jb = await j.json(); for (const l of LEAKS) assert.ok(!jb.reply.includes(l), 'JSON: salió ' + l);
});

test('2) el freno del empleado solo actúa donde hay una palabra del dueño: lo demás sale con la cola de siempre', () => {
  assert.equal(ownerHold('Hay 40 unidades de arroz en la tienda y está bien.'), Infinity);
  const t = 'Hay 40 unidades. El costo'; assert.equal(ownerHold(t), t.indexOf('costo'));
  const plain = 'x'.repeat(200), out = []; const e = createTextEmitter((d) => out.push(d.t), 1200, redactFor('empleado:consultas'), ownerHold);
  e.push(plain); assert.equal(out.join('').length, 200 - STREAM_HOLDBACK);
});

// ---------- data: con espacios ----------
test('data: con espacio después de la coma o base64 cortado en líneas: todo se tapa, el texto que sigue queda', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
  for (const [inp, keep] of [['mira data:image/png;base64, ' + b64 + ' gracias', 'gracias'], ['mira data:image/png;base64,' + b64.slice(0, 20) + '\n' + b64.slice(20, 40) + ' ' + b64.slice(40) + '== y listo', 'y listo'],
    ['data:image/jpeg;base64,\n' + b64 + '\n' + b64 + '\nAAAA= fin', 'fin'], ['data:image/png;base64,AAAA sigue el texto', 'sigue el texto']]) {
    const out = redactText(inp);
    assert.ok(out.includes('[imagen omitida]'), out); assert.ok(out.endsWith(keep), out);
    assert.ok(!/iVBOR|AAAA|NSUh|mNk/.test(out), 'nada del base64: ' + out);
  }
});

// ---------- Bot 5, segunda vuelta: más frases del dueño, tablas por encabezado ----------
const PHRASES = ['el costo de este producto que compramos ayer es S/ 7.77', 'Me costó S/ 7.77', 'Lo compré a S/ 3.21', 'The cost is 3.21',
  'Estos costaron S/ 7.77 la caja', 'Lo compramos a 3.21 soles', 'The cost of the item is 7.77'];
const TABLE = 'Aquí está:\n| Producto | Costo | Precio | Stock |\n|---|---:|---|---|\n| Arroz | S/ 7.77 | S/ 9.00 | 40 |\n| Leche | 3.21 | 4.50 | 12 |\n\n' +
  'Producto\tPrecio compra\tStock\nAzúcar\t7.77\t8\n\nListo.';
for (const n of [1, 2, 47, 48, 49, 100]) {
  test('2b) trozos de ' + n + ': frases de Bot 5 (costó, compré a, cost is, hasta 60 caracteres de distancia) y tabla con columna Costo', () => {
    for (const ph of PHRASES) {
      const txt = 'Hola. ' + ph + '. Hay 40 unidades.';
      const emp = emitSplit(txt, n, 'empleado:consultas');
      assert.ok(!/7\.77|3\.21/.test(emp), 'salió el monto: ' + JSON.stringify(emp));
      assert.equal(emp, redactOwnerData(redactText(txt)), 'sin perder ni repetir'); assert.ok(emp.endsWith('Hay 40 unidades.'));
      assert.equal(emitSplit(txt, n, 'owner'), txt, 'el dueño ve todo');
    }
    const t = emitSplit(TABLE, n, 'empleado:consultas');
    assert.ok(!/7\.77|3\.21/.test(t), 'tabla: ' + JSON.stringify(t));
    assert.match(t, /\| Arroz \| \[dato del dueño\] \| S\/ 9\.00 \| 40 \|/); assert.match(t, /\| Leche \| \[dato del dueño\] \| 4\.50 \| 12 \|/);
    assert.match(t, /\|---\|---:\|---\|---\|/, 'la fila separadora queda'); assert.match(t, /Azúcar\t\[dato del dueño\]\t8/); assert.ok(t.endsWith('Listo.'));
    assert.equal(emitSplit(TABLE, n, 'owner'), TABLE);
  });
}

test('2b) la distancia de 60 caracteres no cruza el punto ni el salto de línea; lo que no es del dueño sigue', () => {
  assert.equal(redactOwnerData('El costo lo revisa el dueño. Hay 40 unidades.'), 'El costo lo revisa el dueño. Hay 40 unidades.');
  assert.equal(redactOwnerData('El costo\n40 unidades'), 'El costo\n40 unidades');
  assert.equal(redactOwnerData('Compramos ayer 3 cajas. Tengo costumbre de 5 cajas.'), 'Compramos ayer 3 cajas. Tengo costumbre de 5 cajas.');
  assert.equal(redactOwnerData('| Producto | Precio | Stock |\n| Arroz | 9.00 | 40 |'), '| Producto | Precio | Stock |\n| Arroz | 9.00 | 40 |');
  assert.match(redactOwnerData('el costo de este producto que compramos ayer en la feria es S/ 7.77'), /^el \[dato del dueño\]$/);
});

test('2b) primeras palabras de respuestas cortas del empleado: igual que antes y que el dueño (mismos trozos en el mismo momento)', () => {
  const short = ['Hay 40 unidades de Arroz en la tienda, está bien de stock y no hace falta pedir hoy. ', 'Gracias por preguntar, que tengas buen día. '];
  const steps = (role) => { const out = []; const e = createTextEmitter((d) => out.push(d.t), 1200, redactFor(role), role === 'owner' ? null : ownerHold);
    const marks = []; for (const w of short.join('').split(/(?<=\s)/)) { e.push(w); marks.push(out.join('').length); } e.flush(); return { marks, all: out.join('') }; };
  const o = steps('owner'), e = steps('empleado:consultas');
  assert.deepEqual(e.marks, o.marks, 'el texto sale palabra a palabra igual que el del dueño'); assert.equal(e.all, o.all);
  // el primer texto sale apenas hay más de STREAM_HOLDBACK caracteres (la cola de siempre, sin freno extra)
  const words = short.join('').split(/(?<=\s)/); let len = 0; const firstIdx = e.marks.findIndex((x) => x > 0);
  for (let k = 0; k <= firstIdx; k++) len += words[k].length;
  assert.equal(e.marks[firstIdx], len - STREAM_HOLDBACK);
});

// ---------- (2) el celular borra lo pintado con reset antes del mensaje simple ----------
test('celular: con «text {reset:true}» se borra lo ya pintado («Claro, te preparo…») antes de mostrar la frase simple; nada vuelve a aparecer', async () => {
  const UI = (await import('node:fs')).readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
  const pick = (re) => { const m = UI.match(re); assert.ok(m, String(re)); return m[0]; };
  const ensure = pick(/function ensureBubble\(\) \{[^\n]*/), searching = pick(/function searching\(\) \{[^\n]*/);
  const painterSt = pick(/painter = C\.createTextPainter\(function \(t\) \{[^\n]*\n/);
  const streamSt = pick(/var st = await C\.streamChat\(root\.fetch\.bind\(root\), q\.url, q\.init, \{[\s\S]*?onStatus: searching \}\);/).replace('root.fetch.bind(root), q.url, q.init', 'fetchImpl, "u", {}');
  // burbuja de mentira: solo lo que usan esas líneas del celular
  const node = () => ({ text: '', kids: [], get textContent() { return this.kids.map((k) => k.data).join(''); }, set textContent(v) { this.kids = v ? [{ data: v, nodeType: 3 }] : []; },
    get firstChild() { return this.kids[0] || null; }, appendChild(k) { this.kids.push(k); }, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} });
  const thinking = node(); thinking.textContent = 'Pensando';
  const seen = [];
  const run = new Function('C', 'doc', 'thinking', 'fetchImpl', 'seen', 'panel',
    'var bubble = null, painter = null, panelEl = panel, mine = panel; function setState(){} function wake(){} function atBottom(){ return true; } function follow(){}\n' +
    ensure + '\n' + searching + '\n' + painterSt + 'return (async function () { ' + streamSt + ' painter.finish(); return { st: st, bubble: bubble }; })();');
  const evs = [['open', { ok: true }], ['text', { t: 'Claro, te preparo el inventario con ' }], ['wait', 160], ['text', { t: 'costos para imprimir' }], ['text', { reset: true }], ['wait', 160],
    ['error', { error: 'forbidden_document', status: 403, message: 'Ese documento es solo para el dueño. Puedes pedir la lista de precios o la lista de pedido.' }]];
  const fetchImpl = async () => new Response(new ReadableStream({ async start(c) { for (const [e, d] of evs) { if (e === 'wait') { await sleep(d); seen.push(thinking.textContent); continue; }
    c.enqueue(enc.encode('event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n')); } c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const out = await run(C, { createTextNode: (t) => ({ data: t, nodeType: 3 }) }, thinking, fetchImpl, seen, {});
  assert.equal(seen[0], 'Claro, te preparo el inventario con ', 'primero se pintó el texto');
  assert.equal(seen[1], '', 'el reset lo borró (también lo que esperaba su tanda)');
  assert.equal(out.bubble.textContent, '', 'al terminar no queda nada pintado');
  assert.equal(out.st.error.error, 'forbidden_document');
  // después: la burbuja vacía se quita y sale SOLO la frase simple (sin tarjeta)
  const sendFn = UI.slice(UI.indexOf('  async function send(text, image) {'), UI.indexOf('  // Comprime en el aparato'));
  const a = sendFn.indexOf('if (!d.ok && bubble) { bubble.remove(); bubble = null; }'), b = sendFn.indexOf("if (!d.ok && d.error === 'forbidden_document') { levelLowered(); errMsg('forbidden_document');");
  assert.ok(a > 0 && b > a, 'se quita la burbuja antes del mensaje simple');
  assert.ok(sendFn.indexOf('addCard(x, text)') > b, 'las tarjetas solo después, con d.ok');
});

// ---------- encabezados abreviados (Bot 5 sobre 31924d60) ----------
const ABBR = ['P. compra', 'P.compra', 'P compra', 'Pr. compra', 'PR.COMPRA', 'Prec. compra', 'Precio de compra', 'Costo unit.', 'C. unit', 'C.unit', 'Cto.', 'CTO', 'Cósto'];
const VISIBLE = ['Precio', 'P. venta', 'P.venta', 'Precio venta', 'P. unit', 'Producto', 'Stock', 'Compras', 'Categoría'];
test('2c) tabla del empleado: columnas abreviadas del dueño (P. compra, Costo unit., C. unit, Cto.…) tapadas; Precio y P. venta visibles', () => {
  for (const h of ABBR) assert.ok(!redactOwnerData('| Producto | ' + h + ' |\n|---|---|\n| Arroz | 7.77 |').includes('7.77'), 'debía taparse: ' + h);
  for (const h of VISIBLE) { const t = '| Producto | ' + h + ' |\n|---|---|\n| Arroz | 9.00 |'; assert.equal(redactOwnerData(t), t, 'debía verse: ' + h); }
});
for (const n of [1, 2, 47, 48, 49, 100]) {
  test('2c) trozos de ' + n + ': tabla con «P. compra», «Precio» y «P. venta»: el empleado no ve P. compra; el dueño ve todo', () => {
    const T = 'Lista:\n| Producto | P. compra | Precio | P. venta | Stock |\n|---|---|---|---|---|\n| Arroz | S/ 7.77 | S/ 9.00 | 9.50 | 40 |\n| Leche | 3.21 | 4.50 | 4.80 | 12 |\nListo.';
    const emp = emitSplit(T, n, 'empleado:consultas');
    assert.ok(!/7\.77|3\.21/.test(emp), JSON.stringify(emp));
    assert.match(emp, /\| Arroz \| \[dato del dueño\] \| S\/ 9\.00 \| 9\.50 \| 40 \|/); assert.match(emp, /\| Leche \| \[dato del dueño\] \| 4\.50 \| 4\.80 \| 12 \|/);
    assert.equal(emp, redactOwnerData(redactText(T)));
    assert.equal(emitSplit(T, n, 'owner'), T);
  });
}

// ---------- Bot 2 sobre 81d526d3: el precio de venta nunca se tapa; más palabras del dueño ----------
const SALE = [
  ['El costo no lo tengo, pero el precio de venta es S/ 2.50', [], ['S/ 2.50']],
  ['El costo es alto y el precio de venta es S/ 2.50', [], ['S/ 2.50']],
  ['Costo desconocido, P. venta S/ 2.50', [], ['S/ 2.50']],
  ['El costo no lo sé; se vende a S/ 2.50', [], ['S/ 2.50']],
  ['El costo aún falta, aunque el PVP es S/ 2.50', [], ['S/ 2.50']],
  ['el costo es S/ 1.80, pero el precio de venta es S/ 2.50', ['1.80'], ['S/ 2.50']],
  ['costo S/ 1.80 y venta S/ 2.50', ['1.80'], ['S/ 2.50']],
  ['precio de venta S/ 2.50, costo S/ 1.80', ['1.80'], ['S/ 2.50']],
  ['Costo: S/ 1.80, precio de venta S/ 2.50', ['1.80'], ['S/ 2.50']]
];
const MORE = ['el precio al proveedor es S/ 1.10', 'La inversión fue de S/ 500', 'Invertí S/ 300 en mercadería', 'Invertimos 300 soles', 'Ganaste S/ 40 hoy',
  'Ganamos 15% este mes', 'Gané S/ 12', 'Cto. 3.50', 'Cto 3.50 por caja'];
for (const n of [1, 2, 47, 48, 49, 100]) {
  test('3) trozos de ' + n + ': el precio de venta queda visible (también junto a un costo, en cualquier orden); el costo se tapa', () => {
    for (const [txt, hide, show] of SALE) {
      const full = 'Arroz. ' + txt + '. Hay 40 unidades.';
      const emp = emitSplit(full, n, 'empleado:consultas');
      for (const h of hide) assert.ok(!emp.includes(h), 'salió ' + h + ': ' + emp);
      for (const v of show) assert.ok(emp.includes(v), 'se tapó el precio de venta: ' + emp);
      assert.equal(emp, redactOwnerData(redactText(full))); assert.ok(emp.endsWith('Hay 40 unidades.'));
      assert.equal(emitSplit(full, n, 'owner'), full);
    }
  });
  test('3) trozos de ' + n + ': precio al proveedor, inversión/invertí, ganaste/ganamos/gané y Cto. con monto fuera de tablas se tapan', () => {
    for (const txt of MORE) {
      const full = 'Hola. ' + txt + '. Hay 40 unidades.';
      const emp = emitSplit(full, n, 'empleado:consultas');
      assert.ok(!/1\.10|500|300|40 hoy|15%|12|3\.50/.test(emp.replace('Hay 40 unidades.', '')), 'salió en: ' + emp);
      assert.match(emp, /\[dato del dueño\]/); assert.equal(emp, redactOwnerData(redactText(full)));
      assert.equal(emitSplit(full, n, 'owner'), full);
    }
  });
}

test('4) tarjeta de documento: el nombre del cliente solo en el estado de cuenta (con «Cliente:»); la lista de precios nunca lo muestra ni lo recibe', async () => {
  const { toProposal } = await import('../../tools/cloudflare-lab/src/pos-assistant.js');
  const lp = toProposal({ name: 'preparar_documento', arguments: { tipo: 'lista_precios', cliente: 'Rosa Quispe' } }, 'owner', { products: [] }, 1);
  const ec = toProposal({ name: 'preparar_documento', arguments: { tipo: 'estado_cuenta', cliente: 'Rosa Quispe' } }, 'owner', { products: [] }, 2);
  assert.equal(lp.cliente, null, 'la lista de precios no lleva cliente'); assert.equal(ec.cliente, 'Rosa Quispe');
  const UI = (await import('node:fs')).readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
  const line = UI.match(/if \(p\.type === 'documento'\) return[\s\S]*?data-open>Abrir documento<\/button><\/div>';/)[0];
  const E = (v) => String(v), cardDoc = new Function('p', 'E', 'CUSTOMER_DOCS', line.replace(/^if \(p\.type === 'documento'\) /, ''));
  const html = (p) => cardDoc({ title: 'T', ...p }, E, ['estado_cuenta']);
  assert.ok(!html({ tipo: 'lista_precios', cliente: 'Rosa Quispe' }).includes('Rosa'), 'lista de precios sin nombre aunque llegue');
  assert.match(html({ tipo: 'estado_cuenta', cliente: 'Rosa Quispe' }), /Cliente: Rosa Quispe/);
  assert.ok(!html({ tipo: 'lista_pedido', cliente: 'Rosa' }).includes('Rosa'));
});
