import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCanon, device, storage } from './canon-browser-harness.mjs';

// F5 en CANON: el estado y la ola de lecturas salen juntos cuando la réplica local ya era ACTIVE,
// y las páginas usan el tamaño anunciado por el Worker. La valla de autoridad no se relaja.
const TOKEN = 'fast-reload-token';
const routeOf = (url) => new URL(url).pathname.replace('/read/canonical/', '');
const limitOf = (url) => new URL(url).searchParams.get('limit');

function replicaStore() {
  let stored = null;
  return {
    globals: {
      _naReadCanonicalReplica: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
      _naWriteCanonicalReplica: async (value) => { stored = JSON.parse(JSON.stringify(value)); return true; },
    },
    get value() { return stored; },
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

test('recarga con réplica ACTIVE: la ola sale en paralelo con status y usa páginas de 250', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-2', localStorage: ls, globals: replica.globals });
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
  for (const entry of pages) assert.equal(limitOf(entry.url), '250');
  assert.equal(tab.api.sourceState().validation, 'current');
});

test('valla intacta: si una página no coincide con status, la recarga falla cerrada', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  const first = await device(f, { token: TOKEN, deviceId: 'fast-3', localStorage: ls, globals: replica.globals });
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

test('Worker sin páginas grandes: 400 con limit=250 → se olvida y se reintenta una vez con 100', async (t) => {
  const f = await canon(t);
  const replica = replicaStore();
  const ls = storage();
  await device(f, { token: TOKEN, deviceId: 'fast-4', localStorage: ls, globals: replica.globals });
  assert.equal(ls.getItem('na_canon_read_page_limit'), '250');
  const tab = await device(f, {
    token: TOKEN, localStorage: ls, globals: replica.globals,
    onFetch: async (url, _options, real) => {
      if (url.includes('/read/canonical/status')) {
        const body = await (await real()).json();
        delete body.page_limit_max;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/read/canonical/') && limitOf(url) === '250') {
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
