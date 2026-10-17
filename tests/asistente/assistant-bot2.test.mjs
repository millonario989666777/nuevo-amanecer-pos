// Hallazgos de Bot 2 sobre b6d83ef5: tope duro de compras, productos sin control de inventario, causa real al no abrir el ajuste
// y documento solo del dueño pedido por un empleado (403).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assistantChatRoute, assistantConfirmRoute, createMemoryUsageStore, PURCHASE_HARD_LIMITS, toProposal, sanitizeContext, STOCK_READ_FAILED_TEXT } from '../../tools/cloudflare-lab/src/pos-assistant.js';
import { assistantAccess } from '../../tools/cloudflare-lab/src/pos-assistant-access.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');

const jsonR = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ENV = { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', DEEPSEEK_API_KEY: 'k' };
const OWN = { principalId: 'session:dev-owner', posRole: 'owner' };
const tool = (name, args, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const fakeDS = (calls) => async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: calls } }] }));
// Base del servidor (solo lectura): A controla inventario, S (servicio) no.
const reader = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: true }, { id: 'S', nombre: 'Recarga', controla: false }] };
const CTX = { products: [{ id: 'A', nombre: 'Arroz', precio: 4, costo: 3, stock: 50 }, { id: 'S', nombre: 'Recarga', precio: 5, stock: 0 }] };
async function chat(calls, extra = {}) {
  const store = extra.store || createMemoryUsageStore();
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: JSON.stringify({ text: 'x', context: extra.ctx || CTX }) }), ENV, extra.auth || OWN, jsonR,
    { store, resolveRole: async () => extra.role || 'owner', fetch: fakeDS(calls), reader: extra.reader === undefined ? reader : extra.reader, audit: async () => {} });
  return { status: r.status, body: await r.json(), store };
}
// Sin PIN: ya no hay aprobación que gastar. «spent» cuenta si ESTA llamada dejó la tarjeta marcada como usada (1) o no (0):
// un rechazo (422, 409, 503) no la marca y se puede reintentar con un toque.
async function confirm(store, p, review, extra = {}) {
  const { confirm_token, ...proposal } = p;
  const n = JSON.parse(Buffer.from(confirm_token.split('.')[0], 'base64url').toString()).n;
  const usedNow = () => [...store._map.keys()].filter((k) => k.endsWith('u:' + n) && store._map.get(k).value?.op).length;
  const before = usedNow();
  const r = await assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', body: JSON.stringify({ token: confirm_token, proposal, review }) }), ENV, OWN, jsonR,
    { store, resolveRole: async () => 'owner', reader: extra.reader === undefined ? reader : extra.reader, audit: async () => {} });
  return { status: r.status, body: await r.json(), spent: usedNow() - before };
}
const opOf = (p) => JSON.parse(Buffer.from(p.confirm_token.split('.')[0], 'base64url').toString()).op;

test('1) factura absurda 9999 × S/ 99,999: «Está bien» NO la deja pasar (tope duro en el servidor, sin marcar la tarjeta)', async () => {
  const { body, store } = await chat([tool('leer_factura_compra', { proveedor: 'Dist', lineas: [{ product_id: 'A', nombre: 'Arroz', cantidad: 9999, costo_unitario: 99999 }, { product_id: 'A', nombre: 'Arroz chico', cantidad: 2, costo_unitario: 3 }] })]);
  const card = body.proposals.find((p) => p.type === 'compra'); assert.ok(card, JSON.stringify(body));
  assert.deepEqual(card.lineas[0].limite, ['cantidad', 'costo', 'total']); assert.equal(card.fueraDeLimite, 1);
  const op = opOf(card);
  // aceptar la fila marcada: igual 422 over_limit con motivo claro; la tarjeta NO queda usada
  const r = await confirm(store, card, { op, accept: [0], drop: [] });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'over_limit'); assert.deepEqual(r.body.rows, [0]);
  assert.match(r.body.message, /pasa el límite \(cantidad mayor a 5000\): corrige la factura o quita la fila\./); assert.ok(r.body.message.length <= 120, 'una frase corta: ' + r.body.message); assert.ok(!/\(s\)/.test(r.body.message));
  assert.equal(r.spent, 0);
  // quitando la fila sí pasa
  const ok = await confirm(store, card, { op, accept: [], drop: [0] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual(ok.body.proposal.lineas.map((l) => l.cantidad), [2]); assert.equal(ok.spent, 1);
});

test('1b) tope del total de la compra y tope de cantidad del ajuste', async () => {
  const lineas = Array.from({ length: 5 }, (_, i) => ({ product_id: 'A', nombre: 'L' + i, cantidad: 1000, costo_unitario: 45 })); // 45,000 por fila, 225,000 total
  const { body, store } = await chat([tool('preparar_compra', { lineas })]);
  const card = body.proposals.find((p) => p.type === 'compra'); const op = opOf(card);
  const r = await confirm(store, card, { op, accept: [0, 1, 2, 3, 4], drop: [] });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'over_limit'); assert.equal(r.body.total, true); assert.match(r.body.message, /^La compra pasa el límite de S\/ 200000: quita algunas filas\.$/);
  assert.equal(PURCHASE_HARD_LIMITS.maxTotal, 200000);
  const adj = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'entrada', cantidad: 9000, motivo: 'Ajuste de inventario' })]);
  assert.equal(adj.body.proposals.length, 0); assert.deepEqual(adj.body.dropped, [{ tool: 'proponer_ajuste_stock', reason: 'over_limit' }]);
  assert.match(adj.body.reply, /pasa el límite de 5000/);
});

test('2) producto sin control de inventario: ni ajuste ni fila de compra; mensaje claro; se vuelve a mirar al confirmar', async () => {
  const adj = await chat([tool('proponer_ajuste_stock', { product_id: 'S', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })]);
  assert.equal(adj.status, 200); assert.equal(adj.body.proposals.length, 0);
  assert.match(adj.body.reply, /«Recarga» no lleva control de stock/);
  assert.ok(adj.body.dropped.some((d) => d.reason === 'sin_control_stock'));
  // el aparato no lo marcó (contexto viejo): igual lo corta la base del servidor
  const ctxSinFlag = { products: CTX.products.map(({ controla, ...p }) => p) };
  const c = await chat([tool('preparar_compra', { lineas: [{ product_id: 'S', nombre: 'Recarga', cantidad: 3 }, { product_id: 'A', nombre: 'Arroz', cantidad: 2 }] })], { ctx: ctxSinFlag });
  const card = c.body.proposals.find((p) => p.type === 'compra');
  assert.deepEqual(card.lineas.map((l) => l.product_id), ['A']); assert.deepEqual(card.omitidas, [{ nombre: 'Recarga', motivo: 'no lleva control de stock' }]);
  assert.match(c.body.reply, /«Recarga» no lleva control de stock/);
  // la marca del aparato (controla:false) se respeta aunque no haya base
  assert.equal(sanitizeContext({ products: [{ id: 'S', nombre: 'Recarga', controla: false }] }, 'owner').products[0].controla, false);
  const off = toProposal({ name: 'proponer_ajuste_stock', arguments: { product_id: 'S', tipo: 'salida', cantidad: 1 } }, 'owner', sanitizeContext({ products: [{ id: 'S', nombre: 'Recarga', controla: false }] }, 'owner'), 1);
  assert.equal(off.dropped, 'sin_control_stock');
  // en confirm: el producto dejó de controlar inventario después de la tarjeta -> 409 con el motivo, aprobación sin gastar
  const a = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })]);
  const later = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: false }] };
  const r = await confirm(a.store, a.body.proposals[0], null, { reader: later });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'sin_control_stock'); assert.match(r.body.message, /«Arroz» no lleva control de stock/); assert.equal(r.spent, 0);
});

test('3) ajuste en el aparato: se revisa ANTES de gastar la tarjeta y se dice el motivo real', async () => {
  let confirms = 0, opened = 0;
  const base = { roles: () => ({ role: 'owner', isOwner: () => true }), online: () => true, confirm: async () => { confirms++; return { ok: true, operation_id: 'AST-1' }; } };
  const card = { id: 'k1', type: 'ajuste', needsConfirm: true, confirm_token: 't', product_id: 'S', nombre: 'Recarga', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' };
  const g1 = C.createGate({ ...base, productos: () => [{ id: 'S', name: 'Recarga', controlInventario: false }], openStockMove: () => { opened++; return true; } });
  const r1 = await g1.execute(g1.add(card), { confirmed: true });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'precheck'); assert.match(r1.msg, /«Recarga» no lleva control de stock/); assert.equal(confirms, 0, 'no se gastó la tarjeta'); assert.equal(opened, 0);
  const g2 = C.createGate({ ...base, productos: () => [{ id: 'S', name: 'Recarga' }], stockMoveReady: () => 'La ventana «Registrar movimiento» no está cargada. Recarga la página e inténtalo otra vez.', openStockMove: () => true });
  const r2 = await g2.execute(g2.add(card), { confirmed: true });
  assert.match(r2.msg, /no está cargada/); assert.equal(confirms, 0);
  // si igual falla al abrir, se muestra la causa que dio el POS (no un «No se pudo abrir» mudo)
  const g3 = C.createGate({ ...base, productos: () => [{ id: 'S', name: 'Recarga' }], openStockMove: () => 'El POS no abrió «Registrar movimiento» (puede que el producto no controle inventario). Revisa la ficha del producto.' });
  const r3 = await g3.execute(g3.add(card), { confirmed: true });
  assert.equal(r3.ok, false); assert.match(r3.msg, /El POS no abrió/);
  assert.equal(C.tracksStock({ tipo: 'servicio' }), false); assert.equal(C.tracksStock({ tracks_inventory: 0 }), false); assert.equal(C.tracksStock({ id: 1 }), true);
  // contexto del celular: marca controla:false
  assert.equal(C.buildContext([{ id: 'S', name: 'Recarga', precio: 5, trackStock: false }], 'owner', null, '').products[0].controla, false);
});

test('4) empleado pide un documento solo del dueño: 403 forbidden_document (no 200)', async () => {
  const emp = { principalId: 'session:emp', posRole: 'empleado' };
  for (const tipo of ['inventario_valorizado', 'reporte_ventas', 'estado_cuenta', 'resumen_cierre']) {
    const r = await chat([tool('preparar_documento', { tipo })], { auth: emp, role: 'empleado:consultas_documentos' });
    assert.equal(r.status, 403, tipo); assert.equal(r.body.error, 'forbidden_document'); assert.deepEqual(r.body.allowed, ['lista_precios', 'lista_pedido']);
  }
  const ok = await chat([tool('preparar_documento', { tipo: 'lista_precios' })], { auth: emp, role: 'empleado:consultas_documentos', reader: { ...reader, products: async () => [] } });
  assert.equal(ok.status, 200);
});

test('UI: over_limit marca filas «Fuera del límite» sin «Está bien»; el motivo del servidor se muestra', async () => {
  const v = C.confirmFailureView({ ok: false, code: 'over_limit', rows: [0], msg: '«Arroz»: cantidad mayor a 5000. Fuera del límite: corrige la factura o quita la fila.' });
  assert.equal(v.kind, 'limit'); assert.deepEqual(v.rows, [0]); assert.equal(v.again, true); assert.match(v.msg, /cantidad mayor a 5000/);
  const g = C.createGate({ roles: () => ({ role: 'owner', isOwner: () => true }), online: () => true, productos: () => [], confirm: async () => ({ ok: false, error: 'over_limit', rows: [0], message: 'motivo del servidor' }) });
  const r = await g.execute(g.add({ id: 'c', type: 'compra', needsConfirm: true, confirm_token: 't', lineas: [{ nombre: 'X', cantidad: 9999 }] }), { confirmed: true });
  assert.equal(r.msg, 'motivo del servidor'); assert.equal(r.code, 'over_limit');
  const fs = await import('node:fs');
  const ui = fs.readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /l\.limite && l\.limite\.length \? '<div class="flag-t">Fuera del límite: /);
  assert.match(ui, /var pre = C\.precheck \? C\.precheck\(p, deps\) : null;\n\s*if \(pre\)[^\n]*return; }/, 'la revisión va ANTES de enviar');
  assert.ok(!/verifyOwnerPin|na-asst-pin|pinBox/.test(ui), 'sin PIN en la tarjeta');
});

test('R25 (Bot 5): empleado en «consultas» que pide CUALQUIER documento -> 403 forbidden_document para todo el pedido', async () => {
  const emp = { principalId: 'session:emp', posRole: 'empleado' };
  for (const tipo of ['lista_precios', 'inventario_valorizado']) {
    const r = await chat([tool('preparar_documento', { tipo }), tool('consultar', { tipo: 'bajo_stock' }, 'c2')], { auth: emp, role: 'empleado:consultas' });
    assert.equal(r.status, 403, tipo); assert.equal(r.body.error, 'forbidden_document'); assert.equal(r.body.proposals, undefined, 'no viaja ninguna tarjeta');
  }
});

test('confirm falla CERRADO si no puede leer el producto: sin base, lectura caída, lista cortada sin el producto; borrado -> 409', async () => {
  const a = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })]);
  const card = a.body.proposals[0];
  const cut = Object.assign([{ id: 'Z', nombre: 'Otro', controla: true }], { truncated: true });
  for (const [name, rd, st, err] of [['sin base', null, 503, 'stock_check_unavailable'], ['lectura caída', { products: async () => { throw new Error('D1'); } }, 503, 'stock_check_unavailable'],
    ['lista cortada', { products: async () => cut }, 503, 'stock_check_unavailable'], ['borrado', { products: async () => [{ id: 'Z', nombre: 'Otro', controla: true }] }, 409, 'product_missing']]) {
    const r = await confirm(a.store, card, null, { reader: rd });
    assert.equal(r.status, st, name); assert.equal(r.body.error, err, name); assert.equal(r.spent, 0, name + ': tarjeta sin marcar');
  }
  assert.equal((await confirm(a.store, card, null)).status, 200, 'con la base bien, pasa');
});

test('confirm: 429 y 403 de rol se anotan AGRUPADOS; los demás rechazos, uno por uno', async () => {
  const rows = []; const audit = async (_db, r) => { rows.push(...r); };
  const store = createMemoryUsageStore();
  const { body } = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })], { store });
  const card = body.proposals[0]; const { confirm_token, ...proposal } = card;
  const send = (extra = {}) => assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', body: JSON.stringify({ token: confirm_token, proposal: extra.proposal || proposal }) }), { ...ENV, ASSISTANT_CONFIRMS_PER_MINUTE: '0' }, OWN, jsonR,
    { store, resolveRole: async () => extra.role || 'owner', reader, audit });
  assert.equal((await send({ proposal: { ...proposal, cantidad: 9 } })).status, 409);
  assert.equal((await send()).status, 429);
  assert.equal((await send({ role: 'empleado:off' })).status, 403);
  assert.equal((await send({ role: 'empleado:consultas' })).status, 403);
  assert.deepEqual(rows.map((r) => [r.outcome, !!r.aggregate]), [['rejected:proposal_changed', false], ['rejected:rate_limited', true], ['rejected:assistant_off', true], ['rejected:forbidden_role', true]]);
  assert.ok(rows.every((r) => r.device_id === OWN.principalId));
});

test('chat: 429 y 403 de rol se anotan AGRUPADOS (src chat); los demás rechazos, uno por uno; nunca el texto', async () => {
  const rows = []; const audit = async (_db, r) => { rows.push(...r); };
  const send = (body, extra = {}) => assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: JSON.stringify(body) }), { ...ENV, ...(extra.env || {}) }, OWN, jsonR,
    { store: createMemoryUsageStore(), resolveRole: async () => extra.role || 'owner', fetch: fakeDS([tool('preparar_documento', { tipo: 'inventario_valorizado' })]), reader, audit });
  assert.equal((await send({ text: 'PIN 4821' }, { role: 'empleado:off' })).status, 403);
  assert.equal((await send({ text: 'PIN 4821' }, { role: 'sin_rol' })).status, 403);
  assert.equal((await send({ text: 'PIN 4821' }, { env: { ASSISTANT_PER_MINUTE: '0' } })).status, 429);
  assert.equal((await send({ text: 'inventario valorizado' }, { role: 'empleado:consultas_documentos' })).status, 403);
  assert.equal((await send({ text: '' })).status, 400);
  assert.equal((await send({ text: 'hola' }, { env: { ASSISTANT_ENABLED: '0' } })).status, 404);
  assert.deepEqual(rows.map((r) => [r.outcome, !!r.aggregate, r.src]), [['rejected:assistant_off', true, 'chat'], ['rejected:assistant_off', true, 'chat'],
    ['rejected:rate_limited', true, 'chat'], ['rejected:forbidden_document', true, 'chat'], ['rejected:empty_message', false, 'chat']]);
  assert.ok(!/4821|inventario valorizado|hola/.test(JSON.stringify(rows)));
});

// Bot 2 (50b6716b, menor): si la lectura por id del inventario falla en el chat, NO se ofrecen compras ni ajustes (mensaje simple).
test('chat: falla la lectura del inventario -> fuera tarjetas de compra y ajuste (y sus costos), mensaje simple; consultas y precios siguen', async () => {
  const broken = { productsById: async () => { throw new Error('D1 caída'); }, products: async () => { throw new Error('D1 caída'); } };
  const a = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })], { reader: broken });
  assert.equal(a.status, 200); assert.equal(a.body.proposals.length, 0); assert.equal(a.body.reply, STOCK_READ_FAILED_TEXT);
  assert.deepEqual(a.body.dropped, [{ tool: 'proponer_ajuste_stock', reason: 'stock_unavailable' }]);
  const c = await chat([tool('preparar_compra', { lineas: [{ product_id: 'A', nombre: 'Arroz', cantidad: 2, costo_unitario: 9 }] }, 'c1'), tool('proponer_cambio_precio', { product_id: 'A', precio_nuevo: 5 }, 'c2')], { reader: broken });
  assert.deepEqual(c.body.proposals.map((p) => p.type), ['precio']); // sin compra y sin «Actualizar costo»
  assert.match(c.body.reply, /^No pude revisar el inventario en este momento/); assert.match(c.body.reply, /Las otras tarjetas sí se pueden revisar/);
  assert.ok(!/Confirmar/.test(c.body.reply));
  // solo el fallo de productsById también corta (lector por id)
  const onlyById = { productsById: async () => { throw new Error('x'); } };
  const c2 = await chat([tool('preparar_compra', { lineas: [{ product_id: 'A', nombre: 'Arroz', cantidad: 2 }] })], { reader: onlyById });
  assert.equal(c2.body.proposals.length, 0); assert.equal(c2.body.reply, STOCK_READ_FAILED_TEXT);
  // con la base bien, la misma compra sí sale
  const ok = await chat([tool('preparar_compra', { lineas: [{ product_id: 'A', nombre: 'Arroz', cantidad: 2 }] })]);
  assert.deepEqual(ok.body.proposals.map((p) => p.type), ['compra']);
});

// Bot 2 (50b6716b, menor): teléfono SIN fila de rol = 'sin_rol' en la bitácora (antes salía 'empleado:off').
test('teléfono sin rol: assistantAccess da sin_rol y la bitácora del chat lo anota así (403 assistant_off, agrupado)', async () => {
  const fakeDb = (row, fail) => ({ prepare: () => ({ bind: () => ({ first: async () => { if (fail) throw new Error('x'); return row; } }) }) });
  assert.equal(await assistantAccess(fakeDb(null), { principalId: 'session:tel', posRole: 'owner' }), 'sin_rol');
  assert.equal(await assistantAccess(fakeDb({ pos_role: 'owner' }), { principalId: 'session:tel', posRole: 'empleado' }), 'empleado:off');
  assert.equal(await assistantAccess(fakeDb(null, true), { principalId: 'session:tel', posRole: 'owner' }), 'empleado:off'); // error de base: falla cerrado
  assert.equal(await assistantAccess(fakeDb({ pos_role: 'owner' }), { principalId: 'session:tel', posRole: 'owner' }), 'owner');
  const rows = []; const audit = async (_db, r) => { rows.push(...r); };
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: '{"ping":true}' }), ENV, { principalId: 'session:tel', posRole: 'owner' }, jsonR,
    { store: createMemoryUsageStore(), db: fakeDb(null), audit });
  assert.equal(r.status, 403); const b = await r.json(); assert.equal(b.error, 'assistant_off'); assert.equal(b.reason, 'sin_rol');
  assert.deepEqual(rows.map((x) => [x.role, x.outcome, !!x.aggregate]), [['sin_rol', 'rejected:assistant_off', true]]);
});
