// Pruebas del alcance de administración: consultas en el servidor (resumen chico al modelo), tarjetas de costo,
// ajuste y producto nuevo con PIN del dueño, documentos sin cuentas propias. Datos inventados; DeepSeek siempre simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantChatRoute, assistantConfirmRoute, createMemoryUsageStore, readConfirmToken, costProposals, DOC_TYPES } from '../../tools/cloudflare-lab/src/pos-assistant.js';
import { runAssistantQuery, memoryReader, canonicalReader, QUERY_TYPES } from '../../tools/cloudflare-lab/src/pos-assistant-queries.js';
import { readerData } from '../../tools/asistente-proto/demo-data.mjs';
import { activeCanon } from '../cloud-sync/canon-browser-harness.mjs';

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const SECRET = 'secreto-de-prueba-0123456789abcdef';
const OWNER = { principalId: 'session:dev-owner', posRole: 'owner' };
const env = (x = {}) => ({ ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: SECRET, ASSISTANT_DEMO: '1', ...x });
const tool = (name, args, id = 'call_' + name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const PRODUCTS = [{ id: 'P1', nombre: 'Paracetamol 500 mg', precio: 0.5, costo: 0.2, stock: 100 }, { id: 'P2', nombre: 'Ibuprofeno 400 mg', precio: 0.8, costo: 0.3, stock: 40 }];
async function chat(body, deps = {}, e = env()) {
  const r = await assistantChatRoute(new Request('https://w.test/auth/assistant/chat', { method: 'POST', body: JSON.stringify({ context: { products: PRODUCTS }, ...body }) }), e, OWNER, json, { store: createMemoryUsageStore(), resolveRole: async () => 'owner', ...deps });
  return { status: r.status, body: await r.json() };
}
function scripted(responses, cap) {
  let i = 0;
  return async (url, init) => { cap.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: responses[Math.min(i++, responses.length - 1)] }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); };
}

test('consultas en memoria: los 7 tipos responden con tabla para la pantalla y resumen chico para el modelo', async () => {
  const reader = memoryReader(readerData);
  for (const tipo of QUERY_TYPES) {
    const r = await runAssistantQuery(reader, { tipo, producto: 'paracetamol', periodo: 'semana' });
    assert.ok(!r.error, tipo); assert.ok(Array.isArray(r.filas) && r.texto && r.resumen, tipo);
    assert.ok(JSON.stringify(r.resumen).length < 1500, tipo + ' resumen ' + JSON.stringify(r.resumen).length);
  }
  const d = await runAssistantQuery(reader, { tipo: 'deudas_clientes' });
  const sent = JSON.stringify(d.resumen);
  for (const c of readerData.customers) { assert.ok(!sent.includes(c.nombre), 'sin nombre al modelo'); if (c.dni) assert.ok(!sent.includes(c.dni)); }
  assert.ok(d.filas.some((f) => readerData.customers.some((c) => c.nombre === f[0])), 'la pantalla sí ve el nombre');
  assert.deepEqual(await runAssistantQuery(reader, { tipo: 'borrar_todo' }), { error: 'bad_query' });
});

test('consultas sobre la base real (lectura canónica existente): 400 productos, al modelo van como mucho 8 filas', async (t) => {
  const f = await activeCanon(t, { migrations: ['0024_pos_roles_owner_pin.sql'] });
  const reader = canonicalReader(f.env.nuevo_amanecer_lab);
  const low = await runAssistantQuery(reader, { tipo: 'bajo_stock' });
  assert.ok(!low.error); assert.ok(low.resumen.revisados >= 28);
  assert.ok(low.resumen.primeros.length <= 8); assert.ok(low.filas.length <= 10);
  const sin = await runAssistantQuery(reader, { tipo: 'sin_costo' }); assert.ok(!sin.error);
  const deu = await runAssistantQuery(reader, { tipo: 'deudas_clientes' });
  assert.equal(deu.resumen.clientes_con_deuda, 1); assert.ok(!JSON.stringify(deu.resumen).includes('sintético'));
  for (const tipo of ['ventas_periodo', 'top_productos', 'compras_recientes', 'stock_producto']) assert.ok(!(await runAssistantQuery(reader, { tipo, producto: 'Synthetic 00002' })).error, tipo);
});

test('chat con consulta: segunda llamada a DeepSeek solo con el resumen (mensaje role tool), sin inventario completo; payload_bytes medido', async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ id: 'X' + i, nombre: 'Producto inventado ' + i, precio: 2, costo: i % 3 ? 1 : 0, stock: i % 5, min: 3, controla: true }));
  const reader = memoryReader({ ...readerData, products: many });
  const cap = [];
  const r = await chat({ text: '¿Qué me falta reponer?' }, { reader, fetch: scripted([{ content: '', tool_calls: [tool('consultar', { tipo: 'bajo_stock' }, 'call_1')] }, { content: 'Te faltan varios; los más urgentes están en la tabla.' }], cap) }, env({ DEEPSEEK_API_KEY: 'k' }));
  assert.equal(r.status, 200); assert.equal(cap.length, 2);
  const toolMsg = cap[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1'); assert.ok(toolMsg.content.length <= 2000);
  assert.equal(cap[1].tools, undefined, 'la segunda llamada no ofrece herramientas');
  const sent = JSON.stringify(cap[1]);
  assert.ok((sent.match(/Producto inventado/g) || []).length <= 8 + 25, 'solo el resumen (8) y el contexto chico (≤25)');
  const p = r.body.proposals[0]; assert.equal(p.type, 'consulta'); assert.equal(p.needsConfirm, false); assert.ok(!p.confirm_token);
  assert.ok(p.result.filas.length <= 10 && p.result.filas.length > 0);
  const [b1, b2] = r.body.payload_bytes; assert.ok(b1 > 0 && b1 < 12000 && b2 > 0 && b2 < 12000, 'bytes ' + r.body.payload_bytes);
  assert.match(r.body.reply, /más urgentes/);
});

test('si la segunda llamada falla, la respuesta usa el texto de la consulta (no inventa)', async () => {
  let n = 0; const f = async () => (++n === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [tool('consultar', { tipo: 'sin_costo' })] } }] })) : new Response('x', { status: 500 }));
  const r = await chat({ text: 'sin costo' }, { reader: memoryReader(readerData), fetch: f }, env({ DEEPSEEK_API_KEY: 'k' }));
  assert.equal(r.status, 200); assert.match(r.body.reply, /costo/);
});

test('foto de factura: compara costo actual y de factura; «Actualizar costo» es tarjeta aparte; la confirma solo la sesión dueño, de un toque', async () => {
  const lines = [{ product_id: 'P1', cantidad: 10, costo_unitario: 0.25 }, { product_id: 'P2', cantidad: 5, costo_unitario: 0.3 }, { nombre: 'Nuevo', cantidad: 1, costo_unitario: 1 }];
  const cap = [];
  const r = await chat({ text: 'lee', image: 'data:image/jpeg;base64,AAAA' }, { fetch: scripted([{ content: '', tool_calls: [tool('leer_factura_compra', { proveedor: 'Dist', lineas: lines })] }], cap) }, env({ DEEPSEEK_API_KEY: 'k' }));
  const [compra, costo] = r.body.proposals;
  assert.equal(compra.type, 'compra'); assert.equal(compra.lineas[0].costo_actual, 0.2);
  assert.equal(costo.type, 'costo'); assert.equal(costo.product_id, 'P1'); assert.equal(costo.costo_nuevo, 0.25); assert.ok(costo.confirm_token);
  assert.equal(r.body.proposals.length, 2, 'P2 sin cambio de costo y la fila nueva no generan tarjeta');
  const tok = await readConfirmToken(costo.confirm_token, SECRET); assert.equal(tok.t, 'costo');
  const { confirm_token, ...clean } = costo;
  const seen = []; const store = createMemoryUsageStore();
  const send = (role) => assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', body: JSON.stringify({ token: confirm_token, proposal: clean }) }), env(), OWNER, json, { store, resolveRole: async () => role, verifyApproval: async (id) => { seen.push(id); return true; } });
  const emp = await send('empleado:consultas_documentos'); assert.equal(emp.status, 403); assert.equal((await emp.json()).error, 'forbidden_role');
  const c = await send('owner'); assert.equal(c.status, 200); assert.deepEqual(seen, [], 'sin PIN: no se pide aprobación');
  assert.equal(costProposals({ lineas: [{ product_id: 'P1', costo_unitario: 1, costo_actual: 1 }] }).length, 0);
});

test('producto nuevo: sin PIN, la sesión dueño confirma de un toque; empleado o sin rol, 403', async () => {
  const r = await chat({ text: 'crea el producto nuevo Jabón inventado a 3.50 costo 2' });
  const p = r.body.proposals[0]; assert.equal(p.type, 'producto');
  const { confirm_token, ...clean } = p; const seen = [];
  const send = (role) => assistantConfirmRoute(new Request('https://w.test/auth/assistant/confirm', { method: 'POST', body: JSON.stringify({ token: confirm_token, proposal: clean }) }), env(), OWNER, json, { store: createMemoryUsageStore(), resolveRole: async () => role, verifyApproval: async (id) => { seen.push(id); return true; } });
  for (const role of ['empleado:consultas', 'empleado:consultas_documentos']) { const r = await send(role); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'forbidden_role'); }
  for (const role of ['sin_rol', 'empleado:off']) { const r = await send(role); assert.equal(r.status, 403); assert.equal((await r.json()).error, 'assistant_off'); }
  const ok = await send('owner'); assert.equal(ok.status, 200); assert.deepEqual(seen, []);
});

test('preparar_documento: propuesta de solo lectura, NO fiscal, 6 tipos acordados', async () => {
  assert.deepEqual([...DOC_TYPES], ['inventario_valorizado', 'lista_precios', 'lista_pedido', 'reporte_ventas', 'estado_cuenta', 'resumen_cierre']);
  for (const text of ['imprime el inventario valorizado', 'arma la lista de pedido', 'estado de cuenta de Rosa Quispe DNI 45678912']) {
    const r = await chat({ text });
    const p = r.body.proposals[0]; assert.equal(p.type, 'documento', text); assert.equal(p.fiscal, false); assert.equal(p.needsConfirm, false); assert.ok(!p.confirm_token);
    assert.ok(!JSON.stringify(r.body).includes('45678912'));
  }
});
