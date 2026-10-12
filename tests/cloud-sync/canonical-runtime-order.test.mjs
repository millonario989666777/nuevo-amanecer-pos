import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client=readFileSync(new URL('../../POS/js/sync/canonical-client.js',import.meta.url),'utf8');
const inline03=readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js',import.meta.url),'utf8');
const integration=readFileSync(new URL('../../POS/js/sync/canonical-sale-integration.js',import.meta.url),'utf8');
const outbox=readFileSync(new URL('../../POS/js/sync/canonical-sale-outbox.js',import.meta.url),'utf8');

test('runtime remains local-first: cached canonical replica is published before remote refresh',()=>{
  const start=client.slice(client.indexOf('async function startPOS()'),client.indexOf('function legacySnapshot()'));
  const read=start.indexOf('await localReplica()');
  const publish=start.indexOf("publishReplica(cached, 'cache')");
  const refresh=start.indexOf('var validating = refresh();');
  const notify=start.indexOf('notifyReplicaUpdate()',refresh);
  // The cached replica is published (provisional, read-only) before the refresh starts; the
  // refresh requests leave before the cached view is rendered.
  assert.ok(read>=0 && publish>read && refresh>publish && notify>refresh);
});

test('transport verification is not the READY/green signal',()=>{
  const connected=inline03.slice(inline03.indexOf("window.addEventListener('na:canonical-connected'"),inline03.indexOf('let _naCanonicalLoadError'));
  assert.match(connected,/_naSetHeaderConnectionState\('update','Sincronizando CANON…'\)/);
  assert.doesNotMatch(connected,/_naSetHeaderConnectionState\('connected'/);
  assert.match(inline03,/const connectionReady=state\.validation==='current',connectionSyncing=state\.validation==='validating'/);
  assert.match(inline03,/connectionReady\?'connected':connectionSyncing\?'update':'disconnected'/);
});

test('new sale enters the durable local outbox without waiting for CANON freshness or previous remote work',()=>{
  assert.match(integration,/function canonicalSaleGate\(\)/);
  assert.match(integration,/canonical\.snapshot\(\)/);
  assert.match(integration,/outbox\.snapshot\(\)/);
  assert.doesNotMatch(integration,/state\.validation !== 'current'/);
  assert.doesNotMatch(integration,/snapshot\.mode !== 'ACTIVE'/);
  assert.doesNotMatch(integration,/snapshot\.read_only !== false/);
  assert.doesNotMatch(integration,/canonical\.pendingSnapshot\(\)/);
  assert.doesNotMatch(integration,/outbox\.snapshot\(\)\.intents\.length/);
  assert.doesNotMatch(integration,/await\s+outbox\.sync\s*\(/);
  const capture=integration.slice(integration.indexOf('async function capture()'),integration.indexOf('function wrappedConfirm()'));
  const gate=capture.indexOf('canonicalSaleGate()');
  const enqueue=capture.indexOf('outbox.enqueue(intent)');
  const project=capture.indexOf('projectCurrentOutbox()');
  const background=capture.indexOf('syncOutboxInBackground(outbox)');
  assert.ok(gate>=0 && enqueue>gate,'local storage gate must run before durable enqueue');
  assert.ok(project>enqueue && background>project,'local projection must finish before background sync is scheduled');
});

test('startup outbox waits for current replica instead of racing bootstrap',()=>{
  const resume=outbox.slice(outbox.indexOf('async function resume()'),outbox.indexOf('resumeOutbox = resume'));
  const current=resume.indexOf("state.validation !== 'current'");
  const queue=resume.indexOf("snapshot().intents.length");
  const sync=resume.indexOf('await sync()');
  assert.ok(current>=0 && queue>current && sync>queue);
});

test('online recovery refreshes authority first when runtime is not current',()=>{
  const listeners=outbox.slice(outbox.indexOf("root.addEventListener('online'"),outbox.indexOf("root.addEventListener('na:canonical-updated'"));
  assert.match(listeners,/state\.validation !== 'current'/);
  assert.match(listeners,/canonical\.refresh\(\)/);
});


test('current CANON authority replaces pre-cutover replica caches for the same epoch/revision',()=>{
  assert.match(client,/var REPLICA_SCHEMA_VERSION = 2;/);
  assert.match(client,/replica\.schema_version === REPLICA_SCHEMA_VERSION/);
  assert.match(client,/schema_version: REPLICA_SCHEMA_VERSION/);
  const newer=client.slice(client.indexOf('function cacheIsNewer'),client.indexOf('async function localReplica'));
  assert.match(newer,/if \(cache\.revision !== remote\.revision\) return cache\.revision > remote\.revision;/);
  assert.doesNotMatch(newer,/financial_revision\s*\|\|\s*0\)\s*>/);
  assert.match(newer,/return false;/);
});
