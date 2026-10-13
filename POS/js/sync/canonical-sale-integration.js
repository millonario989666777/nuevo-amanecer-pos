(function (root) {
  'use strict';

  var originalConfirm = root.confirmarVenta;
  var projection = null;
  var busy = false;
  var VERSION = 1;

  function copy(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
  function enabled() {
    return !!(root.NuevoAmanecerCanonical && typeof root.NuevoAmanecerCanonical.enabled === 'function' && root.NuevoAmanecerCanonical.enabled());
  }
  function runtime() { return root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime; }
  function canonicalSaleGate() {
    var canonical = root.NuevoAmanecerCanonical;
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
    if (!canonical || typeof canonical.snapshot !== 'function')
      return { ready:false, reason:'La base local de CANON no está disponible' };
    if (!outbox || typeof outbox.snapshot !== 'function' || typeof outbox.enqueue !== 'function')
      return { ready:false, reason:'La cola local de ventas no está disponible' };
    try {
      // A4 local-first contract: capture depends on durable local state, never on
      // cloud freshness. Remote ACTIVE/read_only/auth state is evaluated later by
      // the background sender; it must not block the cashier from recording a sale.
      canonical.snapshot();
      outbox.snapshot();
    } catch (_) {
      return { ready:false, reason:'No se pudo validar el almacenamiento local de ventas · reintenta' };
    }
    return { ready:true };
  }
  function notify(message, tone) {
    if (runtime()) return runtime().notify(message, tone);
    var fn; try { if (typeof toast === 'function') fn = toast; } catch (_) {}
    if (!fn) fn = root.toast;
    if (typeof fn === 'function') fn(message, tone);
  }
  function failClosed(message, error) {
    notify(message, 'error');
    if (error && root.console && typeof root.console.error === 'function') root.console.error('[Venta canónica]', error.code || error.message || 'Error');
  }

  // The legacy POS keeps its authoritative runtime state in top-level `let`
  // bindings. In classic browser scripts those bindings are shared by the same
  // global lexical environment, but they are NOT properties of window/globalThis.
  // Read/write the lexical binding first and keep root.* only as a compatibility
  // fallback for isolated tests or alternate hosts.
  function liveCart() {
    if (runtime()) return runtime().cart();
    try { if (typeof cart !== 'undefined' && Array.isArray(cart)) return cart; } catch (_) {}
    return Array.isArray(root.cart) ? root.cart : [];
  }
  function liveProducts() {
    if (runtime()) return runtime().products();
    try { if (typeof productos !== 'undefined' && Array.isArray(productos)) return productos; } catch (_) {}
    return Array.isArray(root.productos) ? root.productos : [];
  }
  function liveSales() {
    if (runtime()) return runtime().sales();
    try { if (typeof ventas !== 'undefined' && Array.isArray(ventas)) return ventas; } catch (_) {}
    return Array.isArray(root.ventas) ? root.ventas : [];
  }
  function liveCustomers() {
    if (runtime()) return runtime().customers();
    try { if (typeof clientes !== 'undefined' && Array.isArray(clientes)) return clientes; } catch (_) {}
    return Array.isArray(root.clientes) ? root.clientes : [];
  }
  function livePaymentMethod() {
    if (runtime()) return runtime().paymentMethod();
    try { if (typeof posPayM !== 'undefined') return posPayM; } catch (_) {}
    return root.posPayM;
  }
  function liveProcessing() {
    if (runtime()) return runtime().processing();
    try { if (typeof posProc !== 'undefined') return !!posProc; } catch (_) {}
    return !!root.posProc;
  }
  function setLiveProcessing(value) {
    if (runtime()) return runtime().setProcessing(value);
    try {
      if (typeof posProc !== 'undefined') posProc = value;
      else root.posProc = value;
    } catch (_) { root.posProc = value; }
  }
  // Legacy helpers are top-level `const` in inline-02/core-utils: they live in
  // the shared lexical scope, NOT on window. Resolve them lexically first.
  function lexical(name) {
    var fn = null;
    try {
      if (name === 'sessionOpen' && typeof _naSessionOpen === 'function') fn = _naSessionOpen;
      else if (name === 'unitsSold' && typeof _naUnitsSold === 'function') fn = _naUnitsSold;
      else if (name === 'tracksStock' && typeof _naTracksStock === 'function') fn = _naTracksStock;
      else if (name === 'unitsPerQty' && typeof _naUnitsPerQty === 'function') fn = _naUnitsPerQty;
      else if (name === 'clean' && typeof _naClean === 'function') fn = _naClean;
      else if (name === 'getBusiness' && typeof _naGetBusiness === 'function') fn = _naGetBusiness;
    } catch (_) { fn = null; }
    if (fn) return fn;
    var legacy = { sessionOpen: '_naSessionOpen', unitsSold: '_naUnitsSold', tracksStock: '_naTracksStock', unitsPerQty: '_naUnitsPerQty', clean: '_naClean', getBusiness: '_naGetBusiness' }[name];
    return legacy && typeof root[legacy] === 'function' ? root[legacy] : null;
  }
  function liveCashState() {
    try { if (typeof cajEstado !== 'undefined') return cajEstado; } catch (_) {}
    return root.cajEstado || null;
  }
  function closedTillMessage() {
    var state = liveCashState();
    if (state && state.abierta && !state.cerrada && state.fechaApertura) {
      var parts = String(state.fechaApertura).split('-');
      var label = parts.length === 3 ? parts[2] + '/' + parts[1] : String(state.fechaApertura);
      return 'La caja del ' + label + ' sigue abierta: ciérrala en Caja y abre la de hoy para vender.';
    }
    return 'La caja no está abierta';
  }
  // The canonical till open right now: a cash sale is bound to it so the
  // Worker never counts it in a later till.
  function openCanonicalSession() {
    try {
      var sessions = (root.NuevoAmanecerCanonical.snapshot().cashSessions || []).filter(function (item) { return item && item.status === 'OPEN'; });
      return sessions.length === 1 && typeof sessions[0].session_id === 'string' && sessions[0].session_id ? sessions[0].session_id : null;
    } catch (_) { return null; }
  }
  var CAPTURE_ERRORS = {
    VENTA_MODO_CAJA_UNSUPPORTED: 'La venta por mayor (caja) todavía no está disponible con CANON. Vende por unidades.',
    UNITS_PER_QTY_UNSUPPORTED: 'La venta por mayor (caja) todavía no está disponible con CANON. Vende por unidades.',
    VENTA_SIN_STOCK: 'CANON no permite vender sin stock. Quita del carrito los productos sin stock.',
    STOCK_NEGATIVO: 'CANON no permite vender sin stock. Quita del carrito los productos sin stock.',
    PRODUCT_ID_DUPLICATE_PRICE: 'El mismo producto está en dos líneas con distinto precio. Deja una sola línea con el precio correcto y vuelve a cobrar.',
    PRODUCT_ID_DUPLICATE: 'El mismo producto está en dos líneas distintas. Deja una sola línea y vuelve a cobrar.',
    MIXED_PAYMENT_INVALID: 'El pago mixto no cuadra con el total. Revisa el efectivo (máximo 2 decimales).',
    PRICE_INVALID: 'Un precio del carrito no es válido (máximo 2 decimales).',
    BUSY: 'Se está cerrando la caja o guardando otra venta. Espera unos segundos y vuelve a cobrar; el carrito se conserva.',
    OUTBOX_STORAGE_WRITE_FAILED: 'El navegador no pudo guardar la venta (almacenamiento lleno o bloqueado).',
    VENTA_LIBRE_UNSUPPORTED: 'La venta libre no está disponible en este cobro.'
  };
  function captureErrorMessage(error) {
    var code = String(error && (error.code || error.message) || '');
    return (CAPTURE_ERRORS[code] || 'No se guardó la venta.') + ' Tus productos siguen en el carrito.';
  }
  function clearLiveCart() {
    if (runtime()) return runtime().clearCart();
    try {
      if (typeof cart !== 'undefined') { cart = []; return; }
    } catch (_) {}
    root.cart = [];
  }
  function browserLockReason() {
    try {
      if (typeof root.securityIsLocked === 'function' && root.securityIsLocked()) return 'sesión de seguridad bloqueada';
    } catch (_) {}
    try {
      if (typeof root._naGetLocks === 'function') {
        var locks = root._naGetLocks() || {};
        if (locks.master) return 'Bloquear edición crítica está activado';
        if (locks.readOnly) return 'Modo solo lectura está activado';
        if (locks.modules && locks.modules.ventas) return 'Ventas y POS está protegido';
      }
    } catch (_) {}
    try {
      if (root.sessionStorage && root.sessionStorage.getItem('na_security_locked') === 'true') return 'sesión de seguridad bloqueada';
      if (root.localStorage) {
        if (root.localStorage.getItem('na_master_lock') === 'true') return 'Bloquear edición crítica está activado';
        if (root.localStorage.getItem('na_readonly') === 'true') return 'Modo solo lectura está activado';
        if (root.localStorage.getItem('na_lock_ventas') === 'true') return 'Ventas y POS está protegido';
      }
    } catch (_) {}
    return '';
  }
  function nextSaleId() {
    var canonical = root.NuevoAmanecerCanonical;
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
    var confirmed = canonical && typeof canonical.snapshot === 'function' ? canonical.snapshot().sales || [] : [];
    var pending = outbox && typeof outbox.snapshot === 'function' ? outbox.snapshot().intents : [];
    var ids = liveSales().concat(confirmed, pending).map(function (sale) {
      var match = /^V-(\d+)$/.exec(String(sale.sale_id || sale.id || ''));
      return match ? Number(match[1]) : 0;
    });
    return 'V-' + String(Math.max.apply(Math, [0].concat(ids)) + 1).padStart(3, '0');
  }

  function pendingReferenceExists(reference) {
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
    if (!outbox || typeof outbox.snapshot !== 'function') return false;
    return outbox.snapshot().intents.some(function (intent) {
      return intent && intent.payment && intent.payment.reference === reference;
    });
  }
  function cents(value) { return Math.round(Number(value) * 100); }
  function setBusy(value) {
    busy = value;
    setLiveProcessing(value);
    var button = root.document && root.document.getElementById('mBtnConf');
    if (button) button.disabled = value;
  }
  function updateAfterCommit(saleId, confirmed) {
    clearLiveCart();
    if (typeof root.posUpdateCart === 'function') root.posUpdateCart(false);
    if (typeof root.posRender === 'function') root.posRender();
    if (runtime()) { runtime().closeModal('mCobro'); runtime().closeModal('mCobroRapido'); }
    else {
      var close; try { if (typeof cerrarModal === 'function') close = cerrarModal; } catch (_) {}
      if (!close) close = root.cerrarModal;
      if (typeof close === 'function') close('mCobro');
    }
    var drawer = root.document && root.document.getElementById('cartDrawer');
    var backdrop = root.document && root.document.getElementById('cartBackdrop');
    drawer && drawer.classList && drawer.classList.remove('open');
    backdrop && backdrop.classList && backdrop.classList.remove('open');
    // Nunca se muestra éxito antes de que el servidor confirme: primero «guardada», luego confirmada o ámbar.
    if (confirmed) notify('Venta ' + saleId + ' confirmada', 'success');
    else if (root.navigator && root.navigator.onLine === false) notify('Venta ' + saleId + ' guardada en este equipo, falta confirmar (sin conexión). Se enviará sola; no la cobres de nuevo.', 'warning');
    else notify('Venta ' + saleId + ' guardada. Confirmando con el servidor…', 'info');
  }
  function projectCurrentOutbox() {
    var canonical = root.NuevoAmanecerCanonical;
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
    var projector = root.NuevoAmanecerCanonicalSaleProjection;
    if (!canonical || typeof canonical.snapshot !== 'function' || !outbox || typeof outbox.snapshot !== 'function' || !projector || typeof projector.project !== 'function') throw new Error('CANONICAL_PROJECTION_UNAVAILABLE');
    var rawBase = canonical.snapshot();
    var base = { products: rawBase.products || [], customers: rawBase.customers || [], credits: rawBase.credits || [], sales: rawBase.sales || [] };
    projection = copy(projector.project(base, outbox.snapshot()));
    // P1-A (mobile): no listener reads the projection from the event and the
    // callers ignore the return value: two extra deep copies per sale removed.
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('na:canonical-sale-projection', { detail: { source: 'capture' } }));
    return true;
  }
  // Si el servidor no confirmó la venta recién guardada (error 5xx, sin red…), se avisa en ámbar que falta
  // confirmarla; queda en la cola y se confirma sola con el MISMO id.
  function warnIfUnconfirmed(outbox, saleId, why) {
    try {
      if (!saleId || typeof outbox.snapshot !== 'function') return;
      var still = (outbox.snapshot().intents || []).some(function (x) { return x && x.sale_id === saleId; });
      if (still) notify('Venta ' + saleId + ' guardada, falta confirmar con el servidor' + (why ? ' (' + why + ')' : '') + '. Se confirmará sola; no la cobres de nuevo.', 'warning');
    } catch (_) {}
  }
  function syncOutboxInBackground(outbox, saleId) {
    if (!outbox || typeof outbox.sync !== 'function') return;
    var run = function () {
      Promise.resolve().then(function () { return outbox.sync(); }).then(function (r) {
        var offline = root.navigator && root.navigator.onLine === false;
        if (r && /^(WAITING|BLOCKED_)/.test(String(r.status || ''))) warnIfUnconfirmed(outbox, saleId, offline || /OFFLINE|Failed to fetch|NetworkError|AUTHORITY_UNAVAILABLE|TIMEOUT/i.test(String(r.reason || '')) ? 'sin conexión' : /5\d\d|internal|storage/i.test(String(r.reason || '')) ? 'falla del servidor' : '');
        else if (saleId && !offline) { try { if (!(outbox.snapshot().intents || []).some(function (x) { return x && x.sale_id === saleId; })) notify('Venta ' + saleId + ' confirmada', 'success'); } catch (_) {} }
      }).catch(function (error) {
        warnIfUnconfirmed(outbox, saleId, root.navigator && root.navigator.onLine === false ? 'sin conexión' : 'falla del servidor');
        if (root.console && typeof root.console.warn === 'function')
          root.console.warn('[Venta CANON] Venta local conservada; sincronización pendiente', error && (error.code || error.message) || 'SYNC_FAILED');
      });
    };
    if (typeof root.setTimeout === 'function') root.setTimeout(run, 0);
    else Promise.resolve().then(run);
  }
  async function capture() {
    if (!enabled()) return;
    if (busy || liveProcessing()) return;
    var gate = canonicalSaleGate();
    if (!gate.ready) { failClosed(gate.reason, null); return; }
    try {
      var client = root.NuevoAmanecerCanonical;
      var pendingGate = client && typeof client.pendingSnapshot === 'function' ? client.pendingSnapshot() : null;
      var queue = root.NuevoAmanecerCanonicalSaleOutbox;
      // Capture is local-first: only a definitive sale.create rejection that
      // the background drain cannot resolve by itself stops new sales. Cash,
      // abono or inventory commands, 429/5xx and session errors never do.
      if (pendingGate && pendingGate.state === 'PENDING' && pendingGate.command === 'sale.create' && pendingGate.last_error &&
          [400, 404, 409].indexOf(pendingGate.last_status) !== -1 && !(queue && typeof queue.autoResolves === 'function' && queue.autoResolves(pendingGate))) {
        var blockedSale = pendingGate.payload && pendingGate.payload.sale_id || '';
        failClosed('La venta ' + blockedSale + ' fue rechazada por CANON (' + String(pendingGate.last_error) + ') y no se pudo apartar para revisión. Recarga la página; no la cobres de nuevo.', null);
        return;
      }
    } catch (_) {}
    try {
      if (typeof root.isModuleLocked !== 'function' || root.isModuleLocked('ventas', { canonicalSaleCapture: true })) {
        var lockReason = browserLockReason();
        failClosed(lockReason ? 'Venta bloqueada: ' + lockReason : 'Las ventas están bloqueadas', null); return;
      }
    } catch (lockError) {
      var caughtReason = browserLockReason();
      failClosed(caughtReason ? 'Venta bloqueada: ' + caughtReason : 'Las ventas están bloqueadas por un error interno de seguridad', lockError); return;
    }
    var cart = liveCart();
    if (!cart.length) { failClosed('El carrito está vacío.', null); return; }
    var sessionOpen = lexical('sessionOpen');
    if (sessionOpen && !sessionOpen()) { failClosed(closedTillMessage(), null); return; }
    var unitsSold = lexical('unitsSold'), tracksStock = lexical('tracksStock'), unitsPerQty = lexical('unitsPerQty');
    var productsById = new Map();
    liveProducts().forEach(function (product) {
      productsById.set(String(product.id), product);
    });
    var reservedByProduct = new Map();
    cart.forEach(function (item) {
      var key = String(item.id);
      var units = unitsSold ? unitsSold(item) : Number(item.qty);
      reservedByProduct.set(key, (reservedByProduct.get(key) || 0) + units);
    });
    for (var i = 0; i < cart.length; i += 1) {
      var item = cart[i];
      var product = productsById.get(String(item.id));
      if (product && (!tracksStock || tracksStock(product))) {
        var reserved = reservedByProduct.get(String(item.id)) || 0;
        if (reserved > Number(product.stock)) { failClosed('Stock insuficiente para ' + (product.name || item.name || item.id) + ': quedan ' + product.stock + ' unidades', null); return; }
      }
    }
    var paymentState = typeof root._naPaymentState === 'function' ? root._naPaymentState() : { valid: false, message: 'No se pudo validar el pago.' };
    if (!paymentState.valid) {
      if (typeof root._naSetPaymentHint === 'function') root._naSetPaymentHint(paymentState.message, 'error');
      failClosed(paymentState.message, null);
      if (typeof root._naPaymentFocusTarget === 'function') root._naPaymentFocusTarget()?.focus();
      return;
    }
    var method = livePaymentMethod();
    var mixed = method === 'mixto' && typeof root._naMixedPaymentData === 'function' ? root._naMixedPaymentData() : null;
    var digital = typeof root._naDigitalSalePayment === 'function' && root._naDigitalSalePayment();
    var verified = typeof root._naDigitalPaymentVerified === 'function' && root._naDigitalPaymentVerified();
    if (digital && !verified) { failClosed('Confirma que verificaste la recepción del pago digital.', null); return; }
    var reference = '';
    if (method === 'mixto') reference = mixed.reference;
    else if (['yape', 'plin', 'transferencia'].includes(method)) {
      var referenceInput = root.document && root.document.getElementById('mDigitalRef');
      var cleanText = lexical('clean');
      reference = cleanText ? cleanText(referenceInput && referenceInput.value) : String(referenceInput && referenceInput.value || '').trim();
    }
    try {
      if (reference && (liveSales().some(function (sale) { return !sale.anulada && sale.paymentRef === reference; }) || pendingReferenceExists(reference))) {
        failClosed('Ese número de operación ya fue registrado.', null); return;
      }
    } catch (referenceError) {
      failClosed('No se pudo validar la referencia contra las ventas locales.', referenceError); return;
    }
    var customer = null, due = null;
    var customerInputId = method === 'credito' ? 'mCreditoCliente' : 'mVentaCliente';
    var customerId = root.document && root.document.getElementById(customerInputId)?.value;
    if (customerId) {
      customer = liveCustomers().find(function (candidate) { return String(candidate.id) === String(customerId); });
      if (!customer) { failClosed('El cliente seleccionado ya no está disponible. Actualiza la lista y vuelve a intentarlo.', null); return; }
    }
    if (method === 'credito') {
      due = root.document && root.document.getElementById('mCreditoVence')?.value;
      if (!customer || !due) { failClosed('Selecciona cliente y fecha de vencimiento', null); return; }
    }
    var saleId = nextSaleId();
    var createdAt = new Date().toISOString();
    var input = {
      sale_id: saleId,
      created_at: createdAt,
      payment_method: method,
      items: cart.map(function (item) {
        var line = { quantity: Number(item.qty), precio: item.precio,
          unitsPerQty: unitsPerQty ? unitsPerQty(item) : 1,
          ventaModo: item.ventaModo, modo: item.modo, ventaLibre: !!item.ventaLibre,
          ventaSinStock: !!item.ventaSinStock, unidadesSinStock: item.unidadesSinStock };
        if (item.ventaLibre) {
          line.canonicalGenericId = item.canonicalGenericId;
          line.name = item.name || item.nombre || 'VARIOS';
          line.codigoIngresado = item.codigoIngresado || item.barcode || '';
          line.barcode = item.barcode || '';
          line.sku = item.sku || '';
        } else line.product_id = String(item.id);
        return line;
      })
    };
    if (method === 'mixto') {
      // Work in integer cents: digital is exactly total - cash, never two
      // independently rounded amounts that can miss the total by 1 céntimo.
      var totalCents = cart.reduce(function (sum, item) { return sum + cents(item.precio) * Number(item.qty); }, 0);
      var cashCents = cents(mixed.cash);
      input.payment = { cash_cents: cashCents, digital_cents: totalCents - cashCents, digital_method: mixed.digitalMethod, reference: reference };
    }
    else if (['yape', 'plin', 'transferencia'].includes(method)) input.payment = { reference: reference };
    if (customer && method !== 'credito') input.customer_id = customer.id;
    if (method === 'credito') {
      input.customer_id = customer.id; input.credit_due = due;
      var creditV2 = root.NA_CLIENT_CREDIT_ACCOUNTS_V2 && typeof root.NA_CLIENT_CREDIT_ACCOUNTS_V2.saleDraft === 'function'
        ? root.NA_CLIENT_CREDIT_ACCOUNTS_V2.saleDraft() : null;
      if (creditV2 && creditV2.account) input.credit_account = copy(creditV2.account);
      if (creditV2 && Array.isArray(creditV2.installment_dates) && creditV2.installment_dates.length) input.installment_dates = copy(creditV2.installment_dates);
    }
    var receiptItems=copy(cart),receiptReceived=method==='efectivo'?Number(root.document.getElementById('mMontoRec')?.value):method==='mixto'?mixed.cash:cart.reduce(function(sum,item){return sum+Number(item.qty)*Number(item.precio);},0);
    var cashTill = (method === 'efectivo' || method === 'mixto') ? openCanonicalSession() : null;
    if (cashTill) input.session_id = cashTill;
    var getBusiness = lexical('getBusiness');
    var receiptCashier=root._naCashierSnapshot?.()||{nombre:getBusiness?getBusiness().cajero||'':''};
    var durable = false;
    var ownsBusy = true;
    setBusy(true);
    try {
      var intentApi = root.NuevoAmanecerCanonicalSaleIntent;
      var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
      if (!intentApi || typeof intentApi.build !== 'function' || !outbox || typeof outbox.enqueue !== 'function') throw new Error('CANONICAL_SALE_CAPTURE_UNAVAILABLE');
      var intent = intentApi.build(input);
      intent = await outbox.enqueue(intent);
      saleId = intent.sale_id;
      durable = true;

      // The commercial action ends at the durable local commit. Update the
      // projected stock/sales immediately, release the cashier UI, and let the
      // cloud drain happen independently. This preserves A4 even while CANON is
      // validating, offline, slow, or carrying an earlier pending operation.
      updateAfterCommit(saleId, false);
      try { projectCurrentOutbox(); }
      catch (projectionError) { failClosed('Venta ' + saleId + ' guardada localmente. No se pudo actualizar la proyección.', projectionError); }
      setBusy(false);
      ownsBusy = false;
      syncOutboxInBackground(outbox, saleId);
      try {
        var share=root.NAReceiptShare;
        if(share){
          var when=new Date(createdAt),received=receiptReceived;
          var saleReceipt={id:saleId,operation_id:intent.operation_id,fecha:when.toLocaleDateString('en-CA',{timeZone:'America/Lima'}),hora:when.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour12:true}),metodo:method,items:receiptItems,clienteId:customer?.id||null,clienteNombre:customer?.nombre||'',cajero:receiptCashier.nombre,recibido:received,vuelto:method==='efectivo'?Math.max(0,received-intent.total_cents/100):0,paymentRef:reference,paymentBreakdown:mixed?{efectivo:mixed.cash,digital:mixed.digital,digitalMethod:mixed.digitalMethod}:null};
          share.onSale(saleReceipt,customer,{pendingSync:true,due:due});
        }
      } catch(shareError){root.console?.warn('[Comprobante venta]',shareError.message);}
      return { status: 'PENDING_SYNC', operation_id: intent.operation_id, sale_id: saleId };
    } catch (error) {
      if (durable) {
        updateAfterCommit(saleId, false);
        try { projectCurrentOutbox(); } catch (_) {}
        failClosed('Venta ' + saleId + ' guardada localmente · pendiente de sincronización.', error);
      } else failClosed(captureErrorMessage(error), error);
    } finally { if (ownsBusy) setBusy(false); }
  }
  function wrappedConfirm() {
    if (!enabled()) return typeof originalConfirm === 'function' ? originalConfirm.apply(this, arguments) : undefined;
    return capture();
  }
  root.confirmarVenta = wrappedConfirm;
  root.NuevoAmanecerCanonicalSaleIntegration = Object.freeze({ VERSION: VERSION, capture: capture, lastProjection: function () { return copy(projection); }, enabled: enabled });
})(globalThis);
