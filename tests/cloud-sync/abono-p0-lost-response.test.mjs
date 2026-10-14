// P0: un abono con respuesta perdida no puede cobrarse dos veces. Solo fixtures locales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dniLookupRoute } from '../../tools/cloudflare-lab/src/pos-dni-lookup.js';

const v2 = readFileSync('POS/js/modules/client-credit-accounts-v2.js', 'utf8');
const client = readFileSync('POS/js/sync/canonical-client.js', 'utf8');
const index = readFileSync('POS/index.html', 'utf8');
const dni = readFileSync('POS/js/config/pos-dni-lookup-client.js', 'utf8');
const sw = readFileSync('POS/sw.js', 'utf8');

test('respuesta perdida: el borrador enviado guarda el lote exacto y el reenvío reusa los mismos operation_id', () => {
  assert.match(v2, /if \(pend\) \{ sd\.batch = pend; naV2StoredWrite\(sd\); \}/);
  assert.match(v2, /prior && prior\.submitted && prior\.batch && prior\.clientId === labClientScreenState\.clientId/);
  assert.match(v2, /await canon\.resumePaymentBatch\(prior\.batch\)/);
  const resume = client.slice(client.indexOf('async function resumePaymentBatch'), client.indexOf('async function retryPending'));
  assert.match(resume, /payload: copy\(saved\.payload\)/, 'mismo payload, mismo operation_id, mismo hash');
  assert.match(resume, /current\.payload\.operation_id !== saved\.payload\.operation_id\) fail\('CANONICAL_FINANCIAL_PENDING'\)/);
  assert.doesNotMatch(resume, /makeId|operation_id\s*=/, 'nunca genera ids nuevos');
  assert.match(client, /resumePaymentBatch: resumePaymentBatch/);
});

test('borrador enviado nunca se pisa ni se restaura con un lote pendiente; restaurar no guarda', () => {
  assert.match(v2, /var prev = naV2StoredRead\(\); if \(prev && prev\.submitted\) return;/);
  assert.match(v2, /own\.submitted && naV2PendingBatch\(\)\) return;/);
  assert.match(v2, /naV2Restoring = true;/);
  assert.match(v2, /if \(naV2Restoring \|\| naV2DraftSkip/);
});

test('rechazo local no deja el borrador marcado como enviado', () => {
  for (const c of ['CANONICAL_PAYMENT_DISABLED', 'CANONICAL_PAYMENT_BUSY', 'EMPTY_BATCH', 'CANONICAL_OFFLINE', 'BATCH_REFERENCE_ALREADY_USED']) assert.ok(v2.includes(c), c);
  assert.match(v2, /NA_V2_LOCAL_CODES\.test\(String\(result\.code \|\| ''\)\)\) \{\s*sd\.submitted = false;/);
});

test('Actualizar ahora sin versión esperando solo recarga', () => {
  assert.doesNotMatch(index, /throw new Error\('NO_UPDATE_WORKER_AVAILABLE'\)/);
  assert.match(index, /window\.location\.reload\(\); \}, 80\);\s*return;/);
});

test('sw.js: precache tolerante, solo index.html es crítico', () => {
  assert.match(sw, /CRITICAL_SHELL/);
  assert.match(sw, /PRECACHE_ITEM_TIMEOUT_MS/);
});

test('DNI cliente: espera 45 s tras error y ofrece Reintentar', () => {
  assert.match(dni, /COOLDOWN_MS = 45000/);
  assert.match(dni, /'Reintentar'/);
});

test('DNI servidor: tras error del proveedor el mismo DNI no se vuelve a consultar ni gasta cupo', async () => {
  let fetched = 0, reserves = 0, t0 = 1_800_000_000_000;
  const db = { prepare: sql => ({ bind: () => ({ first: async () => { if (/pos_settings/.test(sql)) reserves++; return null; }, run: async () => ({}), all: async () => ({ results: [] }) }), first: async () => null }) };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const deps = { now: () => t0, fetch: async () => { fetched++; return new Response('x', { status: 500 }); } };
  const req = () => new Request('http://l/auth/dni-lookup', { method: 'POST', body: JSON.stringify({ dni: '11223344' }) });
  const auth = { posRole: 'owner', principalId: 'p' };
  const a = await (await dniLookupRoute(req(), { DECOLECTA_API_TOKEN: 'fake' }, auth, json, db, deps)).json();
  const before = reserves;
  const b = await (await dniLookupRoute(req(), { DECOLECTA_API_TOKEN: 'fake' }, auth, json, db, deps)).json();
  assert.equal(a.reason, 'provider_error');
  assert.equal(b.status, 'manual'); assert.equal(b.reason, 'cooldown');
  assert.equal(fetched, 1);
  assert.equal(reserves, before, 'no gasta cupo');
});
