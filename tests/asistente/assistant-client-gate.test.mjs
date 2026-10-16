// Pruebas del lado del celular: permisos (cliente + tabla única) y la puerta «Confirmar».
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../POS/js/config/pos-permissions.js';
import { createRequire } from 'node:module';
import { PERMISSIONS } from '../../tools/cloudflare-lab/src/pos-permissions.js';
import { toolsForRole, TOOL_ACTIONS } from '../../tools/cloudflare-lab/src/pos-assistant.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');

const owner = { role: 'owner', isOwner: () => true };
const emp = { role: 'empleado', isOwner: () => false };
const PRODUCTS = [{ id: 'P1', name: 'Paracetamol 500 mg', precio: 0.5, costo: 0.2, stock: 100 }];
function deps(roles, extra = {}) {
  const calls = { stock: [], navigate: [], editor: [], newProd: [], confirm: 0, purchase: 0, doc: 0 };
  return { calls, d: Object.assign({
    roles: () => roles, online: () => true, productos: () => PRODUCTS,
    confirm: async () => { calls.confirm++; return { ok: true, operation_id: 'AST-0001' }; },
    openStockMove: (id, tipo, cant, motivo) => { calls.stock.push([id, tipo, cant, motivo]); return true; }, navigate: (id) => calls.navigate.push(id),
    openPurchase: () => { calls.purchase++; return {}; }, fillPurchase: () => {}, openProductEditor: (id, p) => calls.editor.push([id, p]),
    openNewProduct: (p) => { calls.newProd.push(p.nombre); return true; },
    showDocument: () => { calls.doc++; }, businessName: () => 'Prueba'
  }, extra) };
}
const ajuste = { id: 'p1-ajuste', type: 'ajuste', needsConfirm: true, confirm_token: 't', product_id: 'P1', nombre: 'Paracetamol', tipo: 'salida', cantidad: 2, motivo: 'Merma / daño' };
const precio = { id: 'p1-precio', type: 'precio', needsConfirm: true, confirm_token: 't', product_id: 'P1', nombre: 'Paracetamol', precio_actual: 0.5, precio_nuevo: 0.6 };

test('tabla única de permisos: chat/confirm para dueño y empleado (el servidor revisa el nivel), cambiar niveles solo dueño', () => {
  for (const path of ['/auth/assistant/chat', '/auth/assistant/confirm']) assert.deepEqual([...PERMISSIONS.routeRoles(path, 'POST')].sort(), ['empleado', 'owner']);
  for (const m of ['GET', 'POST']) assert.deepEqual([...PERMISSIONS.routeRoles('/auth/assistant/employee-access', m)], ['owner']);
  for (const a of Object.values(TOOL_ACTIONS)) assert.equal(PERMISSIONS.canDo('empleado', a), false, a);
  assert.deepEqual([...PERMISSIONS.routeRoles('/auth/assistant/chat', 'GET')], ['owner'], 'otros métodos: denegado por defecto');
  assert.equal(PERMISSIONS.canDo('empleado', 'assistant.price.propose'), false);
  assert.equal(PERMISSIONS.canDo('empleado', 'assistant.purchase.propose'), false);
  assert.equal(PERMISSIONS.canDo('owner', 'assistant.price.propose'), true);
  assert.equal(PERMISSIONS.canDo('unknown', 'assistant.chat'), false);
  // El Worker ofrece exactamente lo que la tabla permite.
  for (const role of ['owner', 'empleado']) for (const [toolName, action] of Object.entries(TOOL_ACTIONS))
    assert.equal(toolsForRole(role).some((t) => t.function.name === toolName), PERMISSIONS.canDo(role, action));
  assert.equal(toolsForRole('unknown').length, 0);
});

test('nada se ejecuta sin confirmed:true', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(ajuste);
  assert.equal((await g.execute(ajuste.id)).ok, false);
  assert.equal((await g.execute(ajuste.id, { confirmed: 'yes' })).ok, false);
  assert.equal(calls.confirm, 0); assert.equal(calls.stock.length, 0);
});

test('Confirmar en ajuste: pide el token al Worker y abre «Registrar movimiento» lleno; no guarda solo', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(ajuste);
  const r = await g.execute(ajuste.id, { confirmed: true });
  assert.equal(r.ok, true); assert.equal(calls.confirm, 1); assert.deepEqual(calls.stock, [['P1', 'salida', 2, 'Merma / daño']]);
  assert.equal(C.EXECUTORS.venta, undefined, 'no existe ejecutor de venta: el asistente no llena el carrito');
  assert.equal(g.operationId(ajuste.id), 'AST-0001');
});

test('doble y triple toque: una sola confirmación y una sola ejecución', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(ajuste);
  const rs = await Promise.all([g.execute(ajuste.id, { confirmed: true }), g.execute(ajuste.id, { confirmed: true }), g.execute(ajuste.id, { confirmed: true })]);
  assert.ok(rs.every((r) => r.ok)); assert.equal(calls.confirm, 1); assert.equal(calls.stock.length, 1);
  const again = await g.execute(ajuste.id, { confirmed: true });
  assert.match(again.msg, /no se repitió/i); assert.equal(calls.stock.length, 1);
});

test('corte de señal al confirmar: reintento con el mismo token, se ejecuta una vez', async () => {
  let n = 0; const tokens = [];
  const { d, calls } = deps(owner, { confirm: async (p) => { tokens.push(p.confirm_token); n++; if (n === 1) throw new Error('network'); return { ok: true, operation_id: 'AST-0001', already_confirmed: n > 2 }; } });
  const g = C.createGate(d); g.add(ajuste);
  const r1 = await g.execute(ajuste.id, { confirmed: true });
  assert.equal(r1.ok, false); assert.equal(r1.retry, true); assert.equal(calls.stock.length, 0);
  const r2 = await g.execute(ajuste.id, { confirmed: true });
  assert.equal(r2.ok, true); assert.equal(calls.stock.length, 1);
  assert.deepEqual(tokens, ['t', 't']);
});

test('empleado: nada se ejecuta en el aparato (asistente solo para el dueño), sin abrir la ficha ni gastar token', async () => {
  const { d, calls } = deps(emp); const g = C.createGate(d); g.add(precio);
  const r = await g.execute(precio.id, { confirmed: true });
  assert.equal(r.ok, false); assert.match(r.msg, /solo para el dueño/); assert.equal(calls.confirm, 0); assert.equal(calls.editor.length, 0);
  assert.equal(g.state(precio.id), 'denied');
  // dueño sin rol confirmado por el servidor tampoco
  const { d: d2, calls: c2 } = deps({ role: 'owner', isOwner: () => false }); const g2 = C.createGate(d2); g2.add(precio);
  assert.equal((await g2.execute(precio.id, { confirmed: true })).ok, false); assert.equal(c2.editor.length, 0);
  // dueño confirmado: abre la ficha existente con el precio (guardar sigue siendo del POS)
  const { d: d3, calls: c3 } = deps(owner); const g3 = C.createGate(d3); g3.add(precio);
  assert.equal((await g3.execute(precio.id, { confirmed: true })).ok, true); assert.deepEqual(c3.editor, [['P1', { precio: 0.6 }]]);
});

test('sin internet, sin token o rol desconocido: no se ejecuta', async () => {
  const off = deps(owner, { online: () => false }); const g = C.createGate(off.d); g.add(ajuste);
  assert.match((await g.execute(ajuste.id, { confirmed: true })).msg, /sin internet/); assert.equal(off.calls.confirm, 0);
  const nt = deps(owner); const g2 = C.createGate(nt.d); g2.add({ ...ajuste, id: 'x', confirm_token: null });
  assert.equal((await g2.execute('x', { confirmed: true })).ok, false); assert.equal(nt.calls.stock.length, 0);
  const un = deps({ role: 'unknown' }); const g3 = C.createGate(un.d); g3.add(ajuste);
  assert.equal((await g3.execute(ajuste.id, { confirmed: true })).ok, false);
});

test('Worker rechaza (vencido o rol): la tarjeta queda bloqueada', async () => {
  const { d, calls } = deps(owner, { confirm: async () => ({ ok: false, error: 'confirm_expired' }) }); const g = C.createGate(d); g.add(ajuste);
  const r = await g.execute(ajuste.id, { confirmed: true });
  assert.match(r.msg, /venció/); assert.equal(g.state(ajuste.id), 'denied'); assert.equal(calls.stock.length, 0);
});

test('cancelar impide ejecutar después', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(ajuste); g.cancel(ajuste.id);
  assert.equal((await g.execute(ajuste.id, { confirmed: true })).ok, false); assert.equal(calls.confirm, 0);
});

test('contexto del celular: sin clientes, sin DNI y sin costos para el empleado', () => {
  const list = [{ id: 'P9', name: 'Jarabe cliente 45678912', precio: 3, costo: 1, stock: 2, dni: '45678912', cliente: 'Ana' }];
  const e = C.buildContext(list, 'empleado', 'pageInventario', 'jarabe');
  assert.deepEqual(Object.keys(e.products[0]).sort(), ['id', 'nombre', 'precio', 'stock']);
  assert.ok(!JSON.stringify(e).includes('45678912'));
  assert.equal(C.buildContext(list, 'owner', null, '').products[0].costo, 1);
});

const DOC = (tipo, extra = {}) => ({ id: 'd', type: 'documento', tipo, title: 'Doc ' + tipo, fiscal: false, ...extra });
test('documento: NO comprobante SUNAT, escapado, y sin el módulo del POS no inventa cifras', async () => {
  const html = (await C.buildDocument(DOC('lista_precios'), { productos: [{ id: 'X', name: '<script>x</script>', precio: 1.5 }] }, 'Botica')).html;
  assert.ok(html.includes('NO ES COMPROBANTE SUNAT')); assert.ok(!html.includes('<script>x')); assert.ok(html.includes('S/ 1.50'));
  for (const t of ['inventario_valorizado', 'reporte_ventas', 'estado_cuenta', 'resumen_cierre']) {
    const d = await C.buildDocument(DOC(t, { cliente: 'Rosa' }), { productos: [{ id: 'X', name: 'Y', precio: 1, costo: 1, stock: 1 }] }, 'Botica');
    assert.match(d.html, /No disponible/, t); assert.ok(!/S\/ \d/.test(d.html), t + ': sin cuentas propias');
  }
});

test('documentos con dinero: usan los cálculos del POS (mismos números que la pantalla) y llevan los avisos heredados', async () => {
  const seen = [];
  const api = {
    valorizacion: (p) => { seen.push('valorizacion:' + p.length); return { rows: [{ category: 'Farmacia', products: 2, units: 5, costValue: 1.11, saleValue: 2.22 }], totals: { products: 2, units: 5, costValue: 1.11, saleValue: 2.22, noCostProducts: 1 } }; },
    totalV: (v) => { seen.push('totalV'); return v.raw * 2; },
    deudaReport: () => { seen.push('deuda'); return { rows: [{ name: 'Rosa Quispe', balance: 10.05, overdueDebt: 3, oldestDate: '2026-10-01', openCredits: 1 }], total: 10.05, count: 1 }; },
    summarizeClient: (c, ro) => { seen.push('summary:' + ro); return { active: [{ desc: 'Fiado', monto: 20, pagado: 9.95 }], overdueDebt: 0 }; },
    effectiveBalance: () => 7.77, pending: () => null, outstanding: (c) => c.monto - c.pagado,
    cashCloses: async (d, h) => { seen.push('arqueo:' + d + ':' + h); return { fromServer: true, report: { range: { desde: d, hasta: h }, rows: [{ fechaLabel: '15/10', hora: '20:00', closedByName: 'Dueño', esperado: 12345, contado: 12300, diferencia: -45 }], totals: { count: 1, esperado: 12345, contado: 12300, diferencia: -45, sinContar: 0 } } }; }
  };
  const data = { api, productos: [{ id: 'A' }, { id: 'B' }], ventas: [{ fecha: '2026-10-15T10:00', raw: 1.5, metodo: 'efectivo' }, { fecha: '2026-10-15T11:00', raw: 9, metodo: 'yape', anulada: true }], clientes: [{ id: 'C1', nombre: 'Rosa Quispe', dni: '45678912' }] };
  const v = (await C.buildDocument(DOC('inventario_valorizado'), data, 'B')).html;
  assert.ok(v.includes('S/ 1.11') && v.includes('S/ 2.22')); assert.match(v, /no actualiza el costo/);
  const s = (await C.buildDocument(DOC('reporte_ventas', { desde: '2026-10-15', hasta: '2026-10-15' }), data, 'B')).html;
  assert.ok(s.includes('S/ 3.00'), 'suma totalV(v) sin la anulada'); assert.ok(!s.includes('S/ 18.00')); assert.match(s, /efectivo y pagos digitales/);
  const e = (await C.buildDocument(DOC('estado_cuenta', { cliente: 'rosa quispe' }), data, 'B')).html;
  assert.ok(e.includes('S/ 7.77'), 'saldo = effectiveBalance como en Clientes'); assert.ok(!e.includes('45678912') && e.includes('8912'));
  const c = (await C.buildDocument(DOC('resumen_cierre', { desde: '2026-10-15', hasta: '2026-10-15' }), data, 'B')).html;
  assert.ok(c.includes('S/ 123.45') && c.includes('S/ -0.45')); assert.match(c, /servidor/); assert.match(c, /efectivo y pagos digitales/);
  assert.deepEqual(seen, ['valorizacion:2', 'totalV', 'summary:true', 'arqueo:2026-10-15:2026-10-15']);
  for (const h of [v, s, e, c]) assert.ok(h.includes('NO ES COMPROBANTE SUNAT'));
});

test('consulta y documento no piden token ni PIN; el ejecutor de documento es asíncrono y muestra el resultado', async () => {
  const { d, calls } = deps(owner, { data: () => ({ productos: [], api: {} }) });
  const r = await C.EXECUTORS.documento(DOC('lista_precios'), d);
  assert.equal(r.ok, true); assert.equal(calls.doc, 1); assert.equal(calls.confirm, 0); assert.match(r.msg, /No es comprobante SUNAT/);
});

// ---- Hallazgo de Bot 2 (ALTO): con la tarjeta 1 pendiente, Confirmar en la tarjeta 2 ejecutaba la propuesta de la tarjeta 1 ----
import { assistantChatRoute, assistantConfirmRoute, createMemoryUsageStore } from '../../tools/cloudflare-lab/src/pos-assistant.js';
const jsonR = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ENV = { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', ASSISTANT_DEMO: '1' };
const OWN = { principalId: 'session:dev-owner', posRole: 'owner' };
const CTX = { products: [{ id: 'A', nombre: 'Arroz', precio: 12.34, stock: 50 }, { id: 'G', nombre: 'Gaseosa', precio: 12.34, stock: 50 }] };
async function serverCard(store, text) {
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: JSON.stringify({ text, context: CTX }) }), ENV, OWN, jsonR, { store, resolveRole: async () => 'owner' });
  return (await r.json()).proposals[0];
}
function serverConfirm(store) {
  return async (p, review) => { const { confirm_token, ...proposal } = p;
    const r = await assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', headers: { 'x-owner-approval': 'apr-test' }, body: JSON.stringify({ token: confirm_token, proposal, review }) }), ENV, OWN, jsonR, { store, resolveRole: async () => 'owner', verifyApproval: async () => true });
    return r.json(); };
}

test('dos tarjetas pendientes: Confirmar en la segunda abre SOLO la segunda (Worker real)', async () => {
  const store = createMemoryUsageStore();
  const c1 = await serverCard(store, 'merma de 2 arroz');
  const c2 = await serverCard(store, 'merma de 1 gaseosa');
  assert.notEqual(c1.id, c2.id, 'ids distintos generados por el servidor');
  const { d, calls } = deps(owner, { productos: () => [{ id: 'A', name: 'Arroz' }, { id: 'G', name: 'Gaseosa' }], confirm: serverConfirm(store) });
  const gate = C.createGate(d);
  const k1 = gate.add(c1), k2 = gate.add(c2);
  const r = await gate.execute(k2, { confirmed: true });
  assert.equal(r.ok, true, r.msg); assert.deepEqual(calls.stock, [['G', 'salida', 1, 'Merma / daño']]);
  assert.equal(gate.state(k1), 'pending', 'la tarjeta 1 sigue sin tocar');
});

test('id repetido con otro token (como el error viejo): cada tarjeta conserva su propia propuesta', async () => {
  const a = { ...ajuste, id: 'p1-ajuste', confirm_token: 't1', product_id: 'A', cantidad: 3 };
  const b = { ...ajuste, id: 'p1-ajuste', confirm_token: 't2', product_id: 'G', cantidad: 1 };
  const seen = [];
  const { d, calls } = deps(owner, { productos: () => [{ id: 'A', name: 'Arroz' }, { id: 'G', name: 'Gaseosa' }], confirm: async (p) => { seen.push(p.confirm_token); return { ok: true, operation_id: 'AST-x', proposal: p }; } });
  const gate = C.createGate(d);
  const ka = gate.add(a), kb = gate.add(b);
  assert.notEqual(ka, kb);
  await gate.execute(kb, { confirmed: true });
  assert.deepEqual(seen, ['t2']); assert.deepEqual(calls.stock.map((x) => x[0]), ['G']);
});

test('se aplica la propuesta devuelta por el servidor; si no coincide con la tarjeta, no se ejecuta nada', async () => {
  const mine = { ...ajuste, id: 'u-1' };
  const { d, calls } = deps(owner, { confirm: async () => ({ ok: true, operation_id: 'AST-1', proposal: { ...mine, id: 'u-otra' } }) });
  const gate = C.createGate(d); const k = gate.add(mine);
  const r = await gate.execute(k, { confirmed: true });
  assert.equal(r.ok, false); assert.deepEqual(calls.stock, []);
});

test('producto nuevo: abre «Nuevo producto» lleno solo después de Confirmar', async () => {
  const p = { id: 'u-p', type: 'producto', needsConfirm: true, confirm_token: 't', nombre: 'Jabón inventado', precio: 3, costo: 2 };
  const { d, calls } = deps(owner); const g = C.createGate(d); const k = g.add(p);
  assert.deepEqual(calls.newProd, []);
  assert.equal((await g.execute(k, { confirmed: true })).ok, true); assert.deepEqual(calls.newProd, ['Jabón inventado']);
});

test('compra con filas marcadas: la revisión (aceptar/quitar) viaja a confirm y se abre la compra con lo que devolvió el servidor', async () => {
  let got = null, filled = null;
  const p = { id: 'u-c', type: 'compra', needsConfirm: true, confirm_token: 't', lineas: [{ nombre: 'X', cantidad: 9999, costo_unitario: 99999, revisar: ['cantidad'] }, { nombre: 'Y', cantidad: 2, costo_unitario: 1 }] };
  const { d } = deps(owner, { confirm: async (pp, review) => { got = review; return { ok: true, operation_id: 'AST-2', proposal: { ...pp, lineas: [pp.lineas[1]], quitadas: [0] } }; }, fillPurchase: (w, x) => { filled = x; } });
  const gate = C.createGate(d); const k = gate.add(p);
  const r = await gate.execute(k, { confirmed: true, review: { op: 'AST-2', accept: [], drop: [0] } });
  assert.equal(r.ok, true); assert.deepEqual(got, { op: 'AST-2', accept: [], drop: [0] });
  assert.deepEqual(filled.lineas.map((l) => l.nombre), ['Y'], 'la fila quitada no llega a «Nueva compra»');
});

// ---- Hallazgo de Bot 3 (P1): el cliente no tenía límite de tiempo ----
const hanging = (log) => (url, init) => new Promise((_, reject) => { log.push(url); init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); });

test('request: un servidor que no responde se aborta a tiempo (AbortController) y lanza timeout', async () => {
  const log = []; const t0 = Date.now();
  await assert.rejects(C.request(hanging(log), '/auth/assistant/chat', { method: 'POST' }, 80), (e) => e.timeout === true);
  assert.ok(Date.now() - t0 < 1000); assert.deepEqual(log, ['/auth/assistant/chat']);
  // respuesta normal
  const r = await C.request(async () => new Response('{"ok":true}', { status: 200 }), '/x', {}, 500);
  assert.deepEqual(r.data, { ok: true }); assert.equal(r.ok, true);
  // cuerpo que nunca termina también se corta
  await assert.rejects(C.request(async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }), '/x', {}, 60), (e) => e.timeout === true);
  assert.ok(C.TIMEOUTS.chat >= 25000 && C.TIMEOUTS.chat <= 35000, 'chat ~30 s, más que los 25 s del Worker');
  assert.ok(C.TIMEOUTS.confirm >= 10000 && C.TIMEOUTS.confirm <= 15000, 'confirm 10-15 s por intento');
});

test('confirm que se corta por tiempo: «Pulsa Confirmar otra vez», sigue pendiente y el reintento usa el MISMO token', async () => {
  const tokens = []; let n = 0;
  const { d, calls } = deps(owner, { confirm: async (p) => { tokens.push(p.confirm_token); if (++n === 1) { const e = new Error('timeout'); e.timeout = true; throw e; } return { ok: true, operation_id: 'AST-9', proposal: p }; } });
  const gate = C.createGate(d); const k = gate.add({ ...ajuste, id: 'u-t', confirm_token: 'tok-1' });
  const r1 = await gate.execute(k, { confirmed: true });
  assert.equal(r1.ok, false); assert.match(r1.msg, /Volver a intentar/); assert.equal(C.confirmFailureView(r1).button, 'Volver a intentar'); assert.equal(gate.state(k), 'pending'); assert.deepEqual(calls.stock, []);
  const r2 = await gate.execute(k, { confirmed: true });
  assert.equal(r2.ok, true); assert.deepEqual(tokens, ['tok-1', 'tok-1']); assert.equal(calls.stock.length, 1);
});

test('contexto por mensaje: coincidencias primero y tope de ~2 KB', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 'X' + i, name: 'Producto inventado con nombre largo ' + i, precio: 1, stock: 1 }));
  many.push({ id: 'AMOX', name: 'Amoxicilina 500 mg', precio: 2, stock: 5 });
  const c = C.buildContext(many, 'owner', 'pageInventario', 'stock de amoxicilina');
  assert.equal(c.products[0].id, 'AMOX');
  assert.ok(JSON.stringify(c).length <= 2100, 'tamaño ' + JSON.stringify(c).length);
  assert.ok(c.products.length <= 25);
});

test('niveles en el aparato: empleado con nivel puede pedir tarjetas (el PIN del dueño lo exige el servidor); costos y documentos de dueño no', () => {
  const lvl = (level) => ({ role: 'empleado', level, isOwner: () => false });
  assert.equal(C.canExecute(lvl('off'), ajuste).ok, false);
  assert.equal(C.canExecute(lvl('consultas'), ajuste).ok, true);
  assert.equal(C.canExecute(lvl('consultas'), { type: 'costo' }).ok, false);
  assert.equal(C.canExecute(lvl('consultas'), { type: 'documento', tipo: 'lista_precios' }).ok, false, 'Solo consultas: sin documentos');
  assert.equal(C.canExecute(lvl('consultas_documentos'), { type: 'documento', tipo: 'lista_precios' }).ok, true);
  assert.equal(C.canExecute(lvl('consultas_documentos'), { type: 'documento', tipo: 'inventario_valorizado' }).ok, false);
});

test('lista de pedido: la del empleado usa SOLO las filas del servidor (sin costos); la del dueño trae costo e inversión', async () => {
  const local = [{ id: 'A', name: 'Arroz', stock: 1, stockMin: 5, costo: 3.33, precio: 5, controlInventario: true }];
  const emp = await C.buildDocument({ type: 'documento', tipo: 'lista_pedido', title: 'Pedido', data: { columnas: ['Producto', 'Stock', 'Cantidad sugerida'], filas: [['Arroz', 1, 9]] } }, { productos: local }, 'B');
  assert.ok(!/3\.33|Costo|Inversi/i.test(emp.html.replace(/no actualiza el costo/g, '')), 'sin costos'); assert.ok(emp.html.includes('Arroz') && emp.html.includes('NO ES COMPROBANTE SUNAT'));
  const own = await C.buildDocument({ type: 'documento', tipo: 'lista_pedido', title: 'Pedido' }, { productos: local }, 'B');
  assert.ok(own.html.includes('S/ 3.33') && /Inversi/.test(own.html) && own.html.includes('S/ 29.97'));
});

test('tarjeta nunca trabada: 422 review_required marca filas, 429 «Volver a intentar», sin aprobación vuelve a pedir PIN; siempre «Pedir de nuevo»', async () => {
  const answers = [
    { ok: false, error: 'review_required', rows: [0, 2], operation_id: 'AST-R' },
    { ok: false, error: 'rate_limited', retry_after_s: 12 },
    { ok: false, error: 'owner_approval_required' },
    { ok: true, operation_id: 'AST-R' },
  ];
  const tokens = []; const { d, calls } = deps(owner, { confirm: async (p) => { tokens.push(p.confirm_token); return answers.shift(); } });
  const g = C.createGate(d); const k = g.add({ ...ajuste, id: 'nt-1', confirm_token: 'tok-nt' });
  const r1 = await g.execute(k, { confirmed: true });
  assert.equal(r1.ok, false); assert.equal(r1.code, 'review_required'); assert.deepEqual(r1.rows, [0, 2]); assert.equal(g.state(k), 'pending');
  const v1 = C.confirmFailureView(r1);
  assert.deepEqual([v1.kind, v1.rows, v1.button, v1.keepApproval, v1.again], ['review', [0, 2], 'Confirmar', true, true]);
  const r2 = await g.execute(k, { confirmed: true });
  const v2 = C.confirmFailureView(r2);
  assert.equal(r2.code, 'rate_limited'); assert.equal(g.state(k), 'pending');
  assert.equal(v2.msg, 'Espera un momento y vuelve a intentar.'); assert.equal(v2.button, 'Volver a intentar'); assert.equal(v2.keepApproval, true); assert.equal(v2.again, true);
  assert.equal(C.confirmFailureView({ ok: false, code: 'HTTP_429' }).kind, 'wait');
  const r3 = await g.execute(k, { confirmed: true });
  const v3 = C.confirmFailureView(r3);
  assert.equal(v3.kind, 'pin'); assert.equal(v3.keepApproval, false, 'la aprobación se descarta y se pide el PIN otra vez'); assert.equal(g.state(k), 'pending');
  assert.equal(calls.stock.length, 0, 'nada se abrió mientras el servidor no aceptó');
  const r4 = await g.execute(k, { confirmed: true });
  assert.equal(r4.ok, true); assert.equal(calls.stock.length, 1);
  assert.deepEqual(tokens, ['tok-nt', 'tok-nt', 'tok-nt', 'tok-nt'], '«Volver a intentar» reenvía la MISMA tarjeta');
  for (const r of [r1, r2, r3]) assert.equal(C.confirmFailureView(r).again, true);
  assert.equal(C.confirmFailureView({ ok: true }), null);
  assert.deepEqual(C.confirmFailureView({ ok: false, code: 'review_required', rows: [1, -1, 'x', 2.5] }).rows, [1], 'solo índices válidos');
});

test('reintentos automáticos con tope; reenvío idempotente: already_confirmed abre una sola vez', async () => {
  assert.equal(C.CONFIRM_ATTEMPTS, 2);
  let n = 0; const { d, calls } = deps(owner, { confirm: async () => { if (++n === 1) throw new Error('network'); return { ok: true, operation_id: 'AST-I', already_confirmed: true }; } });
  const g = C.createGate(d); const k = g.add({ ...ajuste, id: 'id-1', confirm_token: 'tok-i' });
  const r1 = await g.execute(k, { confirmed: true });
  assert.equal(r1.code, 'network'); assert.equal(C.confirmFailureView(r1).kind, 'network');
  assert.equal((await g.execute(k, { confirmed: true })).ok, true); assert.equal(calls.stock.length, 1);
  const r3 = await g.execute(k, { confirmed: true });
  assert.equal(r3.ok, true); assert.match(r3.msg, /No se repitió/); assert.equal(calls.stock.length, 1); assert.equal(n, 2);
});

test('pantalla de la tarjeta: «Pedir de nuevo», reenvío sin PIN con aprobación vigente y tope de reintentos en el envío', async () => {
  const fs = await import('node:fs');
  const ui = fs.readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /data-again hidden>Pedir de nuevo</);
  assert.match(ui, /C\.confirmFailureView\(r\)/);
  assert.match(ui, /if \(pinEl && !approvals\[p\.id\]\)/, 'con aprobación vigente no vuelve a pedir el PIN');
  assert.match(ui, /if \(!f\.keepApproval\) delete approvals\[p\.id\]/);
  assert.match(ui, /t\.textContent = limit \? 'Fuera del límite: quita la fila o corrige la factura' : 'Revisa este dato'/);
  assert.match(ui, /i < \(C\.CONFIRM_ATTEMPTS \|\| 2\)/);
  assert.match(ui, /gate\.cancel\(key\); delete approvals\[p\.id\];[^\n]*\n[^\n]*\n\s*res\.textContent = 'Pidiendo una tarjeta nueva…'; send\(prompt\)/);
});
