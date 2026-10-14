// Búsqueda de DNI al agregar cliente. Solo fixtures locales: nunca llama a Decolecta de verdad.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { a6Fixture } from './a6-fixture.mjs';
import { dniLookupRoute, queryDecolecta, DECOLECTA_URL, LIMITS } from '../../tools/cloudflare-lab/src/pos-dni-lookup.js';

const read = n => readFileSync(new URL('../../infra/database/migrations/' + n, import.meta.url), 'utf8');
const FAKE = 'fake-test-token';
async function setup(t) {
  const f = await a6Fixture(t);
  f.database.exec(read('0010_session_auth.sql').replace(/DROP INDEX[^;]*;/, ''));
  f.database.exec(read('0024_pos_roles_owner_pin.sql'));
  f.addDevice('owner-phone', 'writer', 'active', 'owner-token');
  f.env.DECOLECTA_API_TOKEN = FAKE;
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    return new Response(JSON.stringify({ first_name: 'ANA', first_last_name: 'PEREZ', second_last_name: 'RUIZ', full_name: 'PEREZ RUIZ, ANA', document_number: '12345678', extra: 'no-debe-salir' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  f.calls = calls;
  return f;
}
const H = token => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
async function call(f, path, token, body) {
  const r = await f.fetch('http://localhost' + path, { method: 'POST', headers: H(token), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function employee(f) {
  await call(f, '/auth/owner-pin', 'owner-token', { new_pin: '2468' });
  const code = await call(f, '/auth/pairing-code', 'owner-token', { label: 'Caja 2', pin: '2468' });
  const paired = await call(f, '/auth/pair', null, { code: code.body.code });
  return paired.body.session_token;
}

test('nuevo DNI: el Worker consulta con su secreto y devuelve solo nombre y apellidos', async t => {
  const f = await setup(t);
  const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni: '12345678' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'found', name: 'ANA PEREZ RUIZ', first_name: 'ANA', last_names: 'PEREZ RUIZ' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, DECOLECTA_URL + '?numero=12345678');
  assert.equal(f.calls[0].auth, 'Bearer ' + FAKE);
  assert.ok(!JSON.stringify(r.body).includes(FAKE));
});

test('DNI ya guardado: abre esa ficha y no gasta consulta', async () => {
  const seen = [];
  const db = { prepare: sql => ({ bind: (...args) => ({ first: async () => { seen.push([sql, args]); return /canonical_live_customers/.test(sql) && args[0] === '87654321' ? { customer_id: 'c-1', name: 'Cliente  Uno' } : null; } }) }) };
  let fetched = 0;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const req = new Request('http://localhost/auth/dni-lookup', { method: 'POST', body: JSON.stringify({ dni: '87654321' }) });
  const r = await dniLookupRoute(req, { DECOLECTA_API_TOKEN: FAKE }, { posRole: 'empleado', principalId: 'd' }, json, db, { fetch: async () => { fetched++; } });
  assert.deepEqual(await r.json(), { status: 'existing', customer_id: 'c-1', name: 'Cliente Uno' });
  assert.equal(fetched, 0);
  assert.ok(seen.every(([sql]) => !/pos_settings/.test(sql)), 'no cuenta consulta');
});

test('DNI inválido, sin sesión y sin secreto', async t => {
  const f = await setup(t);
  assert.equal((await call(f, '/auth/dni-lookup', 'owner-token', { dni: '1234' })).status, 400);
  assert.equal((await call(f, '/auth/dni-lookup', 'bad', { dni: '12345678' })).status, 401);
  delete f.env.DECOLECTA_API_TOKEN;
  const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni: '12345678' });
  assert.deepEqual(r.body, { status: 'manual', reason: 'not_configured' });
  assert.equal(f.calls.length, 0);
});

test('empleado: límite por minuto; contadores ocultos en /settings', async t => {
  const f = await setup(t);
  const tok = await employee(f);
  assert.ok(tok);
  for (let i = 0; i < LIMITS.employeePerMinute; i++) { const r = await call(f, '/auth/dni-lookup', tok, { dni: '1000000' + i }); assert.equal(r.body.status, 'found', JSON.stringify(r)); }
  const over = await call(f, '/auth/dni-lookup', tok, { dni: '20000000' });
  assert.equal(over.status, 429);
  assert.deepEqual(over.body, { status: 'manual', reason: 'minute_limit' });
  assert.equal(f.calls.length, LIMITS.employeePerMinute);
  const s = await f.fetch('http://localhost/settings', { headers: H('owner-token') });
  const keys = (await s.json()).settings.map(x => x.key);
  assert.ok(!keys.some(k => k.startsWith('internal:')));
});

test('tope mensual del negocio', async t => {
  const f = await setup(t);
  f.env.DNI_LOOKUP_MONTHLY_CAP = '2';
  await call(f, '/auth/dni-lookup', 'owner-token', { dni: '11111111' });
  await call(f, '/auth/dni-lookup', 'owner-token', { dni: '22222222' });
  const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni: '33333333' });
  assert.deepEqual(r.body, { status: 'manual', reason: 'monthly_limit' });
  assert.equal(f.calls.length, 2);
});

test('servicio lento o caído: pasa a nombre manual', async () => {
  const slow = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  assert.deepEqual(await queryDecolecta('12345678', 't', slow, 30), { status: 'timeout' });
  assert.deepEqual(await queryDecolecta('12345678', 't', async () => { throw new Error('offline'); }), { status: 'provider_error' });
  assert.deepEqual(await queryDecolecta('12345678', 't', async () => new Response('{}', { status: 404 })), { status: 'not_found' });
  assert.deepEqual(await queryDecolecta('12345678', 't', async () => new Response('{}', { status: 401 })), { status: 'provider_auth' });
});

test('el celular nunca llama a Decolecta ni ve la clave', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.ok(!/decolecta/i.test(client.replace(/^\s*\/\*[\s\S]*?\*\//, '')));
  assert.match(client, /\/auth\/dni-lookup/);
  assert.match(client, /TIMEOUT_MS = 3000/);
  assert.match(readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8'), /js\/config\/pos-dni-lookup-client\.js/);
  assert.match(readFileSync(new URL('../../POS/sw.js', import.meta.url), 'utf8'), /'\.\/js\/config\/pos-dni-lookup-client\.js'/);
});

test('fetch compatible con Cloudflare Workers: nunca redirect "error"', async () => {
  let seen;
  const r = await queryDecolecta('12345678', 't', async (_u, init) => { seen = init; return new Response(JSON.stringify({ first_name: 'A', first_last_name: 'B', second_last_name: 'C' }), { status: 200 }); });
  assert.equal(r.status, 'found');
  assert.ok(['follow', 'manual', undefined].includes(seen.redirect));
  assert.deepEqual(await queryDecolecta('12345678', 't', async () => new Response('', { status: 302 })), { status: 'provider_error' });
});

test('celular: respuesta lenta completa el nombre después; fallo de red no se recuerda como «sin nombre»', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.ok(!/Promise\.race/.test(client), 'no se descarta la respuesta que llega después de 3 s');
  assert.match(client, /if \(reason === 'not_found'\) asked\[dni\] = \{ name: null \};/);
  assert.match(client, /'network'/);
});

test('celular: sin exigir Canonical.enabled, varios eventos y una sola consulta por DNI', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.ok(!/NuevoAmanecerCanonical\.enabled/.test(client));
  for (const ev of ['input', 'change', 'blur', 'keyup']) assert.ok(client.includes(`'${ev}'`));
  assert.match(client, /addEventListener\('paste'/);
  assert.match(client, /if \(inflight === dni\) return;/);
});

test('celular: sesión vencida/desconectada da mensaje claro y solo «not_found» se recuerda', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.match(client, /e\.status === 401 \|\| e\.status === 403/);
  assert.match(client, /Sesión vencida o aparato desconectado: vuelva a vincular/);
  assert.equal((client.match(/asked\[dni\] = \{ name: null \}/g) || []).length, 1);
});

test('DNI existente: cierra con cerrarModal real, abre la cuenta y avisa según lo que pasó', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.match(client, /typeof cerrarModal === 'function'/);
  assert.match(client, /naCanonOpenClientAccount\(found\.id\)/);
  assert.match(client, /opened \? /);
  assert.match(client, /Ya hay un nombre escrito/);
});

test('actualización automática: no recarga con Nueva compra, anulación, revisiones, descuento ni foto OCR en curso', () => {
  const index = readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
  const ocr = readFileSync(new URL('../../POS/js/ocr/ocr-purchase-integration.js', import.meta.url), 'utf8');
  for (const sel of ['.modal-overlay.open', '.na-pin-overlay', '.na-review-overlay', '.na-ds-overlay']) assert.ok(index.includes(sel), sel);
  assert.match(index, /window\.NAOcrBusy && window\.NAOcrBusy\(\)/);
  assert.match(ocr, /root\.NAOcrBusy = function \(\) \{ return !!\(reading \|\| applying\); \};/);
  // la recarga tras «controllerchange» espera ventanas abiertas, no solo el carrito
  assert.match(index, /afterSaleFinishes\(function \(\) \{\s*\/\/[^\n]*\n\s*if \(quietNeeded\(\)/);
});

test('lote abono: guardia frena con abono escrito, confirmación abierta y cola; borrador persistente sin duplicar', () => {
  const index = readFileSync(new URL('../../POS/index.html', import.meta.url), 'utf8');
  const v2 = readFileSync(new URL('../../POS/js/modules/client-credit-accounts-v2.js', import.meta.url), 'utf8');
  assert.ok(index.includes('.na-confirm-overlay.open'));
  assert.match(index, /getElementById\('naV2BatchAmount'\)/);
  assert.match(index, /if \(quietNeeded\(\) \|\| queuedWork\(\)\)/);
  assert.match(index, /function queuedWork\(\) \{\s*if \(updateBusy\) return false;/);
  assert.match(v2, /na_v2_abono_draft_v1/);
  assert.match(v2, /labBatchSubmitInFlight = true;\s*naV2DraftMarkSubmitted\(\);/);
  assert.match(v2, /naV2DraftSkip = true;\s*naV2DraftClear\(\);/);
  assert.match(v2, /if \(d\.submitted \|\|/);
  assert.match(v2, /draft\.checks/);
});

test('DNI: tras rellenar no repite ni avisa; «La búsqueda tarda» no lo pisa keyup/blur', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.match(client, /if \(!done && inflight === dni\) hint\(SLOW\)/);
  assert.ok(client.indexOf('if (inflight === dni) return;') < client.indexOf("hint('Ya hay un nombre escrito"));
  assert.match(client, /clean\(nameEl\.value\) === clean\(asked\[dni\]\.name\)\) return;/);
});
