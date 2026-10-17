// Bot 5 sobre 5662737a: la foto es solo del dueño. Un aparato que no es dueño (empleado con nivel, sin rol, apagado) recibe 403 ANTES de
// leer o interpretar la foto: sin JSON.parse de la foto, sin cupo, sin DeepSeek. La bitácora lo anota agrupado como los otros 403 de rol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assistantChatRoute, createMemoryUsageStore, hasImageField, readBounded, EMPLOYEE_MAX_BODY_BYTES, IMAGE_OWNER_ONLY } from '../../tools/cloudflare-lab/src/pos-assistant.js';
import { isAggregated, bucketOf } from '../../tools/cloudflare-lab/src/pos-assistant-audit.js';
const require = createRequire(import.meta.url);
const C = require('../../POS/js/modules/asistente/asistente-core.js');

const ENV = { ASSISTANT_ENABLED: '1', ASSISTANT_CONFIRM_SECRET: 'secreto-de-prueba-0123456789abcdef', DEEPSEEK_API_KEY: 'k' };
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(4000);
const BIG = 'data:image/jpeg;base64,' + 'A'.repeat(900_000);
const jsonR = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });

function harness(role) {
  const ds = { calls: 0 }, rows = [], store = createMemoryUsageStore();
  const fetch = async () => { ds.calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'Leí la foto.' } }] })); };
  const send = async (body, { headers = {}, raw } = {}) => {
    const text = raw != null ? raw : JSON.stringify(body);
    const req = new Request('https://w.test/auth/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers }, body: text });
    const r = await assistantChatRoute(req, ENV, { principalId: 'session:x', posRole: role === 'owner' ? 'owner' : 'empleado' }, jsonR,
      { store, resolveRole: async () => role, fetch, audit: async (_db, r2) => { rows.push(...r2); }, reader: { products: async () => [] } });
    return { status: r.status, body: await r.json() };
  };
  return { ds, rows, store, send };
}

test('empleado (con nivel) que manda una foto: 403 image_owner_only, DeepSeek 0 veces, sin cupo; bitácora agrupada', async () => {
  for (const role of ['empleado:consultas', 'empleado:consultas_documentos']) {
    const h = harness(role);
    for (const img of [IMG, BIG]) {
      const r = await h.send({ text: 'lee esta factura', image: img, context: {} });
      assert.equal(r.status, 403, role); assert.equal(r.body.error, 'image_owner_only'); assert.equal(r.body.message, 'Eso solo lo puede hacer el dueño.');
    }
    // aunque no declare tamaño ni tipo: cabecera de foto, tipo multipart/imagen, o campo image escondido al final
    assert.equal((await h.send({ text: 'x', image: IMG }, { headers: { 'x-assistant-image': '1' } })).status, 403);
    assert.equal((await h.send(null, { raw: '--b\r\nContent-Type: image/jpeg\r\n\r\nAAAA', headers: { 'content-type': 'multipart/form-data; boundary=b' } })).status, 403);
    assert.equal((await h.send(null, { raw: '{"text":"hola","context":{},"image" : "data:image/png;base64,AAAA"}' })).status, 403);
    assert.equal(h.ds.calls, 0, 'DeepSeek nunca se llamó'); assert.equal(h.store._map.size, 0, 'no se gastó cupo');
    assert.ok(h.rows.length >= 5 && h.rows.every((x) => x.outcome === 'rejected:image_owner_only' && x.aggregate === true && x.src === 'chat'), JSON.stringify(h.rows[0]));
    // el mismo empleado sin foto sigue pudiendo preguntar
    const ok = await h.send({ text: '¿qué falta reponer?', context: {} }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(h.ds.calls, 1);
  }
});

test('sin rol y apagado: 403 antes de leer el cuerpo (ni foto ni DeepSeek)', async () => {
  for (const role of ['sin_rol', 'empleado:off']) {
    const h = harness(role); const r = await h.send({ text: 'x', image: BIG });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'assistant_off'); assert.equal(h.ds.calls, 0); assert.equal(h.store._map.size, 0);
  }
});

test('el empleado no se lee entero: cuerpo grande se corta por tamaño declarado o leyendo con tope (sin content-length)', async () => {
  const h = harness('empleado:consultas');
  const big = JSON.stringify({ text: 'x', image: BIG });
  assert.equal((await h.send(null, { raw: big })).status, 403);
  // sin content-length (cuerpo en trozos): readBounded corta en cuanto pasa el tope y no baja el resto
  let pulled = 0; const chunk = new Uint8Array(16_384).fill(65);
  const stream = new ReadableStream({ pull(c) { pulled++; if (pulled > 200) c.close(); else c.enqueue(chunk); } });
  const req = new Request('https://w.test/x', { method: 'POST', body: stream, duplex: 'half' });
  assert.equal(await readBounded(req, EMPLOYEE_MAX_BODY_BYTES), null); assert.ok(pulled <= Math.ceil(EMPLOYEE_MAX_BODY_BYTES / 16_384) + 3, String(pulled));
  assert.equal(await readBounded(new Request('https://w.test/x', { method: 'POST', body: '{"text":"hola"}' }), 100), '{"text":"hola"}');
  // la palabra "image" escrita DENTRO del texto no cuenta como foto; image:null tampoco
  assert.equal(hasImageField(JSON.stringify({ text: 'mi "image": favorita' })), false);
  assert.equal(hasImageField('{"text":"x","image":null}'), false);
  assert.equal(hasImageField('{"text":"x","image":"data:"}'), true);
  assert.equal((await h.send({ text: 'el "image": del producto', context: {} })).status, 200);
});

test('dueño con foto: sigue funcionando (llega a DeepSeek una vez)', async () => {
  const h = harness('owner');
  const r = await h.send({ text: 'lee esta factura', image: IMG, context: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(h.ds.calls, 1); assert.equal(r.body.reply, 'Leí la foto.');
});

test('celular: image_owner_only se muestra como «Eso solo lo puede hacer el dueño.», sin código ni «Reintentar»; no quita el asistente', () => {
  const f = C.friendlyError('image_owner_only'); assert.equal(f.msg, 'Eso solo lo puede hacer el dueño.'); assert.equal(f.retry, false);
  assert.equal(IMAGE_OWNER_ONLY.error, 'image_owner_only');
  const ui = readFileSync(new URL('../../POS/js/modules/asistente/asistente-ui.js', import.meta.url), 'utf8');
  const lost = ui.match(/var ACCESS_LOST = \{[^}]*\}/); assert.ok(lost && !/image_owner_only/.test(lost[0]), 'no es pérdida de acceso');
  assert.ok(isAggregated('rejected:image_owner_only'));
  const k = bucketOf({ device_id: 'session:x', role: 'empleado:consultas', outcome: 'rejected:image_owner_only', aggregate: true });
  assert.ok(k, String(k));
});
