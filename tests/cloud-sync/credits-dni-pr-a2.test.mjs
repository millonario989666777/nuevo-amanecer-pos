// Borrador de abono por cliente, aviso con otro abono pendiente y «Reintentar» con cuenta regresiva.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dniLookupRoute } from '../../tools/cloudflare-lab/src/pos-dni-lookup.js';

const v2 = readFileSync('POS/js/modules/client-credit-accounts-v2.js', 'utf8');
const dniClient = readFileSync('POS/js/config/pos-dni-lookup-client.js', 'utf8');
const css = readFileSync('POS/css/canon-ux-fixes.css', 'utf8');

function storage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}
function loadDrafts(ls) {
  const a = v2.indexOf("  var NA_V2_DRAFT_KEY = "), b = v2.indexOf('  var naV2Restoring');
  const c = { root: { localStorage: ls }, labClientScreenState: { clientId: 'A' }, JSON };
  vm.runInNewContext(v2.slice(a, b) + '\nthis.read=naV2StoredRead;this.write=naV2StoredWrite;', c);
  return c;
}

test('un borrador por cliente: el abono enviado de A no impide guardar ni leer el de B', () => {
  const ls = storage(); const c = loadDrafts(ls);
  c.write({ clientId: 'A', values: { naV2BatchAmount: '0.90' }, submitted: true, at: 1 });
  c.labClientScreenState.clientId = 'B';
  c.write({ clientId: 'B', values: { naV2BatchAmount: '0.40' }, submitted: false, at: 2 });
  assert.equal(c.read('A').submitted, true);
  assert.equal(c.read().values.naV2BatchAmount, '0.40');
  c.write(null, 'B'); assert.equal(c.read('B'), null); assert.ok(c.read('A'), 'borrar B no toca A');
});

test('migra el borrador único anterior a la ranura de su cliente', () => {
  const old = JSON.stringify({ clientId: 'C9', values: { naV2BatchAmount: '5' }, at: 3 });
  const ls = storage({ na_v2_abono_draft_v1: old }); const c = loadDrafts(ls);
  assert.equal(ls.getItem('na_v2_abono_draft_v1'), null);
  assert.equal(c.read('C9').values.naV2BatchAmount, '5');
});

test('restaurar: solo se bloquea la ficha con su propio abono enviado; aviso al confirmar con otro pendiente', () => {
  assert.match(v2, /var own = naV2StoredRead\(draft\.clientId\); if \(own && own\.submitted && naV2PendingBatch\(\)\) return;/);
  assert.doesNotMatch(v2, /    if \(naV2PendingBatch\(\)\) return; \/\/ hay un lote/);
  assert.ok(v2.includes('Hay otro abono terminando de enviarse. Este queda guardado'));
  assert.match(v2, /var subCid = labClientScreenState\.clientId;/);
  assert.match(v2, /naV2DraftMarkSubmitted\(subCid\)/);
});

test('Worker en espera: responde cuántos segundos faltan para reintentar', async () => {
  let t = 1_900_000_000_000;
  const db = { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }), first: async () => null }) };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const deps = { now: () => t, fetch: async () => new Response('x', { status: 500 }) };
  const req = () => new Request('http://l/auth/dni-lookup', { method: 'POST', body: JSON.stringify({ dni: '55667788' }) });
  const auth = { posRole: 'owner', principalId: 'p' };
  const a = await (await dniLookupRoute(req(), { DECOLECTA_API_TOKEN: 'fake' }, auth, json, db, deps)).json();
  assert.equal(a.retry_after, 30);
  t += 12_000;
  const b = await (await dniLookupRoute(req(), { DECOLECTA_API_TOKEN: 'fake' }, auth, json, db, deps)).json();
  assert.deepEqual(b, { status: 'manual', reason: 'cooldown', retry_after: 18 });
});

test('«Reintentar» desactivado con «disponible en N s», se activa solo; 44 px, ancho fijo y contraste', () => {
  assert.match(dniClient, /'Reintentar · disponible en ' \+ left \+ ' s'/);
  assert.match(dniClient, /btn\.disabled = false;/);
  assert.match(dniClient, /if \(btn\.disabled \|\| !failedAt\[dni\]\) return;/);
  assert.match(css, /\.na-dni-retry\{[^}]*min-height:44px;min-width:16\.5em;[^}]*font-variant-numeric:tabular-nums/);
  assert.match(css, /body\.dark \.na-dni-retry:disabled\{background:#334155;color:#f1f5f9\}/);
  assert.doesNotMatch(dniClient, /opacity:\.8/, 'la opacidad del aviso bajaba el contraste del botón');
});
