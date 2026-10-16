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
  const calls = { posAdd: [], navigate: [], editor: [], confirm: 0, purchase: 0, doc: 0 };
  return { calls, d: Object.assign({
    roles: () => roles, online: () => true, productos: () => PRODUCTS,
    confirm: async () => { calls.confirm++; return { ok: true, operation_id: 'AST-0001' }; },
    posAdd: (id) => { calls.posAdd.push(id); return true; }, navigate: (id) => calls.navigate.push(id),
    openPurchase: () => { calls.purchase++; return {}; }, fillPurchase: () => {}, openPriceEditor: (id, p) => calls.editor.push([id, p]),
    showDocument: () => { calls.doc++; }, businessName: () => 'Prueba'
  }, extra) };
}
const venta = { id: 'p1-preparar_venta', type: 'venta', needsConfirm: true, confirm_token: 't', lineas: [{ product_id: 'P1', nombre: 'Paracetamol', cantidad: 2, precio: 0.5 }] };
const precio = { id: 'p1-precio', type: 'precio', needsConfirm: true, confirm_token: 't', product_id: 'P1', nombre: 'Paracetamol', precio_actual: 0.5, precio_nuevo: 0.6 };

test('tabla única de permisos: rutas del asistente para ambos roles, acciones de dueño solo dueño', () => {
  for (const path of ['/auth/assistant/chat', '/auth/assistant/confirm']) assert.deepEqual([...PERMISSIONS.routeRoles(path, 'POST')].sort(), ['empleado', 'owner']);
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
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(venta);
  assert.equal((await g.execute(venta.id)).ok, false);
  assert.equal((await g.execute(venta.id, { confirmed: 'yes' })).ok, false);
  assert.equal(calls.confirm, 0); assert.equal(calls.posAdd.length, 0);
});

test('Confirmar en venta: pide el token al Worker y llena el carrito con posAdd; no cobra', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(venta);
  const r = await g.execute(venta.id, { confirmed: true });
  assert.equal(r.ok, true); assert.equal(calls.confirm, 1); assert.deepEqual(calls.posAdd, ['P1', 'P1']); assert.deepEqual(calls.navigate, ['pagePOS']);
  assert.equal(g.operationId(venta.id), 'AST-0001');
});

test('doble y triple toque: una sola confirmación y una sola ejecución', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(venta);
  const rs = await Promise.all([g.execute(venta.id, { confirmed: true }), g.execute(venta.id, { confirmed: true }), g.execute(venta.id, { confirmed: true })]);
  assert.ok(rs.every((r) => r.ok)); assert.equal(calls.confirm, 1); assert.equal(calls.posAdd.length, 2);
  const again = await g.execute(venta.id, { confirmed: true });
  assert.match(again.msg, /no se repitió/i); assert.equal(calls.posAdd.length, 2);
});

test('corte de señal al confirmar: reintento con el mismo token, se ejecuta una vez', async () => {
  let n = 0; const tokens = [];
  const { d, calls } = deps(owner, { confirm: async (p) => { tokens.push(p.confirm_token); n++; if (n === 1) throw new Error('network'); return { ok: true, operation_id: 'AST-0001', already_confirmed: n > 2 }; } });
  const g = C.createGate(d); g.add(venta);
  const r1 = await g.execute(venta.id, { confirmed: true });
  assert.equal(r1.ok, false); assert.equal(r1.retry, true); assert.equal(calls.posAdd.length, 0);
  const r2 = await g.execute(venta.id, { confirmed: true });
  assert.equal(r2.ok, true); assert.equal(calls.posAdd.length, 2);
  assert.deepEqual(tokens, ['t', 't']);
});

test('empleado: cambio de precio denegado en el aparato, sin abrir la ficha ni gastar token', async () => {
  const { d, calls } = deps(emp); const g = C.createGate(d); g.add(precio);
  const r = await g.execute(precio.id, { confirmed: true });
  assert.equal(r.ok, false); assert.match(r.msg, /Solo el dueño/); assert.equal(calls.confirm, 0); assert.equal(calls.editor.length, 0);
  assert.equal(g.state(precio.id), 'denied');
  // dueño sin rol confirmado por el servidor tampoco
  const { d: d2, calls: c2 } = deps({ role: 'owner', isOwner: () => false }); const g2 = C.createGate(d2); g2.add(precio);
  assert.equal((await g2.execute(precio.id, { confirmed: true })).ok, false); assert.equal(c2.editor.length, 0);
  // dueño confirmado: abre la ficha existente con el precio (guardar sigue siendo del POS)
  const { d: d3, calls: c3 } = deps(owner); const g3 = C.createGate(d3); g3.add(precio);
  assert.equal((await g3.execute(precio.id, { confirmed: true })).ok, true); assert.deepEqual(c3.editor, [['P1', 0.6]]);
});

test('sin internet, sin token o rol desconocido: no se ejecuta', async () => {
  const off = deps(owner, { online: () => false }); const g = C.createGate(off.d); g.add(venta);
  assert.match((await g.execute(venta.id, { confirmed: true })).msg, /sin internet/); assert.equal(off.calls.confirm, 0);
  const nt = deps(owner); const g2 = C.createGate(nt.d); g2.add({ ...venta, id: 'x', confirm_token: null });
  assert.equal((await g2.execute('x', { confirmed: true })).ok, false); assert.equal(nt.calls.posAdd.length, 0);
  const un = deps({ role: 'unknown' }); const g3 = C.createGate(un.d); g3.add(venta);
  assert.equal((await g3.execute(venta.id, { confirmed: true })).ok, false);
});

test('Worker rechaza (vencido o rol): la tarjeta queda bloqueada', async () => {
  const { d, calls } = deps(owner, { confirm: async () => ({ ok: false, error: 'confirm_expired' }) }); const g = C.createGate(d); g.add(venta);
  const r = await g.execute(venta.id, { confirmed: true });
  assert.match(r.msg, /venció/); assert.equal(g.state(venta.id), 'denied'); assert.equal(calls.posAdd.length, 0);
});

test('cancelar impide ejecutar después', async () => {
  const { d, calls } = deps(owner); const g = C.createGate(d); g.add(venta); g.cancel(venta.id);
  assert.equal((await g.execute(venta.id, { confirmed: true })).ok, false); assert.equal(calls.confirm, 0);
});

test('contexto del celular: sin clientes, sin DNI y sin costos para el empleado', () => {
  const list = [{ id: 'P9', name: 'Jarabe cliente 45678912', precio: 3, costo: 1, stock: 2, dni: '45678912', cliente: 'Ana' }];
  const e = C.buildContext(list, 'empleado', 'pagePOS', 'jarabe');
  assert.deepEqual(Object.keys(e.products[0]).sort(), ['id', 'nombre', 'precio', 'stock']);
  assert.ok(!JSON.stringify(e).includes('45678912'));
  assert.equal(C.buildContext(list, 'owner', null, '').products[0].costo, 1);
});

test('documento: siempre marcado como NO comprobante SUNAT y escapado', () => {
  const html = C.documentHtml({ title: 'Nota', tipo: 'nota_venta', lineas: [{ nombre: '<script>x</script>', cantidad: 2, precio: 1.5 }] }, 'Botica');
  assert.ok(html.includes('NO ES COMPROBANTE SUNAT')); assert.ok(!html.includes('<script>x')); assert.ok(html.includes('S/ 3.00'));
});
