(function (root) {
  'use strict';

  var VERSION = 1;
  var KEY = 'na_canonical_sale_outbox_v1';
  // Two locks. LOCK serializes the drain/close/quarantine actions and may be
  // held across network calls. STORE_LOCK only wraps synchronous
  // read-modify-write of localStorage, so registering a new sale never waits
  // on (or fails because of) the network.
  var LOCK = 'na-canonical-sale-outbox';
  var STORE_LOCK = 'na-canonical-sale-outbox-store';
  var STORE_WAIT_MS = 20000;
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
  // `work` must be synchronous: it never awaits, so the lock is held for
  // microseconds and never across the network. Never nest withStore.
  async function withStore(work) {
    var locks = root.navigator && root.navigator.locks;
    if (!locks || typeof locks.request !== 'function') fail('WEB_LOCKS_UNAVAILABLE');
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = controller && typeof root.setTimeout === 'function' ? root.setTimeout(function () { controller.abort(); }, STORE_WAIT_MS) : null;
    var options = { mode: 'exclusive' };
    if (controller) options.signal = controller.signal;
    try {
      return await locks.request(STORE_LOCK, options, function () { return work(); });
    } catch (error) {
      if (controller && controller.signal.aborted) fail('BUSY');
      throw error;
    } finally { if (timer !== null && typeof root.clearTimeout === 'function') root.clearTimeout(timer); }
  }
  // Only the cash-close barrier keeps STORE_LOCK across a network call, so no
  // new sale lands between "queue empty" and the close ACK. A sale registered
  // meanwhile waits (bounded by STORE_WAIT_MS) instead of failing BUSY.
  // While this tab is closing the till, a new sale fails fast with BUSY (cart
  // kept) instead of waiting and landing in a caja that is about to close.
  var closingTill = 0;
  async function holdStore(work) {
    var locks = root.navigator && root.navigator.locks;
    if (!locks || typeof locks.request !== 'function') fail('WEB_LOCKS_UNAVAILABLE');
    closingTill++;
    try { return await locks.request(STORE_LOCK, { mode: 'exclusive' }, function () { return work(); }); }
    finally { closingTill--; }
  }
  function snapshot() { var current = parseStored(); return clone(current); }
  // Sale quarantine: rejected or undeliverable sales leave the FIFO only after a
  // full durable copy is saved here. Entries are never deleted; they only
  // change status (QUARANTINED -> REQUEUED | CONFIRMED_REMOTE | ARCHIVED_NO_CHARGE).
  var QKEY = KEY + '_quarantine';
  var DETERMINISTIC = ['INVALID_CANONICAL_CUSTOMER', 'INVALID_CANONICAL_CREDIT', 'INVALID_CANONICAL_PRODUCT', 'INVALID_CANONICAL_ITEM',
    'INVALID_CANONICAL_GENERIC_LINE', 'INVALID_CANONICAL_TOTAL', 'UNSAFE_CANONICAL_TOTAL', 'INVALID_CANONICAL_PAYMENT', 'INVALID_CANONICAL_INTENT'];
  var CONFLICTS = ['operation_id_conflict', 'sale_id_conflict'];
  // A charged sale whose cash/payment really happened: never offered as
  // "annul as not registered" (the owner reconciles it from the review list).
  var NEVER_ANNUL = CONFLICTS.concat(['payment_reference_conflict', 'cash_session_closed', 'cash_session_required', 'promotion_changed']);
  // Rejections about THIS sale move it aside to the durable review list so the
  // rest of the queue keeps flowing. Any other definitive 400/404/409 of
  // sale.create also goes to review (never freeze the drain); system answers
  // (401, 403, stale_authority, canonical_not_active) keep the intent queued,
  // free the journal and wait for a new session/binding.
  var SALE_REJECTIONS = ['product_not_found', 'insufficient_stock', 'stale_stock', 'invalid_sale_request', 'customer_not_found',
    'sale_id_conflict', 'operation_id_conflict', 'canonical_sale_conflict', 'payment_reference_conflict',
    'cash_session_closed', 'cash_session_required', 'credit_limit_exceeded'];
  var SYSTEM_ERRORS = ['unauthorized', 'session_revoked', 'read_only_session', 'stale_authority', 'canonical_not_active', 'HTTP_401', 'HTTP_403'];
  function systemRejection(record) {
    return !!record && !!record.last_error && (record.last_status === 401 || record.last_status === 403 || SYSTEM_ERRORS.indexOf(String(record.last_error)) !== -1);
  }
  function definitive(record) { return !!record && !!record.last_error && [400, 404, 409].indexOf(record.last_status) !== -1; }
  var REASON_TEXT = {
    cash_closed_before_sale: 'la caja ya estaba cerrada en el servidor cuando la venta iba a confirmarse',
    insufficient_stock: 'no había stock suficiente en CANON: el stock de este aparato estaba desactualizado (otro equipo o una salida usó esas unidades). Revisa el producto y pulsa Reintentar, o Anular si no se cobró',
    stale_stock: 'stock desactualizado: el stock cambió en otro equipo mientras se vendía. Pulsa Reintentar: usa el stock actual y nunca cobra dos veces',
    product_not_found: 'el producto no existe en CANON',
    customer_not_found: 'el cliente no existe en CANON',
    sale_id_conflict: 'otro equipo ya usó ese número de venta',
    operation_id_conflict: 'la operación choca con otra ya registrada',
    payment_reference_conflict: 'ese número de operación Yape/transferencia ya está en otra venta',
    cash_session_closed: 'la caja ya estaba cerrada',
    cash_session_required: 'no hay ninguna caja abierta en CANON',
    promotion_changed: 'CANON cambió de promoción mientras la venta esperaba',
    credit_limit_exceeded: 'supera la línea de crédito del cliente',
    canonical_sale_conflict: 'CANON no pudo registrarla',
    invalid_sale_request: 'los datos de la venta no son válidos'
  };
  function reasonText(reason) { return REASON_TEXT[reason] || ('CANON la rechazó (' + String(reason) + ')'); }
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
  // Caja a la que pertenece una venta: su session_id o, si no lo lleva, la caja abierta cuando se hizo.
  function sessionOfIntent(intent) {
    var c = root.NuevoAmanecerCanonical, list = [];
    try { list = (c && typeof c.snapshot === 'function' && c.snapshot().cashSessions) || []; } catch (_) {}
    if (intent && intent.session_id) return list.find(function (x) { return x.session_id === intent.session_id; }) || null;
    var t = Date.parse(intent && intent.created_at || '') || 0;
    return list.find(function (x) { var o = Date.parse(x.opened_at || '') || 0, e = x.closed_at ? Date.parse(x.closed_at) : Infinity; return t >= o && t <= e; }) || null;
  }
  // Solo bloquean el cierre las ventas en revisión de la caja ABIERTA. Las de una caja anterior ya cerrada se
  // siguen mostrando en ámbar pero no impiden cerrar la caja nueva.
  function blockingQuarantine() {
    return readQuarantine().entries.filter(function (entry) {
      if (entry.status !== 'QUARANTINED') return false;
      var s = sessionOfIntent(entry.intent);
      return !s || s.status !== 'CLOSED';
    });
  }
  // Safe retry (same operation_id) only where the cause can clear by itself or
  // after a data fix; never for conflicts or malformed requests.
  // Explicit allowlist (fail-closed): causes that clear when the replica
  // catches up, stock arrives, or the missing customer/product is registered.
  var RETRYABLE = DETERMINISTIC.concat(['insufficient_stock', 'stale_stock', 'customer_not_found', 'product_not_found', 'sale_id_conflict',
    'cash_session_closed', 'cash_session_required', 'promotion_changed', 'credit_limit_exceeded']);
  // Retrying these re-assigns the charged sale explicitly (owner action).
  var REBIND_ON_RETRY = ['cash_session_closed', 'cash_session_required'];
  function retryable(reason) { return RETRYABLE.indexOf(reason) !== -1; }
  // Annul only when the absence proof can see the sale: the quarantined
  // command must carry a journal bound to the promotion that is active now
  // (the replica only lists that promotion's sales). No journal: no annul.
  function boundPromotion(entry) { var j = entry && entry.journal; return j && ((j.binding && j.binding.promotion_id) || (j.payload && j.payload.promotion_id)) || null; }
  function annullable(entry, canonical) {
    if (!entry || NEVER_ANNUL.indexOf(entry.reason) !== -1) return false;
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
    await withStore(function () {
      var q = readQuarantine();
      if (!q.entries.some(function (entry) { return entry.intent.operation_id === head.operation_id && entry.status === 'QUARANTINED'; })) {
        q.entries = q.entries.filter(function (entry) { return !(entry.intent.operation_id === head.operation_id && entry.status === 'REQUEUED'); })
          .concat(q.entries.filter(function (entry) { return entry.intent.operation_id === head.operation_id && entry.status === 'REQUEUED'; })
            .map(function (entry) { entry.status = 'RETRY_REJECTED'; return entry; }));
        q.entries.push({ intent: clone(head), reason: String(reason), last_status: status || (own && own.last_status) || null, journal: own ? clone(own) : null,
          status: 'QUARANTINED', quarantined_at: new Date().toISOString() });
        writeQuarantine(q);
      }
    });
    if (own) {
      var released = false;
      try { released = await canonical.releaseRejectedSaleJournal(head.operation_id); } catch (_) { released = false; }
      if (!released) return false;
    }
    await removeHead(head);
    clearHold(head.operation_id);
    notifyReview(head, reason);
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
    return true;
  }
  function matching(value, intent) { return !!value && value.operation_id === intent.operation_id && value.sale_id === intent.sale_id; }
  function removeHead(expected) {
    return withStore(function () {
      var current = parseStored();
      if (!current.intents.length || current.intents[0].operation_id !== expected.operation_id) fail('OUTBOX_HEAD_CHANGED');
      var number = /^V-(\d+)$/.exec(expected.sale_id);
      if (number) current.last_sale_number = Math.max(current.last_sale_number || 0, Number(number[1]));
      current.intents.shift();
      write(current);
    });
  }
  function maxReservedNumber(current, canonical) {
    var confirmed = canonical && typeof canonical.snapshot === 'function' ? (canonical.snapshot() || {}).sales || [] : [];
    var receipt = canonical && typeof canonical.receiptSnapshot === 'function' ? canonical.receiptSnapshot() : null;
    var held = []; try { held = readQuarantine().entries.map(function (entry) { return entry.intent; }); } catch (_) {}
    return confirmed.concat(current.intents, held, receipt ? [receipt] : []).reduce(function (value, sale) {
      var number = /^V-(\d+)$/.exec(String(sale && (sale.sale_id || sale.id) || ''));
      return Math.max(value, number ? Number(number[1]) : 0);
    }, current.last_sale_number || 0);
  }
  // 409 sale_id_conflict proves nothing was committed for this operation_id:
  // keep the SAME operation_id and give the sale the next free number.
  async function renumberHead(canonical, head) {
    try { await canonical.refresh(); } catch (_) {}
    var updated = await withStore(function () {
      var current = parseStored();
      if (!current.intents.length || current.intents[0].operation_id !== head.operation_id) fail('OUTBOX_HEAD_CHANGED');
      var next = maxReservedNumber(current, canonical) + 1;
      if (!Number.isSafeInteger(next)) fail('SALE_NUMBER_UNSAFE');
      var input = clone(head); input.sale_id = 'V-' + String(next).padStart(3, '0');
      var intent = validateIntent(input);
      current.intents[0] = intent;
      current.last_sale_number = next;
      write(current);
      return intent;
    });
    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    if (runtime && typeof runtime.notify === 'function') runtime.notify('La venta ' + head.sale_id + ' se registra como ' + updated.sale_id +
      ': otro equipo ya había usado ese número. Es la misma venta; no la cobres de nuevo.', 'info');
    return updated;
  }
  // System rejections (401/403/stale_authority/canonical_not_active) free the
  // journal but keep the intent queued. Remember the promotion it was bound to:
  // if CANON moved to another promotion, the owner decides from the review list.
  var HOLD_KEY = KEY + '_authority_hold';
  function readHolds() { try { var v = JSON.parse(root.localStorage.getItem(HOLD_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; } }
  function writeHolds(v) { try { if (Object.keys(v).length) root.localStorage.setItem(HOLD_KEY, JSON.stringify(v)); else root.localStorage.removeItem(HOLD_KEY); } catch (_) {} }
  function clearHold(operationId) { var holds = readHolds(); if (holds[operationId]) { delete holds[operationId]; writeHolds(holds); } }
  var sessionNoticeAt = 0;
  function notifySystemHold(reason, remaining) {
    var now = Date.now();
    if (now - sessionNoticeAt < 60000) return;
    sessionNoticeAt = now;
    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    if (!runtime || typeof runtime.notify !== 'function') return;
    var auth = ['unauthorized', 'session_revoked', 'HTTP_401', 'HTTP_403', 'read_only_session'].indexOf(reason) !== -1;
    runtime.notify((auth ? 'Sesión vencida: vuelve a iniciar sesión. ' : 'CANON no acepta ventas en este momento (' + reason + '). ') +
      remaining + (remaining === 1 ? ' venta espera' : ' ventas esperan') + ' guardada' + (remaining === 1 ? '' : 's') + ' en este equipo; se enviarán solas.', 'error');
  }
  async function holdForSystem(canonical, head, pending) {
    var reason = String(pending.last_error);
    var holds = readHolds();
    var promotion = pending.binding && pending.binding.promotion_id || (pending.payload && pending.payload.promotion_id) || null;
    if (!holds[head.operation_id] && promotion) { holds[head.operation_id] = { promotion_id: promotion, reason: reason, at: new Date().toISOString() }; writeHolds(holds); }
    var released = false;
    if (typeof canonical.releaseRejectedSaleJournal === 'function') {
      try { released = await canonical.releaseRejectedSaleJournal(head.operation_id); } catch (_) { released = false; }
    }
    notifySystemHold(reason, parseStored().intents.length);
    return released;
  }
  // Another command (cash, payment, inventory...) occupies the single journal.
  // Lost ACK or 429/5xx: replay the SAME operation_id. Definitive 4xx: the
  // client archives it (no commit happened) so sales keep flowing.
  async function settleForeignPending(canonical, pending) {
    // A sale journal for another operation is never touched from here.
    if (!pending || pending.command === 'sale.create') return false;
    // Un cierre de caja sin confirmar NUNCA se reenvía solo: el cajero debe volver a confirmarlo en Caja.
    if (pending.command === 'cash.close') return false;
    if (!pending.last_error || pending.last_status === 429 || pending.last_status >= 500) {
      try { await canonical.retryPending(); return true; } catch (_) { return false; }
    }
    if (typeof canonical.releaseRejectedFinancial !== 'function') return false;
    try { return !!(await canonical.releaseRejectedFinancial(pending.payload && pending.payload.operation_id)); } catch (_) { return false; }
  }
  function result(status, processed, remaining, reason, head) {
    var out = { status: status, processed: processed, remaining: remaining };
    if (reason) out.reason = reason;
    if (head) { out.sale_id = head.sale_id; out.operation_id = head.operation_id; }
    // Only sale-specific rejections are 'held for review'; system/session
    // reasons keep the sale in the queue and must not claim CANON rejected it.
    if (status === 'BLOCKED_PENDING_REJECTED' && head && (SALE_REJECTIONS.indexOf(reason) !== -1 || DETERMINISTIC.indexOf(reason) !== -1)) notifyReview(head, reason);
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
    if (runtime && typeof runtime.notify === 'function') runtime.notify('Venta ' + head.sale_id + ' en revisión: ' + reasonText(reason) +
      '. No la cobres de nuevo y no entregues el crédito hasta resolverla en Caja › Ventas en revisión. Las demás ventas siguen funcionando.', 'error');
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
    var processed = 0, refreshedFor = {}, renumbered = {};
    while (true) {
      var current = parseStored();
      if (!current.intents.length) return result(processed ? 'DRAINED' : 'EMPTY', processed, 0);
      var head = current.intents[0];
      if (quarantinedOperation(head.operation_id)) {
        // Crash between the quarantine copy and the FIFO removal: finish it.
        var stillOwn = root.NuevoAmanecerCanonical && typeof root.NuevoAmanecerCanonical.pendingSnapshot === 'function' && root.NuevoAmanecerCanonical.pendingSnapshot();
        if (!stillOwn || !stillOwn.payload || stillOwn.payload.operation_id !== head.operation_id) { await removeHead(head); continue; }
      }
      if (current.intents.some(function (item, index) { return index > 0 && item.sale_id === head.sale_id; }))
        return result('BLOCKED_DUPLICATE_SALE_ID', processed, current.intents.length, 'DUPLICATE_SALE_ID');
      var canonical = root.NuevoAmanecerCanonical;
      if (!canonical || typeof canonical.receiptSnapshot !== 'function' || typeof canonical.pendingSnapshot !== 'function' || typeof canonical.refresh !== 'function' || typeof canonical.createSale !== 'function' || typeof canonical.retryPending !== 'function') fail('CANONICAL_API_UNAVAILABLE');
      var receipt = canonical.receiptSnapshot();
      if (matching(receipt, head)) { await removeHead(head); clearHold(head.operation_id); processed += 1; continue; }
      var pending = canonical.pendingSnapshot();
      if (pending) {
        var payload = pending.payload;
        if (pending.command !== 'sale.create' || !payload || payload.operation_id !== head.operation_id || payload.sale_id !== head.sale_id) {
          // Never let a cash/payment/inventory command freeze the sales queue.
          if (await settleForeignPending(canonical, pending)) continue;
          return result('BLOCKED_FOREIGN_PENDING', processed, current.intents.length, 'FOREIGN_PENDING');
        }
        if (pending.last_error && (pending.last_status === 429 || pending.last_status >= 500)) {
          // A 429/5xx is not evidence that the sale did not commit. The
          // previous acknowledgement may be lost: retry only the exact
          // durable operation_id and rely on the server idempotency contract.
          try { await canonical.retryPending(); }
          catch (error) {
            var afterTransient = canonical.pendingSnapshot();
            // The replay itself was answered with a definitive 4xx: handle it.
            if (afterTransient && afterTransient.last_error && afterTransient.last_status !== 429 && afterTransient.last_status < 500 &&
                afterTransient.payload && afterTransient.payload.operation_id === head.operation_id) continue;
            return result('WAITING', processed, current.intents.length,
              String(error && (error.code || error.message) || 'RETRY_FAILED'));
          }
          if (!matching(canonical.receiptSnapshot(), head))
            return result('WAITING', processed, current.intents.length, 'RECEIPT_NOT_CONFIRMED');
          await removeHead(head); clearHold(head.operation_id); processed += 1; continue;
        }
        if (pending.last_error && systemRejection(pending)) {
          // 401/403/stale_authority/canonical_not_active: a 4xx before commit.
          // Free the journal, keep the intent queued (same operation_id) and
          // wait for a new session/binding instead of jamming forever.
          var held = await holdForSystem(canonical, head, pending);
          return result('WAITING', processed, parseStored().intents.length, held ? 'SESSION_' + String(pending.last_error) : String(pending.last_error), head);
        }
        if (pending.last_error) {
          // Safe sale rejects (409/400) prove no D1 commit.
          var rejectReason = String(pending.last_error);
          var recoverable = rejectReason === 'stale_stock' || rejectReason === 'stock_revision_conflict';
          if (rejectReason === 'sale_id_conflict' && (renumbered[head.operation_id] || 0) < 3 && typeof canonical.discardRejectedSale === 'function') {
            var freed = false;
            try { freed = await canonical.discardRejectedSale(); } catch (_) { freed = false; }
            if (freed) {
              renumbered[head.operation_id] = (renumbered[head.operation_id] || 0) + 1;
              try { await renumberHead(canonical, head); } catch (error) { return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'RENUMBER_FAILED'), head); }
              continue;
            }
          }
          if (!recoverable) {
            // Only a server-side record of this exact operation_id settles it
            // as done; otherwise it moves to the durable review list (which
            // keeps blocking cash close) and the rest of the queue continues.
            if (await confirmedRemotely(canonical, head)) {
              var cleared = false;
              try { cleared = await canonical.discardRejectedSale(); } catch (_) { cleared = false; }
              if (!cleared) return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason, head);
              await removeHead(head); clearHold(head.operation_id); processed += 1; continue;
            }
            if ((SALE_REJECTIONS.indexOf(rejectReason) !== -1 || definitive(pending)) && await quarantineHead(canonical, head, rejectReason, pending.last_status)) continue;
            return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason, head);
          }
          var discarded = false;
          if (typeof canonical.discardRejectedSale === 'function') {
            try { discarded = await canonical.discardRejectedSale(); } catch (_) { discarded = false; }
          }
          if (!discarded) return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, rejectReason, head);
          try {
            // One fresh read, then one retry with the new revision (same operation_id).
            await canonical.refresh();
            await canonical.createSale(head);
          } catch (error) {
            var afterRetry = canonical.pendingSnapshot();
            if (afterRetry && afterRetry.command === 'sale.create' && afterRetry.payload &&
                afterRetry.payload.operation_id === head.operation_id && afterRetry.payload.sale_id === head.sale_id && afterRetry.last_error) {
              if (afterRetry.last_status === 429 || afterRetry.last_status >= 500)
                return result('WAITING', processed, parseStored().intents.length, String(afterRetry.last_error), head);
              var again = String(afterRetry.last_error);
              // Second stock failure on a fresh read: the units are not there.
              // Move it to review and free the journal; never block other sales.
              if ((again === 'stale_stock' || again === 'stock_revision_conflict' || again === 'insufficient_stock') && definitive(afterRetry)) {
                if (await quarantineHead(canonical, head, again === 'stock_revision_conflict' ? 'stale_stock' : again, afterRetry.last_status)) continue;
                return result('BLOCKED_PENDING_REJECTED', processed, parseStored().intents.length, again, head);
              }
              // Anything else is handled by the generic branch on the next turn.
              continue;
            }
            return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'));
          }
          if (!matching(canonical.receiptSnapshot(), head)) return result('WAITING', processed, parseStored().intents.length, 'RECEIPT_NOT_CONFIRMED');
          await removeHead(head); clearHold(head.operation_id); processed += 1; continue;
        }
        // PENDING without error: lost ACK or timeout. Replay the same operation_id.
        try { await canonical.retryPending(); } catch (error) {
          var afterReplay = canonical.pendingSnapshot();
          if (afterReplay && afterReplay.last_error && afterReplay.payload && afterReplay.payload.operation_id === head.operation_id &&
              afterReplay.last_status !== 429 && afterReplay.last_status < 500) continue;
          return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'RETRY_FAILED'));
        }
        if (!matching(canonical.receiptSnapshot(), head)) return result('WAITING', processed, parseStored().intents.length, 'RECEIPT_NOT_CONFIRMED');
        await removeHead(head); clearHold(head.operation_id); processed += 1; continue;
      }
      var hold = readHolds()[head.operation_id];
      if (hold) {
        // Bound to a promotion that is no longer active: the owner decides.
        var snap = typeof canonical.snapshot === 'function' ? canonical.snapshot() || {} : {};
        var replicaNow = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
        if (snap.promotion_id && hold.promotion_id && snap.promotion_id !== hold.promotion_id && replicaNow && replicaNow.validation === 'current') {
          if (await quarantineHead(canonical, head, 'promotion_changed', 409)) continue;
          return result('BLOCKED_PENDING_REJECTED', processed, current.intents.length, 'promotion_changed', head);
        }
      }
      try {
        // createSale() owns freshness. With a current replica it can go straight
        // to the guarded POST; if the replica is stale it refreshes itself.
        // Do not force a full multi-collection refresh in front of every sale.
        await canonical.createSale(head);
      } catch (error) {
        var afterFailure = canonical.pendingSnapshot();
        if (afterFailure && afterFailure.command === 'sale.create' && afterFailure.payload && afterFailure.payload.operation_id === head.operation_id && afterFailure.payload.sale_id === head.sale_id) {
          // Safe 409/400 rejects leave last_error; loop again so the branch
          // above handles it in this same pass instead of freezing.
          if (afterFailure.last_error) {
            // Do not immediately replay an uncertain 429/5xx inside the same
            // drain pass: let the bounded backoff schedule the next safe retry.
            if (afterFailure.last_status === 429 || afterFailure.last_status >= 500)
              return result('WAITING', processed, parseStored().intents.length, String(afterFailure.last_error));
            continue;
          }
          return result('WAITING', processed, parseStored().intents.length, String(error && (error.code || error.message) || 'CREATE_UNACKNOWLEDGED'));
        }
        if (afterFailure && (afterFailure.command !== 'sale.create' || !afterFailure.payload || afterFailure.payload.operation_id !== head.operation_id || afterFailure.payload.sale_id !== head.sale_id)) {
          if (await settleForeignPending(canonical, afterFailure)) continue;
          return result('BLOCKED_FOREIGN_PENDING', processed, parseStored().intents.length, 'FOREIGN_PENDING');
        }
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
      await removeHead(head); clearHold(head.operation_id); processed += 1;
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
  // P1-B / P1-4: the receipt is projected locally (stock, sale view), so the
  // full server reconciliation is deferred until the queue is idle. It never
  // runs ahead of (or delays) a queued POST, and it repeats if a sale was
  // confirmed while it was reading, so its replica is never older than a POST.
  var RECONCILE_DELAY_MS = 1500, reconcileTimer = null, reconciling = false, confirmedSince = 0;
  function scheduleReconcile() {
    if (reconcileTimer !== null || typeof root.setTimeout !== 'function') return;
    reconcileTimer = root.setTimeout(function () { reconcileTimer = null; reconcileWhenIdle(); }, RECONCILE_DELAY_MS);
  }
  async function reconcileWhenIdle() {
    var canonical = root.NuevoAmanecerCanonical;
    if (!canonical || typeof canonical.refresh !== 'function') return;
    var pending = 0;
    try { pending = snapshot().intents.length; } catch (_) { pending = 0; }
    // A queued sale reschedules this itself when its drain confirms something;
    // never poll while the queue is blocked.
    if (pending) return;
    if (reconciling || syncing) { scheduleReconcile(); return; }
    reconciling = true;
    var mark = confirmedSince;
    try { await canonical.refresh(); }
    catch (error) { if (root.console) root.console.warn('[Venta CANON] Confirmada; reconciliación pendiente', error.code || error.message); }
    finally { reconciling = false; }
    if (confirmedSince !== mark) scheduleReconcile();
  }
  async function sync() {
    if (syncing) return result('WAITING', 0, snapshot().intents.length, 'BUSY');
    syncing = (async function () {
      try {
        var outcome = await withLock(syncLocked);
        // Receipt is already durable and the confirmed intent has been removed.
        // Return the commercial path immediately; reconciliation starts now but
        // is never allowed to hold the sale UI after the durable receipt.
        if (outcome.processed > 0) { confirmedSince++; scheduleReconcile(); }
        if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
        if ((outcome.status === 'WAITING' && outcome.reason !== 'BUSY') || outcome.status === 'BLOCKED_FOREIGN_PENDING') scheduleResume();
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
  // `before` corre dentro del mismo candado, antes de enviar ventas: resuelve un cierre anterior pendiente
  // consultando al servidor. Si la caja YA está cerrada, las ventas de esa caja que siguen en la cola NO se
  // mueven a otra caja ni se borran: pasan a la lista de revisión y se devuelven con su monto.
  async function withCashCloseBarrier(close, before) {
    if (typeof close !== 'function') fail('INVALID_CASH_CLOSE_CALLBACK');
    return withLock(async function () {
      var pre = typeof before === 'function' ? await before() : null;
      if (pre && pre.closedSession) {
        var sid = pre.closedSession.session_id, canonical = root.NuevoAmanecerCanonical, leftOut = [];
        var closedAt = Date.parse(pre.closedSession.closed_at || '') || Date.now();
        // De esa caja: la venta lleva su session_id, o no lleva caja y se hizo antes del cierre real.
        var ofClosed = function (x) { return x && (x.session_id ? String(x.session_id) === String(sid) : (Date.parse(x.created_at || '') || 0) <= closedAt); };
        while (true) {
          var cur = parseStored().intents, head = cur[0];
          if (!head || !ofClosed(head)) break;
          leftOut.push({ sale_id: head.sale_id, total_cents: Number(head.total_cents || 0), operation_id: head.operation_id });
          if (!(await quarantineHead(canonical, head, 'cash_closed_before_sale', 409))) break;
        }
        parseStored().intents.forEach(function (x) {
          if (ofClosed(x) && !leftOut.some(function (l) { return l.operation_id === x.operation_id; }))
            leftOut.push({ sale_id: x.sale_id, total_cents: Number(x.total_cents || 0), operation_id: x.operation_id, queued: true });
        });
        return { status: 'CLOSED', session: pre.closedSession, left_out: leftOut, receipt: pre.receipt || null };
      }
      var outcome = await syncLocked();
      if (snapshot().intents.length) return holdStore(function () { return closeChecks(outcome, close); });
      var held = blockingQuarantine();
      if (held.length) {
        var canonical = root.NuevoAmanecerCanonical, confirmedIds = [];
        for (var i = 0; i < held.length; i++) {
          if (canonical && await confirmedRemotely(canonical, held[i].intent)) confirmedIds.push(held[i].intent.operation_id);
        }
        if (confirmedIds.length) await withStore(function () {
          var q = readQuarantine();
          q.entries.forEach(function (entry) {
            if (entry.status === 'QUARANTINED' && confirmedIds.indexOf(entry.intent.operation_id) !== -1) { entry.status = 'CONFIRMED_REMOTE'; entry.resolved_at = new Date().toISOString(); }
          });
          writeQuarantine(q);
        });
      }
      // enqueue writes under STORE_LOCK: keep it until the close ACK (or
      // uncertainty) so no durable sale is stranded in the gap.
      return holdStore(function () { return closeChecks(outcome, close); });
    });
  }
  function closeChecks(outcome, close) {
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
        var review = new Error('CASH_CLOSE_QUARANTINED_SALES');
        review.code = 'CASH_CLOSE_QUARANTINED_SALES';
        review.sale_id = held[0].intent.sale_id;
        review.operation_id = held[0].intent.operation_id;
        review.reason = held[0].reason;
        review.remaining = held.length;
        review.cash_cents = held.reduce(function (sum, entry) { return sum + cashOf(entry.intent); }, 0);
        throw review;
      }
      return close(outcome.processed);
  }
  function openCashSession(canonical) {
    var snap = canonical && typeof canonical.snapshot === 'function' ? canonical.snapshot() || {} : {};
    var open = (snap.cashSessions || []).filter(function (item) { return item && item.status === 'OPEN' && item.session_id; });
    return open.length === 1 ? clone(open[0]) : null;
  }
  async function resolveQuarantined(operationId, action, meta) {
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
        // Same operation_id: the Worker answers already_processed if it ever
        // committed, so a retry can never charge twice. For a till that was
        // closed, retrying is the owner's explicit choice to register the
        // charged sale in the till that is open now.
        var again = clone(entry.intent);
        if (REBIND_ON_RETRY.indexOf(entry.reason) !== -1) {
          // Etapa 1.3 (auditoría 2026-10-12): nunca re-asignar en silencio. El
          // dueño debe confirmar la caja destino exacta (la única OPEN en CANON)
          // y queda registrado de qué caja venía y a cuál entró.
          var target = openCashSession(canonical);
          if (!target) fail('QUARANTINE_REBIND_NO_OPEN_CASH');
          if (!meta || meta.targetSessionId !== target.session_id) fail('QUARANTINE_REBIND_NEEDS_CONFIRMATION');
          entry.rebound_from_session_id = entry.intent.session_id || null;
          entry.rebound_to_session_id = target.session_id;
          entry.rebound_by = meta.by != null ? String(meta.by) : null;
          again.session_id = target.session_id; again = validateIntent(again);
        }
        if (entry.reason === 'promotion_changed') clearHold(operationId);
        await withStore(function () {
          var current = parseStored();
          if (!current.intents.some(function (item) { return item.operation_id === operationId; })) { current.intents.push(again); write(current); }
          entry.status = 'REQUEUED'; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
        });
        return { status: 'REQUEUED', sale_id: entry.intent.sale_id, operation_id: operationId };
      }
      if (action === 'archive') {
        if (!canonical || typeof canonical.snapshot !== 'function') fail('CANONICAL_API_UNAVAILABLE');
        if (await confirmedRemotely(canonical, entry.intent)) {
          entry.status = 'CONFIRMED_REMOTE'; entry.resolved_at = new Date().toISOString(); writeQuarantine(q);
          return { status: 'CONFIRMED_REMOTE', sale_id: entry.intent.sale_id, operation_id: operationId };
        }
        if (CONFLICTS.indexOf(entry.reason) !== -1) fail('QUARANTINE_CONFLICT_NEEDS_SERVER_CHECK');
        if (NEVER_ANNUL.indexOf(entry.reason) !== -1) fail('QUARANTINE_CHARGED_SALE_NOT_ANNULLABLE');
        if (!entry.verified_absent_at) fail('QUARANTINE_VERIFY_FIRST');
        if (!annullable(entry, canonical)) fail('QUARANTINE_ANNUL_NEEDS_PROMOTION_PROOF');
        var state = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
        if (!state || state.validation !== 'current') fail('QUARANTINE_REMOTE_NOT_VERIFIED');
        if (((canonical.snapshot() || {}).sales || []).some(function (sale) { return sale.operation_id === operationId; })) fail('QUARANTINE_OPERATION_EXISTS_ON_SERVER');
        entry.status = 'ARCHIVED_NO_CHARGE'; entry.resolved_at = new Date().toISOString(); entry.resolved_by = meta && meta.by != null ? String(meta.by) : null; writeQuarantine(q);
        return { status: 'ARCHIVED_NO_CHARGE', sale_id: entry.intent.sale_id, operation_id: operationId };
      }
      fail('QUARANTINE_ACTION_INVALID');
    });
  }
  var lastServerRead = Date.now();
  function start() {
    if (started) return;
    started = true;
    async function resume() {
      if (resuming || syncing || root.navigator.onLine === false) return;
      var canonical = root.NuevoAmanecerCanonical;
      if (canonical && typeof canonical.enabled === 'function' && canonical.enabled()) {
        var state = typeof canonical.sourceState === 'function' ? canonical.sourceState() : null;
        if (!state || state.validation !== 'current') {
          if (state && ['stale','unavailable','offline'].includes(state.validation) && typeof canonical.refresh === 'function') {
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
        // Etapa 1.4: al reconectar se relee CANON siempre (también cajas), aunque
        // la réplica figure como vigente; na:canonical-updated reanuda la cola.
        if (canonical && typeof canonical.enabled === 'function' && canonical.enabled() && typeof canonical.refresh === 'function') {
          lastServerRead = Date.now();
          return canonical.refresh().then(function () { return resume(); }, function () { return resume(); });
        }
        return resume();
      });
      root.addEventListener('na:canonical-updated', resume);
    }
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.hidden) return;
        // Volver a la app tras >60 s: releer CANON (cajas abiertas/cerradas en otro
        // equipo). Una lectura por minuto como máximo: cuida el plan gratuito.
        var canonical = root.NuevoAmanecerCanonical;
        if (Date.now() - lastServerRead > 60000 && root.navigator.onLine !== false && canonical && typeof canonical.enabled === 'function'
          && canonical.enabled() && typeof canonical.refresh === 'function' && !syncing) {
          lastServerRead = Date.now();
          return canonical.refresh().then(function () { return resume(); }, function () { return resume(); });
        }
        resume();
      });
    }
    return resume();
  }
  async function enqueue(input) {
    if (closingTill > 0) fail('BUSY');
    return withStore(function () {
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
    current = parseStored();
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
      await withStore(function () { archiveTests(current, pair, 'DUPLICATE_SALE_ID'); });
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
      await withStore(function () { archiveTests(current, [intent], missing ? 'PRODUCT_NOT_FOUND' : 'DUPLICATE_SALE_ID'); });
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection'));
      return { status: 'REJECTED_TEST_INTENT', operation_id: operationId };
    });
  }
  root.NuevoAmanecerCanonicalSaleOutbox = Object.freeze({ busy: function () { return !!syncing; }, VERSION: VERSION, KEY: KEY, enqueue: enqueue, snapshot: snapshot, sync: sync, withCashCloseBarrier: withCashCloseBarrier, quarantine: quarantineSnapshot, sessionOf: sessionOfIntent, blocking: function () { return clone(blockingQuarantine()); }, quarantineRetryable: retryable, quarantineAnnullable: function (entry) { return annullable(entry, root.NuevoAmanecerCanonical); }, resolveQuarantined: resolveQuarantined, start: start, rejectInvalidTestIntent: rejectInvalidTestIntent,
    reasonText: reasonText, quarantineRebindsOnRetry: function (reason) { return REBIND_ON_RETRY.indexOf(reason) !== -1; },
    rebindTarget: function () { return openCashSession(root.NuevoAmanecerCanonical); },
    // The drain resolves every sale.create rejection by itself (review list,
    // session hold or replay); capture never has to stop for it.
    autoResolves: function (record) { var c = root.NuevoAmanecerCanonical; return !!record && record.command === 'sale.create' && !!c && typeof c.releaseRejectedSaleJournal === 'function'; } });
})(globalThis);
