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
  // Sale quarantine: rejected or undeliverable sales leave the FIFO only after a
  // full durable copy is saved here. Entries are never deleted; they only
  // change status (QUARANTINED -> REQUEUED | CONFIRMED_REMOTE | ARCHIVED_NO_CHARGE).
  var QKEY = KEY + '_quarantine';
  var DETERMINISTIC = ['INVALID_CANONICAL_CUSTOMER', 'INVALID_CANONICAL_CREDIT', 'INVALID_CANONICAL_PRODUCT', 'INVALID_CANONICAL_ITEM',
    'INVALID_CANONICAL_GENERIC_LINE', 'INVALID_CANONICAL_TOTAL', 'UNSAFE_CANONICAL_TOTAL', 'INVALID_CANONICAL_PAYMENT', 'INVALID_CANONICAL_INTENT'];
  var CONFLICTS = ['operation_id_conflict', 'sale_id_conflict'];
  // Only rejections about THIS sale move it aside. System/session/cash-state
  // answers (401, 403, canonical_not_active, stale_authority, cash_session_*)
  // and unknown reasons keep the head in place and stop the drain (fail-closed).
  var SALE_REJECTIONS = ['product_not_found', 'insufficient_stock', 'invalid_sale_request', 'customer_not_found',
    'sale_id_conflict', 'operation_id_conflict', 'canonical_sale_conflict'];
  function readQuarantine() {
    var raw;
    try { raw = root.localStorage.getItem(QKEY); } catch (_) { fail('QUARANTINE_STORAGE_READ_FAILED'); }
    if (raw === null) return { version: VERSION, entries: [] };
    var data;
    try { data = JSON.parse(raw); } catch (_) { fail('QUARANTINE_CORRUPT'); }
    if (!data || data.version !== VERSION || !Array.isArray(data.entries)) fail('QUARANTINE_CORRUPT');
    return data;
  }
  function writeQuarantine(data) {
    var serialized = JSON.stringify(data);
    try { root.localStorage.setItem(QKEY, serialized); } catch (_) { fail('QUARANTINE_STORAGE_WRITE_FAILED'); }
    if (root.localStorage.getItem(QKEY) !== serialized) fail('QUARANTINE_STORAGE_NOT_DURABLE');
  }
  function quarantineSnapshot() { return clone(readQuarantine()); }
  // Owner rule: any unresolved quarantined sale keeps the cash close blocked
  // until it is reconciled (confirmed on the server or annulled as unregistered).
  // It never blocks sales, payments or expenses.
  function cashOf(intent) { return Number(intent && intent.payment && intent.payment.cash_cents) || 0; }
  function blockingQuarantine() { return readQuarantine().entries.filter(function (entry) { return entry.status === 'QUARANTINED'; }); }
  // Safe retry (same operation_id) only where the cause can clear by itself or
  // after a data fix; never for conflicts or malformed requests.
  // Explicit allowlist (fail-closed): causes that clear when the replica
  // catches up, stock arrives, or the missing customer/product is registered.
  var RETRYABLE = DETERMINISTIC.concat(['insufficient_stock', 'customer_not_found', 'product_not_found']);
  function retryable(reason) { return RETRYABLE.indexOf(reason) !== -1; }
  // Annul only when the absence proof can see the sale: the quarantined
  // command must carry a journal bound to the promotion that is active now
  // (the replica only lists that promotion's sales). No journal: no annul.
  function boundPromotion(entry) { var j = entry && entry.journal; return j && ((j.binding && j.binding.promotion_id) || (j.payload && j.payload.promotion_id)) || null; }
  function annullable(entry, canonical) {
    if (!entry || CONFLICTS.indexOf(entry.reason) !== -1) return false;
    var bound = boundPromotion(entry), snap = canonical && typeof canonical.snapshot === 'function' ? canonical.snapshot() || {} : {};
    return !!bound && bound === snap.promotion_id;
  }
  function quarantinedOperation(operationId) {
    return readQuarantine().entries.some(function (entry) { return entry.status === 'QUARANTINED' && entry.intent.operation_id === operationId; });
  }
  async function quarantineHead(canonical, head, reason, status) {
    // Needs the client release; older runtimes keep the sale blocked in place.
    if (typeof canonical.releaseRejectedSaleJournal !== 'function') return false;
    var pending = canonical.pendingSnapshot();
    var own = pending && pending.payload && pending.payload.operation_id === head.operation_id ? pending : null;
    var q = readQuarantine();
    if (!q.entries.some(function (entry) { return entry.intent.operation_id === head.operation_id && entry.status === 'QUARANTINED'; })) {
      q.entries = q.entries.filter(function (entry) { return !(entry.intent.operation_id === head.operation_id && entry.status === 'REQUEUED'); })
        .concat(q.entries.filter(function (entry) { return entry.intent.operation_id === head.operation_id && entry.status === 'REQUEUED'; })
          .map(function (entry) { entry.status = 'RETRY_REJECTED'; return entry; }));
      q.entries.push({ intent: clone(head), reason: String(reason), last_status: status || (own && own.last_status) || null, journal: own ? clone(own) : null,
        status: 'QUARANTINED', quarantined_at: new Date().toISOString() });
      writeQuarantine(q);
    }
    if (own) {
      var released = false;
      try { released = await canonical.releaseRejectedSaleJournal(head.operation_id); } catch (_) { released = false; }
      if (!released) return false;
    }
    removeHead(head);
    notifyReview(head, reason);
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
    return true;
  }
  function matching(value, intent) { return !!value && value.operation_id === intent.operation_id && value.sale_id === intent.sale_id; }
  function removeHead(expected) {
    var current = parseStored();
    if (!current.intents.length || current.intents[0].operation_id !== expected.operation_id) fail('OUTBOX_HEAD_CHANGED');
    var number = /^V-(\d+)$/.exec(expected.sale_id);
    if (number) current.last_sale_number = Math.max(current.last_sale_number || 0, Number(number[1]));
    current.intents.shift();
    write(current);
  }
  function result(status, processed, remaining, reason, head) {
    var out = { status: status, processed: processed, remaining: remaining };
    if (reason) out.reason = reason;
    if (head) { out.sale_id = head.sale_id; out.operation_id = head.operation_id; }
    if (status === 'BLOCKED_PENDING_REJECTED' && head) notifyReview(head, reason);
    return out;
  }
  // Tell the cashier once per operation_id (durable across reloads) that a
  // locally registered sale was rejected and is held for review. Never advise
  // charging again: the intent and its journal are preserved.
  var REVIEW_KEY = KEY + '_review_notified';
  function notifyReview(head, reason) {
    var seen = [];
    try { seen = JSON.parse(root.localStorage.getItem(REVIEW_KEY) || '[]'); if (!Array.isArray(seen)) seen = []; } catch (_) { seen = []; }
    if (seen.indexOf(head.operation_id) !== -1) return;
    try { root.localStorage.setItem(REVIEW_KEY, JSON.stringify(seen.concat([head.operation_id]).slice(-200))); } catch (_) {}
    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    if (runtime && typeof runtime.notify === 'function') runtime.notify('Venta ' + head.sale_id + ' en revisión: CANON la rechazó (' + reason +
      '). No la cobres de nuevo y no entregues el crédito hasta resolverla.', 'error');
  }
  // Server-side proof only: the refreshed replica already holds this exact
  // operation_id + sale_id. Missing API or failed refresh = not proven.
  async function confirmedRemotely(canonical, head) {
    if (typeof canonical.snapshot !== 'function' || typeof canonical.discardRejectedSale !== 'function') return false;
    try { await canonical.refresh(); } catch (_) { return false; }
    if (typeof canonical.sourceState === 'function') {
      var state = canonical.sourceState();
      if (!state || state.validation !== 'current') return false;
    }
    var sales = (canonical.snapshot() || {}).sales || [];
    return sales.some(function (sale) { return sale.operation_id === head.operation_id && (sale.sale_id || sale.id) === head.sale_id; });
  }
  async function syncLocked() {
    var processed = 0, refreshedFor = {};
    while (true) {
      var current = parseStored();
      if (!current.intents.length) return result(processed ? 'DRAINED' : 'EMPTY', processed, 0);
      var head = current.intents[0];
      if (quarantinedOperation(head.operation_id)) {
        // Crash between the quarantine copy and the FIFO removal: finish it.
        var stillOwn = root.NuevoAmanecerCanonical && typeof root.NuevoAmanecerCanonical.pendingSnapshot === 'function' && root.NuevoAmanecerCanonical.pendingSnapshot();
        if (!stillOwn || !stillOwn.payload || stillOwn.payload.operation_id !== head.operation_id) { removeHead(head); continue; }
      }
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
          var recoverable = rejectReason === 'stale_stock' || rejectReason === 'stock_revision_conflict';
          if (!recoverable) {
            // Owner rule 1: a non-stock rejection never removes the durable
            // intent nor its journal. Only a server-side record of this exact
            // operation_id may settle it; otherwise the head stays quarantined
            // in place and keeps blocking cash close with its real reason.
            if (await confirmedRemotely(canonical, head)) {
              var cleared = false;
              try { cleared = await canonical.discardRejectedSale(); } catch (_) { cleared = false; }
              if (!cleared) return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason, head);
              removeHead(head); processed += 1; continue;
            }
            if (SALE_REJECTIONS.indexOf(rejectReason) !== -1 && await quarantineHead(canonical, head, rejectReason, pending.last_status)) continue;
            return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason, head);
          }
          var discarded = false;
          if (typeof canonical.discardRejectedSale === 'function') {
            try { discarded = await canonical.discardRejectedSale(); } catch (_) { discarded = false; }
          }
          if (!discarded) return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason, head);
          {
            try {
              if (typeof canonical.refresh === 'function') await canonical.refresh();
              await canonical.createSale(head);
            } catch (error) {
              var afterRetry = canonical.pendingSnapshot();
              if (afterRetry && afterRetry.command === 'sale.create' && afterRetry.payload &&
                  afterRetry.payload.operation_id === head.operation_id && afterRetry.payload.sale_id === head.sale_id && afterRetry.last_error) {
                // The retry was rejected again. Keep intent + journal (same
                // operation_id); never ask the cashier to charge again here.
                var definitive = [400, 404, 409].indexOf(afterRetry.last_status) !== -1;
                if (definitive && SALE_REJECTIONS.indexOf(String(afterRetry.last_error)) !== -1 && await quarantineHead(canonical, head, String(afterRetry.last_error), afterRetry.last_status)) continue;
                return result(definitive ? 'BLOCKED_PENDING_REJECTED' : 'WAITING', processed, parseStored().intents.length,
                  String(afterRetry.last_error || error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'), head);
              }
              return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'));
            }
            if (!matching(canonical.receiptSnapshot(), head)) return result('WAITING', processed, parseStored().intents.length, 'RECEIPT_NOT_CONFIRMED');
            removeHead(head); processed += 1; continue;
          }
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
        var failureCode = String(error && (error.code || error.message) || '');
        if (!afterFailure && DETERMINISTIC.indexOf(failureCode) !== -1 && typeof canonical.sourceState === 'function') {
          // The replica may simply be behind: refresh once and try again. Only a
          // second identical failure on a current replica moves it aside.
          if (!refreshedFor[head.operation_id]) {
            refreshedFor[head.operation_id] = true;
            try { await canonical.refresh(); } catch (_) { return result('WAITING', processed, parseStored().intents.length, failureCode, head); }
            continue;
          }
          var replica = canonical.sourceState();
          if (replica && replica.validation === 'current' && await quarantineHead(canonical, head, failureCode, null)) continue;
        }
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
  async function withCashCloseBarrier(close) {
    if (typeof close !== 'function') fail('INVALID_CASH_CLOSE_CALLBACK');
    return withLock(async function () {
      var outcome = await syncLocked();
      var left = snapshot().intents;
      if (left.length) {
        var blocked = new Error('CASH_CLOSE_PENDING_SALES');
        blocked.code = 'CASH_CLOSE_PENDING_SALES';
        blocked.sale_id = outcome.sale_id || left[0].sale_id;
        blocked.operation_id = outcome.operation_id || left[0].operation_id;
        blocked.reason = outcome.reason || outcome.status;
        blocked.remaining = left.length;
        throw blocked;
      }
      var held = blockingQuarantine();
      if (held.length) {
        var canonical = root.NuevoAmanecerCanonical, q = readQuarantine(), changed = false;
        for (var i = 0; i < q.entries.length; i++) {
          var entry = q.entries[i];
          if (entry.status === 'QUARANTINED' && canonical && await confirmedRemotely(canonical, entry.intent)) {
            entry.status = 'CONFIRMED_REMOTE'; entry.resolved_at = new Date().toISOString(); changed = true;
          }
        }
        if (changed) writeQuarantine(q);
        held = blockingQuarantine();
      }
      if (held.length) {
        var review = new Error('CASH_CLOSE_QUARANTINED_SALES');
        review.code = 'CASH_CLOSE_QUARANTINED_SALES';
        review.sale_id = held[0].intent.sale_id;
        review.operation_id = held[0].intent.operation_id;
        review.reason = held[0].reason;
        review.remaining = held.length;
        review.cash_cents = held.reduce(function (sum, entry) { return sum + cashOf(entry.intent); }, 0);
        throw review;
      }
      // enqueue and sync share this lock across tabs. Keep it until the close
      // ACK (or uncertainty) so no durable sale is stranded in the gap.
      return close(outcome.processed);
    });
  }
  async function resolveQuarantined(operationId, action) {
    return withLock(async function () {
      var q = readQuarantine();
      var entry = q.entries.find(function (item) { return item.status === 'QUARANTINED' && item.intent.operation_id === operationId; });
      if (!entry) fail('QUARANTINE_ENTRY_NOT_FOUND');
      var canonical = root.NuevoAmanecerCanonical;
      if (action === 'verify') {
        if (!canonical || typeof canonical.snapshot !== 'function') fail('CANONICAL_API_UNAVAILABLE');
        if (await confirmedRemotely(canonical, entry.intent)) {
          entry.status = 'CONFIRMED_REMOTE'; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
          return { status: 'CONFIRMED_REMOTE', sale_id: entry.intent.sale_id, operation_id: operationId };
        }
        var replica = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
        if (!replica || replica.validation !== 'current') fail('QUARANTINE_REMOTE_NOT_VERIFIED');
        // Absence is proven by operation_id alone: a server row with the same
        // operation_id under another sale number is the same sale, never "absent".
        var twin = ((canonical.snapshot() || {}).sales || []).find(function (sale) { return sale.operation_id === operationId; });
        if (twin) {
          entry.status = 'CONFIRMED_REMOTE'; entry.remote_sale_id = twin.sale_id || twin.id; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
          return { status: 'CONFIRMED_REMOTE', sale_id: entry.intent.sale_id, remote_sale_id: entry.remote_sale_id, operation_id: operationId };
        }
        entry.verified_absent_at = new Date().toISOString(); writeQuarantine(q);
        return { status: 'NOT_REGISTERED', sale_id: entry.intent.sale_id, operation_id: operationId };
      }
      if (action === 'retry') {
        if (!retryable(entry.reason)) fail('QUARANTINE_RETRY_NOT_SAFE');
        // Same operation_id and sale_id: the Worker answers already_processed
        // if it ever committed, so a retry can never charge twice.
        var current = parseStored();
        if (!current.intents.some(function (item) { return item.operation_id === operationId; })) { current.intents.push(clone(entry.intent)); write(current); }
        entry.status = 'REQUEUED'; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
        return { status: 'REQUEUED', sale_id: entry.intent.sale_id, operation_id: operationId };
      }
      if (action === 'archive') {
        if (!canonical || typeof canonical.snapshot !== 'function') fail('CANONICAL_API_UNAVAILABLE');
        if (await confirmedRemotely(canonical, entry.intent)) {
          entry.status = 'CONFIRMED_REMOTE'; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
          return { status: 'CONFIRMED_REMOTE', sale_id: entry.intent.sale_id, operation_id: operationId };
        }
        if (CONFLICTS.indexOf(entry.reason) !== -1) fail('QUARANTINE_CONFLICT_NEEDS_SERVER_CHECK');
        if (!entry.verified_absent_at) fail('QUARANTINE_VERIFY_FIRST');
        if (!annullable(entry, canonical)) fail('QUARANTINE_ANNUL_NEEDS_PROMOTION_PROOF');
        var state = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
        if (!state || state.validation !== 'current') fail('QUARANTINE_REMOTE_NOT_VERIFIED');
        if (((canonical.snapshot() || {}).sales || []).some(function (sale) { return sale.operation_id === operationId; })) fail('QUARANTINE_OPERATION_EXISTS_ON_SERVER');
        entry.status = 'ARCHIVED_NO_CHARGE'; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
        return { status: 'ARCHIVED_NO_CHARGE', sale_id: entry.intent.sale_id, operation_id: operationId };
      }
      fail('QUARANTINE_ACTION_INVALID');
    });
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
      var held = []; try { held = readQuarantine().entries.map(function (entry) { return entry.intent; }); } catch (_) {}
      var reserved = confirmed.concat(current.intents, held, receipt ? [receipt] : []);
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
  root.NuevoAmanecerCanonicalSaleOutbox = Object.freeze({ VERSION: VERSION, KEY: KEY, enqueue: enqueue, snapshot: snapshot, sync: sync, withCashCloseBarrier: withCashCloseBarrier, quarantine: quarantineSnapshot, quarantineRetryable: retryable, quarantineAnnullable: function (entry) { return annullable(entry, root.NuevoAmanecerCanonical); }, resolveQuarantined: resolveQuarantined, start: start, rejectInvalidTestIntent: rejectInvalidTestIntent });
})(globalThis);
