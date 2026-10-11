(function (root) {
  'use strict';

  var VERSION = 1;
  var KEY = 'na_canonical_sale_outbox_v1';
  var LOCK = 'na-canonical-sale-outbox';
  var FORBIDDEN = new Set(['token', 'credential', 'device_credential', 'deviceCredential', 'readToken', 'promotion_id', 'authority_epoch', 'expected_control_revision', 'expected_stock_revision', 'device_id']);

  function fail(code) { var error = new Error(code); error.code = code; throw error; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function rejectForbidden(value, seen) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) fail('INTENT_CIRCULAR');
    seen.add(value);
    Object.keys(value).forEach(function (key) { if (FORBIDDEN.has(key)) fail('INTENT_FORBIDDEN_KEY'); rejectForbidden(value[key], seen); });
    seen.delete(value);
  }
  function validateIntent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION) fail('INTENT_VERSION_INVALID');
    rejectForbidden(value, new Set());
    var builder = root.NuevoAmanecerCanonicalSaleIntent;
    if (!builder || builder.VERSION !== VERSION || typeof builder.build !== 'function') fail('SALE_INTENT_UNAVAILABLE');
    var intent = builder.build(value);
    if (intent.version !== VERSION || intent.operation_id !== value.operation_id || intent.sale_id !== value.sale_id || intent.created_at !== value.created_at) fail('INTENT_IDENTITY_CHANGED');
    return clone(intent);
  }
  function parseStored() {
    var raw;
    try { raw = root.localStorage.getItem(KEY); } catch (_) { fail('OUTBOX_STORAGE_READ_FAILED'); }
    if (raw === null) return { version: VERSION, intents: [] };
    var data;
    try { data = JSON.parse(raw); } catch (_) { fail('OUTBOX_CORRUPT'); }
    if (!data || data.version !== VERSION || !Array.isArray(data.intents) ||
        data.last_sale_number !== undefined && (!Number.isSafeInteger(data.last_sale_number) || data.last_sale_number < 0)) fail('OUTBOX_CORRUPT');
    var seen = new Set();
    try {
      data.intents.forEach(function (item) {
        if (!item || typeof item !== 'object' || item.version !== VERSION) fail('OUTBOX_CORRUPT');
        rejectForbidden(item, new Set());
        var canonical = validateIntent(item);
        if (JSON.stringify(canonical) !== JSON.stringify(item) || seen.has(item.operation_id)) fail('OUTBOX_CORRUPT');
        seen.add(item.operation_id);
      });
    } catch (_) { fail('OUTBOX_CORRUPT'); }
    return data;
  }
  function write(data) {
    var serialized = JSON.stringify(data);
    try { root.localStorage.setItem(KEY, serialized); } catch (_) { fail('OUTBOX_STORAGE_WRITE_FAILED'); }
    var readback;
    try { readback = root.localStorage.getItem(KEY); } catch (_) { fail('OUTBOX_STORAGE_READBACK_FAILED'); }
    if (readback !== serialized) fail('OUTBOX_STORAGE_READBACK_MISMATCH');
    return data;
  }
  async function withLock(work) {
    var locks = root.navigator && root.navigator.locks;
    if (!locks || typeof locks.request !== 'function') fail('WEB_LOCKS_UNAVAILABLE');
    return locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, function (lock) {
      if (!lock) fail('BUSY');
      return work();
    });
  }
  function snapshot() { var current = parseStored(); return clone(current); }
  function matching(value, intent) { return !!value && value.operation_id === intent.operation_id && value.sale_id === intent.sale_id; }
  function removeHead(expected) {
    var current = parseStored();
    if (!current.intents.length || current.intents[0].operation_id !== expected.operation_id) fail('OUTBOX_HEAD_CHANGED');
    var number = /^V-(\d+)$/.exec(expected.sale_id);
    if (number) current.last_sale_number = Math.max(current.last_sale_number || 0, Number(number[1]));
    current.intents.shift();
    write(current);
  }
  function result(status, processed, remaining, reason) {
    var out = { status: status, processed: processed, remaining: remaining };
    if (reason) out.reason = reason;
    return out;
  }
  async function syncLocked() {
    var processed = 0;
    while (true) {
      var current = parseStored();
      if (!current.intents.length) return result(processed ? 'DRAINED' : 'EMPTY', processed, 0);
      var head = current.intents[0];
      if (current.intents.some(function (item, index) { return index > 0 && item.sale_id === head.sale_id; }))
        return result('BLOCKED_DUPLICATE_SALE_ID', processed, current.intents.length, 'DUPLICATE_SALE_ID');
      var canonical = root.NuevoAmanecerCanonical;
      if (!canonical || typeof canonical.receiptSnapshot !== 'function' || typeof canonical.pendingSnapshot !== 'function' || typeof canonical.refresh !== 'function' || typeof canonical.createSale !== 'function' || typeof canonical.retryPending !== 'function') fail('CANONICAL_API_UNAVAILABLE');
      var receipt = canonical.receiptSnapshot();
      if (matching(receipt, head)) { removeHead(head); processed += 1; continue; }
      var pending = canonical.pendingSnapshot();
      if (pending) {
        var payload = pending.payload;
        if (pending.command !== 'sale.create' || !payload || payload.operation_id !== head.operation_id || payload.sale_id !== head.sale_id) return result('BLOCKED_FOREIGN_PENDING', processed, current.intents.length, 'FOREIGN_PENDING');
        if (pending.last_error && (pending.last_status === 429 || pending.last_status >= 500)) {
          // A 429/5xx is not evidence that the sale did not commit. The
          // previous acknowledgement may be lost: retry only the exact
          // durable operation_id and rely on the server idempotency contract.
          try { await canonical.retryPending(); }
          catch (error) {
            return result('WAITING', processed, current.intents.length,
              String(error && (error.code || error.message) || 'RETRY_FAILED'));
          }
          if (!matching(canonical.receiptSnapshot(), head))
            return result('WAITING', processed, current.intents.length, 'RECEIPT_NOT_CONFIRMED');
          removeHead(head); processed += 1; continue;
        }
        if (pending.last_error) {
          // Safe sale rejects (409/400) prove no D1 commit. Clear journal and
          // rebuild createSale with fresh ESR (same operation_id), or drop the
          // head when the Worker still rejects — never freeze the whole drain.
          var rejectReason = String(pending.last_error);
          var discarded = false;
          if (typeof canonical.discardRejectedSale === 'function') {
            try { discarded = await canonical.discardRejectedSale(); } catch (_) { discarded = false; }
          }
          if (!discarded) return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason);
          var recoverable = rejectReason === 'stale_stock' || rejectReason === 'stock_revision_conflict';
          if (recoverable) {
            try {
              if (typeof canonical.refresh === 'function') await canonical.refresh();
              await canonical.createSale(head);
            } catch (error) {
              var afterRetry = canonical.pendingSnapshot();
              if (afterRetry && afterRetry.command === 'sale.create' && afterRetry.payload &&
                  afterRetry.payload.operation_id === head.operation_id && afterRetry.payload.sale_id === head.sale_id && afterRetry.last_error) {
                var retryDiscarded = false;
                try {
                  if (typeof canonical.discardRejectedSale === 'function') retryDiscarded = await canonical.discardRejectedSale();
                } catch (_) { retryDiscarded = false; }
                // Only a definitive allowlisted rejection may remove the durable
                // intent. 5xx/429/unknown ACK remains pending with the same
                // operation_id so a later replay cannot lose or duplicate a sale.
                if (!retryDiscarded) {
                  return result('WAITING', processed, parseStored().intents.length,
                    String(afterRetry.last_error || error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'));
                }
                removeHead(head);
                var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
                if (runtime && typeof runtime.notify === 'function') runtime.notify('Venta ' + head.sale_id + ' rechazada por CANON (' + rejectReason + '). No se descontó stock; vuelve a cobrarla.', 'error');
                if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
                continue;
              }
              return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'));
            }
            if (!matching(canonical.receiptSnapshot(), head)) return result('WAITING', processed, parseStored().intents.length, 'RECEIPT_NOT_CONFIRMED');
            removeHead(head); processed += 1; continue;
          }
          removeHead(head);
          var runtimeDrop = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
          if (runtimeDrop && typeof runtimeDrop.notify === 'function') runtimeDrop.notify('Venta ' + head.sale_id + ' rechazada por CANON (' + rejectReason + '). No se descontó stock.', 'error');
          if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
          continue;
        }
        try { await canonical.retryPending(); } catch (error) { return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'RETRY_FAILED')); }
        if (!matching(canonical.receiptSnapshot(), head)) return result('WAITING', processed, parseStored().intents.length, 'RECEIPT_NOT_CONFIRMED');
        removeHead(head); processed += 1; continue;
      }
      try {
        // createSale() owns freshness. With a current replica it can go straight
        // to the guarded POST; if the replica is stale it refreshes itself.
        // Do not force a full multi-collection refresh in front of every sale.
        await canonical.createSale(head);
      } catch (error) {
        var afterFailure = canonical.pendingSnapshot();
        if (afterFailure && afterFailure.command === 'sale.create' && afterFailure.payload && afterFailure.payload.operation_id === head.operation_id && afterFailure.payload.sale_id === head.sale_id) {
          // Safe 409/400 rejects leave last_error; loop again so discard+retry
          // runs in this same syncLocked pass instead of freezing until next sync.
          if (afterFailure.last_error) {
            // Do not immediately replay an uncertain 429/5xx inside the same
            // drain pass: let the bounded backoff schedule the next safe retry.
            if (afterFailure.last_status === 429 || afterFailure.last_status >= 500)
              return result('WAITING', processed, parseStored().intents.length, String(afterFailure.last_error));
            continue;
          }
          return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'));
        }
        if (afterFailure && (afterFailure.command !== 'sale.create' || !afterFailure.payload || afterFailure.payload.operation_id !== head.operation_id || afterFailure.payload.sale_id !== head.sale_id)) return result('BLOCKED_FOREIGN_PENDING', processed, parseStored().intents.length, 'FOREIGN_PENDING');
        return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'CREATE_FAILED'));
      }
      if (!matching(canonical.receiptSnapshot(), head)) return result('WAITING', processed, parseStored().intents.length, 'RECEIPT_NOT_CONFIRMED');
      removeHead(head); processed += 1;
    }
  }
  var syncing = null;
  var started = false;
  var retryTimer = null;
  var retryCount = 0;
  var resumeOutbox = null;
  var resuming = false;
  function scheduleResume() {
    if (!started || retryTimer !== null || root.navigator.onLine === false || typeof root.setTimeout !== 'function') return;
    // Do not abandon durable sales after three failures. Retry at a bounded
    // rate while the page is alive, without creating new operation IDs.
    var delay = Math.min(60000, 1000 * Math.pow(2, Math.min(retryCount, 6)));
    retryCount = Math.min(retryCount + 1, 7);
    retryTimer = root.setTimeout(function () { retryTimer = null; return resumeOutbox(); }, delay);
  }
  async function sync() {
    if (syncing) return result('WAITING', 0, snapshot().intents.length, 'BUSY');
    syncing = (async function () {
      try {
        var outcome = await withLock(syncLocked);
        // Receipt is already durable and the confirmed intent has been removed.
        // Return the commercial path immediately; reconciliation starts now but
        // is never allowed to hold the sale UI after the durable receipt.
        if (outcome.processed > 0) {
          Promise.resolve().then(function () { return root.NuevoAmanecerCanonical.refresh(); })
            .catch(function (error) { if (root.console) root.console.warn('[Venta CANON] Confirmada; reconciliación pendiente', error.code || error.message); });
        }
        if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
        if (outcome.status === 'WAITING' && outcome.reason !== 'BUSY') scheduleResume();
        else if (outcome.status === 'DRAINED' || outcome.status === 'EMPTY') retryCount = 0;
        return outcome;
      }
      catch (error) {
        if (error && error.code === 'BUSY') {
          scheduleResume();
          return result('WAITING', 0, snapshot().intents.length, 'BUSY');
        }
        throw error;
      }
    })();
    try { return await syncing; } finally { syncing = null; }
  }
  function start() {
    if (started) return;
    started = true;
    async function resume() {
      if (resuming || syncing || root.navigator.onLine === false) return;
      var canonical = root.NuevoAmanecerCanonical;
      if (canonical && typeof canonical.enabled === 'function' && canonical.enabled()) {
        var state = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
        if (!state || state.validation !== 'current') {
          if (state && ['stale','unavailable'].includes(state.validation) && typeof canonical.refresh === 'function') {
            try { await canonical.refresh(); state = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null; }
            catch (_) { scheduleResume(); return; }
          }
          if (!state || state.validation !== 'current') { scheduleResume(); return; }
        }
      }
      try { if (!snapshot().intents.length) return; } catch (_) { return; }
      resuming = true;
      try { await repairKnownTestPair(); return await sync(); }
      catch (error) {
        scheduleResume();
        if (root.console) root.console.error('[Venta CANON]', error.code || error.message);
      }
      finally { resuming = false; }
    }
    resumeOutbox = resume;
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('online', function () {
        retryCount = 0;
        var canonical = root.NuevoAmanecerCanonical;
        if (canonical && typeof canonical.enabled === 'function' && canonical.enabled() && typeof canonical.refresh === 'function') {
          var state = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
          if (!state || state.validation !== 'current') return canonical.refresh().catch(function () {});
        }
        return resume();
      });
      root.addEventListener('na:canonical-updated', resume);
    }
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', function () {
        if (!root.document.hidden) resume();
      });
    }
    return resume();
  }
  async function enqueue(input) {
    return withLock(function () {
      var intent = validateIntent(input), current = parseStored();
      if (current.intents.some(function (item) { return item.operation_id === intent.operation_id; })) fail('DUPLICATE_OPERATION_ID');
      // Recheck the reservation under the same cross-tab lock as durability.
      var canonical = root.NuevoAmanecerCanonical;
      var confirmed = canonical && typeof canonical.snapshot === 'function' ? canonical.snapshot().sales || [] : [];
      var receipt = canonical && typeof canonical.receiptSnapshot === 'function' ? canonical.receiptSnapshot() : null;
      var reserved = confirmed.concat(current.intents, receipt ? [receipt] : []);
      var match = /^V-(\d+)$/.exec(intent.sale_id);
      var max = reserved.reduce(function (value, sale) {
        var number = /^V-(\d+)$/.exec(String(sale.sale_id || sale.id || ''));
        return Math.max(value, number ? Number(number[1]) : 0);
      }, current.last_sale_number || 0);
      if (match) {
        var proposed = Number(match[1]);
        if (!Number.isSafeInteger(proposed) || !Number.isSafeInteger(max + 1)) fail('SALE_NUMBER_UNSAFE');
        var next = Math.max(proposed, max + 1);
        intent.sale_id = 'V-' + String(next).padStart(3, '0');
        // Retain the reservation even after the queue drains, a refresh fails,
        // or another financial command replaces the single receipt journal.
        current.last_sale_number = next;
      } else if (reserved.some(function (sale) { return (sale.sale_id || sale.id) === intent.sale_id; })) fail('DUPLICATE_SALE_ID');
      current.intents.push(intent);
      write(current);
      return clone(intent);
    });
  }
  function knownTestPair(current) {
    var pair = current.intents.filter(function (intent) { return intent.sale_id === 'V-001'; });
    return pair.length === 2 && pair.every(function (intent) { return intent.payment_method === 'efectivo'; }) &&
      pair.map(function (intent) { return intent.total_cents; }).sort(function (a, b) { return a - b; }).join(',') === '200,300'
      ? pair : null;
  }
  function archiveTests(current, intents, reason) {
    var key = KEY + '_rejected_tests';
    var archive = JSON.parse(root.localStorage.getItem(key) || '[]');
    if (!Array.isArray(archive)) fail('TEST_ARCHIVE_INVALID');
    intents.forEach(function (intent) {
      if (!archive.some(function (entry) { return entry.intent && entry.intent.operation_id === intent.operation_id; }))
        archive.push({ intent: clone(intent), reason: reason, rejected_at: new Date().toISOString() });
    });
    var raw = JSON.stringify(archive);
    root.localStorage.setItem(key, raw);
    if (root.localStorage.getItem(key) !== raw) fail('TEST_ARCHIVE_NOT_DURABLE');
    var selected = new Set(intents.map(function (intent) { return intent.operation_id; }));
    current.last_sale_number = Math.max(current.last_sale_number || 0, 1);
    current.intents = current.intents.filter(function (intent) { return !selected.has(intent.operation_id); });
    write(current);
  }
  async function repairKnownTestPair() {
    if (!knownTestPair(parseStored())) return;
    return withLock(async function () {
      var canonical = root.NuevoAmanecerCanonical;
      if (!canonical || typeof canonical.sourceState !== 'function' || typeof canonical.refresh !== 'function') return;
      await canonical.refresh();
      var current = parseStored(), pair = knownTestPair(current);
      if (!pair || canonical.sourceState().validation !== 'current' || canonical.pendingSnapshot()) return;
      var base = canonical.snapshot(), receipt = canonical.receiptSnapshot();
      if (pair.some(function (intent) {
        return matching(receipt, intent) || (base.sales || []).some(function (sale) { return sale.operation_id === intent.operation_id; });
      })) return;
      // The owner identified exactly this duplicate test pair and authorized its
      // loss. Archive both only with current authenticated proof of no commit.
      archiveTests(current, pair, 'DUPLICATE_SALE_ID');
      var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
      if (runtime) runtime.notify('Dos ventas de prueba inválidas se retiraron de las pendientes.', 'info');
    });
  }
  async function rejectInvalidTestIntent(operationId) {
    return withLock(async function () {
      var canonical = root.NuevoAmanecerCanonical;
      if (!canonical || typeof canonical.sourceState !== 'function' || typeof canonical.refresh !== 'function') fail('CANONICAL_API_UNAVAILABLE');
      await canonical.refresh();
      if (canonical.sourceState().validation !== 'current' || canonical.pendingSnapshot()) fail('TEST_INTENT_NOT_PROVEN_INVALID');
      var current = parseStored();
      var intent = current.intents.find(function (item) { return item.operation_id === operationId; });
      var base = canonical.snapshot();
      var receipt = canonical.receiptSnapshot();
      // Narrow owner-authorized test repair; never use the display conflict as
      // proof. Unknown ACK/journal, confirmed operations and other amounts fail.
      if (!intent || intent.sale_id !== 'V-001' || [200,300].indexOf(intent.total_cents) === -1 ||
          intent.payment_method !== 'efectivo' || matching(receipt, intent) ||
          (base.sales || []).some(function (sale) { return sale.operation_id === intent.operation_id; })) fail('TEST_INTENT_NOT_PROVEN_INVALID');
      var missing = intent.items.some(function (item) {
        return !item.generic_line && !base.products.some(function (product) { return product.product_id === item.product_id; });
      });
      var key = KEY + '_rejected_tests';
      var archive = JSON.parse(root.localStorage.getItem(key) || '[]');
      if (!Array.isArray(archive)) fail('TEST_ARCHIVE_INVALID');
      var duplicate = current.intents.some(function (item) { return item.operation_id !== intent.operation_id && item.sale_id === intent.sale_id; }) ||
        (base.sales || []).some(function (sale) { return sale.sale_id === intent.sale_id; }) ||
        archive.some(function (entry) { return entry.reason === 'DUPLICATE_SALE_ID' && entry.intent && entry.intent.sale_id === intent.sale_id && entry.intent.operation_id !== operationId; });
      if (!missing && !duplicate) fail('TEST_INTENT_NOT_PROVEN_INVALID');
      archiveTests(current, [intent], missing ? 'PRODUCT_NOT_FOUND' : 'DUPLICATE_SALE_ID');
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
      return { status: 'REJECTED_TEST_INTENT', operation_id: operationId };
    });
  }
  root.NuevoAmanecerCanonicalSaleOutbox = Object.freeze({ VERSION: VERSION, KEY: KEY, enqueue: enqueue, snapshot: snapshot, sync: sync, start: start, rejectInvalidTestIntent: rejectInvalidTestIntent });
})(globalThis);
