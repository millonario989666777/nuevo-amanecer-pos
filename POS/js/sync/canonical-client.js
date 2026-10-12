(function (root) {
  'use strict';

  var CONTRACT = 'a6-gate-c-v1';
  var KEY = 'na_canonical_binding';
  var JOURNAL = 'na_canonical_sale_journal';
  var LOCK = 'na-canonical-financial-writer';
  var CREDENTIALS_KEY = 'na_cloud_sync_credentials';
  var METHODS = ['efectivo', 'yape', 'plin', 'transferencia', 'credito', 'mixto'];
  var COMMANDS = ['sale.create', 'product.create', 'product.update', 'customer.create', 'customer.contact.set', 'customer.credit-policy.set', 'inventory.adjust', 'credit-account.create', 'payment.create', 'payment.batch', 'cash.open', 'cash.close', 'adjustment.create', 'compensation.create', 'expense.create'];
  var FINANCIAL_METHODS = ['efectivo', 'yape', 'plin', 'transferencia'];
  var READ_TIMEOUT_MS = 8000;
  // Every command POST has a deadline. On timeout the journal stays PENDING
  // without last_error and the SAME operation_id is replayed (idempotent).
  var WRITE_TIMEOUT_MS = 15000;
  var REPLICA_SCHEMA_VERSION = 2;
  var HOSTED_API_ORIGIN = null;
  try {
    var hostedConfig = root.NA_HOSTED_CONFIG;
    if (hostedConfig && typeof hostedConfig.apiOrigin === 'string') {
      var hostedUrl = new URL(hostedConfig.apiOrigin);
      if (hostedUrl.protocol === 'https:' && hostedUrl.origin === hostedConfig.apiOrigin &&
          !hostedUrl.username && !hostedUrl.password && !hostedUrl.search && !hostedUrl.hash) {
        HOSTED_API_ORIGIN = hostedUrl.origin;
      }
    }
  } catch (_) {}
  var binding = null, data = null, ready = false, saleOnlyReady = false, loading = null, changed = false, replicaState = { source: 'none', cache: null, validation: 'pending' };

  // FASE7 LAB experimental: bulk snapshot (1 request) vs FASE6 13-request wave.
  // Enable via localStorage na_canon_bulk_snapshot=1 or window.__NA_CANON_BULK_SNAPSHOT=true.
  // On any bulk failure → fall back to 13-route path (no data loss).
  function bulkSnapshotEnabled() {
    try {
      if (root.__NA_CANON_BULK_SNAPSHOT === true) return true;
      if (root.__NA_CANON_BULK_SNAPSHOT === false) return false;
      var ls = root.localStorage && root.localStorage.getItem('na_canon_bulk_snapshot');
      if (ls === '1' || ls === 'true') return true;
      if (ls === '0' || ls === 'false') return false;
      if (root.location && /(?:^|[?&])bulk=1(?:&|$)/.test(root.location.search || '')) return true;
    } catch (_) {}
    return false;
  }
  // Page size for canonical collection reads. A Worker that supports larger pages
  // advertises page_limit_max in /read/canonical/status; it is remembered so the
  // next reload can use it without waiting for status. Never above CLIENT_PAGE_MAX.
  var DEFAULT_PAGE_LIMIT = 100, CLIENT_PAGE_MAX = 250, PAGE_LIMIT_KEY = 'na_canon_read_page_limit';
  // Worker CPU (Free plan ~10 ms/request): a 250-row products page costs ~7.5 ms of
  // Worker CPU at prod-like row width, so products are capped lower than the rest.
  var ROUTE_PAGE_MAX = { products: 200 };
  function routePageLimit(route, limit) { return ROUTE_PAGE_MAX[route] ? Math.min(limit, ROUTE_PAGE_MAX[route]) : limit; }
  // Conditional revalidation: a replica fully validated by the authority is re-confirmed with
  // status + credit-accounts (credit-account.create is not part of financial_revision) and
  // the remaining collections are skipped when everything matches. A full re-read still runs
  // in the background once the last full validation is older than this.
  var FULL_REVALIDATE_MS = 10 * 60 * 1000, PREFETCH_MAX_AGE_MS = 15000;
  // After a deploy the shortcut still applies (the authority fence decides data validity), and one
  // complete read follows in the background once the app can already sell.
  var DEPLOY_FULL_REVALIDATE_DELAY_MS = 30000;
  function readPageLimit() {
    try {
      var stored = Number(root.localStorage && root.localStorage.getItem(PAGE_LIMIT_KEY));
      if (Number.isSafeInteger(stored) && stored >= DEFAULT_PAGE_LIMIT && stored <= CLIENT_PAGE_MAX) return stored;
    } catch (_) {}
    return DEFAULT_PAGE_LIMIT;
  }
  function rememberPageLimit(meta) {
    try {
      var advertised = meta && Number(meta.page_limit_max);
      var value = Number.isSafeInteger(advertised) && advertised >= DEFAULT_PAGE_LIMIT ? Math.min(advertised, CLIENT_PAGE_MAX) : DEFAULT_PAGE_LIMIT;
      if (value === DEFAULT_PAGE_LIMIT) root.localStorage.removeItem(PAGE_LIMIT_KEY);
      else root.localStorage.setItem(PAGE_LIMIT_KEY, String(value));
    } catch (_) {}
  }
  var SNAPSHOT_KEYS = ['products','customers','credits','credit_payments','credit_accounts','sales','sale_items','inventory_movements','cash_movements','cash_sessions','financial_events','expenses'];

  function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function fail(code) { throw new Error(code); }
  function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value); }
  function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
  function uint(value) { return Number.isSafeInteger(value) && value >= 0; }
  function validReason(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value); }
  function validBinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.promotion_id) ||
        !Number.isSafeInteger(value.authority_epoch) || value.authority_epoch < 0 || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
    try {
      var url = new URL(value.endpoint);
      var local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      var sameOrigin = !!(root.location && url.origin === root.location.origin);
      var trustedWorker = url.hostname === 'nuevo-amanecer-sync-lab.nuevo-amanecer-pos.workers.dev' || (!!HOSTED_API_ORIGIN && url.origin === HOSTED_API_ORIGIN);
      return typeof value.endpoint === 'string' && value.endpoint === value.endpoint.replace(/\/+$/, '') &&
        !url.username && !url.password && !url.search && !url.hash &&
        ((local && ['http:', 'https:'].includes(url.protocol)) || (url.protocol === 'https:' && (sameOrigin || trustedWorker)));
    } catch (_) { return false; }
  }
  function sessionCredentials(expected) {
    if (!validBinding(expected)) return null;
    var saved;
    try { saved = JSON.parse(root.localStorage.getItem(CREDENTIALS_KEY) || 'null'); } catch (_) { return null; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || String(saved.endpoint || '').replace(/\/+$/, '') !== expected.endpoint ||
        typeof saved.token !== 'string' || !saved.token || saved.token.length > 2048 || /[\r\n]/.test(saved.token)) return null;
    return { token: saved.token };
  }
  function rememberSession(endpoint, token) {
    if (typeof token !== 'string' || !token || token.length > 2048 || /[\r\n]/.test(token)) fail('SESSION_NOT_AVAILABLE');
    if (root.NuevoAmanecerOutbox && typeof root.NuevoAmanecerOutbox.configure === 'function') {
      root.NuevoAmanecerOutbox.configure({ endpoint: endpoint, token: token, remember: true });
      return;
    }
    var raw = JSON.stringify({ endpoint: endpoint, token: token });
    root.localStorage.setItem(CREDENTIALS_KEY, raw);
    if (root.localStorage.getItem(CREDENTIALS_KEY) !== raw) fail('SESSION_NOT_AVAILABLE');
  }
  function stored(name) {
    var raw = root.localStorage.getItem(name);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (_) { fail('INVALID_CANONICAL_STORAGE'); }
  }
  function durableJournal(value) {
    var raw = JSON.stringify(value);
    root.localStorage.setItem(JOURNAL, raw);
    if (root.localStorage.getItem(JOURNAL) !== raw) fail('CANONICAL_STORAGE_NOT_DURABLE');
  }
  function journal() {
    var value = stored(JOURNAL);
    if (value === null) return null;
    if (!value || typeof value !== 'object' || !['PENDING', 'CONFIRMED'].includes(value.state) || !validBinding(value.binding) ||
        !COMMANDS.includes(value.command) || value.route !== '/commands/' + value.command || !validPayload(value.command, value.payload) ||
        (value.state === 'CONFIRMED' && !validReceipt(value, value.receipt))) {
      fail('INVALID_CANONICAL_JOURNAL');
    }
    return value;
  }
  try {
    var loaded = stored(KEY);
    if (loaded !== null) {
      if (!validBinding(loaded)) fail('INVALID_AUTHORITY_BINDING');
      binding = loaded;
    }
  } catch (_) {
    binding = null;
    changed = true;
  }

  function enabled() {
    try { return !!binding || changed || root.localStorage.getItem(KEY) !== null || root.localStorage.getItem(JOURNAL) !== null; }
    catch (_) { return true; }
  }
  async function configure(options) {
    return withWriterLock(function () {
    ready = false; saleOnlyReady = false;
    var existing = journal();
    var candidate = {
      endpoint: String(options && options.endpoint || '').replace(/\/+$/, ''),
      promotion_id: options && options.promotion_id,
      authority_epoch: options && options.authority_epoch,
      revision: options && options.revision
    };
    if (!validBinding(candidate)) fail('INVALID_AUTHORITY_BINDING');
    if (existing && existing.state === 'PENDING' && JSON.stringify(existing.binding) !== JSON.stringify(candidate)) fail('CANONICAL_FINANCIAL_PENDING');
    var raw = JSON.stringify(candidate);
    // Re-authentication of the same pending intent must not rewrite its binding.
    if (existing && existing.state === 'PENDING' && root.localStorage.getItem(KEY) !== raw) fail('STALE_AUTHORITY_BINDING');
    changed = true;
    root.localStorage.setItem(KEY, raw);
    if (root.localStorage.getItem(KEY) !== raw) fail('BINDING_NOT_DURABLE');
    if (options && options.token !== undefined) rememberSession(candidate.endpoint, String(options.token || ''));
    if (!sessionCredentials(candidate)) fail('SESSION_NOT_AVAILABLE');
    binding = candidate;
    changed = false;
    return copy(binding);
    });
  }
  function verify(meta, expected) {
    if (!meta || meta.authority !== 'canonical' || meta.promotion_id !== expected.promotion_id || meta.authority_epoch !== expected.authority_epoch || meta.revision !== expected.revision ||
        !['CANONICAL_READ_ONLY', 'ACTIVE'].includes(meta.mode) || !['a6-gate-p-v1', CONTRACT].includes(meta.minimum_client_contract) ||
        (meta.mode === 'ACTIVE' ? meta.read_only !== false || meta.minimum_client_contract !== CONTRACT : meta.read_only !== true)) fail('STALE_AUTHORITY_BINDING');
  }
  function assertBinding(expected) {
    if (!validBinding(expected) || changed || JSON.stringify(binding) !== JSON.stringify(expected) || root.localStorage.getItem(KEY) !== JSON.stringify(expected)) fail('STALE_AUTHORITY_BINDING');
  }
  function validReplica(replica) {
    function hasSecretKey(value) { if (!value || typeof value !== 'object') return false; return Object.keys(value).some(function (key) {
      return /(?:token|secret|password|api.?key|credential)/i.test(key) || hasSecretKey(value[key]); }); }
    function rowsValid(rows) { return Array.isArray(rows) && rows.every(function (row) { return !!row && typeof row === 'object' && !Array.isArray(row); }); }
    return !!(replica && replica.schema_version === REPLICA_SCHEMA_VERSION && typeof replica.promotion_id === 'string' && replica.promotion_id &&
      Number.isSafeInteger(replica.authority_epoch) && replica.authority_epoch >= 0 && Number.isSafeInteger(replica.revision) && replica.revision >= 0 &&
      typeof replica.cached_at === 'string' && Number.isFinite(Date.parse(replica.cached_at)) && ['CANONICAL_READ_ONLY','ACTIVE'].includes(replica.mode) && typeof replica.read_only === 'boolean' &&
      (replica.financial_revision == null || uint(replica.financial_revision)) && ['products','customers','credits','credit_payments'].every(function (key) { return Array.isArray(replica[key]); }) &&
      (replica.credit_accounts == null || Array.isArray(replica.credit_accounts)) &&
      (replica.sales == null || Array.isArray(replica.sales)) && (replica.sale_items == null || Array.isArray(replica.sale_items)) &&
      (replica.inventory_movements == null || Array.isArray(replica.inventory_movements)) && (replica.cash_movements == null || Array.isArray(replica.cash_movements)) &&
      (replica.cash_sessions == null || Array.isArray(replica.cash_sessions)) && (replica.financial_events == null || Array.isArray(replica.financial_events)) &&
      (replica.expenses == null || Array.isArray(replica.expenses)) &&
      (replica.digests == null || (replica.digests && typeof replica.digests === 'object' && !Array.isArray(replica.digests))) &&
      ['products','customers','credits','credit_payments'].every(function (key) { return rowsValid(replica[key]); }) && rowsValid(replica.credit_accounts || []) &&
      rowsValid(replica.sales || []) && rowsValid(replica.sale_items || []) && rowsValid(replica.inventory_movements || []) && rowsValid(replica.cash_movements || []) &&
      rowsValid(replica.cash_sessions || []) && rowsValid(replica.financial_events || []) && rowsValid(replica.expenses || []) &&
      !hasSecretKey(replica));
  }
  function replicaOf(value) { return { schema_version: REPLICA_SCHEMA_VERSION, cached_at: new Date().toISOString(), promotion_id: value.promotion_id, authority_epoch: value.authority_epoch,
    revision: value.revision, financial_revision: value.financial_revision == null ? null : value.financial_revision,
    canonical_digest: value.canonical_digest || null,
    digests: copy(value.digests || {}),
    products: copy(value.products), customers: copy(value.customers), credits: copy(value.credits), credit_payments: copy(value.payments), credit_accounts: copy(value.creditAccounts || []),
    sales: copy(value.sales || []), sale_items: copy(value.saleItems || []), inventory_movements: copy(value.inventoryMovements || []), cash_movements: copy(value.cashMovements || []),
    cash_sessions: copy(value.cashSessions || []), financial_events: copy(value.financialEvents || []), expenses: copy(value.expenses || []),
    mode: value.mode, read_only: value.read_only, minimum_client_contract: value.minimum_client_contract }; }
  function cacheIsNewer(cache, remote) {
    if (cache.authority_epoch !== remote.authority_epoch) return cache.authority_epoch > remote.authority_epoch;
    if (cache.promotion_id !== remote.promotion_id) return false;
    if (cache.revision !== remote.revision) return cache.revision > remote.revision;
    // Once the configured CANON authority has returned a complete, internally
    // consistent snapshot for the same epoch/revision, it wins over a local
    // financial revision. This prevents a cache captured from a previous
    // backend provider from pinning the UI to stale balances after cutover.
    return false;
  }
  async function localReplica() {
    if (typeof root._naReadCanonicalReplica !== 'function') return null;
    try { var value = await root._naReadCanonicalReplica(); return validReplica(value) ? value : null; } catch (_) { return null; }
  }
  var publishedReplica = null;
  // The cached replica already on screen was re-confirmed by the authority: only the
  // authority fields change (provisional read-only -> ACTIVE), the rows are identical.
  function promotePublishedReplica(replica) {
    if (publishedReplica !== replica || !data) return publishReplica(replica, 'revalidated');
    data.mode = replica.mode; data.read_only = replica.read_only !== false; data.minimum_client_contract = replica.minimum_client_contract;
    ready = true; saleOnlyReady = false; replicaState = { source: 'revalidated', cache: copy(replicaState.cache), validation: 'current', unchanged: true };
  }
  function publishReplica(replica, source) {
    publishedReplica = replica;
    var provisional = source === 'cache' || source === 'bootstrap';
    data = { authority: 'canonical', promotion_id: replica.promotion_id, authority_epoch: replica.authority_epoch, revision: replica.revision,
      financial_revision: replica.financial_revision, products: copy(replica.products), customers: copy(replica.customers), credits: copy(replica.credits),
      payments: copy(replica.credit_payments), creditAccounts: copy(replica.credit_accounts || []), sales: copy(replica.sales || []), saleItems: copy(replica.sale_items || []),
      inventoryMovements: copy(replica.inventory_movements || []), cashMovements: copy(replica.cash_movements || []), cashSessions: copy(replica.cash_sessions || []), financialEvents: copy(replica.financial_events || []), expenses: copy(replica.expenses || []),
      mode: provisional ? 'CANONICAL_READ_ONLY' : (replica.mode || 'CANONICAL_READ_ONLY'),
      read_only: provisional || replica.read_only !== false, minimum_client_contract: provisional ? 'a6-gate-p-v1' : (replica.minimum_client_contract || 'a6-gate-p-v1') };
    ready = true; saleOnlyReady = false; replicaState = { source: source, cache: { cached_at: replica.cached_at, promotion_id: replica.promotion_id, authority_epoch: replica.authority_epoch,
      revision: replica.revision, financial_revision: replica.financial_revision }, validation: provisional ? 'validating' : 'current' };
  }
  function operationalBootstrapSeed(current, expected) {
    var empty = { sales: [], saleItems: [], inventoryMovements: [], cashMovements: [], cashSessions: [], financialEvents: [], expenses: [] };
    if (!current || current.authority !== 'canonical' || !expected ||
        current.promotion_id !== expected.promotion_id || current.authority_epoch !== expected.authority_epoch || current.revision !== expected.revision) return empty;
    return {
      sales: copy(current.sales || []), saleItems: copy(current.saleItems || []),
      inventoryMovements: copy(current.inventoryMovements || []), cashMovements: copy(current.cashMovements || []),
      cashSessions: copy(current.cashSessions || []), financialEvents: copy(current.financialEvents || []), expenses: copy(current.expenses || [])
    };
  }
  function notifyReplicaUpdate() { try { if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-updated', { detail: sourceState() })); } catch (_) {} }
  function notifyConnectionVerified() { try { if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-connected')); } catch (_) {} }
  function readFetch(url, options, includeJson, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      var timer = root.setTimeout(function () {
        if (settled) return;
        settled = true;
        if (controller) controller.abort();
        reject(new Error('CANONICAL_READ_TIMEOUT'));
      }, timeoutMs || READ_TIMEOUT_MS);
      var requestOptions = Object.assign({}, options || {});
      if (controller) requestOptions.signal = controller.signal;
      Promise.resolve(root.fetch(url, requestOptions)).then(function (response) {
        // Keep the deadline active through the body: headers alone are not a receipt.
        return includeJson ? response.json().then(function (result) { return { response:response, result:result }; }) : response;
      }).then(function (response) {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        resolve(response);
      }, function (error) {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        reject(error);
      });
    });
  }
  var pageLimitRetried = false, bootPrefetch = null, bootCache = null, forceFullRead = false, fullRevalidateTimer = null;
  function readOptions(token) { return { credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { authorization: 'Bearer ' + token } }; }
  // Starts the two requests every ACTIVE refresh needs first (status, credit-accounts page 1)
  // as early as possible during boot. Pure network: nothing is published or trusted until
  // refresh() consumes the responses with exactly the same fences as a normal read.
  function warm() {
    try {
      if (bootPrefetch || !enabled() || root.navigator.onLine === false || bulkSnapshotEnabled()) return false;
      var expected = binding && !changed ? copy(binding) : null;
      var session = expected && sessionCredentials(expected);
      if (!session) return false;
      var limit = readPageLimit();
      bootPrefetch = { key: JSON.stringify(expected), token: session.token, limit: limit, at: Date.now(),
        status: readFetch(expected.endpoint + '/read/canonical/status', readOptions(session.token)),
        accounts: readFetch(expected.endpoint + '/read/canonical/credit-accounts?limit=' + routePageLimit('credit-accounts', limit), readOptions(session.token)) };
      bootPrefetch.status.catch(function () {}); bootPrefetch.accounts.catch(function () {});
      return true;
    } catch (_) { bootPrefetch = null; return false; }
  }
  function takePrefetch(expected, token, limit) {
    var value = bootPrefetch; bootPrefetch = null;
    if (!value || value.key !== JSON.stringify(expected) || value.token !== token || value.limit !== limit || Date.now() - value.at > PREFETCH_MAX_AGE_MS) return null;
    return value;
  }
  var REPLICA_COLLECTIONS = ['products', 'customers', 'credits', 'credit_payments', 'credit_accounts', 'cash_sessions', 'financial_events', 'expenses', 'sales', 'sale_items', 'inventory_movements', 'cash_movements'];
  // The re-confirmation shortcut is bound to the client contract, to the shape of the stored replica
  // and to the session that performed the complete read. Data validity never depends on the app
  // build: the authority fence (status meta + financial_revision + digest + credit-accounts) decides.
  // Bump REPLICA_SHAPE when a build changes which columns/collections the replica must carry.
  var REPLICA_SHAPE = 'replica-shape-1';
  async function replicaContext(endpoint, token) {
    var session = 'unknown';
    try {
      if (root.crypto && root.crypto.subtle && typeof root.TextEncoder === 'function') {
        var digest = new Uint8Array(await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(endpoint + '\n' + token)));
        session = Array.prototype.map.call(digest.slice(0, 12), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }
    } catch (_) {}
    return JSON.stringify([CONTRACT, REPLICA_SHAPE, session]);
  }
  // App build (service-worker shell generation). Informational only: a different build schedules a
  // background complete read, it never blocks the re-confirmation.
  async function replicaBuild() {
    var build = 'no-cache-api';
    try {
      if (root.caches && typeof root.caches.keys === 'function') {
        build = (await root.caches.keys()).filter(function (name) { return /^nuevo-amanecer-pos-shell-/.test(name); }).sort().join(',') || 'no-shell-cache';
      }
    } catch (_) {}
    return build;
  }
  // Stamps written before REPLICA_SHAPE existed carried [contract, build, session]; same contract and
  // session means the same replica shape (replica-shape-1), so they stay valid across this deploy.
  function contextMatches(stored, current) {
    if (typeof stored !== 'string' || typeof current !== 'string') return false;
    if (stored === current) return true;
    try {
      var a = JSON.parse(stored), b = JSON.parse(current);
      return Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a[0] === b[0] && a[2] === b[2] &&
        typeof a[1] === 'string' && !/^replica-shape-/.test(a[1]) && b[1] === 'replica-shape-1';
    } catch (_) { return false; }
  }
  function fullyValidatedAt(replica) {
    var at = replica && typeof replica.remote_validated_at === 'string' ? Date.parse(replica.remote_validated_at) : NaN;
    return Number.isFinite(at) ? at : null;
  }
  // Only a replica written by a complete authority read (never a local projection) can be
  // re-confirmed without re-reading its collections.
  function fastRevalidationCandidate(cache, expected, context) {
    return !!(cache && fullyValidatedAt(cache) !== null && contextMatches(cache.remote_validated_context, context) && cache.mode === 'ACTIVE' && cache.read_only === false && cache.minimum_client_contract === CONTRACT &&
      cache.promotion_id === expected.promotion_id && cache.authority_epoch === expected.authority_epoch && cache.revision === expected.revision &&
      uint(cache.financial_revision) && REPLICA_COLLECTIONS.every(function (key) { return Array.isArray(cache[key]); }));
  }
  function cacheMatchesStatus(cache, meta, digest) {
    return meta.mode === 'ACTIVE' && meta.read_only === false && meta.minimum_client_contract === cache.minimum_client_contract &&
      meta.promotion_id === cache.promotion_id && meta.authority_epoch === cache.authority_epoch && meta.revision === cache.revision &&
      meta.financial_revision === cache.financial_revision && (digest || null) === (cache.canonical_digest || null);
  }
  function scheduleFullRevalidation(delay) {
    if (fullRevalidateTimer) return;
    fullRevalidateTimer = root.setTimeout(function () {
      fullRevalidateTimer = null;
      if (loading) { scheduleFullRevalidation(delay); return; }
      forceFullRead = true;
      refresh().catch(function () {});
    }, delay);
  }
  async function refresh() {
    if (loading) return loading;
    if (!data) ready = false;
    var fullRequested = forceFullRead; forceFullRead = false;
    loading = (async function () {
      if (root.navigator.onLine === false) fail('AUTHORITY_UNAVAILABLE');
      var expected = binding && !changed ? copy(binding) : null, statusMeta = null;
      if (!expected) fail('CANONICAL_NOT_CONFIGURED');
      var endpoint = expected.endpoint, session = sessionCredentials(expected);
      if (!session) fail('SESSION_NOT_AVAILABLE');
      var authHeaders = { authorization: 'Bearer ' + session.token };
      var next = { authority: 'canonical', promotion_id: expected.promotion_id, authority_epoch: expected.authority_epoch, revision: expected.revision, digests: {} };
      var statusDigest = null;
      var expectedPageMeta = null;
      var bulkApplied = false, bulkWanted = bulkSnapshotEnabled();
      var pageLimit = readPageLimit(), deferredPageMetas = null;
      // Status and the first credit-accounts page start before the local replica is read.
      var prefetched = bulkWanted ? null : takePrefetch(expected, session.token, pageLimit);
      var statusRequest = bulkWanted ? null : (prefetched ? prefetched.status : readFetch(endpoint + '/read/canonical/status', readOptions(session.token)));
      var accountsRequest = bulkWanted ? null : (prefetched ? prefetched.accounts : readFetch(endpoint + '/read/canonical/credit-accounts?limit=' + routePageLimit('credit-accounts', pageLimit), readOptions(session.token)));
      if (statusRequest) { statusRequest.catch(function () {}); accountsRequest.catch(function () {}); }
      var contextRequest = replicaContext(endpoint, session.token), buildRequest = replicaBuild();
      var cache = bootCache || await localReplica(); bootCache = null;

      // FASE7 LAB: optional 1-request bulk snapshot (meta + 12 collections, one FR fence).
      // On failure → fall back to FASE6 status + 13 entity routes. Old routes never removed.
      if (bulkWanted) {
        try {
          var snapRes = await readFetch(endpoint + '/read/canonical/snapshot', {
            credentials: 'omit', redirect: 'error', cache: 'no-store', headers: authHeaders
          });
          if (!snapRes.ok) throw new Error('CANONICAL_READ_' + snapRes.status);
          var snap = await snapRes.json();
          verify(snap, expected);
          if (snap.mode !== 'ACTIVE') throw new Error('SNAPSHOT_NOT_ACTIVE');
          if (!uint(snap.financial_revision)) fail('STALE_AUTHORITY_BINDING');
          for (var si = 0; si < SNAPSHOT_KEYS.length; si++) {
            if (!Array.isArray(snap[SNAPSHOT_KEYS[si]])) fail('INVALID_CANONICAL_SNAPSHOT');
          }
          statusMeta = {
            authority: snap.authority, promotion_id: snap.promotion_id, authority_epoch: snap.authority_epoch,
            revision: snap.revision, financial_revision: snap.financial_revision, read_only: snap.read_only,
            mode: snap.mode, minimum_client_contract: snap.minimum_client_contract
          };
          statusDigest = snap.canonical_digest || snap.revision_digest || snap.digest || null;
          expectedPageMeta = JSON.stringify([statusMeta.mode, statusMeta.read_only, statusMeta.minimum_client_contract, statusMeta.financial_revision]);
          if (binding && !changed) assertBinding(expected);
          notifyConnectionVerified();
          next.products = snap.products;
          next.customers = snap.customers;
          next.credits = snap.credits;
          next.payments = snap.credit_payments;
          next.creditAccounts = snap.credit_accounts;
          next.cashSessions = snap.cash_sessions;
          next.financialEvents = snap.financial_events;
          next.expenses = snap.expenses;
          next.sales = snap.sales;
          next.saleItems = snap.sale_items;
          next.inventoryMovements = snap.inventory_movements;
          next.cashMovements = snap.cash_movements;
          if (statusDigest) next.canonical_digest = statusDigest;
          bulkApplied = true;
        } catch (bulkErr) {
          bulkApplied = false;
          statusMeta = null;
          try { if (root.console && root.console.warn) root.console.warn('[canon] bulk snapshot failed, falling back to 13-route', bulkErr && (bulkErr.message || String(bulkErr))); } catch (_) {}
        }
      }

      // entry = [route, name, firstPageResponse?]: the optional third element is a first page
      // already requested (prefetched during boot); it is fenced exactly like any other page.
      async function readEntry(entry) {
        var route = entry[0], name = entry[1], firstResponse = entry[2] || null, cursor = null, seen = new Set(), items = [], digest = null, limit = routePageLimit(route, pageLimit);
        do {
          if (binding && !changed) assertBinding(expected);
          var response;
          if (firstResponse && !cursor && !items.length) { response = await firstResponse; firstResponse = null; }
          else response = await readFetch(endpoint + '/read/canonical/' + route + '?limit=' + limit + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {
            credentials: 'omit', redirect: 'error', cache: 'no-store', headers: authHeaders
          });
          if (response.status === 400 && limit !== DEFAULT_PAGE_LIMIT && !cursor) {
            // A Worker without large pages rejects the limit: forget it and restart this refresh with 100.
            try { root.localStorage.removeItem(PAGE_LIMIT_KEY); } catch (_) {}
            fail('CANONICAL_PAGE_LIMIT_RETRY');
          }
          if (!response.ok) fail('CANONICAL_READ_' + response.status);
          var meta = await response.json(); verify(meta, expected);
          if (meta.mode === 'ACTIVE' && !uint(meta.financial_revision)) fail('STALE_AUTHORITY_BINDING');
          var routeDigest = meta.canonical_digest || meta.revision_digest || meta.digest;
          var pageMeta = JSON.stringify([meta.mode, meta.read_only, meta.minimum_client_contract, meta.mode === 'ACTIVE' ? meta.financial_revision : null]);
          if (deferredPageMetas) {
            // Status runs in parallel with this wave: the same fence is checked once status arrives.
            deferredPageMetas.push({ meta: pageMeta, digest: routeDigest || null });
          } else {
            if (statusMeta && meta.mode === 'ACTIVE' && meta.financial_revision !== statusMeta.financial_revision) fail('STALE_AUTHORITY_BINDING');
            if (statusDigest && routeDigest && routeDigest !== statusDigest) fail('STALE_AUTHORITY_BINDING');
            if (pageMeta !== expectedPageMeta) fail('STALE_AUTHORITY_BINDING');
          }
          if (!Array.isArray(meta.items)) fail('INVALID_CANONICAL_PAGE');
          if (routeDigest) digest = routeDigest;
          items.push.apply(items, meta.items); cursor = meta.next_cursor;
          if (cursor && seen.has(cursor)) fail('REPEATED_CANONICAL_CURSOR');
          seen.add(cursor);
        } while (cursor);
        return { route: route, name: name, items: items, digest: digest };
      }
      function applyEntries(results) {
        results.forEach(function (result) {
          next[result.name] = result.items;
          if (result.digest) next.digests[result.route] = result.digest;
        });
      }
      var coreEntries = [['products', 'products'], ['customers', 'customers'], ['credits', 'credits'], ['credit-payments', 'payments'], ['credit-accounts', 'creditAccounts']];
      var accountsEntry = coreEntries[4];
      var activeEntries = [['cash-sessions', 'cashSessions'], ['financial-events', 'financialEvents'], ['expenses', 'expenses'], ['sales', 'sales'], ['sale-items', 'saleItems'], ['inventory-movements', 'inventoryMovements'], ['cash-movements', 'cashMovements']];

      if (!bulkApplied) {
      // credit-accounts (page 1 already in flight with status) is fenced against status
      // exactly like any other page; its result is reused by every ACTIVE path below.
      var accountsRead = null;
      if (accountsRequest) {
        deferredPageMetas = [];
        accountsRead = readEntry([accountsEntry[0], accountsEntry[1], accountsRequest]);
        accountsRead.catch(function () {});
      }
      var waveEntries = coreEntries.filter(function (entry) { return !accountsRead || entry !== accountsEntry; }).concat(activeEntries);
      // A replica fully validated by this authority only needs status + credit-accounts to be
      // re-confirmed; the remaining reads run only if anything differs.
      var currentContext = await contextRequest;
      var fast = !fullRequested && !!accountsRead && fastRevalidationCandidate(cache, expected, currentContext);
      // The last validated replica was ACTIVE: start the full wave together with status
      // instead of after it (one round trip less). The fence is identical: every page
      // must carry exactly the status meta/digest, otherwise the refresh fails closed.
      var parallelWave = null;
      if (!fast && cache && cache.mode === 'ACTIVE') {
        deferredPageMetas = deferredPageMetas || [];
        parallelWave = Promise.all(waveEntries.map(readEntry));
        parallelWave.catch(function () {});
      }
      var status = await (statusRequest || readFetch(endpoint + '/read/canonical/status', {
        credentials: 'omit', redirect: 'error', cache: 'no-store', headers: authHeaders
      }));
      if (!status.ok) fail('CANONICAL_READ_' + status.status);
      statusMeta = await status.json();
      verify(statusMeta, expected);
      rememberPageLimit(statusMeta);
      statusDigest = statusMeta && (statusMeta.canonical_digest || statusMeta.revision_digest || statusMeta.digest);
      if (statusMeta && statusMeta.mode === 'ACTIVE' && !uint(statusMeta.financial_revision)) fail('STALE_AUTHORITY_BINDING');
      if (binding && !changed) assertBinding(expected);
      notifyConnectionVerified();
      expectedPageMeta = JSON.stringify([statusMeta.mode, statusMeta.read_only, statusMeta.minimum_client_contract, statusMeta.mode === 'ACTIVE' ? statusMeta.financial_revision : null]);
      if (statusDigest) next.canonical_digest = statusDigest;
      var checkDeferredPages = function () {
        var pendingMetas = deferredPageMetas || []; deferredPageMetas = null;
        pendingMetas.forEach(function (page) {
          if (page.meta !== expectedPageMeta) fail('STALE_AUTHORITY_BINDING');
          if (statusDigest && page.digest && page.digest !== statusDigest) fail('STALE_AUTHORITY_BINDING');
        });
      };
      if (statusMeta.mode === 'ACTIVE') {
        var accountsResult = accountsRead ? await accountsRead : null;
        if (fast) {
          checkDeferredPages();
          if (cacheMatchesStatus(cache, statusMeta, statusDigest) && JSON.stringify(accountsResult.items) === JSON.stringify(cache.credit_accounts)) {
            if (binding && !changed) assertBinding(expected);
            promotePublishedReplica(cache); notifyReplicaUpdate();
            if (Date.now() - fullyValidatedAt(cache) > FULL_REVALIDATE_MS) scheduleFullRevalidation(2000);
            else if (cache.remote_validated_build !== await buildRequest) scheduleFullRevalidation(DEPLOY_FULL_REVALIDATE_DELAY_MS);
            return snapshot();
          }
          // Something changed: read every other collection under the status already verified.
          applyEntries([accountsResult].concat(await Promise.all(waveEntries.map(readEntry))));
        } else if (parallelWave) {
          var waveResults = await parallelWave;
          checkDeferredPages();
          applyEntries(waveResults.concat(accountsResult ? [accountsResult] : []));
        } else {
          // FASE6 path: one parallel wave after status (13 routes total with status).
          checkDeferredPages();
          applyEntries((accountsResult ? [accountsResult] : []).concat(await Promise.all(waveEntries.map(readEntry))));
        }
      } else {
        // Predicted ACTIVE but the authority is not: discard the speculative reads.
        deferredPageMetas = null;
        if (parallelWave) await parallelWave.catch(function () {});
        if (accountsRead) await accountsRead.catch(function () {});
        applyEntries(await Promise.all(coreEntries.map(readEntry)));
        var operationalSeed = operationalBootstrapSeed(data, statusMeta);
        next.sales = operationalSeed.sales; next.saleItems = operationalSeed.saleItems; next.inventoryMovements = operationalSeed.inventoryMovements;
        next.cashMovements = operationalSeed.cashMovements; next.cashSessions = operationalSeed.cashSessions; next.financialEvents = operationalSeed.financialEvents; next.expenses = operationalSeed.expenses;
        next.read_only = true; next.mode = 'CANONICAL_READ_ONLY'; next.minimum_client_contract = statusMeta.minimum_client_contract;
        var bootstrapReplica = replicaOf(next);
        if (!validReplica(bootstrapReplica)) fail('INVALID_CANONICAL_REPLICA');
        if (cache && cacheIsNewer(cache, bootstrapReplica)) {
          publishReplica(cache, 'cache'); replicaState.validation = 'remote-older'; notifyReplicaUpdate(); return snapshot();
        }
        publishReplica(bootstrapReplica, 'bootstrap'); notifyReplicaUpdate();
      }
      } // end !bulkApplied fallback
      if (binding && !changed) assertBinding(expected);
      next.read_only = statusMeta.read_only; next.mode = statusMeta.mode; next.minimum_client_contract = statusMeta.minimum_client_contract;
      if (statusMeta.mode === 'ACTIVE') next.financial_revision = statusMeta.financial_revision;
      var incoming = replicaOf(next);
      if (!validReplica(incoming)) fail('INVALID_CANONICAL_REPLICA');
      // Marks a replica written from a complete authority read (see fastRevalidationCandidate).
      incoming.remote_validated_at = new Date().toISOString();
      incoming.remote_validated_context = await contextRequest;
      incoming.remote_validated_build = await buildRequest;
      if (cache && cacheIsNewer(cache, incoming)) {
        publishReplica(cache, 'cache'); replicaState.validation = 'remote-older'; notifyReplicaUpdate(); return snapshot();
      }
      var same = cache && cache.promotion_id === incoming.promotion_id && cache.authority_epoch === incoming.authority_epoch &&
        cache.revision === incoming.revision && (cache.financial_revision || 0) === (incoming.financial_revision || 0) && (cache.canonical_digest || null) === (incoming.canonical_digest || null) &&
        JSON.stringify([cache.products,cache.customers,cache.credits,cache.credit_payments,cache.credit_accounts||[],cache.sales||[],cache.sale_items||[],cache.inventory_movements||[],cache.cash_movements||[],cache.cash_sessions||[],cache.financial_events||[],cache.expenses||[],cache.digests||{}]) ===
        JSON.stringify([incoming.products,incoming.customers,incoming.credits,incoming.credit_payments,incoming.credit_accounts||[],incoming.sales||[],incoming.sale_items||[],incoming.inventory_movements||[],incoming.cash_movements||[],incoming.cash_sessions||[],incoming.financial_events||[],incoming.expenses||[],incoming.digests||{}]);
      var cacheValidatedAt = cache ? fullyValidatedAt(cache) : null;
      var stampStale = cacheValidatedAt === null || Date.now() - cacheValidatedAt > FULL_REVALIDATE_MS / 2 ||
        cache.remote_validated_context !== incoming.remote_validated_context || cache.remote_validated_build !== incoming.remote_validated_build;
      publishReplica(incoming, 'remote');
      if ((!same || stampStale) && typeof root._naWriteCanonicalReplica === 'function') await root._naWriteCanonicalReplica(incoming);
      replicaState.validation = 'current'; notifyReplicaUpdate(); return snapshot();
    })();
    try { return await loading; } catch (error) {
      if (error && error.message === 'CANONICAL_PAGE_LIMIT_RETRY' && !pageLimitRetried) {
        pageLimitRetried = true; loading = null;
        try { return await refresh(); } finally { pageLimitRetried = false; }
      }
      ready = false; saleOnlyReady = false; replicaState.validation = root.navigator.onLine === false ? 'offline' : (data ? 'stale' : 'unavailable'); notifyReplicaUpdate(); throw error; } finally { loading = null; }
  }
  function snapshot() { return copy(data || { products: [], customers: [], credits: [], payments: [], creditAccounts: [], sales: [], saleItems: [], inventoryMovements: [], cashMovements: [], cashSessions: [], financialEvents: [], expenses: [] }); }
  function sourceState() { return copy(replicaState); }
  function pendingSnapshot() {
    var value = journal();
    return value && value.state === 'PENDING' ? copy(value) : null;
  }
  function receiptSnapshot() {
    var value = journal();
    return value && value.state === 'CONFIRMED' ? copy(value.receipt) : null;
  }
  function assertAction(action) {
    if (!COMMANDS.includes(action)) fail('UNSUPPORTED_CANONICAL_ACTION');
    // After a confirmed sale.create the replica holds a local projection of
    // that receipt (stock + revision). It is good enough for the NEXT queued
    // sale (the Worker re-checks every revision atomically) but never for cash
    // or other commands, which wait for a full read.
    var commandReady = ready || (saleOnlyReady && action === 'sale.create');
    if (!commandReady || changed || !data || data.read_only !== false || data.mode !== 'ACTIVE' || data.minimum_client_contract !== CONTRACT || root.navigator.onLine === false) fail('CANONICAL_COMMERCE_CLOSED');
    assertBinding(binding);
    return true;
  }
  function commonPayload() {
    return { operation_id: root.crypto.randomUUID(), promotion_id: binding.promotion_id,
      client_contract: CONTRACT, authority_epoch: binding.authority_epoch, expected_control_revision: binding.revision, created_at: new Date().toISOString() };
  }
  function paymentFor(method, total, sale) {
    var payment = { cash_cents: 0, digital_cents: 0, credit_cents: 0 };
    if (method === 'efectivo') payment.cash_cents = total;
    else if (['yape', 'plin', 'transferencia'].includes(method)) payment.digital_cents = total;
    else if (method === 'credito') payment.credit_cents = total;
    else {
      if (!Number.isSafeInteger(sale.cash_cents) || sale.cash_cents <= 0 || sale.cash_cents >= total || !['yape', 'plin', 'transferencia'].includes(sale.digital_method)) fail('INVALID_CANONICAL_PAYMENT');
      payment.cash_cents = sale.cash_cents;
      payment.digital_cents = total - sale.cash_cents;
      payment.digital_method = sale.digital_method;
    }
    if (sale.reference != null && sale.reference !== '') {
      if (typeof sale.reference !== 'string' || sale.reference.length > 160 || /[\x00-\x1f\x7f]/.test(sale.reference)) fail('INVALID_CANONICAL_PAYMENT');
      payment.reference = sale.reference;
    }
    return payment;
  }
  function normalizeAccountInput(account) {
    if (account == null) return null;
    if (!account || typeof account !== 'object' || Array.isArray(account) || !validId(account.account_id) ||
        typeof account.name !== 'string' || !account.name.trim() || account.name.trim().length > 60 ||
        !['accumulated','separate'].includes(account.mode)) fail('INVALID_CANONICAL_CREDIT_ACCOUNT');
    return { account_id: account.account_id, name: account.name.trim().replace(/\s+/g,' '), mode: account.mode };
  }
  function normalizeInstallmentInput(rows,total) {
    if (rows == null) return [];
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 60) fail('INVALID_CANONICAL_INSTALLMENTS');
    var sum=0;
    var out=rows.map(function (row,index) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.number !== index+1 || !validDate(row.due_date) ||
          !uint(row.amount_cents) || row.amount_cents===0) fail('INVALID_CANONICAL_INSTALLMENTS');
      sum+=row.amount_cents; if(!uint(sum)) fail('INVALID_CANONICAL_INSTALLMENTS');
      return { number:row.number, due_date:row.due_date, amount_cents:row.amount_cents };
    });
    if(sum!==total) fail('INVALID_CANONICAL_INSTALLMENTS');
    return out;
  }
  function makeCreditAccountPayload(input) {
    input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
    var account=normalizeAccountInput(input);
    if(!account || account.account_id==='small' || !validId(input.customer_id) ||
       !data.customers.some(function (item) { return item.customer_id===input.customer_id; })) fail('INVALID_CANONICAL_CREDIT_ACCOUNT');
    return Object.assign(commonPayload(), { customer_id:input.customer_id, account_id:account.account_id, name:account.name, mode:account.mode });
  }

  function makeCustomerPayload(input) {
    input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
    function text(value,max,required) {
      if(value===undefined||value===null||String(value).trim()==='') {
        if(required) fail('INVALID_CANONICAL_CUSTOMER');
        return null;
      }
      var out=String(value).trim().replace(/\s+/g,' ');
      if(out.length>max||/[\x00-\x1f\x7f]/.test(out)) fail('INVALID_CANONICAL_CUSTOMER');
      return out;
    }
    var name=text(input.name,240,true);
    var color=Number.isInteger(input.color)&&input.color>=0&&input.color<=7
      ? input.color
      : ((data&&Array.isArray(data.customers)?data.customers.length:0)%8);
    return Object.assign(commonPayload(),{
      customer_id:validId(input.customer_id)?input.customer_id:'C-'+root.crypto.randomUUID(),
      name:name,
      document:text(input.document,32,false),
      phone:text(input.phone,64,false),
      address:text(input.address,500,false),
      color:color
    });
  }

  function makeCustomerContactPayload(input){
    const customer=data?.customers?.find(c=>String(c.customer_id)===String(input?.customer_id));
    const name=String(input?.name||'').trim().replace(/\s+/g,' '),phone=input?.phone===null?null:String(input?.phone||'');
    if(!customer||!name||name.length>240||/[\x00-\x1f\x7f]/.test(name)||!(phone===null||/^\+[1-9]\d{8,14}$/.test(phone)))fail('INVALID_CANONICAL_CUSTOMER_CONTACT');
    return Object.assign(commonPayload(),{customer_id:String(input.customer_id),name,phone,expected_contact_revision:Number(customer.contact_revision)||0});
  }
  function makeCustomerCreditPolicyPayload(input) {
    input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
    var customer=data&&Array.isArray(data.customers)
      ? data.customers.find(function(item){return String(item.customer_id)===String(input.customer_id);})
      : null;
    if(!customer||!validId(String(input.customer_id||''))) fail('INVALID_CANONICAL_CUSTOMER_CREDIT_POLICY');
    var mode=String(input.mode||'').trim().toUpperCase();
    if(!['MANUAL','AUTOMATIC'].includes(mode)) fail('INVALID_CANONICAL_CUSTOMER_CREDIT_POLICY');
    var reason=String(input.reason||'').trim().replace(/\s+/g,' ');
    var administratorName=String(input.administrator_name||'').trim().replace(/\s+/g,' ');
    var administratorId=input.administrator_id==null||String(input.administrator_id).trim()===''?null:String(input.administrator_id).trim();
    if(reason.length<8||reason.length>500||administratorName.length<1||administratorName.length>160||
       administratorId!==null&&!validId(administratorId)||/[\x00-\x1f\x7f]/.test(reason+administratorName)) fail('INVALID_CANONICAL_CUSTOMER_CREDIT_POLICY');
    var currentRevision=Number(customer.credit_policy_revision)||0;
    var expected=input.expected_policy_revision===undefined?currentRevision:Number(input.expected_policy_revision);
    if(!uint(expected)) fail('INVALID_CANONICAL_CUSTOMER_CREDIT_POLICY');
    var limit=null;
    if(mode==='MANUAL'){
      limit=Number(input.manual_limit_cents);
      if(!uint(limit)||limit>100000000) fail('INVALID_CANONICAL_CUSTOMER_CREDIT_POLICY');
    }else if(input.manual_limit_cents!==null&&input.manual_limit_cents!==undefined){
      fail('INVALID_CANONICAL_CUSTOMER_CREDIT_POLICY');
    }
    return Object.assign(commonPayload(),{
      customer_id:String(input.customer_id),mode:mode,manual_limit_cents:limit,
      expected_policy_revision:expected,reason:reason,
      administrator_id:administratorId,administrator_name:administratorName
    });
  }

  function makeProductPayload(input) {
    input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
    function text(value,max,required) {
      if(value===undefined||value===null||String(value).trim()==='') {
        if(required) fail('INVALID_CANONICAL_PRODUCT');
        return null;
      }
      var out=String(value).trim().replace(/\s+/g,' ');
      if(out.length>max||/[\x00-\x1f\x7f]/.test(out)) fail('INVALID_CANONICAL_PRODUCT');
      return out;
    }
    var name=text(input.name,240,true),unit=text(input.unit,80,true),purchaseUnit=text(input.purchase_unit,80,true);
    var sku=text(input.sku,160,false),barcode=text(input.barcode,160,false);
    var alternate=Array.isArray(input.alternate_codes)?input.alternate_codes.map(function(value){return text(value,160,true);}):[];
    if(alternate.length>10) fail('INVALID_CANONICAL_PRODUCT');
    var codes=[sku,barcode].concat(alternate).filter(Boolean).map(function(value){return value.toLowerCase();});
    if(new Set(codes).size!==codes.length) fail('INVALID_CANONICAL_PRODUCT');
    if(!uint(input.cost_cents)||!Number.isSafeInteger(input.price_cents)||input.price_cents<=0||
       input.box_price_cents!=null&&(!Number.isSafeInteger(input.box_price_cents)||input.box_price_cents<=0)||
       typeof input.purchase_factor!=='number'||!Number.isFinite(input.purchase_factor)||input.purchase_factor<=0||
       input.units_per_box!=null&&(typeof input.units_per_box!=='number'||!Number.isFinite(input.units_per_box)||input.units_per_box<=0)||
       typeof input.initial_stock_quantity!=='number'||!Number.isFinite(input.initial_stock_quantity)||input.initial_stock_quantity<0||
       typeof input.stock_min_quantity!=='number'||!Number.isFinite(input.stock_min_quantity)||input.stock_min_quantity<0||
       ![true,false].includes(input.includes_igv)||![true,false].includes(input.tracks_inventory)||
       input.expiry_date!=null&&input.expiry_date!==''&&!validDate(input.expiry_date)) fail('INVALID_CANONICAL_PRODUCT');
    var tax=String(input.tax_type||'').trim().toLowerCase(),comp=String(input.complementary_tax||'').trim().toLowerCase();
    if(!['','gravado','exonerado','inafecto','gratuito'].includes(tax)||!['','isc','icbper'].includes(comp)) fail('INVALID_CANONICAL_PRODUCT');
    var tracks=input.tracks_inventory;
    return Object.assign(commonPayload(),{
      product_id:validId(input.product_id)?input.product_id:'P-'+root.crypto.randomUUID(),
      name:name,sku:sku,barcode:barcode,alternate_codes:alternate,
      category:text(input.category,120,false),brand:text(input.brand,160,false),description:text(input.description,2000,false),
      icon:text(input.icon,24,false),image:text(input.image,250000,false),unit:unit,purchase_unit:purchaseUnit,
      purchase_factor:input.purchase_factor,cost_cents:input.cost_cents,price_cents:input.price_cents,
      box_price_cents:input.box_price_cents==null?null:input.box_price_cents,
      units_per_box:input.units_per_box==null?null:input.units_per_box,
      initial_stock_quantity:tracks?input.initial_stock_quantity:0,
      stock_min_quantity:tracks?input.stock_min_quantity:0,
      expiry_date:tracks&&input.expiry_date?input.expiry_date:null,
      includes_igv:input.includes_igv,tax_type:tax,complementary_tax:comp,tracks_inventory:tracks
    });
  }

  // product.update: metadata only (price, cost, codes, name, wholesale, stock
  // minimum). Stock, unit, tax and inventory tracking are never sent here.
  function makeProductUpdatePayload(input) {
    input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
    var product=data&&Array.isArray(data.products)?data.products.find(function(item){return item.product_id===input.product_id;}):null;
    if(!product||!validId(String(input.product_id||'')))fail('INVALID_CANONICAL_PRODUCT');
    function text(value,max,required) {
      if(value===undefined||value===null||String(value).trim()==='') {
        if(required) fail('INVALID_CANONICAL_PRODUCT');
        return null;
      }
      var out=String(value).trim().replace(/\s+/g,' ');
      if(out.length>max||/[\x00-\x1f\x7f]/.test(out)) fail('INVALID_CANONICAL_PRODUCT');
      return out;
    }
    var sku=text(input.sku,160,false),barcode=text(input.barcode,160,false);
    var alternate=Array.isArray(input.alternate_codes)?input.alternate_codes.map(function(value){return text(value,160,true);}):[];
    if(alternate.length>10) fail('INVALID_CANONICAL_PRODUCT');
    var codes=[sku,barcode].concat(alternate).filter(Boolean).map(function(value){return value.toLowerCase();});
    if(new Set(codes).size!==codes.length) fail('INVALID_CANONICAL_PRODUCT');
    var hasBox=input.box_price_cents!=null;
    if(!uint(input.cost_cents)||!Number.isSafeInteger(input.price_cents)||input.price_cents<=0||
       hasBox!==(input.units_per_box!=null)||
       hasBox&&(!Number.isSafeInteger(input.box_price_cents)||input.box_price_cents<=0||typeof input.units_per_box!=='number'||!Number.isFinite(input.units_per_box)||input.units_per_box<=0)||
       typeof input.stock_min_quantity!=='number'||!Number.isFinite(input.stock_min_quantity)||input.stock_min_quantity<0||
       input.expiry_date!=null&&input.expiry_date!==''&&!validDate(input.expiry_date)) fail('INVALID_CANONICAL_PRODUCT');
    var tracks=Number(product.tracks_inventory)===1;
    var expected=input.expected_metadata_revision===undefined?(Number(product.metadata_revision)||0):Number(input.expected_metadata_revision);
    if(!uint(expected)) fail('INVALID_CANONICAL_PRODUCT');
    return Object.assign(commonPayload(),{
      product_id:product.product_id,expected_metadata_revision:expected,
      name:text(input.name,240,true),sku:sku,barcode:barcode,alternate_codes:alternate,
      category:text(input.category,120,false),brand:text(input.brand,160,false),description:text(input.description,2000,false),
      icon:text(input.icon,24,false),cost_cents:input.cost_cents,price_cents:input.price_cents,
      box_price_cents:hasBox?input.box_price_cents:null,units_per_box:hasBox?input.units_per_box:null,
      stock_min_quantity:tracks?input.stock_min_quantity:0,
      expiry_date:input.expiry_date?input.expiry_date:null
    });
  }

  function pendingSaleUnits(productId) {
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox, intents = [];
    try { intents = outbox && typeof outbox.snapshot === 'function' ? outbox.snapshot().intents || [] : []; }
    catch (_) { fail('INSUFFICIENT_PROJECTED_STOCK'); }
    return intents.reduce(function (sum, intent) {
      return sum + (Array.isArray(intent && intent.items) ? intent.items : []).reduce(function (units, item) {
        return units + (item && item.product_id === productId && item.generic_line === undefined && Number.isSafeInteger(item.quantity) ? item.quantity : 0);
      }, 0);
    }, 0);
  }
  function makeInventoryPayload(input) {
    input=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
    if(!validId(input.product_id))fail('INVALID_CANONICAL_INVENTORY');
    var type=String(input.movement_type||'').trim().toUpperCase();
    if(!['ENTRADA','SALIDA'].includes(type)||typeof input.quantity!=='number'||!Number.isFinite(input.quantity)||input.quantity<=0||!validReason(input.reason))fail('INVALID_CANONICAL_INVENTORY');
    var product=data&&Array.isArray(data.products)?data.products.find(function(item){return item.product_id===input.product_id;}):null;
    if(!product||Number(product.tracks_inventory)!==1||!uint(product.stock_revision)||typeof product.current_stock_quantity!=='number'||!Number.isFinite(product.current_stock_quantity)||product.current_stock_quantity<0)fail('INVALID_CANONICAL_PRODUCT');
    if(type==='SALIDA'&&input.quantity>product.current_stock_quantity)fail('INSUFFICIENT_CANONICAL_STOCK');
    // Sales already charged but still queued will take their units when they
    // reach CANON. A SALIDA may only use what is left after them; otherwise the
    // queued sale is rejected and the cash and the stock stop matching.
    if(type==='SALIDA'&&input.quantity>product.current_stock_quantity-pendingSaleUnits(product.product_id))fail('INSUFFICIENT_PROJECTED_STOCK');
    // Optional caller-supplied operation_id (e.g. OCR purchase "OCR-PURCHASE-<hash>:<line>")
    // so a re-applied document maps to the SAME operation and can never double-count.
    var common=commonPayload();
    if(input.operation_id!=null){
      if(typeof input.operation_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.operation_id))fail('INVALID_CANONICAL_INVENTORY');
      common.operation_id=input.operation_id;
    }
    return Object.assign(common,{
      product_id:product.product_id,
      movement_type:type,
      quantity:input.quantity,
      expected_stock_revision:product.stock_revision,
      reason:String(input.reason).trim().replace(/\s+/g,' ')
    });
  }

  function makePayload(sale) {
    if (!sale || typeof sale !== 'object' || !Array.isArray(sale.items) || !sale.items.length || sale.items.length > 500 || !METHODS.includes(sale.payment_method)) fail('INVALID_CANONICAL_SALE');
    var seen = new Set(), total = 0;
    var items = sale.items.map(function (requested) {
      if (!requested || !validId(requested.product_id) || seen.has(requested.product_id) || !Number.isFinite(requested.quantity) || requested.quantity <= 0 || requested.quantity > Number.MAX_SAFE_INTEGER) fail('INVALID_CANONICAL_ITEM');
      seen.add(requested.product_id);
      var product = data.products.find(function (item) { return item.product_id === requested.product_id; });
      if (!product || !Number.isSafeInteger(product.price_cents) || product.price_cents < 0 || !Number.isSafeInteger(product.stock_revision) || product.stock_revision < 0) fail('INVALID_CANONICAL_PRODUCT');
      var line = Math.round(requested.quantity * product.price_cents);
      if (!Number.isSafeInteger(line) || line < 0) fail('UNSAFE_CANONICAL_TOTAL');
      total += line; if (!Number.isSafeInteger(total)) fail('UNSAFE_CANONICAL_TOTAL');
      return { product_id: product.product_id, quantity: requested.quantity, unit_price_cents: product.price_cents, line_total_cents: line, expected_stock_revision: product.stock_revision };
    });
    if (total <= 0) fail('INVALID_CANONICAL_SALE');
    var payload = Object.assign(commonPayload(), {
      sale_id: root.crypto.randomUUID(), payment_method: sale.payment_method, total_cents: total,
      payment: paymentFor(sale.payment_method, total, sale), items: items
    });
    if (sale.customer_id != null && sale.customer_id !== '') {
      if (!validId(sale.customer_id) || !data.customers.some(function (item) { return item.customer_id === sale.customer_id; })) fail('INVALID_CANONICAL_CUSTOMER');
      payload.customer_id = sale.customer_id;
    }
    if (sale.payment_method === 'credito') {
      if (!payload.customer_id || !validDate(sale.credit_due)) fail('INVALID_CANONICAL_CREDIT');
      payload.credit_due = sale.credit_due;
      var account = normalizeAccountInput(sale.credit_account);
      if (account) payload.credit_account = account;
      var installments = normalizeInstallmentInput(sale.installments, total);
      if (installments.length) payload.installments = installments;
    }
    return payload;
  }
  function makeIntentPayload(intent) {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent) || !Array.isArray(intent.items) || !intent.items.length || intent.items.length > 500 ||
        !validId(intent.operation_id) || !validId(intent.sale_id) || typeof intent.created_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(intent.created_at) || !Number.isFinite(Date.parse(intent.created_at)) ||
        !METHODS.includes(intent.payment_method) || !uint(intent.total_cents) || intent.total_cents === 0) fail('INVALID_CANONICAL_INTENT');
    var seen = new Set(), total = 0;
    var items = intent.items.map(function (requested) {
      if (!requested || !validId(requested.product_id) || seen.has(requested.product_id) || !Number.isSafeInteger(requested.quantity) || requested.quantity <= 0 ||
          !uint(requested.unit_price_cents) || !uint(requested.line_total_cents)) fail('INVALID_CANONICAL_ITEM');
      seen.add(requested.product_id);
      var generic = requested.generic_line;
      var expectedRevision = 0;
      if (generic !== undefined) {
        if (!generic || typeof generic !== 'object' || Array.isArray(generic) || requested.product_id.slice(0,8) !== 'GENERIC:' ||
            requested.quantity > 9999 || requested.unit_price_cents <= 0 ||
            typeof generic.name !== 'string' || !generic.name.trim() || generic.name.length > 240 || /[\x00-\x1f\x7f]/.test(generic.name) ||
            typeof generic.code !== 'string' || generic.code.length > 160 || /[\x00-\x1f\x7f]/.test(generic.code)) fail('INVALID_CANONICAL_GENERIC_LINE');
      } else {
        var product = data.products.find(function (item) { return item.product_id === requested.product_id; });
        if (!product || !uint(product.stock_revision)) fail('INVALID_CANONICAL_PRODUCT');
        expectedRevision = product.stock_revision;
      }
      var line = requested.quantity * requested.unit_price_cents;
      if (!Number.isSafeInteger(line) || requested.line_total_cents !== line) fail('INVALID_CANONICAL_ITEM');
      total += line; if (!Number.isSafeInteger(total)) fail('UNSAFE_CANONICAL_TOTAL');
      var out = { product_id: requested.product_id, quantity: requested.quantity, unit_price_cents: requested.unit_price_cents,
        line_total_cents: requested.line_total_cents, expected_stock_revision: expectedRevision };
      if (generic !== undefined) out.generic_line = { name: generic.name.trim().replace(/\s+/g,' '), code: generic.code.trim() };
      return out;
    });
    if (total !== intent.total_cents) fail('INVALID_CANONICAL_TOTAL');
    var inputPayment = intent.payment;
    if (!inputPayment || typeof inputPayment !== 'object' || Array.isArray(inputPayment) ||
        !uint(inputPayment.cash_cents) || !uint(inputPayment.digital_cents) || !uint(inputPayment.credit_cents)) fail('INVALID_CANONICAL_PAYMENT');
    var paymentTotal = inputPayment.cash_cents + inputPayment.digital_cents + inputPayment.credit_cents;
    if (!Number.isSafeInteger(paymentTotal) || paymentTotal !== total) fail('INVALID_CANONICAL_PAYMENT');
    if (inputPayment.digital_method != null && !['yape', 'plin', 'transferencia'].includes(inputPayment.digital_method)) fail('INVALID_CANONICAL_PAYMENT');
    if (inputPayment.reference !== undefined && (typeof inputPayment.reference !== 'string' || inputPayment.reference.length > 160 || /[\x00-\x1f\x7f]/.test(inputPayment.reference))) fail('INVALID_CANONICAL_PAYMENT');
    var payload = Object.assign(commonPayload(), { operation_id: intent.operation_id, sale_id: intent.sale_id, created_at: intent.created_at,
      payment_method: intent.payment_method, total_cents: intent.total_cents,
      payment: { cash_cents: inputPayment.cash_cents, digital_cents: inputPayment.digital_cents, credit_cents: inputPayment.credit_cents }, items: items });
    if (inputPayment.digital_method != null) payload.payment.digital_method = inputPayment.digital_method;
    if (inputPayment.reference !== undefined) payload.payment.reference = inputPayment.reference;
    // The till the cash was received in. The Worker rejects the sale with
    // cash_session_closed instead of counting yesterday's cash in today's till.
    if (intent.session_id !== undefined) {
      if (!validId(intent.session_id) || inputPayment.cash_cents <= 0) fail('INVALID_CANONICAL_INTENT');
      payload.session_id = intent.session_id;
    }
    if (intent.customer_id !== undefined) {
      if (!validId(intent.customer_id) || !data.customers.some(function (item) { return item.customer_id === intent.customer_id; })) fail('INVALID_CANONICAL_CUSTOMER');
      payload.customer_id = intent.customer_id;
    }
    if (intent.payment_method === 'credito') {
      if (!payload.customer_id || !validDate(intent.credit_due)) fail('INVALID_CANONICAL_CREDIT');
      payload.credit_due = intent.credit_due;
      var account = normalizeAccountInput(intent.credit_account);
      if (account) payload.credit_account = account;
      var installments = normalizeInstallmentInput(intent.installments, total);
      if (installments.length) payload.installments = installments;
    } else if (intent.credit_due !== undefined || intent.credit_account !== undefined || intent.installments !== undefined) fail('INVALID_CANONICAL_CREDIT');
    return payload;
  }
  function openSession(requestedId) {
    var sessions = (data && data.cashSessions || []).filter(function (item) { return item && item.status === 'OPEN'; });
    if (sessions.length !== 1 || !validId(sessions[0].session_id) || !uint(sessions[0].revision) || !uint(sessions[0].expected_cents) ||
        (requestedId !== undefined && requestedId !== sessions[0].session_id)) fail('INVALID_CANONICAL_CASH_SESSION');
    return sessions[0];
  }
  function makeExpensePayload(input) {
    input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var amount = input.amount_cents;
    if (!uint(amount) || amount === 0 || typeof input.concept !== 'string' || !input.concept.trim() || input.concept.trim().length > 500 ||
        typeof input.category !== 'string' || !input.category.trim() || input.category.trim().length > 120 ||
        !FINANCIAL_METHODS.includes(input.payment_method) || !validDate(input.expense_date) ||
        input.note != null && (typeof input.note !== 'string' || input.note.length > 500 || /[\x00-\x1f\x7f]/.test(input.note))) fail('INVALID_CANONICAL_EXPENSE');
    var payload = Object.assign(commonPayload(), {
      expense_id: validId(input.expense_id) ? input.expense_id : root.crypto.randomUUID(),
      amount_cents: amount,
      concept: input.concept.trim().replace(/\s+/g,' '),
      category: input.category.trim().replace(/\s+/g,' '),
      payment_method: input.payment_method,
      expense_date: input.expense_date
    });
    if (input.note != null && input.note !== '') payload.note = input.note;
    if (input.session_id !== undefined) {
      var session = openSession(input.session_id);
      payload.session_id = session.session_id;
      payload.expected_session_revision = session.revision;
    }
    return payload;
  }

  function makeFinancialPayload(command, input) {
    input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var payload = commonPayload(), session, credit, event;
    if (command === 'payment.create') {
      if (!validId(input.credit_id) || !uint(input.amount_cents) || input.amount_cents === 0 || !FINANCIAL_METHODS.includes(input.payment_method)) fail('INVALID_CANONICAL_PAYMENT');
      credit = data.credits.find(function (item) { return item.credit_id === input.credit_id; });
      if (!credit || !uint(credit.current_balance_cents) || input.amount_cents > credit.current_balance_cents || !uint(credit.revision) || !['IMPORT', 'LIVE'].includes(credit.provenance)) fail('INVALID_CANONICAL_CREDIT');
      Object.assign(payload, { credit_id: credit.credit_id, expected_credit_revision: credit.revision, amount_cents: input.amount_cents, payment_method: input.payment_method });
      if (input.payment_method === 'efectivo') {
        session = openSession(input.session_id); if (!uint(session.expected_cents + input.amount_cents)) fail('UNSAFE_CANONICAL_TOTAL'); payload.session_id = session.session_id;
      } else if (input.session_id !== undefined) fail('INVALID_CANONICAL_PAYMENT');
      if (input.reference != null && input.reference !== '') { if (!validId(input.reference)) fail('INVALID_CANONICAL_PAYMENT'); payload.reference = input.reference; }
    } else if (command === 'cash.open') {
      if (!validId(input.session_id) || !uint(input.opening_cents)) fail('INVALID_CANONICAL_CASH_OPEN');
      if ((data.cashSessions || []).some(function (item) { return item.status === 'OPEN' || item.session_id === input.session_id; })) fail('INVALID_CANONICAL_CASH_SESSION');
      Object.assign(payload, { session_id: input.session_id, opening_cents: input.opening_cents });
    } else if (command === 'cash.close') {
      session = openSession(input.session_id); if (!uint(input.counted_cents)) fail('INVALID_CANONICAL_CASH_CLOSE');
      Object.assign(payload, { session_id: session.session_id, expected_session_revision: session.revision, counted_cents: input.counted_cents });
    } else if (command === 'adjustment.create') {
      session = openSession(input.session_id); if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents === 0 || !uint(session.expected_cents + input.amount_cents) || !validReason(input.reason)) fail('INVALID_CANONICAL_ADJUSTMENT');
      Object.assign(payload, { session_id: session.session_id, expected_session_revision: session.revision, amount_cents: input.amount_cents, reason: input.reason });
    } else if (command === 'compensation.create') {
      if (!validId(input.compensates_operation_id) || !validReason(input.reason)) fail('INVALID_CANONICAL_COMPENSATION');
      event = data.financialEvents.find(function (item) { return item.operation_id === input.compensates_operation_id && ['PAYMENT', 'ADJUSTMENT'].includes(item.event_type); });
      if (!event || !Number.isSafeInteger(event.cash_delta_cents) || !Number.isSafeInteger(event.credit_delta_cents) || data.financialEvents.some(function (item) { return item.compensates_operation_id === event.operation_id; })) fail('INVALID_CANONICAL_COMPENSATION');
      Object.assign(payload, { compensates_operation_id: event.operation_id, reason: input.reason });
      if (event.cash_delta_cents !== 0) {
        session = openSession(input.session_id); if (!uint(session.expected_cents - event.cash_delta_cents)) fail('INVALID_CANONICAL_COMPENSATION');
        payload.session_id = session.session_id; payload.expected_session_revision = session.revision;
      } else if (input.session_id !== undefined) fail('INVALID_CANONICAL_COMPENSATION');
      if (event.credit_id != null) {
        credit = data.credits.find(function (item) { return item.credit_id === event.credit_id && item.provenance === event.credit_provenance; });
        if (!credit || !uint(credit.revision) || !uint(credit.current_balance_cents) || !uint(credit.current_balance_cents - event.credit_delta_cents) || !['IMPORT', 'LIVE'].includes(credit.provenance)) fail('INVALID_CANONICAL_CREDIT'); payload.expected_credit_revision = credit.revision;
      }
    } else fail('UNSUPPORTED_CANONICAL_ACTION');
    return payload;
  }
  function validCommon(payload) {
    return payload && typeof payload === 'object' && !Array.isArray(payload) && validId(payload.operation_id) &&
      validId(payload.promotion_id) && payload.client_contract === CONTRACT && uint(payload.authority_epoch) && uint(payload.expected_control_revision) &&
      typeof payload.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.created_at) &&
      validDate(payload.created_at.slice(0, 10)) && Number.isFinite(Date.parse(payload.created_at));
  }
  function validPayload(command, payload) {
    if (!validCommon(payload)) return false;
    if (command === 'payment.batch') {
      if (!Array.isArray(payload.payments) || payload.payments.length < 1 || payload.payments.length > 20) return false;
      var batchOperations = new Set(), batchCredits = new Set(), firstMethod = null, firstSession = null, firstReference = null;
      for (var batchPayment of payload.payments) {
        if (!validPayload('payment.create', batchPayment) || batchPayment.operation_id === payload.operation_id ||
            batchOperations.has(batchPayment.operation_id) || batchCredits.has(batchPayment.credit_id) ||
            batchPayment.promotion_id !== payload.promotion_id || batchPayment.client_contract !== payload.client_contract ||
            batchPayment.authority_epoch !== payload.authority_epoch || batchPayment.expected_control_revision !== payload.expected_control_revision) return false;
        batchOperations.add(batchPayment.operation_id); batchCredits.add(batchPayment.credit_id);
        if (firstMethod === null) {
          firstMethod = batchPayment.payment_method;
          firstSession = batchPayment.session_id === undefined ? null : batchPayment.session_id;
          firstReference = batchPayment.reference === undefined ? null : batchPayment.reference;
        } else if (batchPayment.payment_method !== firstMethod ||
            (batchPayment.session_id === undefined ? null : batchPayment.session_id) !== firstSession ||
            (batchPayment.reference === undefined ? null : batchPayment.reference) !== firstReference) return false;
      }
      return true;
    }
    if (command === 'credit-account.create') {
      return validId(payload.customer_id) && validId(payload.account_id) && payload.account_id !== 'small' &&
        typeof payload.name === 'string' && payload.name.trim().length > 0 && payload.name.trim().length <= 60 &&
        ['accumulated','separate'].includes(payload.mode);
    }
    if (command === 'customer.contact.set') return validId(payload.customer_id)&&uint(payload.expected_contact_revision)&&typeof payload.name==='string'&&payload.name.trim().length>0&&payload.name.length<=240&&!/[\x00-\x1f\x7f]/.test(payload.name)&&(payload.phone===null||typeof payload.phone==='string'&&/^\+[1-9]\d{8,14}$/.test(payload.phone));
    if (command === 'customer.create') {
      return validId(payload.customer_id) &&
        typeof payload.name==='string' && payload.name.trim().length>0 && payload.name.length<=240 &&
        (payload.document===null || typeof payload.document==='string' && payload.document.trim().length>0 && payload.document.length<=32 && !/[\x00-\x1f\x7f]/.test(payload.document)) &&
        (payload.phone===null || typeof payload.phone==='string' && payload.phone.trim().length>0 && payload.phone.length<=64 && !/[\x00-\x1f\x7f]/.test(payload.phone)) &&
        (payload.address===null || typeof payload.address==='string' && payload.address.trim().length>0 && payload.address.length<=500 && !/[\x00-\x1f\x7f]/.test(payload.address)) &&
        Number.isInteger(payload.color) && payload.color>=0 && payload.color<=7;
    }
    if (command === 'customer.credit-policy.set') {
      return validId(payload.customer_id) && ['MANUAL','AUTOMATIC'].includes(payload.mode) &&
        uint(payload.expected_policy_revision) &&
        (payload.mode==='MANUAL' ? uint(payload.manual_limit_cents) && payload.manual_limit_cents<=100000000 : payload.manual_limit_cents===null) &&
        typeof payload.reason==='string' && payload.reason.trim().length>=8 && payload.reason.length<=500 &&
        (payload.administrator_id===null || validId(payload.administrator_id)) &&
        typeof payload.administrator_name==='string' && payload.administrator_name.trim().length>0 && payload.administrator_name.length<=160;
    }
    if (command === 'product.update') {
      return validId(payload.product_id) && uint(payload.expected_metadata_revision) &&
        typeof payload.name==='string' && payload.name.trim().length>0 && payload.name.length<=240 &&
        uint(payload.cost_cents) && Number.isSafeInteger(payload.price_cents) && payload.price_cents>0 &&
        (payload.box_price_cents===null) === (payload.units_per_box===null) &&
        (payload.box_price_cents===null || Number.isSafeInteger(payload.box_price_cents) && payload.box_price_cents>0) &&
        (payload.units_per_box===null || typeof payload.units_per_box==='number' && Number.isFinite(payload.units_per_box) && payload.units_per_box>0) &&
        typeof payload.stock_min_quantity==='number' && Number.isFinite(payload.stock_min_quantity) && payload.stock_min_quantity>=0 &&
        Array.isArray(payload.alternate_codes) && payload.alternate_codes.length<=10;
    }
    if (command === 'inventory.adjust') {
      return validId(payload.product_id) && ['ENTRADA','SALIDA'].includes(payload.movement_type) &&
        typeof payload.quantity==='number' && Number.isFinite(payload.quantity) && payload.quantity>0 &&
        uint(payload.expected_stock_revision) && validReason(payload.reason);
    }
    if (command === 'product.create') {
      if (!validId(payload.product_id) || typeof payload.name!=='string' || !payload.name.trim() || payload.name.length>240 ||
          typeof payload.unit!=='string' || !payload.unit.trim() || payload.unit.length>80 ||
          typeof payload.purchase_unit!=='string' || !payload.purchase_unit.trim() || payload.purchase_unit.length>80 ||
          !uint(payload.cost_cents) || !Number.isSafeInteger(payload.price_cents) || payload.price_cents<=0 ||
          payload.box_price_cents!==null && (!Number.isSafeInteger(payload.box_price_cents)||payload.box_price_cents<=0) ||
          typeof payload.purchase_factor!=='number' || !Number.isFinite(payload.purchase_factor) || payload.purchase_factor<=0 ||
          payload.units_per_box!==null && (typeof payload.units_per_box!=='number'||!Number.isFinite(payload.units_per_box)||payload.units_per_box<=0) ||
          typeof payload.initial_stock_quantity!=='number'||!Number.isFinite(payload.initial_stock_quantity)||payload.initial_stock_quantity<0 ||
          typeof payload.stock_min_quantity!=='number'||!Number.isFinite(payload.stock_min_quantity)||payload.stock_min_quantity<0 ||
          ![true,false].includes(payload.includes_igv)||![true,false].includes(payload.tracks_inventory) ||
          !Array.isArray(payload.alternate_codes)||payload.alternate_codes.length>10 ||
          payload.expiry_date!==null&&!validDate(payload.expiry_date) ||
          !['','gravado','exonerado','inafecto','gratuito'].includes(payload.tax_type) ||
          !['','isc','icbper'].includes(payload.complementary_tax)) return false;
      var productCodes=[payload.sku,payload.barcode].concat(payload.alternate_codes).filter(Boolean);
      if(productCodes.some(function(value){return typeof value!=='string'||!value.trim()||value.length>160||/[\x00-\x1f\x7f]/.test(value);}))return false;
      return new Set(productCodes.map(function(value){return value.toLowerCase();})).size===productCodes.length;
    }
    if (command === 'sale.create') {
      if (!validId(payload.sale_id) || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > 500 || !METHODS.includes(payload.payment_method) || !uint(payload.total_cents) || payload.total_cents === 0 || !payload.payment) return false;
      var total = 0, seen = new Set();
      for (var item of payload.items) {
        if (!item || !validId(item.product_id) || seen.has(item.product_id) || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > Number.MAX_SAFE_INTEGER ||
            !uint(item.unit_price_cents) || !uint(item.expected_stock_revision) || !uint(item.line_total_cents) || item.line_total_cents !== Math.round(item.quantity * item.unit_price_cents)) return false;
        if (item.generic_line !== undefined) {
          if (!item.generic_line || typeof item.generic_line !== 'object' || Array.isArray(item.generic_line) || item.product_id.slice(0,8)!=='GENERIC:' ||
              !Number.isSafeInteger(item.quantity) || item.quantity>9999 || item.unit_price_cents<=0 || item.expected_stock_revision!==0 ||
              typeof item.generic_line.name!=='string' || !item.generic_line.name.trim() || item.generic_line.name.length>240 || /[\x00-\x1f\x7f]/.test(item.generic_line.name) ||
              typeof item.generic_line.code!=='string' || item.generic_line.code.length>160 || /[\x00-\x1f\x7f]/.test(item.generic_line.code)) return false;
        }
        seen.add(item.product_id); total += item.line_total_cents; if (!uint(total)) return false;
      }
      if (total !== payload.total_cents || (payload.customer_id !== undefined && !validId(payload.customer_id)) || (payload.payment_method === 'credito' && (!validId(payload.customer_id) || !validDate(payload.credit_due)))) return false;
      try {
        var payment = paymentFor(payload.payment_method, total, { cash_cents: payload.payment.cash_cents, digital_method: payload.payment.digital_method, reference: payload.payment.reference });
        if (!['cash_cents', 'digital_cents', 'credit_cents'].every(function (key) { return payment[key] === payload.payment[key]; })) return false;
        if (payload.payment_method === 'credito') {
          if (payload.credit_account !== undefined) normalizeAccountInput(payload.credit_account);
          normalizeInstallmentInput(payload.installments, total);
        } else if (payload.credit_account !== undefined || payload.installments !== undefined) return false;
        return true;
      } catch (_) { return false; }
    }
    if (payload.session_id !== undefined && !validId(payload.session_id) || payload.expected_session_revision !== undefined && !uint(payload.expected_session_revision) ||
        payload.expected_credit_revision !== undefined && !uint(payload.expected_credit_revision) || payload.reference !== undefined && !validId(payload.reference)) return false;
    if (command === 'expense.create') return validId(payload.expense_id) && uint(payload.amount_cents) && payload.amount_cents > 0 &&
      typeof payload.concept === 'string' && payload.concept.trim().length > 0 && payload.concept.length <= 500 &&
      typeof payload.category === 'string' && payload.category.trim().length > 0 && payload.category.length <= 120 &&
      FINANCIAL_METHODS.includes(payload.payment_method) && validDate(payload.expense_date) &&
      (payload.note === undefined || typeof payload.note === 'string' && payload.note.length <= 500 && !/[\x00-\x1f\x7f]/.test(payload.note)) &&
      (payload.session_id === undefined ? payload.expected_session_revision === undefined : validId(payload.session_id) && uint(payload.expected_session_revision));
    if (command === 'payment.create') return validId(payload.credit_id) && uint(payload.expected_credit_revision) && Number.isSafeInteger(payload.amount_cents) && payload.amount_cents > 0 && FINANCIAL_METHODS.includes(payload.payment_method) && (payload.payment_method === 'efectivo' ? validId(payload.session_id) : payload.session_id === undefined);
    if (command === 'cash.open') return validId(payload.session_id) && uint(payload.opening_cents);
    if (command === 'cash.close') return validId(payload.session_id) && uint(payload.expected_session_revision) && uint(payload.counted_cents);
    if (command === 'adjustment.create') return validId(payload.session_id) && uint(payload.expected_session_revision) && Number.isSafeInteger(payload.amount_cents) && payload.amount_cents !== 0 && validReason(payload.reason);
    return command === 'compensation.create' && validId(payload.compensates_operation_id) && validReason(payload.reason) &&
      (payload.session_id === undefined ? payload.expected_session_revision === undefined : uint(payload.expected_session_revision));
  }
  function validReceipt(record, result) {
    if (!result || result.operation_id !== record.payload.operation_id) return false;
    if (!(result.status === 'created' && result.idempotent === false || result.status === 'already_processed' && result.idempotent === true)) return false;
    if (record.command === 'customer.contact.set') return result.command===record.command&&result.customer_id===record.payload.customer_id&&result.promotion_id===record.binding.promotion_id&&result.authority_epoch===record.binding.authority_epoch&&result.contact_revision===record.payload.expected_contact_revision+1;
    if (record.command === 'customer.create') return result.command===record.command &&
      result.customer_id===record.payload.customer_id &&
      result.promotion_id===record.binding.promotion_id &&
      result.authority_epoch===record.binding.authority_epoch;
    if (record.command === 'customer.credit-policy.set') return result.command===record.command &&
      result.customer_id===record.payload.customer_id &&
      result.promotion_id===record.binding.promotion_id &&
      result.authority_epoch===record.binding.authority_epoch &&
      result.mode===record.payload.mode &&
      result.manual_limit_cents===record.payload.manual_limit_cents &&
      result.policy_revision===record.payload.expected_policy_revision+1;
    if (record.command === 'inventory.adjust') return result.command===record.command &&
      result.product_id===record.payload.product_id && result.movement_type===record.payload.movement_type &&
      result.quantity===record.payload.quantity && result.promotion_id===record.binding.promotion_id &&
      result.authority_epoch===record.binding.authority_epoch && validId(result.movement_id) &&
      result.stock_revision_before===record.payload.expected_stock_revision &&
      result.stock_revision_after===record.payload.expected_stock_revision+1 &&
      typeof result.stock_before==='number' && Number.isFinite(result.stock_before) && result.stock_before>=0 &&
      typeof result.stock_after==='number' && Number.isFinite(result.stock_after) && result.stock_after>=0;
    if (record.command === 'product.update') return result.command===record.command && result.product_id===record.payload.product_id &&
      result.promotion_id===record.binding.promotion_id && result.authority_epoch===record.binding.authority_epoch &&
      result.metadata_revision===record.payload.expected_metadata_revision+1;
    if (record.command === 'product.create') return result.command===record.command && result.product_id===record.payload.product_id &&
      result.promotion_id===record.binding.promotion_id && result.authority_epoch===record.binding.authority_epoch;
    // The shipped backend's sale receipt has no command, including on replay.
    if (record.command === 'sale.create') return result.sale_id === record.payload.sale_id && (result.command === undefined || result.command === record.command);
    if (record.command === 'expense.create') return result.command === record.command && result.expense_id === record.payload.expense_id &&
      result.promotion_id === record.binding.promotion_id && result.authority_epoch === record.binding.authority_epoch &&
      result.session_id === (record.payload.session_id === undefined ? null : record.payload.session_id) && Number.isSafeInteger(result.cash_delta_cents);
    if (record.command === 'credit-account.create') return result.command === record.command && result.account_id === record.payload.account_id &&
      result.promotion_id === record.binding.promotion_id && result.authority_epoch === record.binding.authority_epoch;
    if (record.command === 'payment.batch') {
      if (result.command !== 'payment.batch' || result.promotion_id !== record.binding.promotion_id ||
          result.authority_epoch !== record.binding.authority_epoch || !Array.isArray(result.receipts) ||
          result.receipts.length !== record.payload.payments.length ||
          !Array.isArray(record.batch_credit_provenance) ||
          record.batch_credit_provenance.length !== record.payload.payments.length) return false;
      for (var batchIndex = 0; batchIndex < record.payload.payments.length; batchIndex += 1) {
        var expectedPayment = record.payload.payments[batchIndex], batchReceipt = result.receipts[batchIndex];
        if (!batchReceipt || batchReceipt.operation_id !== expectedPayment.operation_id || batchReceipt.command !== 'payment.create' ||
            batchReceipt.promotion_id !== record.binding.promotion_id || batchReceipt.authority_epoch !== record.binding.authority_epoch ||
            batchReceipt.credit_id !== expectedPayment.credit_id || batchReceipt.credit_provenance !== record.batch_credit_provenance[batchIndex] ||
            batchReceipt.event_id !== expectedPayment.operation_id || batchReceipt.credit_delta_cents !== -expectedPayment.amount_cents ||
            batchReceipt.cash_delta_cents !== (expectedPayment.payment_method === 'efectivo' ? expectedPayment.amount_cents : 0) ||
            batchReceipt.credit_revision !== expectedPayment.expected_credit_revision + 1 ||
            !(batchReceipt.status === 'created' && batchReceipt.idempotent === false ||
              batchReceipt.status === 'already_processed' && batchReceipt.idempotent === true) ||
            (expectedPayment.session_id !== undefined && batchReceipt.session_id !== expectedPayment.session_id)) return false;
      }
      return true;
    }
    if (result.command !== record.command) return false;
    if (result.promotion_id !== record.binding.promotion_id || result.authority_epoch !== record.binding.authority_epoch) return false;
    if (record.command === 'payment.create' && result.credit_id !== record.payload.credit_id) return false;
    if (record.payload.session_id !== undefined && result.session_id !== record.payload.session_id) return false;
    if (['payment.create', 'adjustment.create', 'compensation.create'].includes(record.command) && result.event_id !== record.payload.operation_id) return false;
    if (record.command === 'compensation.create' && result.compensates_operation_id !== record.payload.compensates_operation_id) return false;
    if (!record.receipt_ids || Object.keys(record.receipt_ids).some(function (key) { return result[key] !== record.receipt_ids[key]; })) return false;
    return true;
  }
  async function withWriterLock(work) {
    if (!root.navigator.locks || typeof root.navigator.locks.request !== 'function') fail('WEB_LOCKS_REQUIRED');
    return root.navigator.locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, function (lock) {
      if (!lock) fail('CANONICAL_WRITER_BUSY');
      return work();
    });
  }
  function publishConfirmedPaymentReceipt(record, result) {
    if (!record || !result || typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
    function emit(payload, receipt) {
      if (!payload || !receipt || payload.operation_id !== receipt.operation_id || payload.credit_id !== receipt.credit_id) return;
      try {
        root.dispatchEvent(new root.CustomEvent('na:canonical-payment-receipt', {
          detail: {
            version: 1,
            command: 'payment.create',
            payload: copy(payload),
            receipt: copy(receipt)
          }
        }));
      } catch (_) {}
    }
    if (record.command === 'payment.create') {
      emit(record.payload, result);
      return;
    }
    if (record.command === 'payment.batch' && Array.isArray(record.payload && record.payload.payments) && Array.isArray(result.receipts)) {
      for (var i = 0; i < record.payload.payments.length && i < result.receipts.length; i += 1) {
        emit(record.payload.payments[i], result.receipts[i]);
      }
    }
  }

  function publishConfirmedSaleReceipt(record, result) {
    if (!record || record.command !== 'sale.create' || !record.payload || !result ||
        typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
    if (record.payload.operation_id !== result.operation_id || record.payload.sale_id !== result.sale_id) return;
    try {
      root.dispatchEvent(new root.CustomEvent('na:canonical-sale-receipt', {
        detail: {
          version: 1,
          command: 'sale.create',
          payload: copy(record.payload),
          receipt: copy(result)
        }
      }));
    } catch (_) {}
  }

  // Project ONLY the stock effect of a freshly created sale so the next queued
  // sale carries the right expected_stock_revision. Any doubt (replay, unknown
  // product, revision already moved) returns false and forces a full read.
  function projectConfirmedSaleReceipt(record, result) {
    if (!record || record.command !== 'sale.create' || !record.payload || !result || result.status !== 'created' ||
        result.operation_id !== record.payload.operation_id || result.sale_id !== record.payload.sale_id ||
        !data || !Array.isArray(data.products) || !Array.isArray(record.payload.items)) return false;
    var updates = [];
    for (var i = 0; i < record.payload.items.length; i += 1) {
      var item = record.payload.items[i];
      if (item.generic_line !== undefined) continue;
      var product = data.products.find(function (row) { return row && row.product_id === item.product_id; });
      if (!product || Number(product.stock_revision) !== item.expected_stock_revision) return false;
      var tracks = Number(product.tracks_inventory);
      if (tracks === 0) continue;
      if (tracks !== 1 || typeof product.current_stock_quantity !== 'number' || product.current_stock_quantity < item.quantity) return false;
      updates.push([product, item.quantity]);
    }
    updates.forEach(function (entry) {
      entry[0].current_stock_quantity -= entry[1];
      entry[0].stock_revision = Number(entry[0].stock_revision) + 1;
    });
    return true;
  }

  function projectConfirmedCustomerCreditPolicy(record, result) {
    if (!record || record.command !== 'customer.credit-policy.set' || !record.payload || !result ||
        !data || !Array.isArray(data.customers)) return false;
    if (record.payload.operation_id !== result.operation_id ||
        record.payload.customer_id !== result.customer_id ||
        result.policy_revision !== record.payload.expected_policy_revision + 1) return false;
    var customer = data.customers.find(function (item) {
      return item && String(item.customer_id) === String(record.payload.customer_id);
    });
    if (!customer) return false;

    customer.credit_policy_mode = result.mode;
    customer.credit_policy_manual_limit_cents = result.mode === 'MANUAL' ? result.manual_limit_cents : null;
    customer.credit_policy_reason = record.payload.reason;
    customer.credit_policy_administrator_id = record.payload.administrator_id == null ? null : record.payload.administrator_id;
    customer.credit_policy_administrator_name = record.payload.administrator_name;
    customer.credit_policy_updated_at = record.payload.created_at;
    customer.credit_policy_revision = result.policy_revision;

    ready = true;
    replicaState.validation = 'current';
    if (replicaState.cache) {
      replicaState.cache = Object.assign({}, replicaState.cache, { cached_at: new Date().toISOString() });
    }
    if (typeof root._naWriteCanonicalReplica === 'function') {
      try {
        var projectedReplica = replicaOf(data);
        Promise.resolve(root._naWriteCanonicalReplica(projectedReplica)).catch(function () {});
      } catch (_) {}
    }
    return true;
  }

  function projectConfirmedCashReceipt(record, result) {
    if (!record || !record.payload || !result || !data ||
        !['cash.open', 'cash.close', 'adjustment.create'].includes(record.command)) return false;
    var payload = record.payload;
    if (payload.operation_id !== result.operation_id || result.command !== record.command ||
        result.promotion_id !== record.binding.promotion_id || result.authority_epoch !== record.binding.authority_epoch) return false;
    if (!Array.isArray(data.cashSessions)) data.cashSessions = [];
    if (!Array.isArray(data.financialEvents)) data.financialEvents = [];

    var session = data.cashSessions.find(function (item) {
      return item && String(item.session_id) === String(payload.session_id);
    });

    if (record.command === 'cash.open') {
      if (result.session_id !== payload.session_id || result.session_revision !== 0 ||
          result.expected_cents !== payload.opening_cents) return false;
      if (session) {
        if (session.status !== 'OPEN' || Number(session.opening_cents) !== payload.opening_cents) return false;
        session.open_operation_id = session.open_operation_id || payload.operation_id;
        session.expected_cents = result.expected_cents;
        session.revision = result.session_revision;
      } else {
        if (data.cashSessions.some(function (item) { return item && item.status === 'OPEN'; })) return false;
        data.cashSessions.push({
          session_id: payload.session_id,
          promotion_id: payload.promotion_id,
          open_operation_id: payload.operation_id,
          opening_cents: payload.opening_cents,
          opened_at: payload.created_at,
          status: 'OPEN',
          close_operation_id: null,
          expected_cents: result.expected_cents,
          counted_cents: null,
          difference_cents: null,
          closed_at: null,
          revision: result.session_revision
        });
      }
    } else if (record.command === 'cash.close') {
      if (result.session_id !== payload.session_id ||
          result.session_revision !== payload.expected_session_revision + 1 ||
          result.counted_cents !== payload.counted_cents ||
          result.difference_cents !== payload.counted_cents - result.expected_cents) return false;
      if (!session) return false;
      if (session.status === 'CLOSED') {
        if (session.close_operation_id && session.close_operation_id !== payload.operation_id) return false;
      } else if (session.status !== 'OPEN' || Number(session.revision) !== payload.expected_session_revision) {
        return false;
      }
      Object.assign(session, {
        status: 'CLOSED',
        close_operation_id: payload.operation_id,
        expected_cents: result.expected_cents,
        counted_cents: result.counted_cents,
        difference_cents: result.difference_cents,
        closed_at: payload.created_at,
        revision: result.session_revision
      });
    } else {
      if (result.session_id !== payload.session_id ||
          result.session_revision !== payload.expected_session_revision + 1 ||
          result.event_id !== payload.operation_id || result.cash_delta_cents !== payload.amount_cents) return false;
      if (!session || session.status !== 'OPEN') return false;
      var eventExists = data.financialEvents.some(function (item) {
        return item && String(item.operation_id) === String(payload.operation_id);
      });
      if (eventExists) {
        if (Number(session.revision) !== result.session_revision || Number(session.expected_cents) !== result.expected_cents) return false;
      } else {
        if (Number(session.revision) !== payload.expected_session_revision ||
            result.expected_cents !== Number(session.expected_cents) + payload.amount_cents) return false;
        data.financialEvents.push({
          event_id: result.event_id,
          operation_id: payload.operation_id,
          promotion_id: payload.promotion_id,
          event_type: 'ADJUSTMENT',
          session_id: payload.session_id,
          credit_id: null,
          credit_provenance: null,
          credit_delta_cents: 0,
          cash_delta_cents: payload.amount_cents,
          payment_method: null,
          reference: null,
          reason: payload.reason,
          compensates_operation_id: null,
          created_at: payload.created_at
        });
      }
      session.expected_cents = result.expected_cents;
      session.revision = result.session_revision;
    }

    ready = true;
    replicaState.validation = 'current';
    notifyReplicaUpdate();
    return true;
  }

  async function sendPending(record, skipStatus) {
    if (!binding || changed || root.navigator.onLine === false) fail('CANONICAL_COMMERCE_CLOSED');
    var expected = record.binding, session = sessionCredentials(record.binding);
    if (!session) fail('CANONICAL_COMMERCE_CLOSED');
    assertBinding(expected);
    if (record.payload.promotion_id !== expected.promotion_id || record.payload.authority_epoch !== expected.authority_epoch ||
        record.payload.expected_control_revision !== expected.revision || record.payload.client_contract !== CONTRACT) fail('STALE_AUTHORITY_BINDING');
    // A new payment.create, payment.batch or customer.credit-policy.set can
    // already come from a validated current replica. Their Worker handlers
    // recheck authority and domain CAS atomically on write, so the first send
    // may skip a redundant status GET. Retried pending commands still verify
    // remote authority before replaying the exact durable intent.
    if (!skipStatus) {
      var statusTransport = await readFetch(expected.endpoint + '/read/canonical/status', {
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + session.token }
      }, true);
      var statusResponse = statusTransport.response;
      if (!statusResponse.ok) fail('CANONICAL_READ_' + statusResponse.status);
      var meta = statusTransport.result; verify(meta, expected);
      if (meta.mode !== 'ACTIVE') fail('CANONICAL_COMMERCE_CLOSED');
    }
    assertBinding(expected);
    var raw = JSON.stringify(record);
    function unchanged() { if (root.localStorage.getItem(JOURNAL) !== raw) fail('CANONICAL_PENDING_CHANGED'); }
    unchanged();
    // A retry must also fail before POST when storage has become unwritable.
    durableJournal(record);
    var response, result;
    try {
      var payment = record.command === 'payment.create' || record.command === 'payment.batch' ||
        ['cash.close','adjustment.create','expense.create','compensation.create'].includes(record.command);
      var requestOptions = {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token },
        body: JSON.stringify(record.payload)
      };
      var transport = await readFetch(expected.endpoint + record.route, requestOptions, true, payment ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
      response = transport.response; result = transport.result;
    } catch (_) { fail('CANONICAL_FINANCIAL_PENDING'); }
    unchanged();
    if (!response.ok) {
      durableJournal(Object.assign({}, record, {
        last_error: validId(result && result.error) ? result.error : 'HTTP_' + response.status,
        last_status: response.status
      }));
      fail('CANONICAL_FINANCIAL_REJECTED_' + response.status);
    }
    if (!result || !(response.status === 201 && result.status === 'created' && result.idempotent === false || response.status === 200 && result.status === 'already_processed' && result.idempotent === true) ||
        !validReceipt(record, result) ||
        ((record.command !== 'sale.create' || result.status === 'created') && (result.promotion_id !== expected.promotion_id || result.authority_epoch !== expected.authority_epoch))) fail('CANONICAL_FINANCIAL_PENDING');
    // One atomic storage replacement both saves the receipt and clears PENDING.
    var confirmed = Object.assign({}, record, { state: 'CONFIRMED', receipt: copy(result) });
    durableJournal(confirmed);
    // The receipt is now durable. Publish only the exact affected payment so the
    // UI can update immediately while the full canonical reconciliation stays
    // off the user-visible critical path.
    publishConfirmedPaymentReceipt(record, result);
    publishConfirmedSaleReceipt(record, result);
    var policyProjected = projectConfirmedCustomerCreditPolicy(record, result);
    var cashProjected = projectConfirmedCashReceipt(record, result);
    if (!policyProjected && !cashProjected) {
      var saleProjected = projectConfirmedSaleReceipt(record, result);
      ready = false;
      saleOnlyReady = saleProjected;
    }
    return copy(confirmed.receipt);
  }
  async function prepareCommand(command) {
    // Reuse a remotely validated snapshot. Backend authority/revision/CAS checks
    // and retry status verification remain mandatory; a full scan adds no guard.
    // A queued sale may also reuse the local projection of the previous sale
    // receipt: draining N sales costs N POSTs, not N full reads.
    try { if (replicaState.validation === 'current') { assertAction(command); return legacySnapshot(); } } catch (_) {}
    await refresh();
    assertAction(command);
    return legacySnapshot();
  }
  async function createSale(sale) {
    var durableIntent = !!(sale && typeof sale === 'object' && sale.version === 1);
    if (durableIntent) await prepareCommand('sale.create');
    return createCommand('sale.create', sale, durableIntent);
  }
  async function createCommand(command, input, skipStatus) {
    return withWriterLock(async function () {
      var existing = journal();
      if (existing && existing.state === 'PENDING') fail('CANONICAL_FINANCIAL_PENDING');
      assertAction(command);
      if (!sessionCredentials(binding)) fail('CANONICAL_COMMERCE_CLOSED');
      var record = { state: 'PENDING', binding: copy(binding), command: command, route: '/commands/' + command,
        payload: command === 'sale.create' ? (input && input.version === 1 ? makeIntentPayload(input) : makePayload(input)) : command === 'product.create' ? makeProductPayload(input) : command === 'product.update' ? makeProductUpdatePayload(input) : command === 'customer.create' ? makeCustomerPayload(input) : command === 'customer.contact.set' ? makeCustomerContactPayload(input) : command === 'customer.credit-policy.set' ? makeCustomerCreditPolicyPayload(input) : command === 'inventory.adjust' ? makeInventoryPayload(input) : command === 'credit-account.create' ? makeCreditAccountPayload(input) : command === 'expense.create' ? makeExpensePayload(input) : makeFinancialPayload(command, input) };
      record.receipt_ids = {};
      if (command === 'product.create' || command === 'product.update') record.receipt_ids.product_id = record.payload.product_id;
      if (command === 'customer.create') record.receipt_ids.customer_id = record.payload.customer_id;
      if (command === 'customer.credit-policy.set') record.receipt_ids.customer_id = record.payload.customer_id;
      if (command === 'expense.create') record.receipt_ids.expense_id = record.payload.expense_id;
      if (command === 'payment.create') record.receipt_ids.credit_provenance = data.credits.find(function (item) { return item.credit_id === record.payload.credit_id; }).provenance;
      if (command === 'compensation.create') {
        var target = data.financialEvents.find(function (item) { return item.operation_id === record.payload.compensates_operation_id; });
        if (target.credit_id != null) record.receipt_ids = { credit_id: target.credit_id, credit_provenance: target.credit_provenance };
      }
      if (!validPayload(command, record.payload)) fail('INVALID_CANONICAL_PAYLOAD');
      durableJournal(record);
      // New durable sale intents come from prepareCommand() with a validated
      // current replica. The Worker re-checks authority, stock and cash
      // atomically, so an extra status round-trip adds latency but no guard.
      // Any retry still uses retryPending() -> sendPending(record) with status.
      var skipRedundantStatus = ['payment.create','cash.open','cash.close','adjustment.create'].includes(command) || skipStatus === true;
      return sendPending(record, skipRedundantStatus);
    });
  }
  async function createPaymentBatch(inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 60) fail('INVALID_CANONICAL_PAYMENT_BATCH');

    return withWriterLock(async function () {
      var existing = journal();
      if (existing && existing.state === 'PENDING') fail('CANONICAL_FINANCIAL_PENDING');
      assertAction('payment.create');
      if (!sessionCredentials(binding)) fail('CANONICAL_COMMERCE_CLOSED');

      var seen = new Set();
      var normalized = inputs.map(function (input) {
        input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        var creditId = String(input.credit_id || '');
        if (!validId(creditId) || seen.has(creditId)) fail('INVALID_CANONICAL_PAYMENT_BATCH');
        seen.add(creditId);
        return {
          credit_id: creditId,
          amount_cents: input.amount_cents,
          payment_method: input.payment_method,
          session_id: input.session_id,
          reference: input.reference
        };
      });

      // Build every child intent from the same validated replica before the first
      // network write. Different credits have independent revisions.
      var childPayloads = normalized.map(function (input) {
        var payload = makeFinancialPayload('payment.create', input);
        if (!validPayload('payment.create', payload)) fail('INVALID_CANONICAL_PAYLOAD');
        return payload;
      });

      var receipts = [];
      var CHUNK = 20;
      for (var offset = 0; offset < childPayloads.length; offset += CHUNK) {
        var payments = childPayloads.slice(offset, offset + CHUNK);
        var batchPayload = Object.assign(commonPayload(), { payments: payments });
        var provenances = payments.map(function (payment) {
          var credit = data.credits.find(function (item) { return item.credit_id === payment.credit_id; });
          if (!credit || !['IMPORT', 'LIVE'].includes(credit.provenance)) fail('INVALID_CANONICAL_CREDIT');
          return credit.provenance;
        });
        var record = {
          state: 'PENDING',
          binding: copy(binding),
          command: 'payment.batch',
          route: '/commands/payment.batch',
          payload: batchPayload,
          receipt_ids: {},
          batch_credit_provenance: provenances
        };
        if (!validPayload('payment.batch', record.payload)) fail('INVALID_CANONICAL_PAYLOAD');
        durableJournal(record);

        var batchReceipt;
        try {
          // One HTTP request transports up to 20 distinct payment.create intents.
          // The replica was already validated by assertAction(), and the Worker
          // atomically rechecks authority, every credit revision and cash session.
          // Therefore the NEW batch may skip a redundant status GET exactly like
          // a new payment.create. Retries below still require remote status.
          batchReceipt = await sendPending(record, true);
        } catch (error) {
          var retryRecord = journal();
          if (retryRecord && retryRecord.state === 'PENDING' && retryRecord.command === 'payment.batch' && !retryRecord.last_error) {
            try {
              // ACK may have been lost. Replay the exact batch and child
              // operation_ids once after the mandatory remote authority check.
              batchReceipt = await sendPending(retryRecord, false);
            } catch (retryError) {
              return {
                ok: false,
                pending_unresolved: true,
                rejected: false,
                failed_index: offset,
                error: String(retryError && retryError.message || retryError || 'CANONICAL_FINANCIAL_PENDING'),
                receipts: receipts.slice()
              };
            }
          } else {
            return {
              ok: false,
              pending_unresolved: false,
              rejected: true,
              failed_index: offset,
              error: String(error && error.message || error || 'CANONICAL_FINANCIAL_REJECTED'),
              receipts: receipts.slice()
            };
          }
        }

        if (!batchReceipt || !Array.isArray(batchReceipt.receipts) || batchReceipt.receipts.length !== payments.length) {
          return {
            ok: false, pending_unresolved: true, rejected: false, failed_index: offset,
            error: 'INVALID_CANONICAL_BATCH_RECEIPT', receipts: receipts.slice()
          };
        }
        receipts.push.apply(receipts, batchReceipt.receipts.map(copy));
      }

      return { ok: true, receipts: receipts.slice() };
    });
  }

  function createProduct(input) { return createCommand('product.create', input); }
  function updateProduct(input) { return createCommand('product.update', input); }
  function setCustomerContact(input){return createCommand('customer.contact.set',input);}
  function createCustomer(input) { return createCommand('customer.create', input); }
  function setCustomerCreditPolicy(input) { return createCommand('customer.credit-policy.set', input, true); }
  function adjustInventory(input) { return createCommand('inventory.adjust', input); }
  function createCreditAccount(input) { return createCommand('credit-account.create', input); }
  function createPayment(input) { return createCommand('payment.create', input); }
  function openCash(input) { return createCommand('cash.open', input); }
  function closeCash(input) { return createCommand('cash.close', input); }
  function createAdjustment(input) { return createCommand('adjustment.create', input); }
  function createExpense(input) { return createCommand('expense.create', input); }
  function createCompensation(input) { return createCommand('compensation.create', input); }
  async function retryPending() {
    return withWriterLock(async function () {
      var record = journal();
      if (!record || record.state !== 'PENDING') fail('NO_CANONICAL_FINANCIAL_PENDING');
      return sendPending(record);
    });
  }
  // Generic exit for any non-sale command that CANON rejected definitively
  // (4xx except 429: nothing was committed). The full record is archived and
  // the single journal slot is freed, so a failed cash.open, egreso, gasto,
  // abono or inventory movement never freezes sales or the cash close.
  var COMMAND_LABELS = { 'cash.open': 'abrir caja', 'cash.close': 'cerrar caja', 'adjustment.create': 'movimiento de caja', 'expense.create': 'gasto',
    'payment.create': 'abono', 'payment.batch': 'abonos', 'compensation.create': 'compensación', 'inventory.adjust': 'movimiento de inventario',
    'product.create': 'producto nuevo', 'customer.create': 'cliente nuevo', 'customer.contact.set': 'datos del cliente',
    'customer.credit-policy.set': 'línea de crédito', 'credit-account.create': 'cuenta de crédito' };
  async function releaseRejectedFinancial(operationId) {
    return withWriterLock(function () {
      var record = journal();
      if (!record || record.state !== 'PENDING' || record.command === 'sale.create' || !record.payload ||
          (operationId !== undefined && operationId !== null && record.payload.operation_id !== operationId)) return false;
      if (!(record.last_status >= 400 && record.last_status < 500 && record.last_status !== 429) || !record.last_error) return false;
      var key = 'na_canonical_rejected_operations', archive = stored(key);
      if (archive === null) archive = [];
      if (!Array.isArray(archive)) fail('INVALID_CANONICAL_REJECTED_ARCHIVE');
      if (!archive.some(function (item) { return item && item.payload && item.payload.operation_id === record.payload.operation_id; }))
        archive.push(Object.assign(copy(record), { released_at: new Date().toISOString() }));
      var raw = JSON.stringify(archive.slice(-100));
      root.localStorage.setItem(key, raw);
      if (root.localStorage.getItem(key) !== raw) fail('CANONICAL_STORAGE_NOT_DURABLE');
      root.localStorage.removeItem(JOURNAL);
      if (root.localStorage.getItem(JOURNAL) !== null) fail('CANONICAL_STORAGE_NOT_DURABLE');
      ready = false; saleOnlyReady = false;
      try {
        var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
        if (runtime && typeof runtime.notify === 'function') runtime.notify('CANON rechazó «' + (COMMAND_LABELS[record.command] || record.command) + '» (' + record.last_error +
          '). No se aplicó nada; revisa y vuelve a registrarlo si corresponde. Las ventas siguen funcionando.', 'error');
      } catch (_) {}
      return true;
    });
  }
  // C-P0-1: a cash/expense/payment operation stranded in the single journal
  // must never freeze the POS. A definitive 4xx proves nothing committed: it is
  // archived and released. A lost ACK / 429 / 5xx is replayed with the SAME
  // operation_id (idempotent). Sales and the close keep their own recovery.
  async function settleStrandedFinancial() {
    var record = journal();
    if (!record || record.state !== 'PENDING' || !record.payload || record.command === 'sale.create' || record.command === 'cash.close') return null;
    var operationId = record.payload.operation_id;
    if (record.last_error && record.last_status >= 400 && record.last_status < 500 && record.last_status !== 429)
      return (await releaseRejectedFinancial(operationId)) ? { status: 'RELEASED', command: record.command, operation_id: operationId } : null;
    var receipt = await retryPending();
    return { status: 'REPLAYED', command: record.command, operation_id: operationId, receipt: receipt };
  }
  async function releaseRejectedCashClose() {
    return withWriterLock(function () {
      var record = journal();
      // Only this explicit business rejection proves that no closure committed.
      // Unknown ACKs, 5xx, other commands and authority changes must retain their intent.
      if (!record || record.state !== 'PENDING' || record.command !== 'cash.close' ||
          record.last_status !== 409 || record.last_error !== 'stale_session') return null;
      assertAction('cash.close');
      assertBinding(record.binding);
      var session = (data.cashSessions || []).find(function (item) { return item.session_id === record.payload.session_id; });
      if (!session || !['OPEN', 'CLOSED'].includes(session.status)) fail('INVALID_CANONICAL_CASH_SESSION');
      var key = 'na_canonical_cash_close_rejections', archive = stored(key);
      if (archive === null) archive = [];
      if (!Array.isArray(archive)) fail('INVALID_CANONICAL_CASH_ARCHIVE');
      if (!archive.some(function (item) { return item && item.payload && item.payload.operation_id === record.payload.operation_id; })) archive.push(copy(record));
      var raw = JSON.stringify(archive);
      root.localStorage.setItem(key, raw);
      if (root.localStorage.getItem(key) !== raw) fail('CANONICAL_STORAGE_NOT_DURABLE');
      root.localStorage.removeItem(JOURNAL);
      if (root.localStorage.getItem(JOURNAL) !== null) fail('CANONICAL_STORAGE_NOT_DURABLE');
      return { session_id: session.session_id, status: session.status };
    });
  }
  async function discardRejectedPayment() {
    return withWriterLock(function () {
      var record = journal();
      if (!record || record.state !== 'PENDING' || !['payment.create','payment.batch'].includes(record.command)) return false;
      // 400/409 are definitive business/request rejections from the Worker.
      // D1 commits are atomic, so these statuses mean this pending intent did
      // not create a new payment. Transport/storage uncertainty (5xx/no ACK)
      // must remain pending and can only be replayed with the same operation_id.
      if (![400,409].includes(record.last_status) || !record.last_error) return false;
      root.localStorage.removeItem(JOURNAL);
      if (root.localStorage.getItem(JOURNAL) !== null) fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }

  async function discardRejectedProduct() {
    return withWriterLock(function () {
      var record=journal();
      if(!record || record.state!=='PENDING' || !['product.create','product.update'].includes(record.command)) return false;
      var safeErrors=['invalid_product_request','invalid_product_update','duplicate_product_code','product_id_conflict','product_code_conflict','product_not_found','stale_product','product_update_schema_not_ready','operation_id_conflict','stale_authority','canonical_not_active','canonical_product_conflict'];
      // A Worker without product.update (404 not_found) or without its table
      // (503) wrote nothing, so the edit intent can be dropped safely.
      var missingUpdate=record.command==='product.update'&&(record.last_status===404&&['not_found','HTTP_404'].includes(record.last_error)||record.last_status===503&&record.last_error==='product_update_schema_not_ready');
      if(!missingUpdate && (![400,409].includes(record.last_status) || !safeErrors.includes(record.last_error))) return false;
      root.localStorage.removeItem(JOURNAL);
      if(root.localStorage.getItem(JOURNAL)!==null) fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }
  async function discardRejectedCustomer() {
    return withWriterLock(function () {
      var record=journal();
      if(!record||record.state!=='PENDING'||record.command!=='customer.create')return false;
      var safeErrors=['invalid_customer_request','invalid_customer_document','invalid_customer_phone','customer_phone_conflict','customer_id_conflict','customer_document_conflict','operation_id_conflict','stale_authority','canonical_not_active','canonical_customer_conflict'];
      if(![400,409].includes(record.last_status)||!safeErrors.includes(record.last_error))return false;
      root.localStorage.removeItem(JOURNAL);
      if(root.localStorage.getItem(JOURNAL)!==null)fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }
  async function discardRejectedCustomerContact(){
    return withWriterLock(function(){const r=journal();if(!r||r.state!=='PENDING'||r.command!=='customer.contact.set'||![400,409].includes(r.last_status)||!['invalid_customer_contact','customer_not_found','stale_contact','operation_id_conflict','stale_authority','customer_contact_conflict','customer_phone_conflict'].includes(r.last_error))return false;root.localStorage.removeItem(JOURNAL);if(root.localStorage.getItem(JOURNAL)!==null)fail('CANONICAL_STORAGE_NOT_DURABLE');return true;});
  }
  async function discardRejectedCustomerCreditPolicy() {
    return withWriterLock(function () {
      var record=journal();
      if(!record||record.state!=='PENDING'||record.command!=='customer.credit-policy.set')return false;
      var safeErrors=['invalid_customer_credit_policy','customer_not_found','stale_policy','operation_id_conflict','stale_authority','canonical_not_active','customer_credit_policy_conflict'];
      if(![400,409].includes(record.last_status)||!safeErrors.includes(record.last_error))return false;
      root.localStorage.removeItem(JOURNAL);
      if(root.localStorage.getItem(JOURNAL)!==null)fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }
  async function discardRejectedInventory() {
    return withWriterLock(function () {
      var record=journal();
      if(!record||record.state!=='PENDING'||record.command!=='inventory.adjust')return false;
      var safeErrors=['invalid_inventory_request','product_not_found','product_inventory_disabled','stale_stock','insufficient_stock','invalid_stock_state','operation_id_conflict','stale_authority','canonical_not_active','canonical_inventory_conflict'];
      if(![400,404,409].includes(record.last_status)||!safeErrors.includes(record.last_error))return false;
      root.localStorage.removeItem(JOURNAL);
      if(root.localStorage.getItem(JOURNAL)!==null)fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }
  async function discardRejectedSale() {
    return withWriterLock(function () {
      var record = journal();
      if (!record || record.state !== 'PENDING' || record.command !== 'sale.create') return false;
      // 400/409 are definitive Worker rejections. D1 sale.create is atomic, so
      // these statuses prove this pending intent did not commit a sale/mov/stock.
      // Transport uncertainty (5xx / lost ACK) must stay pending for same operation_id replay.
      var safeErrors = ['stale_stock', 'insufficient_stock', 'stock_revision_conflict', 'invalid_sale_request', 'product_not_found', 'operation_id_conflict', 'sale_id_conflict', 'stale_authority', 'canonical_not_active', 'canonical_sale_conflict', 'cash_session_required', 'cash_session_closed', 'credit_limit_exceeded'];
      if (![400, 404, 409].includes(record.last_status) || !safeErrors.includes(record.last_error)) return false;
      root.localStorage.removeItem(JOURNAL);
      if (root.localStorage.getItem(JOURNAL) !== null) fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }
  // The durable intent and a full copy of this journal were already saved in
  // the sale quarantine. Free the single financial slot for a definitive 4xx
  // (never 429/5xx, never another operation) so the POS keeps working.
  async function releaseRejectedSaleJournal(operationId) {
    return withWriterLock(function () {
      var record = journal();
      if (!record || record.state !== 'PENDING' || record.command !== 'sale.create' || !record.payload || record.payload.operation_id !== operationId) return false;
      if (!(record.last_status >= 400 && record.last_status < 500 && record.last_status !== 429) || !record.last_error) return false;
      root.localStorage.removeItem(JOURNAL);
      if (root.localStorage.getItem(JOURNAL) !== null) fail('CANONICAL_STORAGE_NOT_DURABLE');
      return true;
    });
  }
  function renderCredits(container) {
    container.replaceChildren(); container.style.overflowWrap = 'anywhere';
    var current = snapshot();
    current.credits.forEach(function (credit) {
      var customer = current.customers.find(function (item) { return item.customer_id === credit.customer_id; });
      var article = document.createElement('article'), title = document.createElement('h3'), balance = document.createElement('p');
      title.textContent = (customer ? customer.name : credit.customer_id) + ' / ' + credit.credit_id + ' | ' + (credit.provenance === 'LIVE' ? 'LIVE' : 'IMPORT');
      balance.textContent = 'Saldo: S/ ' + (credit.current_balance_cents / 100).toFixed(2); article.append(title, balance);
      current.payments.filter(function (item) { return item.credit_id === credit.credit_id; }).forEach(function (payment) {
        var row = document.createElement('p');
        var date = payment.date_precision === 'UNKNOWN' ? 'fecha desconocida' : payment.date_precision === 'TIMESTAMP' ? payment.payment_date + ' / ' + payment.payment_timestamp : payment.payment_date;
        row.textContent = (payment.source_payment_id || payment.payment_id) + ' | S/ ' + (payment.amount_cents / 100).toFixed(2) + ' | ' + date + (payment.method ? ' | ' + payment.method : ''); article.append(row);
      });
      container.append(article);
    });
  }
  function renderSale(container, setStatus) {
    container.replaceChildren();
    var form = document.createElement('form'), product = document.createElement('select'), quantity = document.createElement('input');
    var method = document.createElement('select'), customer = document.createElement('select'), due = document.createElement('input');
    var cash = document.createElement('input'), digital = document.createElement('select'), reference = document.createElement('input');
    var submit = document.createElement('button'), retry = document.createElement('button'), reload = document.createElement('button'), result = document.createElement('p'), total = document.createElement('p');
    snapshot().products.forEach(function (item) { var option = document.createElement('option'); option.value = item.product_id; option.textContent = item.name + ' | S/ ' + (item.price_cents / 100).toFixed(2) + ' | stock ' + String(item.current_stock_quantity); product.append(option); });
    METHODS.forEach(function (value) { var option = document.createElement('option'); option.value = value; option.textContent = value; method.append(option); });
    var blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Cliente'; customer.append(blank);
    snapshot().customers.forEach(function (item) { var option = document.createElement('option'); option.value = item.customer_id; option.textContent = item.name; customer.append(option); });
    ['yape', 'plin', 'transferencia'].forEach(function (value) { var option = document.createElement('option'); option.value = value; option.textContent = value; digital.append(option); });
    quantity.type = 'number'; quantity.min = '0.001'; quantity.step = 'any'; quantity.value = '1'; quantity.required = true;
    due.type = 'date'; cash.type = 'number'; cash.min = '1'; cash.step = '1'; cash.placeholder = 'Efectivo mixto (centimos)'; reference.placeholder = 'Referencia digital';
    submit.type = 'submit'; submit.textContent = 'Registrar venta'; retry.type = 'button'; retry.textContent = 'Reintentar operacion pendiente';
    reload.type = 'button'; reload.textContent = 'Actualizar datos canonicos';
    form.style.cssText = 'display:grid;gap:10px;max-width:560px;min-width:0';
    [['Producto', product], ['Cantidad', quantity], ['Metodo de pago', method], ['Cliente (obligatorio para credito)', customer], ['Vencimiento del credito', due],
      ['Efectivo mixto en centimos', cash], ['Metodo digital mixto', digital], ['Referencia', reference]].forEach(function (entry) {
      var label = document.createElement('label'); label.textContent = entry[0]; label.style.cssText = 'display:grid;gap:4px;min-width:0';
      entry[1].style.cssText = 'width:100%;min-width:0;max-width:100%;box-sizing:border-box'; label.append(entry[1]); form.append(label);
    });
    form.append(total, submit, retry, reload, result); container.append(form);
    function showTotal() {
      var picked = snapshot().products.find(function (item) { return item.product_id === product.value; });
      var cents = picked && Math.round(picked.price_cents * Number(quantity.value));
      total.textContent = Number.isSafeInteger(cents) && cents > 0 ? 'Total: S/ ' + (cents / 100).toFixed(2) : 'Total no valido';
    }
    product.addEventListener('change', showTotal); quantity.addEventListener('input', showTotal); showTotal();
    function showStored() {
      try {
        var record = journal(), pending = record && record.state === 'PENDING';
        retry.hidden = !pending; submit.disabled = !!pending || !ready || !data || data.mode !== 'ACTIVE';
        result.textContent = recordText(record);
      } catch (_) { submit.disabled = true; retry.disabled = true; result.textContent = 'Almacenamiento no verificable. Operaciones bloqueadas.'; }
    }
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); submit.disabled = true;
      try {
        var receipt = await createSale({ items: [{ product_id: product.value, quantity: Number(quantity.value) }], payment_method: method.value,
          customer_id: customer.value, credit_due: due.value, cash_cents: Number(cash.value), digital_method: digital.value, reference: reference.value });
        setStatus('Venta confirmada: ' + receipt.sale_id); await refresh(); renderSale(container, setStatus);
      } catch (error) { setStatus(String(error.message || error)); }
      showStored();
    });
    retry.addEventListener('click', async function () {
      retry.disabled = true;
      try { var receipt = await retryPending(); setStatus('Operacion confirmada: ' + receipt.operation_id); await refresh(); renderSale(container, setStatus); }
      catch (error) { setStatus(String(error.message || error)); }
      retry.disabled = false; showStored();
    });
    reload.addEventListener('click', async function () {
      reload.disabled = true;
      try { await refresh(); setStatus(data.mode + ' | ' + CONTRACT); renderSale(container, setStatus); }
      catch (error) { setStatus(String(error.message || error)); }
      reload.disabled = false; showStored();
    });
    showStored();
  }
  function recordText(record) {
    if (!record) return '';
    return (record.state === 'PENDING' ? 'PENDING | ' : 'Confirmada | ') + record.command + ' | ' + record.payload.operation_id +
      (record.last_error ? ' | ' + record.last_error : '') + (record.state === 'PENDING' ? ' | Reintento manual; no crear otra operacion.' : ' | ' + record.receipt.status);
  }
  function renderFinancial(container, setStatus, tab) {
    container.replaceChildren();
    var current = snapshot(), forms = [], busy = false;
    var result = document.createElement('p'), retry = document.createElement('button'), reload = document.createElement('button');
    result.setAttribute('role', 'status'); retry.type = reload.type = 'button';
    retry.textContent = 'Reintentar operacion pendiente'; reload.textContent = 'Actualizar datos canonicos';
    function field(labelText, type, options) {
      var label = document.createElement('label'), input = document.createElement(options ? 'select' : 'input');
      label.textContent = labelText; label.style.cssText = 'display:grid;gap:4px;min-width:0';
      input.style.cssText = 'width:100%;min-width:0;max-width:100%;box-sizing:border-box';
      if (options) options.forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; input.append(option); });
      else { input.type = type; if (type === 'number') { input.step = '1'; input.required = true; } }
      label.append(input); return { label: label, input: input };
    }
    function form(title, fields, action) {
      var node = document.createElement('form'), heading = document.createElement('h3'), submit = document.createElement('button');
      node.style.cssText = 'display:grid;gap:10px;max-width:560px;min-width:0'; heading.textContent = title;
      submit.type = 'submit'; submit.textContent = title; node.append(heading);
      fields.forEach(function (item) { node.append(item.label); }); node.append(submit); container.append(node); forms.push(submit);
      node.addEventListener('submit', async function (event) { event.preventDefault(); if (busy) return; await run(action); });
    }
    function update() {
      try {
        var record = journal(), pending = record && record.state === 'PENDING';
        result.textContent = recordText(record); retry.hidden = !pending; retry.disabled = busy;
        forms.forEach(function (button) { button.disabled = busy || !!pending || !ready || !data || data.mode !== 'ACTIVE'; });
      } catch (_) { forms.forEach(function (button) { button.disabled = true; }); retry.disabled = true; result.textContent = 'Almacenamiento no verificable. Operaciones bloqueadas.'; }
      reload.disabled = busy;
    }
    async function run(action) {
      busy = true; update();
      try { var receipt = await action(); setStatus('Operacion confirmada: ' + receipt.operation_id); await refresh(); renderFinancial(container, setStatus, tab); }
      catch (error) { setStatus(String(error.message || error)); }
      finally { busy = false; update(); }
    }
    if (tab === 'payment') {
      var credit = field('Credito / procedencia / saldo', null, current.credits.map(function (item) { return [item.credit_id, item.credit_id + ' | ' + item.provenance + ' | S/ ' + (item.current_balance_cents / 100).toFixed(2)]; }));
      var amount = field('Abono en centimos', 'number'), method = field('Metodo de abono', null, FINANCIAL_METHODS.map(function (item) { return [item, item]; })), reference = field('Referencia (opcional)', 'text');
      amount.input.min = '1';
      form('Registrar abono', [credit, amount, method, reference], function () { return createPayment({ credit_id: credit.input.value, amount_cents: Number(amount.input.value), payment_method: method.input.value, reference: reference.input.value }); });
    } else {
      (current.cashSessions || []).forEach(function (item) { var row = document.createElement('p'); row.textContent = item.session_id + ' | ' + item.status + ' | Esperado S/ ' + (item.expected_cents / 100).toFixed(2); container.append(row); });
      var opening = field('Apertura en centimos', 'number'); opening.input.min = '0';
      form('Abrir caja', [opening], function () { return openCash({ session_id: root.crypto.randomUUID(), opening_cents: Number(opening.input.value) }); });
      var counted = field('Contado en centimos', 'number'); counted.input.min = '0';
      form('Cerrar caja', [counted], function () { return closeCash({ counted_cents: Number(counted.input.value) }); });
      var adjustment = field('Ajuste en centimos (+ entrada / - salida)', 'number'), reason = field('Motivo del ajuste', 'text'); reason.input.required = true;
      form('Registrar ajuste', [adjustment, reason], function () { return createAdjustment({ amount_cents: Number(adjustment.input.value), reason: reason.input.value }); });
      var target = field('Operacion a compensar', null, (current.financialEvents || []).filter(function (item) {
        return ['PAYMENT', 'ADJUSTMENT'].includes(item.event_type) && !current.financialEvents.some(function (other) { return other.compensates_operation_id === item.operation_id; });
      }).map(function (item) { return [item.operation_id, item.event_type + ' | ' + item.operation_id + ' | Caja ' + item.cash_delta_cents + ' | Credito ' + item.credit_delta_cents + ' centimos']; }));
      var compensationReason = field('Motivo de la compensacion', 'text'); compensationReason.input.required = true;
      form('Registrar compensacion', [target, compensationReason], function () { return createCompensation({ compensates_operation_id: target.input.value, reason: compensationReason.input.value }); });
    }
    retry.addEventListener('click', function () { if (!busy) return run(retryPending); });
    reload.addEventListener('click', async function () {
      if (busy) return; busy = true; update();
      try { await refresh(); renderFinancial(container, setStatus, tab); setStatus(data.mode + ' | ' + CONTRACT); }
      catch (error) { setStatus(String(error.message || error)); }
      finally { busy = false; update(); }
    });
    container.append(result, retry, reload); update();
  }
  async function startPOS() {
    if (!enabled()) return null;
    warm();
    var cached = await localReplica();
    if (cached) {
      publishReplica(cached, 'cache');
      // Start the revalidation (its requests leave now) before rendering the cached view.
      bootCache = cached;
      var validating = refresh();
      validating.catch(function () { replicaState.validation = root.navigator.onLine === false ? 'offline' : 'stale'; notifyReplicaUpdate(); }); // online 500 => 'stale': auto-retried
      notifyReplicaUpdate();
      return snapshot();
    }
    return refresh();
  }
  function legacySnapshot() {
    if (!data || data.authority !== 'canonical') fail('CANONICAL_SNAPSHOT_UNAVAILABLE');
    var adapter = root.NuevoAmanecerCanonicalUIAdapter;
    if (!adapter || typeof adapter.snapshot !== 'function') fail('CANONICAL_UI_ADAPTER_UNAVAILABLE');
    return adapter.snapshot(data);
  }
  root.addEventListener('storage', function (event) { if (event.key === KEY || event.key === CREDENTIALS_KEY || event.key === null) { changed = true; ready = false; saleOnlyReady = false; } });
  root.addEventListener('offline', function () { ready = false; saleOnlyReady = false; });
  root.NuevoAmanecerCanonical = Object.freeze({ CONTRACT: CONTRACT, enabled: enabled, configure: configure, refresh: refresh, prepareCommand: prepareCommand, snapshot: snapshot,
    pendingSnapshot: pendingSnapshot, receiptSnapshot: receiptSnapshot, assertAction: assertAction, createSale: createSale, retryPending: retryPending, releaseRejectedCashClose: releaseRejectedCashClose, discardRejectedPayment: discardRejectedPayment, discardRejectedProduct: discardRejectedProduct, discardRejectedCustomer: discardRejectedCustomer, discardRejectedCustomerContact: discardRejectedCustomerContact, discardRejectedCustomerCreditPolicy: discardRejectedCustomerCreditPolicy, discardRejectedInventory: discardRejectedInventory, discardRejectedSale: discardRejectedSale, releaseRejectedSaleJournal: releaseRejectedSaleJournal, releaseRejectedFinancial: releaseRejectedFinancial, settleStrandedFinancial: settleStrandedFinancial,
    createProduct: createProduct, updateProduct: updateProduct, createCustomer: createCustomer, setCustomerContact: setCustomerContact, setCustomerCreditPolicy: setCustomerCreditPolicy, adjustInventory: adjustInventory, createCreditAccount: createCreditAccount, createPayment: createPayment, createPaymentBatch: createPaymentBatch, openCash: openCash, closeCash: closeCash, createAdjustment: createAdjustment, createCompensation: createCompensation, createExpense: createExpense,
    renderCredits: renderCredits, startPOS: startPOS, warm: warm, legacySnapshot: legacySnapshot, sourceState: sourceState });
})(globalThis);
