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
  assert.match(v2, /if \(d\.submitted\) \{[\s\S]{0,400}return null;/);
  assert.match(v2, /draft\.checks/);
});

test('DNI: tras rellenar no repite ni avisa; «La búsqueda tarda» no lo pisa keyup/blur', () => {
  const client = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  assert.match(client, /if \(!done && inflight === dni\) hint\(slowMsg\(dni\)\)/);
  assert.ok(client.indexOf('if (inflight === dni) return;') < client.indexOf("'Ya hay un nombre escrito"));
  assert.match(client, /clean\(nameEl\.value\) === clean\(asked\[dni\]\.name\)\) return;/);
});

test('tablet/PC: Caja y Ventas se desplazan como página completa (KPIs no tapan Reportes); celular sin cambios', () => {
  const css = readFileSync(new URL('../../POS/css/canon-ux-fixes.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* Tablet y PC: en Caja del Día'));
  assert.match(block, /#pageCaja\.active,#pageVentas\.active\{overflow-y:auto!important/);
  assert.match(block, /#pageCaja #cajContent,#pageVentas #ventasContent\{flex:none!important;overflow-y:visible!important/);
});

test('RUC 20: SUNAT devuelve razón social y dirección con el mismo endpoint', async t => {
  const f = await setup(t);
  const { DECOLECTA_RUC_URL } = await import('../../tools/cloudflare-lab/src/pos-dni-lookup.js');
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url: String(url), auth: init?.headers?.authorization });
    return new Response(JSON.stringify({ razon_social: '  NEGOCIO\n NUEVO AMANECER  ', direccion: ' AV.\t LIMA 123 ' }), { status: 200 });
  };
  const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni: '20123456786' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'found', name: 'NEGOCIO NUEVO AMANECER', address: 'AV. LIMA 123', doc_type: 'ruc' });
  assert.equal(DECOLECTA_RUC_URL, 'https://api.decolecta.com/v1/sunat/ruc');
  assert.deepEqual(f.calls, [{ url: DECOLECTA_RUC_URL + '?numero=20123456786', auth: 'Bearer ' + FAKE }]);
  assert.equal(JSON.parse(f.sql("SELECT value_json FROM pos_settings WHERE key='internal:dni:month'").value_json).n, 1);
});

test('RUC 10: SUNAT 404 usa RENIEC con el DNI incluido y una sola reserva', async t => {
  const f = await setup(t);
  const { DECOLECTA_RUC_URL } = await import('../../tools/cloudflare-lab/src/pos-dni-lookup.js');
  globalThis.fetch = async (url, init) => {
    f.calls.push({ url: String(url), auth: init?.headers?.authorization });
    if (String(url).startsWith(DECOLECTA_RUC_URL)) return new Response('{}', { status: 404 });
    assert.equal(String(url), DECOLECTA_URL + '?numero=78203419');
    return new Response(JSON.stringify({ first_name: 'ANA', first_last_name: 'PEREZ', second_last_name: 'RUIZ' }), { status: 200 });
  };
  const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni: '10782034192' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'found', name: 'ANA PEREZ RUIZ', doc_type: 'ruc', source: 'reniec' });
  assert.deepEqual(f.calls, [
    { url: DECOLECTA_RUC_URL + '?numero=10782034192', auth: 'Bearer ' + FAKE },
    { url: DECOLECTA_URL + '?numero=78203419', auth: 'Bearer ' + FAKE },
  ]);
  assert.equal(JSON.parse(f.sql("SELECT value_json FROM pos_settings WHERE key='internal:dni:month'").value_json).n, 1);
});

test('RUC inválido: longitud, prefijo y caracteres se rechazan sin consultar', async t => {
  const f = await setup(t);
  for (const dni of ['1234567890', '30123456789', '1078203419a']) {
    const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni });
    assert.equal(r.status, 400, dni);
    assert.deepEqual(r.body, { error: 'invalid_dni' });
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key='internal:dni:month'").n, 0);
});

test('cliente: RUC de 11 dígitos rellena razón social y dirección vacía; 9-10 dígitos no consulta', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  const els = {};
  const el = id => (els[id] ||= { id, value: '', dataset: {}, hidden: false, textContent: '', style: {}, classList: { contains: () => true, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => null,
    insertAdjacentElement(_, n) { els[n.id] = n; } });
  ['cDni', 'cNombre', 'cDir', 'mCli'].forEach(el);
  const document = { readyState: 'complete', getElementById: id => els[id] || null, createElement: () => el('tmp' + Math.random()), addEventListener() {} };
  const posted = [];
  const win = { document, navigator: { onLine: true }, setTimeout: () => 0,
    NA_ROLES: { api: async (path, body) => { posted.push([path, body]); return { status: 'found', name: 'MI EMPRESA SAC', address: 'AV. LIMA 123', doc_type: 'ruc' }; } } };
  vm.runInNewContext(src, { window: win, globalThis: win, Date, String, Array, Object });
  els.cDni.value = '1234567890'; await win.NA_DNI_LOOKUP.check();
  assert.equal(posted.length, 0);
  els.cDni.value = '20123456786'; await win.NA_DNI_LOOKUP.check();
  assert.equal(JSON.stringify(posted), JSON.stringify([['/auth/dni-lookup', { dni: '20123456786' }]]));
  assert.equal(els.cNombre.value, 'MI EMPRESA SAC');
  assert.equal(els.cDir.value, 'AV. LIMA 123');
});

// ---- Revisión PR #650 ----
import { rucCheckOk } from '../../tools/cloudflare-lab/src/pos-dni-lookup.js';
async function clientHarness({ clientes = [], reply, online = true } = {}) {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../../POS/js/config/pos-dni-lookup-client.js', import.meta.url), 'utf8');
  const els = {};
  const el = id => (els[id] ||= { id, value: '', dataset: {}, hidden: false, textContent: '', style: {}, classList: { contains: () => true, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => null, insertAdjacentElement(_, n) { els[n.id] = n; } });
  ['cDni', 'cNombre', 'cDir', 'mCli'].forEach(el);
  const document = { readyState: 'complete', getElementById: id => els[id] || null, createElement: () => el('tmp' + Math.random()), addEventListener() {} };
  const posted = [];
  const timers = [];
  const win = { document, navigator: { onLine: online }, setTimeout: fn => { timers.push(fn); return 0; },
    NA_ROLES: { api: async (path, body) => { posted.push(body.dni); return reply ? reply(body.dni) : { status: 'manual', reason: 'not_found' }; } } };
  vm.runInNewContext(`var clientes = ${JSON.stringify(clientes)};\n` + src, { window: win, globalThis: win, Date, String, Array, Object, Number });
  const type = async v => { els.cDni.value = v; await win.NA_DNI_LOOKUP.check(); };
  return { els, posted, type, timers, api: win.NA_DNI_LOOKUP, hint: () => els.cDniHint?.textContent || '' };
}

test('1 cliente: RUC 10 encuentra al cliente guardado con su DNI (y al revés), sin consultar', async () => {
  let h = await clientHarness({ clientes: [{ id: 7, nombre: 'ANA', dni: '78203419' }] });
  await h.type('10782034192');
  assert.equal(h.posted.length, 0);
  assert.deepEqual({ ...h.api.findLocal('10782034192') }, { id: 7, name: 'ANA' });
  h = await clientHarness({ clientes: [{ id: 8, nombre: 'ANA', dni: '10782034192' }] });
  await h.type('78203419');
  assert.equal(h.posted.length, 0);
  assert.equal(h.api.findLocal('78203419').id, 8);
});

test('2 cliente: textos de RUC hablan de razón social', async () => {
  const h = await clientHarness();
  h.els.cNombre.value = 'X';
  await h.type('20123456786');
  assert.match(h.hint(), /razón social escrita.*por RUC/);
  h.els.cNombre.value = '';
  await h.type('20123456786');
  assert.equal(h.hint(), 'No se encontró la razón social. Escríbala a mano.');
  await h.type('87654321');
  assert.equal(h.hint(), 'No se encontró el nombre. Escríbalo a mano.');
});

test('3 cliente: la dirección puesta por la búsqueda se reemplaza en otra búsqueda; la editada se respeta', async () => {
  const h = await clientHarness({ reply: n => ({ status: 'found', name: 'EMP ' + n, address: 'DIR ' + n }) });
  await h.type('20123456786');
  assert.equal(h.els.cDir.value, 'DIR 20123456786');
  h.els.cNombre.value = '';
  await h.type('10782034192');
  assert.equal(h.els.cDir.value, 'DIR 10782034192');
  h.els.cDir.value = 'MI DIRECCION'; h.els.cNombre.value = '';
  await h.type('20123456786');
  assert.equal(h.els.cDir.value, 'MI DIRECCION');
});

test('4 cliente: RUC pegado con guiones se consulta como 11 dígitos', async () => {
  const h = await clientHarness({ reply: () => ({ status: 'found', name: 'ANA PEREZ' }) });
  await h.type('10-78203419-2');
  assert.deepEqual([...h.posted], ['10782034192']);
  assert.equal(h.els.cNombre.value, 'ANA PEREZ');
});

test('5 servidor: respaldo RENIEC solo ante not_found/provider_auth, no ante 429 ni tiempo agotado', async () => {
  const { DECOLECTA_RUC_URL } = await import('../../tools/cloudflare-lab/src/pos-dni-lookup.js');
  let i = 0;
  for (const [sunat, fallback] of [[404, true], [401, true], [429, false], ['timeout', false]]) {
    i++; // cada caso, fuera del enfriamiento de 30 s del anterior
    const urls = [];
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ meta: { changes: 1 } }) }) }) };
    const fetchImpl = async (url, init) => {
      urls.push(String(url));
      if (String(url).startsWith(DECOLECTA_RUC_URL)) {
        if (sunat === 'timeout') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
        return new Response('{}', { status: sunat });
      }
      return new Response(JSON.stringify({ first_name: 'ANA', first_last_name: 'PEREZ' }), { status: 200 });
    };
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    const req = new Request('http://localhost/auth/dni-lookup', { method: 'POST', body: JSON.stringify({ dni: '10782034192' }) });
    const r = await dniLookupRoute(req, { DECOLECTA_API_TOKEN: FAKE }, { posRole: 'dueno', principalId: 'o' }, json, db, { fetch: fetchImpl, timeoutMs: 20, now: () => 2e12 + i * 60000 });
    const body = await r.json();
    assert.equal(urls.length, fallback ? 2 : 1, String(sunat) + ' ' + JSON.stringify(body));
    assert.equal(body.status, fallback ? 'found' : 'manual', String(sunat));
  }
});

test('6 RUC con dígito verificador incorrecto: 400 sin consulta ni cupo; cliente avisa al instante', async t => {
  assert.equal(rucCheckOk('10782034192'), true);
  assert.equal(rucCheckOk('20123456786'), true);
  assert.equal(rucCheckOk('10782034193'), false);
  const f = await setup(t);
  const r = await call(f, '/auth/dni-lookup', 'owner-token', { dni: '10782034193' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'invalid_dni' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.sql("SELECT COUNT(*) n FROM pos_settings WHERE key='internal:dni:month'").n, 0);
  const h = await clientHarness();
  await h.type('10782034193');
  assert.equal(h.posted.length, 0);
  assert.match(h.hint(), /^RUC inválido/);
});

test('7 servidor: RUC 10 encuentra al cliente guardado con el DNI incluido, sin gastar cupo', async () => {
  const seen = [];
  const db = { prepare: sql => ({ bind: (...args) => ({ first: async () => { seen.push(sql); return /canonical_live_customers/.test(sql) && args[2] === '78203419' ? { customer_id: 'c-9', name: 'ANA' } : null; } }) }) };
  let fetched = 0;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const req = new Request('http://localhost/auth/dni-lookup', { method: 'POST', body: JSON.stringify({ dni: '10782034192' }) });
  const r = await dniLookupRoute(req, { DECOLECTA_API_TOKEN: FAKE }, { posRole: 'empleado', principalId: 'd' }, json, db, { fetch: async () => { fetched++; } });
  assert.deepEqual(await r.json(), { status: 'existing', customer_id: 'c-9', name: 'ANA' });
  assert.equal(fetched, 0);
  assert.ok(seen.every(sql => !/pos_settings/.test(sql)));
});

// ---- Revisión 2 PR #650 ----
import { ruc10For } from '../../tools/cloudflare-lab/src/pos-dni-lookup.js';

test('R2-1 cliente: «tarda», «sin conexión» y «límite» dicen razón social para RUC y nombre para DNI', async () => {
  let h = await clientHarness({ online: false });
  await h.type('10782034192');
  assert.equal(h.hint(), 'Sin conexión: escriba la razón social a mano.');
  await h.type('78203419');
  assert.equal(h.hint(), 'Sin conexión: escriba el nombre a mano.');
  h = await clientHarness({ reply: () => ({ status: 'manual', reason: 'daily_limit' }) });
  await h.type('20123456786');
  assert.equal(h.hint(), 'Límite de búsquedas alcanzado. Escriba la razón social a mano.');
  let release;
  h = await clientHarness({ reply: () => new Promise(r => { release = r; }) });
  const pending = h.type('20123456786');
  await new Promise(r => setImmediate(r));
  h.timers.forEach(fn => fn());
  assert.equal(h.hint(), 'La búsqueda tarda. Escriba la razón social a mano; si llega, se completa sola.');
  release({ status: 'manual', reason: 'not_found' }); await pending;
});

test('R2-2 cliente: el RUC pegado con guiones/espacios queda solo con dígitos en el campo; lo incompleto no se toca', async () => {
  const h = await clientHarness({ reply: () => ({ status: 'found', name: 'ANA PEREZ' }) });
  await h.type('10-78203419-2');
  assert.equal(h.els.cDni.value, '10782034192');
  h.els.cNombre.value = '';
  await h.type('7820 3419');
  assert.equal(h.els.cDni.value, '78203419');
  await h.type('10-7820');
  assert.equal(h.els.cDni.value, '10-7820');
});

test('R2-2 guardado: alta canónica y alta clásica limpian guiones/espacios del DNI/RUC', () => {
  const bridge = readFileSync(new URL('../../POS/js/sync/canonical-customer-bridge.js', import.meta.url), 'utf8');
  const m = bridge.match(/function docDigits\(v\)\{[^\n]*\}/);
  assert.ok(m);
  const docDigits = new Function(m[0] + '; return docDigits;')();
  assert.equal(docDigits('10-78203419-2'), '10782034192');
  assert.equal(docDigits('7820 3419'), '78203419');
  assert.equal(docDigits('ABC-1'), 'ABC-1');
  assert.match(bridge, /documentId=docDigits\(clean\(value\('cDni'\)\)\)/);
  const legacy = readFileSync(new URL('../../POS/js/legacy-inline/inline-02.js', import.meta.url), 'utf8');
  const fn = legacy.match(/dni=(\(d=>[^\n]*?:d\))\(_naClean\(document\.getElementById\('cDni'\)\.value\)\)/);
  assert.ok(fn, 'alta clásica normaliza el documento');
  const norm = eval(fn[1]);
  assert.equal(norm('10-78203419-2'), '10782034192');
  assert.equal(norm('ABC-1'), 'ABC-1');
});

test('R2-3 servidor: un DNI encuentra al cliente guardado con su RUC 10, sin gastar cupo', async () => {
  assert.equal(ruc10For('78203419'), '10782034192');
  assert.equal(ruc10For('1234'), null);
  const seen = [];
  const db = { prepare: sql => ({ bind: (...args) => ({ first: async () => { seen.push(sql); return /canonical_live_customers/.test(sql) && args[2] === '10782034192' ? { customer_id: 'c-r', name: 'ANA' } : null; } }) }) };
  let fetched = 0;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const req = new Request('http://localhost/auth/dni-lookup', { method: 'POST', body: JSON.stringify({ dni: '78203419' }) });
  const r = await dniLookupRoute(req, { DECOLECTA_API_TOKEN: FAKE }, { posRole: 'empleado', principalId: 'd' }, json, db, { fetch: async () => { fetched++; } });
  assert.deepEqual(await r.json(), { status: 'existing', customer_id: 'c-r', name: 'ANA' });
  assert.equal(fetched, 0);
  assert.ok(seen.every(sql => !/pos_settings/.test(sql)));
});
