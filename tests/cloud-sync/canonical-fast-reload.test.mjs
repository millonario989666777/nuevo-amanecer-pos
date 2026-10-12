import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon, device, storage } from './canon-browser-harness.mjs';

// F5 en CANON: una réplica ACTIVE validada por una lectura completa se reconfirma con status +
// credit-accounts y se omiten las demás colecciones si todo coincide. Cualquier diferencia vuelve a
// la lectura completa (en paralelo con status si la réplica no es candidata). La valla no se relaja.
const TOKEN = 'fast-reload-token';
const routeOf = (url) => new URL(url).pathname.replace('/read/canonical/', '');
const limitOf = (url) => new URL(url).searchParams.get('limit');
const readsOf = (tab) => tab.fetchLog.filter((e) => e.url.includes('/read/canonical/')).map((e) => routeOf(e.url));

function replicaStore() {
  let stored = null;
  return {
    globals: {
      _naReadCanonicalReplica: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
      _naWriteCanonicalReplica: async (value) => { stored = JSON.parse(JSON.stringify(value)); return true; },
    },
    get value() { return stored; },
    // A replica not written by a complete authority read (e.g. an old build or a local projection).
    unvalidate() { delete stored.remote_validated_at; },
    age(ms) { stored.remote_validated_at = new Date(Date.now() - ms).toISOString(); },
  };
}

async function canon(t) {
  const f = await activeCanon(t);
  return f;
}

test('primera carga: status antes de la ola, páginas de 100 y se recuerda page_limit_max', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  const tab = await device(f, { token: TOKEN, deviceId: 'fast-1', localStorage: ls, globals: replica.globals });
  const reads = tab.fetchLog.filter((e) => e.url.includes('/read/canonical/'));
  assert.equal(routeOf(reads[0].url), 'status');
  assert.equal(reads.length, 13, reads.map((e) => routeOf(e.url)).join(','));
  for (const entry of reads.slice(1)) assert.equal(limitOf(entry.url), '100');
  assert.equal(ls.getItem('na_canon_read_page_limit'), '250');
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(replica.value.mode, 'ACTIVE');
});

test('recarga sin cambios: solo status + credit-accounts y queda lista para escribir', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  const first = await device(f, { token: TOKEN, deviceId: 'fast-2', localStorage: ls, globals: replica.globals });
  assert.ok(Date.parse(replica.value.remote_validated_at) > 0, 'a complete read stamps the replica');
  const tab = await device(f, { token: TOKEN, localStorage: ls, globals: replica.globals });
  assert.deepEqual(readsOf(tab), ['status', 'credit-accounts']);
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(tab.api.sourceState().source, 'revalidated');
  assert.equal(JSON.stringify(tab.api.snapshot()), JSON.stringify(first.api.snapshot()));
  assert.equal(tab.api.snapshot().read_only, false);
  assert.equal(tab.api.assertAction('sale.create'), true);
});

test('réplica no candidata (sin sello de lectura completa): la ola sale en paralelo con status; products a 200', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-2b', localStorage: ls, globals: replica.globals });
  replica.unvalidate();
  let statusDone = false;
  const issuedBeforeStatusDone = [];
  const tab = await device(f, {
    token: TOKEN, localStorage: ls, globals: replica.globals,
    onFetch: async (url, _options, real) => {
      if (!url.includes('/read/canonical/')) return null;
      if (routeOf(url) === 'status') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const res = await real();
        statusDone = true;
        return res;
      }
      if (!statusDone) issuedBeforeStatusDone.push(routeOf(url));
      return null;
    },
  });
  assert.equal(issuedBeforeStatusDone.length, 12, issuedBeforeStatusDone.join(','));
  const pages = tab.fetchLog.filter((e) => e.url.includes('/read/canonical/') && routeOf(e.url) !== 'status');
  for (const entry of pages) assert.equal(limitOf(entry.url), routeOf(entry.url) === 'products' ? '200' : '250', entry.url);
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.ok(Date.parse(replica.value.remote_validated_at) > 0, 'the full read stamps the replica again');
});

test('valla intacta en la reconfirmación: credit-accounts con otra financial_revision falla cerrada', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  const first = await device(f, { token: TOKEN, deviceId: 'fast-3', localStorage: ls, globals: replica.globals });
  const before = JSON.stringify(first.api.snapshot());
  await assert.rejects(device(f, {
    token: TOKEN, localStorage: ls, globals: replica.globals,
    onFetch: async (url, _options, real) => {
      if (!url.includes('/read/canonical/credit-accounts')) return null;
      const res = await real();
      const body = await res.json();
      body.financial_revision += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }), /STALE_AUTHORITY_BINDING/);
  assert.equal(JSON.stringify(first.api.snapshot()), before);
});

test('valla intacta en la lectura completa: si una página no coincide con status, la recarga falla cerrada', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  const first = await device(f, { token: TOKEN, deviceId: 'fast-3b', localStorage: ls, globals: replica.globals });
  replica.unvalidate();
  const before = JSON.stringify(first.api.snapshot());
  await assert.rejects(device(f, {
    token: TOKEN, localStorage: ls, globals: replica.globals,
    onFetch: async (url, _options, real) => {
      if (!url.includes('/read/canonical/products')) return null;
      const res = await real();
      const body = await res.json();
      body.financial_revision += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }), /STALE_AUTHORITY_BINDING/);
  assert.equal(JSON.stringify(first.api.snapshot()), before);
});

test('una cuenta de crédito creada en otro equipo (no cuenta en financial_revision) fuerza la lectura completa', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  const first = await device(f, { token: TOKEN, deviceId: 'fast-5', localStorage: ls, globals: replica.globals });
  const revision = replica.value.financial_revision;
  const customer = first.api.snapshot().customers[0];
  const other = await device(f, { token: 'fast-other-token', deviceId: 'fast-5-other' });
  const account = await other.api.createCreditAccount({ customer_id: customer.customer_id, account_id: 'tecnologia', name: 'Tecnología', mode: 'separate' });
  assert.equal(account.status, 'created');
  const tab = await device(f, { token: TOKEN, localStorage: ls, globals: replica.globals });
  assert.equal(tab.api.snapshot().financial_revision, revision, 'credit-account.create leaves financial_revision unchanged');
  const reads = readsOf(tab);
  assert.equal(reads.length, 13, reads.join(','));
  assert.ok(tab.api.snapshot().creditAccounts.some((row) => row.account_id === 'tecnologia'));
  assert.equal(tab.api.sourceState().source, 'remote');
  assert.equal(tab.api.sourceState().validation, 'current');
});

test('una escritura en otro equipo (financial_revision distinta) fuerza la lectura completa', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-6', localStorage: ls, globals: replica.globals });
  const revision = replica.value.financial_revision;
  const other = await device(f, { token: 'fast-other6-token', deviceId: 'fast-6-other' });
  const opened = await other.api.openCash({ session_id: 'reload-session', opening_cents: 1000 });
  assert.equal(opened.status, 'created');
  const tab = await device(f, { token: TOKEN, localStorage: ls, globals: replica.globals });
  assert.notEqual(tab.api.snapshot().financial_revision, revision);
  assert.equal(readsOf(tab).length, 13, readsOf(tab).join(','));
  assert.equal(tab.api.sourceState().source, 'remote');
});

test('reconfirmación con sello antiguo: lista al instante y relectura completa en segundo plano', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-7', localStorage: ls, globals: replica.globals });
  replica.age(11 * 60 * 1000);
  const timers = [];
  const tab = await device(f, {
    token: TOKEN, localStorage: ls,
    globals: { ...replica.globals, setTimeout: (fn, ms) => { if (ms === 2000) { timers.push(fn); return 1; } return setTimeout(fn, ms); } },
  });
  assert.deepEqual(readsOf(tab), ['status', 'credit-accounts']);
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(timers.length, 1, 'one background full revalidation is scheduled');
  timers[0]();
  for (let i = 0; i < 100 && tab.api.sourceState().source !== 'remote'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readsOf(tab).length, 2 + 13, readsOf(tab).join(','));
  assert.equal(tab.api.sourceState().source, 'remote');
  assert.ok(Date.now() - Date.parse(replica.value.remote_validated_at) < 60000, 'stamp refreshed');
});

test('Worker sin páginas grandes: 400 con limit=250 → se olvida y se reintenta una vez con 100', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-4', localStorage: ls, globals: replica.globals });
  assert.equal(ls.getItem('na_canon_read_page_limit'), '250');
  replica.unvalidate();
  const tab = await device(f, {
    token: TOKEN, localStorage: ls, globals: replica.globals,
    onFetch: async (url, _options, real) => {
      if (url.includes('/read/canonical/status')) {
        const body = await (await real()).json();
        delete body.page_limit_max;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/read/canonical/') && ['250', '200'].includes(limitOf(url))) {
        return new Response(JSON.stringify({ error: 'invalid_limit' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return null;
    },
  });
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(ls.getItem('na_canon_read_page_limit'), null);
  const retried = tab.fetchLog.filter((e) => e.url.includes('/read/canonical/') && limitOf(e.url) === '100');
  assert.equal(retried.length, 12);
});

test('warm() adelanta status + credit-accounts y refresh() los consume sin duplicar lecturas', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-8', localStorage: ls, globals: replica.globals });
  const tab = await device(f, { token: TOKEN, localStorage: ls, globals: replica.globals });
  const before = tab.fetchLog.length;
  assert.equal(tab.api.warm(), true);
  assert.equal(tab.api.warm(), false, 'only one prefetch in flight');
  assert.deepEqual(tab.fetchLog.slice(before).map((e) => routeOf(e.url)), ['status', 'credit-accounts']);
  await tab.api.refresh();
  assert.deepEqual(tab.fetchLog.slice(before).map((e) => routeOf(e.url)), ['status', 'credit-accounts']);
  assert.equal(tab.api.sourceState().validation, 'current');
});

test('la vista ya pintada se reutiliza solo cuando la autoridad reconfirma filas idénticas', async () => {
  const { readFileSync } = await import('node:fs');
  const inline03 = readFileSync('POS/js/legacy-inline/inline-03.js', 'utf8');
  const inline02 = readFileSync('POS/js/legacy-inline/inline-02.js', 'utf8');
  const saleView = readFileSync('POS/js/sync/canonical-sale-view.js', 'utf8');
  const client = readFileSync('POS/js/sync/canonical-client.js', 'utf8');
  assert.match(inline03, /const reuse=state\.unchanged===true&&_naCanonicalViewApplied&&!_naCanonicalLoadError;/);
  assert.match(inline03, /function _naClearCanonicalOperationalView\(\)\{_naCanonicalViewApplied=false;/);
  assert.match(inline03, /function _naClearCanonicalLegacyView\(\)\{_naCanonicalViewApplied=false;/);
  assert.match(inline03, /NuevoAmanecerCanonical\.warm\(\)/);
  assert.match(saleView, /event\.detail\.unchanged === true && last\) return;/);
  // unchanged is set only when the published replica object itself was re-confirmed.
  assert.match(client, /if \(publishedReplica !== replica \|\| !data\) return publishReplica\(replica, 'revalidated'\);/);
  // Boot storage reads are reused once and dropped by any snapshot write.
  assert.match(inline02, /async function _naCommitSnapshot\(snapshot,serialized\)\{_naBootStorageReads=null;/);
  assert.match(inline02, /const boot=_naBootStorageReads;_naBootStorageReads=null;/);
});

test('otro build (cachés del service worker) u otra sesión invalidan la reconfirmación: lectura completa', async (t) => {
  const { webcrypto, randomUUID } = await import('node:crypto');
  const cryptoGlobal = { subtle: webcrypto.subtle, getRandomValues: (a) => webcrypto.getRandomValues(a), randomUUID };
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  let shells = ['nuevo-amanecer-pos-shell-aaa'];
  const globals = { ...replica.globals, crypto: cryptoGlobal, caches: { keys: async () => [...shells, 'nuevo-amanecer-pos-vendor-x'] } };
  await device(f, { token: TOKEN, deviceId: 'fast-9', localStorage: ls, globals });
  const same = await device(f, { token: TOKEN, localStorage: ls, globals });
  assert.deepEqual(readsOf(same), ['status', 'credit-accounts']);
  shells = ['nuevo-amanecer-pos-shell-bbb'];
  const deployed = await device(f, { token: TOKEN, localStorage: ls, globals });
  assert.equal(readsOf(deployed).length, 13, 'new build -> complete read');
  const again = await device(f, { token: TOKEN, localStorage: ls, globals });
  assert.deepEqual(readsOf(again), ['status', 'credit-accounts'], 'the complete read re-binds the stamp to the new build');
  f.addDevice('fast-9-b', 'writer', 'active', 'fast-9-b-token');
  const creds = JSON.parse(ls.getItem('na_cloud_sync_credentials'));
  ls.setItem('na_cloud_sync_credentials', JSON.stringify({ ...creds, token: 'fast-9-b-token' }));
  const otherSession = await device(f, { token: 'fast-9-b-token', localStorage: ls, globals });
  assert.equal(readsOf(otherSession).length, 13, 'another session -> complete read');
});

test('antes de la confirmación las escrituras se rechazan; si la revalidación falla siguen bloqueadas y la cola local no se toca', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-10', localStorage: ls, globals: replica.globals });
  // Real storage keys (the old list named keys that do not exist, so it proved nothing).
  ls.setItem('na_canonical_sale_outbox_v1', '{"marker":"queue-untouched"}');
  ls.setItem('na_canonical_sale_outbox_v1_quarantine', '{"marker":"quarantine-untouched"}');
  ls.setItem('na_canonical_sale_journal', '{"marker":"journal-untouched"}');
  const queueKeys = () => JSON.stringify(['na_canonical_sale_outbox_v1', 'na_canonical_sale_journal', 'na_canonical_sale_outbox_v1_quarantine'].map((k) => ls.getItem(k)));
  const keysBefore = queueKeys();
  let mode = 'ok', release = null;
  const tab = await device(f, {
    token: TOKEN, localStorage: ls, globals: replica.globals,
    onFetch: async (url) => {
      if (!url.includes('/read/canonical/status') || mode === 'ok') return null;
      if (mode === 'hold') await new Promise((resolve) => { release = resolve; });
      return new Response('{}', { status: 500 });
    },
  });
  assert.equal(tab.api.assertAction('sale.create'), true);
  // Reload: cached rows published at once, but commerce stays closed while the authority answers.
  mode = 'hold';
  const booted = await tab.api.startPOS();
  assert.ok(booted.products.length > 0, 'cached rows are browsable immediately');
  assert.equal(tab.api.sourceState().validation, 'validating');
  assert.throws(() => tab.api.assertAction('sale.create'), /CANONICAL_COMMERCE_CLOSED/);
  assert.throws(() => tab.api.assertAction('cash.close'), /CANONICAL_COMMERCE_CLOSED|UNSUPPORTED_CANONICAL_ACTION/);
  // The authority fails: never auto-unlock.
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  for (let i = 0; i < 100 && tab.api.sourceState().validation === 'validating'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(tab.api.sourceState().validation, 'current');
  assert.throws(() => tab.api.assertAction('sale.create'), /CANONICAL_COMMERCE_CLOSED/);
  assert.ok(tab.api.snapshot().products.length > 0, 'cached rows stay visible');
  assert.equal(queueKeys(), keysBefore, 'revalidation never writes the sale queue, journal or quarantine');
  // Reintentar: an explicit refresh that succeeds confirms and opens commerce again.
  mode = 'ok';
  await tab.api.refresh();
  assert.equal(tab.api.sourceState().validation, 'current');
  assert.equal(tab.api.assertAction('sale.create'), true);
});
