// Niveles del asistente por aparato de empleado: Apagado (por defecto) / Solo consultas / Consultas y documentos.
// Base de datos real del laboratorio (activeCanon) y Worker real; DeepSeek no se llama (modo demostración o stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon } from '../cloud-sync/canon-browser-harness.mjs';
import { toolsForRole, EMPLOYEE_TOOLS } from '../../tools/cloudflare-lab/src/pos-assistant.js';

const MIG = ['0024_pos_roles_owner_pin.sql', '0025_pos_reviews_pin_failures.sql'];
const PIN = '4821';
async function setup(t, { log = false } = {}) {
  const f = await activeCanon(t, { migrations: log ? [...MIG, '0034_pos_assistant_access_log.sql'] : MIG });
  Object.assign(f.env, { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', ASSISTANT_DEMO: '1' });
  f.addDevice('dueno', 'writer', 'active', 'tok-dueno');
  f.addDevice('emp', 'writer', 'active', 'tok-emp');
  f.addDevice('emp2', 'writer', 'active', 'tok-emp2');
  const at = new Date().toISOString();
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES('session:dueno','owner','Dueño','test',?)", at);
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES('session:emp','empleado','Caja 2','session:dueno',?)", at);
  f.exec("INSERT INTO pos_device_roles(device_id,pos_role,label,created_by,created_at) VALUES('session:emp2','empleado','Caja 3','session:dueno',?)", at);
  const call = (tok, path, body, extra = {}, method = 'POST') => f.fetch('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', ...extra }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  assert.equal((await call('tok-dueno', '/auth/owner-pin', { new_pin: PIN })).status, 200);
  let nOp = 0;
  // Cambio de nivel: PIN -> aprobación de UN uso ligada a este operation_id -> POST con x-owner-approval (no hay PIN suelto en el cuerpo).
  const level = async (device, lvl, tok = 'tok-dueno', pin = PIN, op = 'lvl-' + (++nOp)) => {
    if (pin === '') return call(tok, '/auth/assistant/employee-access', { device_id: device, level: lvl, operation_id: op });
    const a = await call(tok, '/auth/owner-approval', { pin, action: 'assistant.employee_access', operation_id: op });
    if (a.status >= 300) return a;
    return call(tok, '/auth/assistant/employee-access', { device_id: device, level: lvl, operation_id: op }, { 'x-owner-approval': (await a.json()).approval_id });
  };
  const chat = async (tok, text) => { const r = await call(tok, '/auth/assistant/chat', { text, context: { products: [{ id: '00002', nombre: 'Synthetic 00002', precio: 12.34, costo: 0.29, stock: 1 }] } }); return { status: r.status, body: await r.json() }; };
  const confirm = async (tok, p, approval) => { const { confirm_token, ...proposal } = p; const r = await call(tok, '/auth/assistant/confirm', { token: confirm_token, proposal }, approval ? { 'x-owner-approval': approval } : {}); return { status: r.status, body: await r.json() }; };
  const approve = async (tok, action, op, pin = PIN) => { const r = await call(tok, '/auth/owner-approval', { pin, action, operation_id: op }); return { status: r.status, body: await r.json() }; };
  return { f, call, level, chat, confirm, approve };
}
const opOf = (p) => JSON.parse(Buffer.from(p.confirm_token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).op;

test('herramientas por nivel: apagado nada; consultas sin documentos; documentos con documentos; nunca venta', () => {
  assert.deepEqual(toolsForRole('empleado:off'), []);
  const c = toolsForRole('empleado:consultas').map((t) => t.function.name), d = toolsForRole('empleado:consultas_documentos').map((t) => t.function.name);
  assert.ok(c.includes('consultar') && !c.includes('preparar_documento')); assert.ok(d.includes('preparar_documento'));
  assert.deepEqual(new Set(EMPLOYEE_TOOLS.consultas_documentos), new Set([...EMPLOYEE_TOOLS.consultas, 'preparar_documento']));
  for (const n of [...c, ...d]) assert.ok(!/venta|carrito|cobr/.test(n));
});

test('apagado por defecto: el empleado recibe 403 assistant_off en chat, ping y confirm', async (t) => {
  const { chat, call } = await setup(t);
  const r = await chat('tok-emp', 'qué falta reponer'); assert.equal(r.status, 403); assert.equal(r.body.error, 'assistant_off');
  const ping = await call('tok-emp', '/auth/assistant/chat', { ping: true }); assert.equal(ping.status, 403);
  const own = await call('tok-dueno', '/auth/assistant/chat', { ping: true }); assert.deepEqual({ ...(await own.json()), server_now: 0 }, { ok: true, role: 'owner', level: 'dueno', configured: true, owner_bootstrap: false, server_now: 0 });
  const conf = await call('tok-emp', '/auth/assistant/confirm', { token: 'x', proposal: {} }); assert.equal(conf.status, 403); assert.equal((await conf.json()).error, 'assistant_off');
});

test('cambiar el nivel: solo aparato dueño + PIN correcto; el empleado no puede subirse solo; queda anotado si existe la bitácora', async (t) => {
  const { f, level, call } = await setup(t, { log: true });
  assert.equal((await level('session:emp', 'consultas', 'tok-emp')).status, 403, 'empleado no cambia niveles');
  const sinPin = await level('session:emp', 'consultas', 'tok-dueno', ''); assert.equal(sinPin.status, 403); assert.equal((await sinPin.json()).action, 'assistant.employee_access');
  const malo = await level('session:emp', 'consultas', 'tok-dueno', '9999'); assert.equal(malo.status, 403); assert.equal((await malo.json()).error, 'owner_pin_invalid');
  assert.equal((await level('session:dueno', 'consultas')).status, 409, 'solo aparatos empleado');
  assert.equal((await level('session:emp', 'admin')).status, 400);
  const ok = await level('session:emp', 'consultas'); const b = await ok.json();
  assert.equal(ok.status, 200); assert.equal(b.level, 'consultas'); assert.equal(b.logged, true);
  assert.equal(f.sql('SELECT COUNT(*) n FROM pos_assistant_access_log').n, 1);
  const list = await (await call('tok-dueno', '/auth/assistant/employee-access', null, {}, 'GET')).json();
  assert.deepEqual(list.devices.map((d) => [d.device_id, d.level]), [['session:emp', 'consultas'], ['session:emp2', 'off']]);
  assert.equal((await call('tok-emp', '/auth/assistant/employee-access', null, {}, 'GET')).status, 403);
  // Sin la migración 0034 el nivel se guarda igual, solo no se anota.
});

test('Solo consultas: stock y por reponer sí; costos, ventas, deudas y documentos no; cambios piden PIN del dueño (estricto)', async (t) => {
  const { level, chat, confirm, approve, call } = await setup(t);
  assert.equal((await level('session:emp', 'consultas')).status, 200);
  const ping = await (await call('tok-emp', '/auth/assistant/chat', { ping: true })).json(); assert.equal(ping.level, 'consultas');
  const low = await chat('tok-emp', '¿Qué me falta reponer?'); assert.equal(low.status, 200); assert.equal(low.body.proposals[0]?.type, 'consulta');
  for (const q of ['productos sin costo', 'ventas de hoy', '¿quién me debe?', 'compras recientes']) {
    const r = await chat('tok-emp', q); assert.equal(r.status, 200, q); assert.ok(!r.body.proposals.some((p) => p.type === 'consulta'), q);
  }
  const doc = await chat('tok-emp', 'imprime la lista de precios'); assert.ok(!doc.body.proposals.some((p) => p.type === 'documento'));
  assert.ok(!JSON.stringify(low.body).includes('0.29'), 'sin costos');
  // Propuesta de cambio: el empleado no la ejecuta sin el PIN del dueño.
  const card = (await chat('tok-emp', 'merma de 1 Synthetic 00002')).body.proposals.find((p) => p.type === 'ajuste'); assert.ok(card);
  const no = await confirm('tok-emp', card); assert.equal(no.status, 403); assert.equal(no.body.error, 'owner_approval_required');
  const otra = await approve('tok-emp', 'inventory.adjust', 'AST-otra-operacion'); assert.ok(otra.status < 300, JSON.stringify(otra.body));
  assert.equal((await confirm('tok-emp', card, otra.body.approval_id)).status, 403, 'aprobación de otra operación');
  const buena = await approve('tok-emp', 'inventory.adjust', opOf(card)); assert.ok(buena.status < 300);
  const rs = await Promise.all([1, 2, 3].map(() => confirm('tok-emp', card, buena.body.approval_id)));
  assert.equal(rs.filter((r) => r.status === 200 && !r.body.already_confirmed).length, 1, JSON.stringify(rs.map((r) => r.status)));
});

test('Consultas y documentos: lista de precios y pedido sí; inventario valorizado, cierre y deudas no', async (t) => {
  const { level, chat } = await setup(t);
  assert.equal((await level('session:emp', 'consultas_documentos')).status, 200);
  const ok = await chat('tok-emp', 'imprime la lista de precios'); assert.equal(ok.body.proposals[0]?.type, 'documento'); assert.equal(ok.body.proposals[0].tipo, 'lista_precios');
  for (const q of ['imprime el inventario valorizado', 'cierre de caja de hoy', 'reporte de deudas de clientes', 'estado de cuenta de Rosa']) {
    const r = await chat('tok-emp', q); assert.ok(!r.body.proposals.some((p) => p.type === 'documento'), q);
  }
});

test('quitar el permiso aplica al instante: tarjeta emitida antes y chat siguiente reciben 403', async (t) => {
  const { level, chat, confirm, approve } = await setup(t);
  assert.equal((await level('session:emp', 'consultas_documentos')).status, 200);
  const card = (await chat('tok-emp', 'merma de 1 Synthetic 00002')).body.proposals.find((p) => p.type === 'ajuste');
  const apr = await approve('tok-emp', 'inventory.adjust', opOf(card));
  assert.equal((await level('session:emp', 'off')).status, 200);
  const c = await confirm('tok-emp', card, apr.body.approval_id); assert.equal(c.status, 403); assert.equal(c.body.error, 'assistant_off');
  assert.equal((await chat('tok-emp', 'qué falta reponer')).status, 403);
  // Otro empleado nunca tuvo permiso: sigue apagado.
  assert.equal((await chat('tok-emp2', 'qué falta reponer')).status, 403);
});

test('contrato Bot 5: aprobación assistant.employee_access ligada al operation_id, gastada una vez; enabled true/false; el empleado no se activa ni con el PIN', async (t) => {
  const { call, approve, chat } = await setup(t, { log: true });
  const set = (tok, body, apr) => call(tok, '/auth/assistant/employee-access', body, apr ? { 'x-owner-approval': apr } : {});
  // Empleado con el PIN del dueño escrito en SU aparato: la aprobación existe, pero el aparato no es dueño.
  const aE = await approve('tok-emp', 'assistant.employee_access', 'op-e'); assert.ok(aE.status < 300, JSON.stringify(aE.body));
  assert.equal((await set('tok-emp', { device_id: 'session:emp', enabled: true, operation_id: 'op-e' }, aE.body.approval_id)).status, 403);
  const fake = await set('tok-emp', { device_id: 'session:emp', enabled: true, operation_id: 'op-x', pos_role: 'owner', role: 'owner' }, null); assert.equal(fake.status, 403);
  // Dueño: aprobación de otra operación no vale; la correcta sí; reutilizarla para otro aparato no vale.
  const otra = await approve('tok-dueno', 'assistant.employee_access', 'op-otra');
  assert.equal((await set('tok-dueno', { device_id: 'session:emp', enabled: true, operation_id: 'op-1' }, otra.body.approval_id)).status, 403);
  const buena = await approve('tok-dueno', 'assistant.employee_access', 'op-1');
  const ok = await set('tok-dueno', { device_id: 'session:emp', enabled: true, operation_id: 'op-1' }, buena.body.approval_id);
  assert.equal(ok.status, 200); assert.equal((await ok.json()).level, 'consultas', 'enabled:true = consultas');
  assert.equal((await set('tok-dueno', { device_id: 'session:emp2', enabled: true, operation_id: 'op-1' }, buena.body.approval_id)).status, 403, 'aprobación ya gastada');
  assert.equal((await chat('tok-emp', 'qué falta reponer')).status, 200);
  assert.equal((await chat('tok-emp2', 'qué falta reponer')).status, 403);
  const off = await approve('tok-dueno', 'assistant.employee_access', 'op-2');
  const r = await set('tok-dueno', { device_id: 'session:emp', enabled: false, operation_id: 'op-2' }, off.body.approval_id); assert.equal((await r.json()).level, 'off');
  assert.equal((await chat('tok-emp', 'qué falta reponer')).status, 403);
});

test('lista de pedido / precios del empleado: filas del servidor sin costos ni inversión; la del dueño puede traer costos', async (t) => {
  const { level, chat } = await setup(t);
  assert.equal((await level('session:emp', 'consultas_documentos')).status, 200);
  for (const [q, tipo, cols] of [['arma la lista de pedido para el proveedor', 'lista_pedido', ['Producto', 'Stock', 'Cantidad sugerida']], ['imprime la lista de precios', 'lista_precios', ['Producto', 'Precio S/']]]) {
    const r = await chat('tok-emp', q); const p = r.body.proposals.find((x) => x.type === 'documento');
    assert.ok(p, q); assert.equal(p.tipo, tipo); assert.deepEqual(p.data.columnas, cols);
    const txt = JSON.stringify(r.body);
    assert.ok(!/costo|inversi|cost_cents|0\.29/i.test(JSON.stringify(p.data)), 'sin costos en los datos'); assert.ok(!txt.includes('0.29'));
    assert.ok(p.data.filas.every((f) => f.length === cols.length));
  }
  const own = await chat('tok-dueno', 'arma la lista de pedido para el proveedor');
  const po = own.body.proposals.find((x) => x.type === 'documento'); assert.equal(po.tipo, 'lista_pedido'); assert.equal(po.data, undefined, 'el dueño arma su lista con los cálculos del POS (puede traer costos)');
});

test('lista_pedido del empleado: aunque el modelo mande costos, total o inversión, el servidor solo deja producto, stock y cantidad sugerida', async (t) => {
  const { f, level } = await setup(t);
  assert.equal((await level('session:emp', 'consultas_documentos')).status, 200);
  f.env.DEEPSEEK_API_KEY = 'k-prueba';
  const { assistantChatRoute, createMemoryUsageStore } = await import('../../tools/cloudflare-lab/src/pos-assistant.js');
  const fake = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Costo total S/ 4321.97', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'preparar_documento', arguments: JSON.stringify({ tipo: 'lista_pedido', costo_total: 4321.97, inversion: 999.11, filas: [['X', 1, 2, 3.5]] }) } }] } }] }));
  const r = await assistantChatRoute(new Request('https://w/x', { method: 'POST', body: JSON.stringify({ text: 'pedido' }) }), f.env, { principalId: 'session:emp', posRole: 'empleado' }, (d, st = 200) => new Response(JSON.stringify(d), { status: st }), { db: f.env.nuevo_amanecer_lab, store: createMemoryUsageStore(), fetch: fake });
  const b = await r.json(); const p = b.proposals[0];
  assert.equal(p.tipo, 'lista_pedido'); assert.deepEqual(p.data.campos, ['producto', 'stock', 'cantidad_sugerida']);
  assert.deepEqual(Object.keys(p).sort(), ['data', 'fiscal', 'id', 'needsConfirm', 'tipo', 'title', 'type']);
  const txt = JSON.stringify(p); assert.ok(!/4321|999\.11|costo|inversi/i.test(txt), txt);
  assert.ok(p.data.filas.every((x) => x.length === 3));
});

test('cambio de nivel: el PIN suelto en el cuerpo ya no sirve; un aparato destino inválido NO gasta la aprobación', async (t) => {
  const { call } = await setup(t);
  const suelto = await call('tok-dueno', '/auth/assistant/employee-access', { device_id: 'session:emp', level: 'consultas', operation_id: 'op-s', pin: PIN });
  assert.equal(suelto.status, 403); assert.equal((await suelto.json()).error, 'owner_approval_required');
  const apr = (await (await call('tok-dueno', '/auth/owner-approval', { pin: PIN, action: 'assistant.employee_access', operation_id: 'op-d' })).json()).approval_id;
  const malo = await call('tok-dueno', '/auth/assistant/employee-access', { device_id: 'session:dueno', level: 'consultas', operation_id: 'op-d' }, { 'x-owner-approval': apr });
  assert.equal(malo.status, 409);
  const bueno = await call('tok-dueno', '/auth/assistant/employee-access', { device_id: 'session:emp', level: 'consultas', operation_id: 'op-d' }, { 'x-owner-approval': apr });
  assert.equal(bueno.status, 200, 'la misma aprobación sigue sirviendo tras el 409');
  const otra = await call('tok-dueno', '/auth/assistant/employee-access', { device_id: 'session:emp2', level: 'consultas', operation_id: 'op-d' }, { 'x-owner-approval': apr });
  assert.equal(otra.status, 403, 'y ya gastada no sirve otra vez');
});

test('A20 auditoría: una fila por llamada a herramienta y por confirmación; solo el dueño la lee; sin textos, PIN ni DNI', async (t) => {
  const { f, call, chat, confirm, approve } = await setup(t);
  const a = await chat('tok-dueno', 'merma de 2 Synthetic 00002 DNI 45678912');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const card = a.body.proposals.find((p) => p.confirm_token);
  const apr = await approve('tok-dueno', 'inventory.adjust', opOf(card));
  assert.equal((await confirm('tok-dueno', card, apr.body.approval_id)).status, 200);
  const r = await call('tok-dueno', '/auth/assistant/audit', null, {}, 'GET'); const b = await r.json();
  assert.equal(r.status, 200);
  assert.ok(b.entries.length >= a.body.proposals.length + 1, JSON.stringify(b.entries));
  assert.ok(b.entries.some((e) => e.outcome === 'confirmed' && e.operation_id === opOf(card)));
  assert.ok(b.entries.some((e) => e.outcome === 'proposed' && e.tool === 'proponer_ajuste_stock'));
  const txt = JSON.stringify(b); assert.ok(!/45678912|4821|merma de/.test(txt), txt);
  assert.equal((await call('tok-emp', '/auth/assistant/audit', null, {}, 'GET')).status, 403);
  // y no se ve por /settings
  const st = await call('tok-dueno', '/settings', null, {}, 'GET'); if (st.status === 200) assert.ok(!JSON.stringify(await st.json()).includes('internal:asst:audit'));
});
