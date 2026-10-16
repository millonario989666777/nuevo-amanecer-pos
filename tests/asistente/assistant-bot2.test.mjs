// Hallazgos de Bot 2 sobre b6d83ef5: tope duro de compras, productos sin control de inventario, causa real al no abrir el ajuste
// y documento solo del dueño pedido por un empleado (403).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assistantChatRoute, assistantConfirmRoute, createMemoryUsageStore, PURCHASE_HARD_LIMITS, toProposal, sanitizeContext } from '../../tools/cloudflare-lab/src/pos-assistant.js';
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
async function confirm(store, p, review, extra = {}) {
  const { confirm_token, ...proposal } = p; let spent = 0;
  const r = await assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', headers: { 'x-owner-approval': 'apr' }, body: JSON.stringify({ token: confirm_token, proposal, review }) }), ENV, OWN, jsonR,
    { store, resolveRole: async () => 'owner', verifyApproval: async () => { spent++; return true; }, reader: extra.reader === undefined ? reader : extra.reader, audit: async () => {} });
  return { status: r.status, body: await r.json(), spent };
}
const opOf = (p) => JSON.parse(Buffer.from(p.confirm_token.split('.')[0], 'base64url').toString()).op;

test('1) factura absurda 9999 × S/ 99,999: «Está bien» NO la deja pasar (tope duro en el servidor, sin gastar la aprobación)', async () => {
  const { body, store } = await chat([tool('leer_factura_compra', { proveedor: 'Dist', lineas: [{ product_id: 'A', nombre: 'Arroz', cantidad: 9999, costo_unitario: 99999 }, { product_id: 'A', nombre: 'Arroz chico', cantidad: 2, costo_unitario: 3 }] })]);
  const card = body.proposals.find((p) => p.type === 'compra'); assert.ok(card, JSON.stringify(body));
  assert.deepEqual(card.lineas[0].limite, ['cantidad', 'costo', 'total']); assert.equal(card.fueraDeLimite, 1);
  const op = opOf(card);
  // aceptar la fila marcada: igual 422 over_limit con motivo claro; la aprobación NO se gasta
  const r = await confirm(store, card, { op, accept: [0], drop: [] });
  assert.equal(r.status, 422); assert.equal(r.body.error, 'over_limit'); assert.deepEqual(r.body.rows, [0]);
  assert.match(r.body.message, /Fuera del límite: corrige la factura o quita la fila/); assert.match(r.body.message, /cantidad mayor a 5000/);
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
  assert.equal(r.status, 422); assert.equal(r.body.error, 'over_limit'); assert.equal(r.body.total, true); assert.match(r.body.message, /total de la compra mayor a S\/ 200000/);
  assert.equal(PURCHASE_HARD_LIMITS.maxTotal, 200000);
  const adj = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'entrada', cantidad: 9000, motivo: 'Ajuste de inventario' })]);
  assert.equal(adj.body.proposals.length, 0); assert.deepEqual(adj.body.dropped, [{ tool: 'proponer_ajuste_stock', reason: 'over_limit' }]);
  assert.match(adj.body.reply, /pasa el límite de 5000/);
});

test('2) producto sin control de inventario: ni ajuste ni fila de compra; mensaje claro; se vuelve a mirar al confirmar', async () => {
  const adj = await chat([tool('proponer_ajuste_stock', { product_id: 'S', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })]);
  assert.equal(adj.status, 200); assert.equal(adj.body.proposals.length, 0);
  assert.match(adj.body.reply, /«Recarga» no controla inventario/);
  assert.ok(adj.body.dropped.some((d) => d.reason === 'sin_control_stock'));
  // el aparato no lo marcó (contexto viejo): igual lo corta la base del servidor
  const ctxSinFlag = { products: CTX.products.map(({ controla, ...p }) => p) };
  const c = await chat([tool('preparar_compra', { lineas: [{ product_id: 'S', nombre: 'Recarga', cantidad: 3 }, { product_id: 'A', nombre: 'Arroz', cantidad: 2 }] })], { ctx: ctxSinFlag });
  const card = c.body.proposals.find((p) => p.type === 'compra');
  assert.deepEqual(card.lineas.map((l) => l.product_id), ['A']); assert.deepEqual(card.omitidas, [{ nombre: 'Recarga', motivo: 'no controla inventario' }]);
  assert.match(c.body.reply, /«Recarga» no controla inventario/);
  // la marca del aparato (controla:false) se respeta aunque no haya base
  assert.equal(sanitizeContext({ products: [{ id: 'S', nombre: 'Recarga', controla: false }] }, 'owner').products[0].controla, false);
  const off = toProposal({ name: 'proponer_ajuste_stock', arguments: { product_id: 'S', tipo: 'salida', cantidad: 1 } }, 'owner', sanitizeContext({ products: [{ id: 'S', nombre: 'Recarga', controla: false }] }, 'owner'), 1);
  assert.equal(off.dropped, 'sin_control_stock');
  // en confirm: el producto dejó de controlar inventario después de la tarjeta -> 409 con el motivo, aprobación sin gastar
  const a = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })]);
  const later = { products: async () => [{ id: 'A', nombre: 'Arroz', controla: false }] };
  const r = await confirm(a.store, a.body.proposals[0], null, { reader: later });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'sin_control_stock'); assert.match(r.body.message, /«Arroz» no controla inventario/); assert.equal(r.spent, 0);
});

test('3) ajuste en el aparato: se revisa ANTES de gastar la tarjeta y se dice el motivo real', async () => {
  let confirms = 0, opened = 0;
  const base = { roles: () => ({ role: 'owner', isOwner: () => true }), online: () => true, confirm: async () => { confirms++; return { ok: true, operation_id: 'AST-1' }; } };
  const card = { id: 'k1', type: 'ajuste', needsConfirm: true, confirm_token: 't', product_id: 'S', nombre: 'Recarga', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' };
  const g1 = C.createGate({ ...base, productos: () => [{ id: 'S', name: 'Recarga', controlInventario: false }], openStockMove: () => { opened++; return true; } });
  const r1 = await g1.execute(g1.add(card), { confirmed: true });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'precheck'); assert.match(r1.msg, /«Recarga» no controla inventario/); assert.equal(confirms, 0, 'no se gastó la tarjeta'); assert.equal(opened, 0);
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
  assert.match(ui, /var pre = C\.precheck \? C\.precheck\(p, deps\) : null;\n\s*if \(pre\)[^\n]*return; }\n\s*if \(pinEl && !approvals\[p\.id\]\)/, 'la revisión va ANTES del PIN');
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
    assert.equal(r.status, st, name); assert.equal(r.body.error, err, name); assert.equal(r.spent, 0, name + ': aprobación sin gastar');
  }
  assert.equal((await confirm(a.store, card, null)).status, 200, 'con la base bien, pasa');
});

test('confirm: 429 y 403 de rol se anotan AGRUPADOS; los demás rechazos, uno por uno', async () => {
  const rows = []; const audit = async (_db, r) => { rows.push(...r); };
  const store = createMemoryUsageStore();
  const { body } = await chat([tool('proponer_ajuste_stock', { product_id: 'A', tipo: 'salida', cantidad: 1, motivo: 'Merma / daño' })], { store });
  const card = body.proposals[0]; const { confirm_token, ...proposal } = card;
  const send = (extra = {}) => assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', headers: extra.noApproval ? {} : { 'x-owner-approval': 'apr' }, body: JSON.stringify({ token: confirm_token, proposal }) }), { ...ENV, ASSISTANT_CONFIRMS_PER_MINUTE: '0' }, OWN, jsonR,
    { store, resolveRole: async () => extra.role || 'owner', verifyApproval: async () => true, reader, audit });
  assert.equal((await send({ noApproval: true })).status, 403);
  assert.equal((await send()).status, 429);
  assert.equal((await send({ role: 'empleado:off' })).status, 403);
  assert.deepEqual(rows.map((r) => [r.outcome, !!r.aggregate]), [['rejected:owner_approval_required', false], ['rejected:rate_limited', true], ['rejected:assistant_off', true]]);
  assert.ok(rows.every((r) => r.device_id === OWN.principalId));
});
