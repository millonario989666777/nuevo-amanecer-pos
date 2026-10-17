// Pedido del dueño: «fácil y que no maree». Errores en palabras simples (nunca un código), «Reintentar» en vez de un «Pensando» sin fin,
// tarjeta con «Confirmar» y «Cancelar», nada de dueño a la vista del empleado, respuestas cortas y una sola tarjeta por acción.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assistantChatRoute, createMemoryUsageStore, systemPrompt, dedupeActions } from '../../tools/cloudflare-lab/src/pos-assistant.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');
const UI = readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../POS/css/asistente.css', import.meta.url), 'utf8');
const CODEISH = /\b[a-z]+_[a-z_]+\b|HTTP|\b[1-5]\d\d\b|undefined|null|error/i;

const CODES = ['forbidden_role', 'admin_only', 'assistant_off', 'forbidden_document', 'owner_approval_required', 'unauthorized', 'rate_limited', 'daily_limit', 'monthly_cap',
  'network', 'offline', 'timeout', 'upstream_timeout', 'upstream_error', 'upstream_busy', 'stock_check_unavailable', 'confirm_expired', 'proposal_changed', 'proposal_id_mismatch',
  'product_missing', 'sin_control_stock', 'review_required', 'over_limit', 'empty_after_review', 'other_device', 'image_too_large', 'bad_image', 'not_found', 'bad_request', 'bad_token',
  'HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_409', 'HTTP_410', 'HTTP_418', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'algo_nuevo_raro', 'error', '', undefined];

test('mapeo de errores: ningún código llega a la persona; cada uno es una frase simple', () => {
  for (const code of CODES) {
    const f = C.friendlyError(code);
    assert.equal(typeof f.msg, 'string', String(code)); assert.ok(f.msg.length >= 10 && f.msg.length <= 120, String(code));
    assert.doesNotMatch(f.msg, CODEISH, String(code) + ' -> ' + f.msg);
    assert.ok(!f.msg.includes(String(code)) || !code, String(code));
  }
});

test('mapeo de errores: las frases que pidió el dueño', () => {
  for (const c of ['forbidden_role', 'admin_only', 'HTTP_403']) assert.equal(C.friendlyError(c).msg, 'Eso solo lo puede hacer el dueño.');
  for (const c of ['network', 'offline']) { const f = C.friendlyError(c); assert.match(f.msg, /^Sin conexión\. Toca «Reintentar»/); assert.equal(f.retry, true); }
  for (const c of ['rate_limited', 'HTTP_429', 'upstream_busy']) { const f = C.friendlyError(c); assert.equal(f.msg, 'Espera un momento e intenta de nuevo.'); assert.equal(f.retry, true); }
  for (const c of ['timeout', 'upstream_timeout']) { const f = C.friendlyError(c); assert.match(f.msg, /tardando/); assert.equal(f.retry, true); }
  for (const c of ['HTTP_503', 'HTTP_500', 'algo_nuevo_raro']) assert.equal(C.friendlyError(c).retry, true, c);
  for (const c of ['forbidden_role', 'assistant_off', 'confirm_expired', 'forbidden_document']) assert.equal(C.friendlyError(c).retry, false, c + ': reintentar no serviría');
});

test('mapeo de errores: un motivo del servidor solo se muestra si viene en palabras; si trae algo técnico, va la frase simple', () => {
  assert.equal(C.friendlyError('over_limit', '«Arroz»: cantidad mayor a 5000. Fuera del límite: corrige la factura o quita la fila.').msg, '«Arroz»: cantidad mayor a 5000. Fuera del límite: corrige la factura o quita la fila.');
  assert.equal(C.friendlyError('product_missing', 'Ibuprofeno 400 mg x10 ya no está.').msg, 'Ibuprofeno 400 mg x10 ya no está.');
  for (const bad of ['D1_ERROR: disk full', 'HTTP 503 Service Unavailable', 'status: 409', '503 upstream', 'TypeError: x is undefined', 'stock_check_unavailable'])
    assert.doesNotMatch(C.friendlyError('stock_check_unavailable', bad).msg, CODEISH, bad);
});

test('confirm: cualquier rechazo del servidor llega a la tarjeta como frase simple (y el corte de red ofrece «Reintentar»)', async () => {
  const owner = { role: 'owner', isOwner: () => true };
  for (const code of ['forbidden_role', 'admin_only', 'assistant_off', 'other_device', 'bad_token', 'confirm_expired', 'proposal_changed', 'rate_limited', 'stock_check_unavailable', 'HTTP_502', 'raro_nuevo']) {
    const g = C.createGate({ roles: () => owner, online: () => true, productos: () => [{ id: 'A', name: 'Arroz', controlInventario: true }], confirm: async () => ({ ok: false, error: code, message: 'D1_ERROR internal' }) });
    const r = await g.execute(g.add({ id: 'x-' + code, type: 'ajuste', product_id: 'A', needsConfirm: true, confirm_token: 't' }), { confirmed: true });
    assert.equal(r.ok, false); assert.doesNotMatch(r.msg, CODEISH, code + ' -> ' + r.msg);
    const v = C.confirmFailureView(r); assert.doesNotMatch(v.msg || '', CODEISH, code);
  }
  const g = C.createGate({ roles: () => owner, online: () => true, productos: () => [{ id: 'A', name: 'Arroz', controlInventario: true }], confirm: async () => { throw new TypeError('Failed to fetch'); } });
  const r = await g.execute(g.add({ id: 'n', type: 'ajuste', product_id: 'A', needsConfirm: true, confirm_token: 't' }), { confirmed: true });
  assert.match(r.msg, /Reintentar/); assert.equal(C.confirmFailureView(r).button, 'Reintentar'); assert.equal(g.state('n') || 'pending', 'pending');
});

test('red cortada: el pedido se corta con tiempo (nunca un «Pensando» sin fin) y el chat muestra «Reintentar» con lo mismo', async () => {
  const t0 = Date.now();
  await assert.rejects(C.request(() => new Promise(() => {}), 'http://x', {}, 60), (e) => e.timeout === true);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(C.TIMEOUTS.chat <= 30000 && C.TIMEOUTS.confirm <= 15000);
  assert.ok(!/var ERRORS = \{/.test(UI), 'sin tabla de códigos propia en la UI');
  assert.match(UI, /function errMsg\(code, serverMsg, retryArgs\)[\s\S]{0,200}C\.friendlyError\(code, serverMsg\)/);
  assert.match(UI, /b\.textContent = 'Reintentar';[\s\S]{0,300}send\(retryArgs\[0\], retryArgs\[1\]\)/);
  assert.match(UI, /catch \(e\) \{ if \(!panelEl\) return; if \(painter\) painter\.reset\(\); if \(bubble\) bubble\.remove\(\); thinking\.remove\(\); errMsg\(root\.navigator\.onLine === false \? 'offline' : e && e\.timeout \? 'timeout' : 'network', null, \[text, image\]\);/);
  assert.match(UI, /if \(!d\.ok\) \{ errMsg\(d\.error, null, \[text, image\]\);/);
  assert.match(UI, /errMsg\('offline', null, \[text, image, false\]\)/);
  assert.ok(!/addMsg\('a', [^)]*d\.error/.test(UI), 'nunca se muestra d.error tal cual');
  assert.match(CSS, /\.na-asst-msg \.na-asst-retry\{[^}]*min-height:44px/);
});

test('tarjeta de cambio: dos botones, «Confirmar» y «Cancelar»; botones rápidos grandes', () => {
  const card = UI.slice(UI.indexOf("'<div class=\"acts\"><button type=\"button\" class=\"na-asst-ok\" data-ok>"), UI.indexOf('Pedir de nuevo</button></div>'));
  assert.match(card, /data-ok>Confirmar<\/button><button type="button" class="na-asst-no" data-no>Cancelar<\/button>/);
  assert.match(CSS, /\.na-asst-chips button\{min-height:44px/); assert.match(CSS, /\.h-chip\{min-height:44px/);
});

test('empleado: sin botones ni opciones de dueño (ni foto de factura, ni tarjetas de cambio)', () => {
  assert.match(UI, /if \(photoBtn\) photoBtn\.hidden = !isOwnerAccess\(\);/);
  const emp = UI.slice(UI.indexOf('function chipsHtml()'), UI.indexOf('function chipsHtml()') + 1200).split('\n').slice(2, 4).join('\n');
  assert.ok(!/data-photo|Leer factura|Ventas de hoy|valorizado/.test(emp), emp);
  const lvl = { role: 'empleado', level: 'consultas_documentos', isOwner: () => false };
  for (const t of ['ajuste', 'precio', 'compra', 'producto', 'costo']) assert.equal(C.canExecute(lvl, { type: t, needsConfirm: true }).ok, false, t);
  assert.match(CSS, /\.na-asst-photo\[hidden\]\{display:none!important\}/);
});

test('prompt de sistema: 2-3 frases, español sencillo sin términos técnicos, una sola pregunta, una sola tarjeta por acción', () => {
  for (const role of ['owner', 'empleado:consultas']) {
    const p = systemPrompt(role, {});
    assert.match(p, /máximo 2 o 3 frases cortas/); assert.match(p, /Sin palabras técnicas/); assert.match(p, /UNA sola pregunta/); assert.match(p, /Una sola tarjeta por acción/);
    assert.doesNotMatch(p, /máximo 5 líneas/);
  }
});

test('una sola tarjeta por acción: el mismo cambio dos veces para el mismo producto deja solo la primera', async () => {
  const tool = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const env = { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', DEEPSEEK_API_KEY: 'k' };
  const ctx = { products: [{ id: 'A', nombre: 'Arroz', precio: 4, costo: 3, stock: 50 }, { id: 'B', nombre: 'Azúcar', precio: 5, costo: 4, stock: 20 }] };
  const reader = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: true }, { id: 'B', nombre: 'Azúcar', controla: true }] };
  const calls = [tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' }, 'c1'), tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 2, motivo: 'Vencido' }, 'c2'),
    tool('proponer_ajuste_stock', { product_id: 'B', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' }, 'c3'), tool('proponer_cambio_precio', { product_id: 'A', precio_nuevo: 4.5 }, 'c4'), tool('proponer_cambio_precio', { product_id: 'A', precio_nuevo: 4.8 }, 'c5')];
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: JSON.stringify({ text: 'x', context: ctx }) }), env, { principalId: 'session:o', posRole: 'owner' },
    (d, s = 200) => new Response(JSON.stringify(d), { status: s }), { store: createMemoryUsageStore(), resolveRole: async () => 'owner', reader, audit: async () => {},
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: calls } }] })) });
  const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b));
  const ks = b.proposals.map((p) => p.type + ':' + p.product_id);
  assert.deepEqual(ks, ['ajuste:A', 'ajuste:B', 'precio:A'], JSON.stringify(ks));
  assert.equal(b.proposals[0].cantidad, 1, 'queda la primera');
  assert.equal(b.dropped.filter((d) => d.reason === 'duplicate_action').length, 2);
  // consultas y documentos no se tocan
  assert.equal(dedupeActions([{ type: 'consulta', needsConfirm: false }, { type: 'consulta', needsConfirm: false }], []).length, 2);
});

test('empleado que pide un cambio: sin tarjeta y una frase simple («Eso solo lo puede hacer el dueño…»)', async () => {
  const { EMPLOYEE_CHANGE_TEXT } = await import('../../tools/cloudflare-lab/src/pos-assistant.js');
  const tool = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: JSON.stringify({ text: 'merma de 1 arroz', context: { products: [{ id: 'A', nombre: 'Arroz', precio: 4, stock: 5 }] } }) }),
    { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', DEEPSEEK_API_KEY: 'k' }, { principalId: 'session:e', posRole: 'empleado' }, (d, s = 200) => new Response(JSON.stringify(d), { status: s }),
    { store: createMemoryUsageStore(), resolveRole: async () => 'empleado:consultas', audit: async () => {}, reader: { products: async () => [{ id: 'A', nombre: 'Arroz', controla: true }] },
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' }, 'c1')] } }] })) });
  const b = await r.json(); assert.equal(r.status, 200); assert.deepEqual(b.proposals, []); assert.equal(b.reply, EMPLOYEE_CHANGE_TEXT);
  assert.doesNotMatch(b.reply, CODEISH);
});
