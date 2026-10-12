import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canonical=readFileSync(new URL('../../POS/js/sync/canonical-client.js',import.meta.url),'utf8');
const inline03=readFileSync(new URL('../../POS/js/legacy-inline/inline-03.js',import.meta.url),'utf8');
const layout=readFileSync(new URL('../../POS/css/layout.css',import.meta.url),'utf8');

test('CANON cold start mounts UI without awaiting the remote bootstrap',()=>{
  const start=inline03.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(start>=0);
  const block=inline03.slice(start);
  assert.match(block,/const canonicalEnabled=/);
  assert.match(block,/if\(canonicalEnabled\)\{productos=\[\];clientes=\[\];creditos=\[\];\}/);
  assert.match(block,/NuevoAmanecerCanonical\.startPOS\(\)\.catch/);
  assert.doesNotMatch(block,/try\{await NuevoAmanecerCanonical\.startPOS\(\)/);
  assert.match(block,/Sincronizando CANON…/);
  assert.match(block,/posUpdateCart\(canonicalEnabled\?false:true\)/);
});

test('cold-start read failure exits pending and exposes retryable unavailable UI',()=>{
  assert.match(canonical,/data \? 'stale' : 'unavailable'/);
  assert.match(canonical,/notifyReplicaUpdate\(\); throw error/);
  assert.match(inline03,/if\(state\.source==='none'\)/);
  assert.match(inline03,/Canónico no disponible · reintenta/);
  assert.match(inline03,/Autoridad canónica no validada/);
});

test('canonical reads and payment receipts are bounded while other command transports stay direct',()=>{
  assert.match(canonical,/var READ_TIMEOUT_MS = 8000/);
  assert.match(canonical,/function readFetch\(url, options, includeJson\)/);
  assert.match(canonical,/reject\(new Error\('CANONICAL_READ_TIMEOUT'\)\)/);
  assert.match(canonical,/readFetch\(endpoint \+ '\/read\/canonical\/status'/);
  assert.match(canonical,/var status = await \(statusRequest \|\| readFetch\(endpoint \+ '\/read\/canonical\/status'/);
  assert.match(canonical,/await readFetch\(endpoint \+ '\/read\/canonical\/' \+ route/);
  const sendPending=canonical.slice(canonical.indexOf('async function sendPending'),canonical.indexOf('async function createSale'));
  assert.match(sendPending,/record\.command === 'payment\.create' \|\| record\.command === 'payment\.batch'/);
  assert.match(sendPending,/await readFetch\(expected\.endpoint \+ record\.route, requestOptions, true\)/);
  assert.match(sendPending,/statusTransport = await readFetch[\s\S]*}, true\)/);
  assert.match(sendPending,/root\.fetch\(expected\.endpoint \+ record\.route/);
});

test('header exposes transport as syncing and reserves green for current replica',()=>{
  const statusVerified=canonical.indexOf('notifyConnectionVerified();');
  const coreBootstrap=canonical.indexOf('Promise.all(coreEntries.map(readEntry))');
  assert.ok(statusVerified>=0,'verified status must still signal transport connectivity');
  assert.ok(coreBootstrap>statusVerified,'transport can be known before collections finish');
  assert.match(canonical,/new root\.CustomEvent\('na:canonical-connected'\)/);
  const connectedBlock=inline03.slice(inline03.indexOf("addEventListener('na:canonical-connected'"),inline03.indexOf('let _naCanonicalLoadError'));
  assert.match(connectedBlock,/_naCanonicalTransportConnected=true/);
  assert.match(connectedBlock,/_naSetHeaderConnectionState\('update','Sincronizando CANON…'\)/);
  assert.doesNotMatch(connectedBlock,/_naSetHeaderConnectionState\('connected'/);
  assert.match(inline03,/const connectionReady=state\.validation==='current',connectionSyncing=state\.validation==='validating'/);
  assert.doesNotMatch(inline03,/state\.validation==='current'\|\|\(_naCanonicalTransportConnected&&state\.validation==='validating'\)/);
});

test('commerce remains fail closed until CANON is ready and ACTIVE',()=>{
  assert.match(canonical,/!ready \|\| changed \|\| !data \|\| data\.read_only !== false \|\| data\.mode !== 'ACTIVE'/);
  assert.match(canonical,/fail\('CANONICAL_COMMERCE_CLOSED'\)/);
});


test('CANON refresh keeps read-only bootstrap fail-closed and ACTIVE reads in one parallel wave',()=>{
  assert.match(canonical,/source === 'cache' \|\| source === 'bootstrap'/);
  assert.match(canonical,/mode: provisional \? 'CANONICAL_READ_ONLY'/);
  assert.match(canonical,/read_only: provisional \|\| replica\.read_only !== false/);
  assert.match(canonical,/var activeEntries = \[\['cash-sessions', 'cashSessions'\], \['financial-events', 'financialEvents'\], \['expenses', 'expenses'\], \['sales', 'sales'\], \['sale-items', 'saleItems'\], \['inventory-movements', 'inventoryMovements'\], \['cash-movements', 'cashMovements'\]\];/);

  const activeStart=canonical.indexOf("if (statusMeta.mode === 'ACTIVE')");
  const readOnlyStart=canonical.lastIndexOf('} else {',canonical.indexOf('// Predicted ACTIVE but the authority is not'));
  const fallbackEnd=canonical.indexOf('} // end !bulkApplied fallback',readOnlyStart);
  assert.ok(activeStart>=0 && readOnlyStart>activeStart && fallbackEnd>readOnlyStart,'refresh branches must remain explicit');

  const activeBlock=canonical.slice(activeStart,readOnlyStart);
  assert.match(activeBlock,/Promise\.all\(waveEntries\.map\(readEntry\)\)/);
  // Conditional revalidation only reuses the cache after status + credit-accounts match it exactly.
  assert.match(activeBlock,/cacheMatchesStatus\(cache, statusMeta, statusDigest\) && JSON\.stringify\(accountsResult\.items\) === JSON\.stringify\(cache\.credit_accounts\)/);
  assert.doesNotMatch(activeBlock,/publishReplica\(bootstrapReplica/);

  const readOnlyBlock=canonical.slice(readOnlyStart,fallbackEnd);
  assert.match(readOnlyBlock,/Promise\.all\(coreEntries\.map\(readEntry\)\)/);
  assert.match(readOnlyBlock,/publishReplica\(bootstrapReplica, 'bootstrap'\); notifyReplicaUpdate\(\)/);
  assert.doesNotMatch(readOnlyBlock,/coreEntries\.concat\(activeEntries\)/);
});

test('mobile status shows runtime CANON state instead of a hardcoded Local label',()=>{
  assert.doesNotMatch(layout,/content:'Local'/);
  assert.match(layout,/\.g-status span\{font-size:10px/);
  assert.match(inline03,/na:canonical-connected/);
  assert.match(inline03,/connectionReady/);
});
