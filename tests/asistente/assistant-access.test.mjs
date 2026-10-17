// Niveles del asistente por aparato de empleado: Apagado (por defecto) / Solo consultas / Consultas y documentos.
// Base de datos real del laboratorio (activeCanon) y Worker real; DeepSeek no se llama (modo demostración o stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon } from '../cloud-sync/canon-browser-harness.mjs';
import { toolsForRole, EMPLOYEE_TOOLS, PING_FIELDS, pingBody } from '../../tools/cloudflare-lab/src/pos-assistant.js';

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
  const chat = async (tok, text) => { const r = await call(tok, '/auth/assistant/chat', { text, context: { products: [{ id: '00003', nombre: 'Synthetic 00003', precio: 12.34, costo: 0.29, stock: 1 }] } }); return { status: r.status, body: await r.json() }; };
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
  const own = await call('tok-dueno', '/auth/assistant/chat', { ping: true }); assert.deepEqual(await own.json(), { ok: true, enabled: true, role: 'owner', level: 'dueno' });
  const conf = await call('tok-emp', '/auth/assistant/confirm', { token: 'x', proposal: {} }); assert.equal(conf.status, 403); assert.equal((await conf.json()).error, 'assistant_off');
});

// Bots 3 y 5 (50b6716b): el ping del re-chequeo devuelve SOLO si este aparato tiene asistente y su nivel. Nada del dueño ni de otros aparatos.
test('ping: la respuesta trae solo los campos de nivel (ok, enabled, role, level), para dueño y empleado; nada del dueño ni de la configuración', async (t) => {
  const { call, level } = await setup(t);
  assert.deepEqual([...PING_FIELDS], ['ok', 'enabled', 'role', 'level']);
  assert.equal((await level('session:emp', 'consultas_documentos')).status, 200);
  for (const [tok, want] of [['tok-dueno', { role: 'owner', level: 'dueno' }], ['tok-emp', { role: 'empleado', level: 'consultas_documentos' }]]) {
    const r = await call(tok, '/auth/assistant/chat', { ping: true }); assert.equal(r.status, 200);
    const raw = await r.text(), body = JSON.parse(raw);
    assert.deepEqual(Object.keys(body).sort(), [...PING_FIELDS].sort(), raw); assert.deepEqual(body, { ok: true, enabled: true, ...want });
    assert.ok(!/session:|dueno-|device|owner_bootstrap|configured|server_now|pin|token|approval/i.test(raw.replace('"level":"dueno"', '')), raw);
    assert.ok(raw.length < 90, 'chico: ' + raw.length + ' bytes');
  }
  assert.deepEqual(Object.keys(pingBody('empleado:consultas')), [...PING_FIELDS]);
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
  const doc = await chat('tok-emp', 'imprime la lista de precios'); assert.ok(!(doc.body.proposals || []).some((p) => p.type === 'documento'));
  assert.equal(doc.status, 403, 'R25: «consultas» no tiene documentos -> 403 para todo el pedido'); assert.equal(doc.body.error, 'forbidden_document');
  assert.ok(!JSON.stringify(low.body).includes('0.29'), 'sin costos');
  // Propuesta de cambio: el empleado no la ejecuta sin el PIN del dueño.
  const card = (await chat('tok-emp', 'merma de 1 Synthetic 00003')).body.proposals.find((p) => p.type === 'ajuste'); assert.ok(card);
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
    const r = await chat('tok-emp', q); assert.ok(!(r.body.proposals || []).some((p) => p.type === 'documento'), q);
    if (/inventario valorizado|cierre|estado de cuenta/.test(q)) { assert.equal(r.status, 403, q); assert.equal(r.body.error, 'forbidden_document'); }
  }
});

test('quitar el permiso aplica al instante: tarjeta emitida antes y chat siguiente reciben 403', async (t) => {
  const { level, chat, confirm, approve } = await setup(t);
  assert.equal((await level('session:emp', 'consultas_documentos')).status, 200);
  const card = (await chat('tok-emp', 'merma de 1 Synthetic 00003')).body.proposals.find((p) => p.type === 'ajuste');
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
  const a = await chat('tok-dueno', 'merma de 2 Synthetic 00003 DNI 45678912');
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
  const st = await call('tok-dueno', '/settings', null, {}, 'GET'); assert.equal(st.status, 200); assert.ok(!JSON.stringify(await st.json()).includes('internal:'), '/settings nunca devuelve claves internas');
  assert.equal(b.keep, 1000); assert.deepEqual(b.caps, { o: 1000, or: 300, oa: 100, r: 300, a: 300 }); assert.equal(typeof b.write_errors, 'number');
});

test('A20: cajones con tope propio (dueño 1000, empleados 300, agrupados 300): un empleado inundando NO saca filas del dueño', async (t) => {
  const { f } = await setup(t);
  const { auditWrite, AUDIT_CAPS } = await import('../../tools/cloudflare-lab/src/pos-assistant-audit.js');
  const db = f.env.nuevo_amanecer_lab;
  const cnt = (b) => f.all(`SELECT COUNT(*) AS n FROM pos_settings WHERE key LIKE 'internal:asst:audit:${b}:%'`)[0].n;
  await auditWrite(db, Array.from({ length: 40 }, (_, i) => ({ device_id: 'session:dueno', role: 'owner', tool: 'proponer_ajuste_stock', outcome: i % 2 ? 'confirmed' : 'proposed', card_id: 'o' + i })));
  // inundación: 900 propuestas/rechazos de empleado + 500 «429» y «403 de rol» del mismo aparato
  for (let k = 0; k < 9; k++) await auditWrite(db, Array.from({ length: 100 }, (_, i) => ({ device_id: 'session:emp', role: 'empleado:consultas', tool: 'consultar', outcome: i % 3 ? 'proposed' : 'rejected:review_required', card_id: 'e' + k + '-' + i })));
  for (let k = 0; k < 5; k++) await auditWrite(db, Array.from({ length: 100 }, (_, i) => ({ device_id: 'session:emp', role: 'empleado:consultas', outcome: i % 2 ? 'rejected:rate_limited' : 'rejected:forbidden_role', aggregate: true })));
  assert.equal(cnt('o'), 40, 'las 40 filas del dueño siguen todas');
  assert.equal(cnt('r'), AUDIT_CAPS.r, 'el ruido del empleado se recorta en SU cajón');
  // TODO rechazo de un aparato que no es dueño se agrupa: una fila por aparato, minuto y resultado con count (no 800 filas)
  const agg = f.all("SELECT value_json FROM pos_settings WHERE key LIKE 'internal:asst:audit:a:%'").map((r) => JSON.parse(r.value_json));
  assert.ok(agg.length <= 6, JSON.stringify(agg.length));
  assert.equal(agg.reduce((n, a) => n + a.count, 0), 500 + 9 * 34); // 34 de cada 100 son review_required
  assert.deepEqual([...new Set(agg.map((a) => a.outcome))].sort(), ['rejected:forbidden_role', 'rejected:rate_limited', 'rejected:review_required']);
  assert.ok(f.all("SELECT key FROM pos_settings WHERE key LIKE 'internal:asst:audit:%'").every((r) => r.key.length <= 60), 'claves de 60 caracteres o menos');
});

test('A20: confirm rechazado queda anotado (422/403 sueltos; 429 agrupados); fallo al anotar: console.warn sin datos y write_errors', async (t) => {
  const { f, call, chat, confirm, approve } = await setup(t);
  const { auditWrite, auditStats } = await import('../../tools/cloudflare-lab/src/pos-assistant-audit.js');
  const a = await chat('tok-dueno', 'merma de 2 Synthetic 00003');
  const card = a.body.proposals.find((p) => p.confirm_token);
  assert.equal((await confirm('tok-dueno', card)).status, 403); // sin aprobación
  const g = await (await call('tok-dueno', '/auth/assistant/audit', null, {}, 'GET')).json();
  assert.ok(g.entries.some((e) => e.outcome === 'rejected:owner_approval_required' && e.card_id === card.id), JSON.stringify(g.entries.slice(0, 4)));
  // base que falla: no lanza, avisa y cuenta
  const warns = []; const orig = console.warn; console.warn = (...x) => warns.push(x.join(' '));
  const before = auditStats().write_errors;
  try { assert.equal(await auditWrite({ prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error('D1_ERROR: disk full key=internal:asst:audit:secreto DNI 45678912'); } }, [{ device_id: 'x', role: 'owner', outcome: 'proposed' }]), 0); }
  finally { console.warn = orig; }
  assert.equal(auditStats().write_errors, before + 1); assert.equal(warns.length, 1); assert.ok(!/45678912|secreto|internal:asst/.test(warns[0]), warns[0]);
  assert.equal((await chat('tok-dueno', '¿qué me falta reponer?')).status, 200);
  const g2 = await (await call('tok-dueno', '/auth/assistant/audit', null, {}, 'GET')).json();
  assert.ok(g2.write_errors >= 1); assert.ok(g2.last_write_error_at);
});

test('A20 chat: rechazos del chat de otros aparatos TODOS agrupados (403 de rol, assistant_off, 429, 400) y una inundación NO saca filas del dueño', async (t) => {
  const { f, call, chat, level } = await setup(t);
  const { auditWrite, AUDIT_CAPS } = await import('../../tools/cloudflare-lab/src/pos-assistant-audit.js');
  const cnt = (b) => f.all(`SELECT COUNT(*) AS n FROM pos_settings WHERE key LIKE 'internal:asst:audit:${b}:%'`)[0].n;
  const ownerRows = () => f.all("SELECT key FROM pos_settings WHERE key LIKE 'internal:asst:audit:o:%' ORDER BY key").map((r) => r.key);
  await auditWrite(f.env.nuevo_amanecer_lab, Array.from({ length: 40 }, (_, i) => ({ device_id: 'session:dueno', role: 'owner', tool: 'proponer_ajuste_stock', outcome: i % 2 ? 'confirmed' : 'proposed', card_id: 'o' + i })));
  assert.equal((await chat('tok-dueno', 'merma de 2 Synthetic 00003')).status, 200);
  const before = ownerRows(); assert.ok(before.length > 40);
  const SECRET = 'PIN 4821 DNI 45678912 clave-secreta';
  // 1) empleado apagado: 403 assistant_off (chat y ping) -> agrupado
  for (let i = 0; i < 150; i++) assert.equal((await chat('tok-emp', SECRET + ' ' + i)).status, 403);
  for (let i = 0; i < 30; i++) assert.equal((await call('tok-emp', '/auth/assistant/chat', { ping: true })).status, 403);
  // 2) empleado en «consultas» pidiendo documentos: 403 forbidden_document -> agrupado
  assert.equal((await level('session:emp2', 'consultas')).status, 200);
  Object.assign(f.env, { ASSISTANT_PER_MINUTE: '1000', ASSISTANT_PER_DAY: '1000' }); // el cupo se gasta antes del 403 de documento
  for (let i = 0; i < 20; i++) assert.equal((await chat('tok-emp2', 'imprime la lista de precios ' + SECRET)).status, 403);
  // 3) cuerpo malo / foto mala / vacío: suelto al cajón r (pasa su tope de 300 y se recorta solo ahí)
  for (let i = 0; i < 160; i++) assert.equal((await call('tok-emp2', '/auth/assistant/chat', { text: SECRET, image: 'no-es-foto-' + i })).status, 400);
  for (let i = 0; i < 160; i++) assert.equal((await call('tok-emp2', '/auth/assistant/chat', { text: '' })).status, 400);
  // 4) 429: el aparato pasa su cupo por minuto -> agrupado por resultado
  f.env.ASSISTANT_PER_MINUTE = '0';
  for (let i = 0; i < 120; i++) assert.equal((await chat('tok-emp2', '¿qué me falta? ' + SECRET)).status, 429);
  delete f.env.ASSISTANT_PER_MINUTE; delete f.env.ASSISTANT_PER_DAY;
  assert.deepEqual(ownerRows(), before, 'ninguna fila del dueño se borró');
  assert.equal(cnt('r'), 0, 'los rechazos de otro aparato nunca van sueltos');
  const agg = f.all("SELECT key, value_json FROM pos_settings WHERE key LIKE 'internal:asst:audit:a:%'").map((r) => ({ key: r.key, ...JSON.parse(r.value_json) }));
  const by = (o) => agg.filter((a) => a.outcome === o).reduce((n, a) => n + a.count, 0);
  assert.equal(by('rejected:assistant_off'), 180); assert.equal(by('rejected:forbidden_document'), 20); assert.equal(by('rejected:rate_limited'), 120);
  assert.equal(by('rejected:bad_image'), 160); assert.equal(by('rejected:empty_message'), 160);
  assert.ok(agg.length <= 12, 'una fila por aparato, minuto y resultado: ' + agg.length);
  assert.ok(agg.every((a) => a.src === 'chat' && a.tool === 'chat' && /:c[a-z_]+$/.test(a.key)));
  const all = JSON.stringify(f.all("SELECT key, value_json FROM pos_settings WHERE key LIKE 'internal:asst:audit:%'"));
  assert.ok(!/PIN 4821|45678912|clave-secreta|no-es-foto|lista de precios|me falta/.test(all), 'sin texto del mensaje, PIN ni secretos'); // «4821» suelto puede salir en un hash o una hora
  assert.ok(f.all("SELECT key FROM pos_settings WHERE key LIKE 'internal:asst:audit:%'").every((r) => r.key.length <= 60));
  // el dueño lo lee; el empleado no
  const g = await (await call('tok-dueno', '/auth/assistant/audit?limit=500', null, {}, 'GET')).json();
  assert.ok(g.entries.some((e) => e.outcome === 'rejected:rate_limited' && e.src === 'chat'));
  assert.equal((await call('tok-emp2', '/auth/assistant/audit', null, {}, 'GET')).status, 403);
});

// ---- Bot 2 sobre 1b87710d: el control de inventario lee SOLO los ids de la tarjeta (sin tope de 5000) ----
// Catálogo grande SOLO en la base de prueba en memoria: se apaga el candado de candidato sellado y las FK para copiar filas.
function bigCatalog(f, total) {
  for (const r of f.all("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='products' AND sql LIKE '%INSERT ON products%'")) f.database.exec('DROP TRIGGER ' + r.name);
  f.database.exec('PRAGMA foreign_keys=OFF');
  const cols = f.all('PRAGMA table_info(products)').map((c) => c.name);
  const sel = cols.map((c) => c === 'product_id' ? "printf('%05d', n)" : c === 'name' ? "'Synthetic ' || printf('%05d', n)" : c === 'source_row' ? '100000 + n' : c === 'source_key' ? "printf('%05d', n)"
    : c === 'tracks_inventory' ? 'CASE WHEN n % 7 = 0 THEN 0 ELSE 1 END' : c).join(',');
  f.database.exec(`WITH RECURSIVE s(n) AS (SELECT 28 UNION ALL SELECT n + 1 FROM s WHERE n < ${total - 1})
    INSERT INTO products(${cols.join(',')}) SELECT ${sel} FROM s, (SELECT * FROM products WHERE product_id='00001')`);
}
function countingDb(db, seen) {
  return new Proxy(db, { get(t, k) { if (k !== 'prepare') { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
    return (sql) => { const st = t.prepare(sql); if (/product_id IN \(/.test(sql)) { const n = (sql.match(/IN \(([^)]*)\)/) || ['', ''])[1].split(',').length; seen.push(n); }
      if (/\/read\/canonical|FROM \(\s*SELECT 'I:'/.test(sql)) seen.push('catalogo'); return st; }; } });
}

test('Bot 2: con 5300 productos, el #5200 confirma 200 leyendo solo su id; sin control -> 409; id inexistente -> 409 product_missing', async (t) => {
  const { f, call, approve } = await setup(t);
  bigCatalog(f, 5300);
  assert.equal(f.all('SELECT COUNT(*) n FROM products')[0].n, 5300);
  const chatWith = async (prod) => { const r = await call('tok-dueno', '/auth/assistant/chat', { text: 'merma de 2 ' + prod.nombre, context: { products: [{ ...prod, precio: 5, costo: 1, stock: 10 }] } }); return { status: r.status, body: await r.json() }; };
  const confirmCard = async (card) => { const { confirm_token, ...proposal } = card; const apr = await approve('tok-dueno', 'inventory.adjust', opOf(card));
    const r = await call('tok-dueno', '/auth/assistant/confirm', { token: confirm_token, proposal }, { 'x-owner-approval': apr.body.approval_id }); return { status: r.status, body: await r.json() }; };
  const a = await chatWith({ id: '05200', nombre: 'Synthetic 05200' }); assert.equal(a.status, 200, JSON.stringify(a.body));
  const card = a.body.proposals.find((p) => p.type === 'ajuste'); assert.ok(card, JSON.stringify(a.body));
  const ok = await confirmCard(card); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // sin control de inventario (#5201): el chat ya no ofrece la tarjeta (consulta por id, no la lista cortada)
  const nc = await chatWith({ id: '05201', nombre: 'Synthetic 05201' }); assert.ok(!nc.body.proposals.some((p) => p.type === 'ajuste'), JSON.stringify(nc.body));
  assert.match(nc.body.reply, /no controla inventario/);
  // id que no existe en la base: la tarjeta sale (dato del aparato) pero el confirm responde 409 product_missing
  const gone = await chatWith({ id: '09999', nombre: 'Synthetic 09999' }); const gc = gone.body.proposals.find((p) => p.type === 'ajuste'); assert.ok(gc);
  const r = await confirmCard(gc); assert.equal(r.status, 409); assert.equal(r.body.error, 'product_missing');
});

test('Bot 2/Bot 3: tarjeta de 125 productos -> 3 consultas IN de <= 50 ids, sin leer el catálogo, confirma 200', async (t) => {
  const { f } = await setup(t);
  bigCatalog(f, 300);
  const { assistantConfirmRoute, issueConfirmToken, createMemoryUsageStore } = await import('../../tools/cloudflare-lab/src/pos-assistant.js');
  const { canonicalReader, PRODUCT_ID_CHUNK } = await import('../../tools/cloudflare-lab/src/pos-assistant-queries.js');
  assert.equal(PRODUCT_ID_CHUNK, 50);
  const ids = Array.from({ length: 300 }, (_, i) => String(i).padStart(5, '0')).filter((id) => Number(id) % 7 !== 0 && Number(id) % 2 === 1).slice(0, 125);
  assert.equal(ids.length, 125);
  // Las tarjetas del chat llegan hasta 30 filas; aquí se firma directo una de 125 para probar los tramos.
  const proposal = { id: 'big-1', type: 'compra', needsConfirm: true, requiresRole: 'owner', title: 'Registrar compra', proveedor: 'Dist', lineas: ids.map((id) => ({ product_id: id, nombre: 'Synthetic ' + id, cantidad: 1, costo_unitario: 1 })) };
  const env = { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef' }, auth = { principalId: 'session:dueno', posRole: 'owner' };
  const token = await issueConfirmToken(proposal, 'owner', auth, env.ASSISTANT_CONFIRM_SECRET, Date.now());
  const seen = []; const reader = canonicalReader(countingDb(f.env.nuevo_amanecer_lab, seen));
  const jsonR = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
  const res = await assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', headers: { 'x-owner-approval': 'apr' }, body: JSON.stringify({ token, proposal }) }), env, auth, jsonR,
    { store: createMemoryUsageStore(), resolveRole: async () => 'owner', verifyApproval: async () => true, reader, audit: async () => {} });
  const body = await res.json(); assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.proposal.lineas.length, 125);
  assert.deepEqual(seen, [50, 50, 25], 'tres tramos de 50/50/25 ids y ninguna lectura del catálogo');
  // un id que falta entre los 125 -> 409 product_missing; consulta que falla -> 503 sin gastar nada
  const p2 = { ...proposal, id: 'big-2', lineas: [...proposal.lineas.slice(0, 124), { product_id: '77777', nombre: 'No existe', cantidad: 1, costo_unitario: 1 }] };
  const t2 = await issueConfirmToken(p2, 'owner', auth, env.ASSISTANT_CONFIRM_SECRET, Date.now()); let spent = 0;
  const r2 = await assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', headers: { 'x-owner-approval': 'apr' }, body: JSON.stringify({ token: t2, proposal: p2 }) }), env, auth, jsonR,
    { store: createMemoryUsageStore(), resolveRole: async () => 'owner', verifyApproval: async () => { spent++; return true; }, reader: canonicalReader(f.env.nuevo_amanecer_lab), audit: async () => {} });
  assert.equal(r2.status, 409); assert.equal((await r2.json()).error, 'product_missing'); assert.equal(spent, 0);
  const broken = new Proxy(f.env.nuevo_amanecer_lab, { get(t, k) { if (k === 'prepare') return (sql) => { if (/product_id IN \(/.test(sql)) throw new Error('D1_ERROR: caída'); return t.prepare(sql); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  const r3 = await assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', headers: { 'x-owner-approval': 'apr' }, body: JSON.stringify({ token, proposal }) }), env, auth, jsonR,
    { store: createMemoryUsageStore(), resolveRole: async () => 'owner', verifyApproval: async () => { spent++; return true; }, reader: canonicalReader(broken), audit: async () => {} });
  assert.equal(r3.status, 503); assert.equal((await r3.json()).error, 'stock_check_unavailable'); assert.equal(spent, 0);
});

test('Bot 2: GET de la bitácora muestra PRIMERO las filas del dueño aunque haya inundación; ?grupo=o|r|a filtra; grupo malo 400', async (t) => {
  const { f, call } = await setup(t);
  const { auditWrite } = await import('../../tools/cloudflare-lab/src/pos-assistant-audit.js');
  const db = f.env.nuevo_amanecer_lab;
  await auditWrite(db, Array.from({ length: 180 }, (_, i) => ({ device_id: 'session:dueno', role: 'owner', tool: 'proponer_ajuste_stock', outcome: 'proposed', card_id: 'o' + i })));
  for (let k = 0; k < 4; k++) await auditWrite(db, Array.from({ length: 100 }, (_, i) => ({ device_id: 'session:emp', role: 'empleado:consultas', tool: 'consultar', outcome: 'proposed', card_id: 'r' + k + i })));
  // 320 grupos en minutos distintos (claves a: escritas a mano con minuto distinto)
  for (let m = 0; m < 320; m++) f.exec("INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?,?,1,?,'x')", 'internal:asst:audit:a:' + (29000000 + m) + ':abcdef0123:krate_limited', JSON.stringify({ at: new Date().toISOString(), last_at: new Date(Date.now() + 1000).toISOString(), outcome: 'rejected:rate_limited', count: 3 }), new Date().toISOString());
  const g = await (await call('tok-dueno', '/auth/assistant/audit?limit=500', null, {}, 'GET')).json();
  assert.equal(g.entries.filter((e) => e.outcome === 'proposed').length, 180, 'las 180 del dueño se ven por defecto');
  assert.ok(g.entries.slice(0, 180).every((e) => e.grupo === 'o'), 'y van primero');
  assert.equal(g.entries.length, 500); assert.equal(g.grupos.o, 180); assert.equal(g.grupos.r, 300); assert.equal(g.grupos.a, 320);
  const r = await (await call('tok-dueno', '/auth/assistant/audit?grupo=r&limit=500', null, {}, 'GET')).json();
  assert.equal(r.entries.length, 300); assert.ok(r.entries.every((e) => e.grupo === 'r')); assert.equal(r.grupo, 'r');
  const a = await (await call('tok-dueno', '/auth/assistant/audit?grupo=a&limit=50', null, {}, 'GET')).json(); assert.equal(a.entries.length, 50); assert.ok(a.entries.every((e) => e.grupo === 'a'));
  assert.equal((await call('tok-dueno', '/auth/assistant/audit?grupo=x', null, {}, 'GET')).status, 400);
  assert.equal((await call('tok-emp', '/auth/assistant/audit?grupo=o', null, {}, 'GET')).status, 403);
});

test('Bot 5: rechazos del DUEÑO en su propio cajón (or); bad_token y bad_request de otros aparatos (empleado y sin rol) van agrupados y no los sacan', async (t) => {
  const { f, call, chat, level } = await setup(t);
  const { AUDIT_CAPS } = await import('../../tools/cloudflare-lab/src/pos-assistant-audit.js');
  f.addDevice('sinrol', 'writer', 'active', 'tok-sinrol');
  const cnt = (b) => f.all(`SELECT COUNT(*) AS n FROM pos_settings WHERE key LIKE 'internal:asst:audit:${b}:%'`)[0].n;
  const keys = (b) => f.all(`SELECT key FROM pos_settings WHERE key LIKE 'internal:asst:audit:${b}:%' ORDER BY key`).map((r) => r.key);
  const raw = (tok, path, body) => f.fetch('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body });
  // rechazos del dueño: confirm sin aprobación, token malo y cuerpo malo (uno por uno, cajón or)
  const card = (await chat('tok-dueno', 'merma de 2 Synthetic 00003')).body.proposals.find((p) => p.confirm_token); const { confirm_token, ...proposal } = card;
  assert.equal((await call('tok-dueno', '/auth/assistant/confirm', { token: confirm_token, proposal })).status, 403);
  assert.equal((await call('tok-dueno', '/auth/assistant/confirm', { token: 'malo', proposal })).status, 403);
  assert.equal((await raw('tok-dueno', '/auth/assistant/confirm', '{no es json')).status, 400);
  assert.equal((await raw('tok-dueno', '/auth/assistant/chat', '{no es json')).status, 400);
  const ownerRej = keys('or'); assert.equal(ownerRej.length, 4, JSON.stringify(ownerRej));
  const ownerOut = f.all("SELECT value_json FROM pos_settings WHERE key LIKE 'internal:asst:audit:or:%'").map((r) => JSON.parse(r.value_json).outcome).sort();
  assert.deepEqual(ownerOut, ['rejected:bad_request', 'rejected:bad_request', 'rejected:bad_token', 'rejected:owner_approval_required']);
  // diluvio de otros aparatos: empleado con nivel (llega a leer el token) y teléfono sin rol (se corta en el rol, antes del cuerpo)
  assert.equal((await level('session:emp', 'consultas')).status, 200);
  for (let i = 0; i < 200; i++) assert.equal((await call('tok-emp', '/auth/assistant/confirm', { token: 'x' + i, proposal: {} })).status, 403);
  for (let i = 0; i < 200; i++) assert.equal((await raw('tok-emp', '/auth/assistant/confirm', '{roto' + i)).status, 400);
  for (let i = 0; i < 200; i++) assert.equal((await raw('tok-sinrol', '/auth/assistant/confirm', '{roto' + i)).status, 403);
  for (let i = 0; i < 200; i++) assert.equal((await raw('tok-sinrol', '/auth/assistant/chat', '{roto' + i)).status, 403);
  assert.deepEqual(keys('or'), ownerRej, 'los rechazos del dueño siguen todos');
  assert.equal(cnt('r'), 0, 'ningún rechazo de otro aparato va suelto');
  const agg = f.all("SELECT value_json FROM pos_settings WHERE key LIKE 'internal:asst:audit:a:%'").map((r) => JSON.parse(r.value_json));
  assert.ok(agg.length <= 8, String(agg.length)); assert.equal(agg.reduce((n, a) => n + a.count, 0), 800);
  assert.ok(agg.every((a) => a.role !== 'owner'));
  const g = await (await call('tok-dueno', '/auth/assistant/audit?grupo=or', null, {}, 'GET')).json(); assert.equal(g.entries.length, 4);
  assert.ok(f.all("SELECT key FROM pos_settings WHERE key LIKE 'internal:asst:audit:%'").every((r) => r.key.length <= 60));
  assert.deepEqual(Object.keys(AUDIT_CAPS), ['o', 'or', 'oa', 'r', 'a']);
});

test('Bot 3: rango de claves (key >= p AND key < p+1) devuelve EXACTAMENTE las mismas filas que LIKE y usa el índice de la clave', async (t) => {
  const { f } = await setup(t);
  const { auditWrite, prefixRange, AUDIT_PREFIX, AUDIT_CAPS } = await import('../../tools/cloudflare-lab/src/pos-assistant-audit.js');
  const db = f.env.nuevo_amanecer_lab;
  await auditWrite(db, Array.from({ length: 30 }, (_, i) => ({ device_id: 'session:dueno', role: 'owner', outcome: i % 2 ? 'proposed' : 'rejected:bad_token', card_id: 'c' + i })));
  await auditWrite(db, Array.from({ length: 20 }, (_, i) => ({ device_id: 'session:emp', role: 'empleado:consultas', outcome: i % 2 ? 'proposed' : 'rejected:rate_limited' })));
  // vecinos que NO deben entrar: otro prefijo parecido, mayúsculas y el carácter siguiente a «:»
  const at = new Date().toISOString();
  for (const k of ['internal:asst:audit;x', 'internal:asst:audiu:x', 'internal:asst:odev;x', 'internal:asst:odevx', 'internal:asst:odev:dev-1']) f.exec("INSERT INTO pos_settings(key,value_json,revision,updated_at,updated_by) VALUES(?,'{}',1,?,'t')", k, at);
  for (const p of [AUDIT_PREFIX, ...Object.keys(AUDIT_CAPS).map((b) => AUDIT_PREFIX + b + ':'), 'internal:asst:odev:']) {
    const [lo, hi] = prefixRange(p);
    const like = f.all('SELECT key FROM pos_settings WHERE key LIKE ? ORDER BY key', p + '%').map((r) => r.key);
    const range = f.all('SELECT key FROM pos_settings WHERE key >= ? AND key < ? ORDER BY key', lo, hi).map((r) => r.key);
    assert.deepEqual(range, like, p); assert.ok(range.every((k) => k.startsWith(p)), p);
    const plan = JSON.stringify(f.all('EXPLAIN QUERY PLAN SELECT key FROM pos_settings WHERE key >= ? AND key < ?', lo, hi));
    assert.match(plan, /SEARCH/, 'usa el índice: ' + plan);
  }
  assert.deepEqual(prefixRange('internal:asst:audit:o:'), ['internal:asst:audit:o:', 'internal:asst:audit:o;']);
});
