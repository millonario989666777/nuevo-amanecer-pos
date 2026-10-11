(function (root) {
  'use strict';

  if (!root || !root.document) return;

  var original = {
    abrirModalApertura: root.abrirModalApertura,
    abrirCaja: root.abrirCaja,
    abrirMovCaja: root.abrirMovCaja,
    guardarMovCaja: root.guardarMovCaja,
    cerrarCaja: root.cerrarCaja
  };

  var openingBusy = false;
  var movementBusy = false;
  var closingBusy = false;

  function api() {
    return root.NuevoAmanecerCanonical;
  }

  function enabled() {
    var client = api();
    try {
      return !!(client && typeof client.enabled === 'function' && client.enabled());
    } catch (_) {
      return false;
    }
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback === undefined ? 0 : fallback);
  }

  function cents(value) {
    var amount = number(value, NaN);
    if (!Number.isFinite(amount) || amount < 0) return null;
    var result = Math.round(amount * 100);
    return Number.isSafeInteger(result) ? result : null;
  }

  function clean(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  function notify(message, tone) {
    var fn; try { if (typeof toast === 'function') fn = toast; } catch (_) {}
    if (!fn) fn = root.toast;
    if (typeof fn === 'function') fn(message, tone || 'error');
  }

  function renderCash() {
    // cajRender already updates the dashboard. Only fall back if unavailable.
    if (typeof root.cajRender === 'function') root.cajRender();
    else if (typeof root.updateDashboard === 'function') root.updateDashboard();
  }

  async function refreshCanonical() {
    var client = api();
    if (!client || typeof client.refresh !== 'function') throw new Error('CANONICAL_CLIENT_UNAVAILABLE');
    await client.refresh();
  }

  async function prepare(command) {
    var client = api();
    if (client && typeof client.prepareCommand === 'function') return client.prepareCommand(command);
    return refreshCanonical();
  }
  function refreshAfterReceipt() {
    Promise.resolve().then(refreshCanonical).then(renderCash).catch(function (error) {
      if (root.console) root.console.warn('[Caja CANON] Confirmada; actualización pendiente', error.message);
    });
  }
  function closeModal(id) {
    var fn; try { if (typeof cerrarModal === 'function') fn = cerrarModal; } catch (_) {}
    if (!fn) fn = root.cerrarModal;
    if (typeof fn === 'function') fn(id);
    else root.document.getElementById(id)?.classList.remove('open');
  }

  function authorizeCash(reason) {
    if (typeof root._naF10AuthorizePermission === 'function') {
      return root._naF10AuthorizePermission('cash', reason) !== false;
    }
    return true;
  }

  function authorizeClose() {
    if (typeof root._naAuthorize === 'function') {
      return root._naAuthorize('cerrarCaja', 'Cerrar caja del día') !== false;
    }
    return true;
  }

  function selectedCashier() {
    var value = root.document.getElementById('cajCajero')?.value;
    if (typeof root._naFindCashier === 'function') return root._naFindCashier(value);
    if (typeof root._naCashierSnapshot === 'function') return root._naCashierSnapshot(value);
    return value ? { id: value, nombre: value } : null;
  }

  function verifyCashierPin(cashier) {
    if (typeof root._naF10VerifyCashierPin !== 'function') return true;
    return root._naF10VerifyCashierPin(cashier, 'Abrir caja con esta identidad') !== false;
  }

  function setMovementMethodCanonical(active) {
    var field = root.document.getElementById('cajMovMetodo');
    if (!field) return;
    if (active) {
      field.value = 'efectivo';
      field.disabled = true;
      field.setAttribute('data-na-canonical-cash-only', 'true');
    } else {
      field.disabled = false;
      field.removeAttribute('data-na-canonical-cash-only');
    }
  }

  function showOpeningModal() {
    var fund = root.document.getElementById('cajFondo');
    if (fund) fund.value = '';
    if (typeof root._naPopulateCashierSelect === 'function') {
      var activeCashierId = root.appConfig && root.appConfig.activeCashierId;
      root._naPopulateCashierSelect('cajCajero', activeCashierId);
    }
    root.document.getElementById('mApertura')?.classList.add('open');
  }

  function showMovementModal(type) {
    var colors = { ing: 'green', egr: 'red' };
    var icons = { ing: '💵', egr: '💸' };
    var labels = { ing: 'Ingreso', egr: 'Egreso' };
    var categories = {
      ing: ['Venta retail','Venta bebidas','Venta snacks','Venta limpieza','Otro ingreso'],
      egr: ['Retiro de caja','Pago a proveedor','Pago servicios','Otro egreso']
    };

    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    if (runtime) runtime.setMovementType(type);
    else if (typeof cajMovTipo !== 'undefined') cajMovTipo = type;
    else root.cajMovTipo = type;
    var head = root.document.getElementById('mMovCajaHead');
    var title = root.document.getElementById('mMovCajaTit');
    var button = root.document.getElementById('cajMovBtn');
    var amount = root.document.getElementById('cajMovMonto');
    var desc = root.document.getElementById('cajMovDesc');
    var cat = root.document.getElementById('cajMovCat');

    if (head) head.className = 'mhead ' + colors[type];
    if (title) title.textContent = icons[type] + ' ' + labels[type];
    if (button) button.className = 'mbtn mbtn-ok ' + colors[type];
    if (amount) amount.value = '';
    if (desc) desc.value = '';
    if (cat) {
      cat.replaceChildren();
      categories[type].forEach(function (name) {
        var option = root.document.createElement('option');
        option.textContent = name;
        option.value = name;
        cat.append(option);
      });
    }
    setMovementMethodCanonical(true);
    root.document.getElementById('mMovCaja')?.classList.add('open');
  }

  root.abrirModalApertura = function () {
    if (!enabled()) return typeof original.abrirModalApertura === 'function' ? original.abrirModalApertura.apply(this, arguments) : undefined;
    if (!authorizeCash('Abrir caja')) return;
    showOpeningModal();
  };

  root.abrirCaja = async function () {
    if (!enabled()) return typeof original.abrirCaja === 'function' ? original.abrirCaja.apply(this, arguments) : false;
    if (openingBusy) return false;
    if (!authorizeCash('Confirmar apertura de caja')) return false;

    var cashier = selectedCashier();
    if (!cashier || !cashier.id) {
      notify('Selecciona un cajero activo', 'error');
      return false;
    }
    if (!verifyCashierPin(cashier)) return false;

    var openingCents = cents(root.document.getElementById('cajFondo')?.value || 0);
    if (openingCents === null) {
      notify('Ingresa un fondo inicial válido', 'error');
      return false;
    }

    var button = root.document.querySelector('#mApertura .mbtn-ok');
    var label = button?.textContent || '✅ Abrir caja';
    openingBusy = true;
    if (button) { button.disabled = true; button.textContent = 'Procesando…'; }

    try {
      await prepare('cash.open');
      var client = api();
      var id = root.crypto && typeof root.crypto.randomUUID === 'function'
        ? root.crypto.randomUUID()
        : 'cash-' + Date.now().toString(36);
      await client.openCash({ session_id: id, opening_cents: openingCents });
      refreshAfterReceipt();
      closeModal('mApertura');
      renderCash();
      notify('Caja CANON abierta con S/ ' + (openingCents / 100).toFixed(2), 'success');
      return true;
    } catch (error) {
      notify('No se pudo abrir la caja CANON: ' + clean(error && error.message), 'error');
      return false;
    } finally {
      openingBusy = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };

  root.abrirMovCaja = function (type) {
    if (!enabled()) {
      setMovementMethodCanonical(false);
      return typeof original.abrirMovCaja === 'function' ? original.abrirMovCaja.apply(this, arguments) : undefined;
    }
    if (!authorizeCash('Registrar movimiento de caja')) return;
    if (typeof root._naSessionOpen === 'function' && !root._naSessionOpen()) {
      notify('Abre la caja del día primero', 'error');
      return;
    }
    if (type === 'cob') {
      notify('Los cobros de crédito CANON se registran desde Clientes y Créditos.', 'error');
      return;
    }
    if (type === 'gas') {
      notify('Los gastos CANON aún no tienen una fuente financiera autorizada. No se registró ningún movimiento.', 'error');
      return;
    }
    if (type !== 'ing' && type !== 'egr') {
      notify('Movimiento de caja no compatible con CANON', 'error');
      return;
    }
    showMovementModal(type);
  };

  root.guardarMovCaja = async function () {
    if (!enabled()) return typeof original.guardarMovCaja === 'function' ? original.guardarMovCaja.apply(this, arguments) : undefined;
    if (movementBusy) return false;
    if (!authorizeCash('Guardar movimiento de caja')) return false;
    if (typeof root._naSessionOpen === 'function' && !root._naSessionOpen()) {
      notify('La caja no está abierta', 'error');
      return false;
    }

    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    var type = runtime ? runtime.movementType() : (typeof cajMovTipo !== 'undefined' ? cajMovTipo : root.cajMovTipo);
    if (type !== 'ing' && type !== 'egr') {
      notify(type === 'cob'
        ? 'Registra el cobro desde Clientes y Créditos.'
        : 'Este tipo de movimiento aún no tiene escritura CANON autorizada.', 'error');
      return false;
    }

    var amountCents = cents(root.document.getElementById('cajMovMonto')?.value);
    var description = clean(root.document.getElementById('cajMovDesc')?.value);
    var category = clean(root.document.getElementById('cajMovCat')?.value);
    if (!amountCents || !description) {
      notify('Completa monto y concepto', 'error');
      return false;
    }

    var signed = type === 'egr' ? -amountCents : amountCents;
    var reason = (type === 'ing' ? 'Ingreso' : 'Egreso') + (category ? ' · ' + category : '') + ' · ' + description;
    var button = root.document.getElementById('cajMovBtn');
    var label = button?.textContent || '✅ Registrar';
    movementBusy = true;
    if (button) { button.disabled = true; button.textContent = 'Procesando…'; }

    try {
      await prepare('adjustment.create');
      await api().createAdjustment({ amount_cents: signed, reason: reason.slice(0, 500) });
      refreshAfterReceipt();
      closeModal('mMovCaja');
      renderCash();
      notify((type === 'ing' ? 'Ingreso' : 'Egreso') + ' CANON de S/ ' + (amountCents / 100).toFixed(2) + ' registrado', 'success');
      return true;
    } catch (error) {
      notify('No se pudo registrar el movimiento CANON: ' + clean(error && error.message), 'error');
      return false;
    } finally {
      movementBusy = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };

  function pendingClose(client) {
    var record = typeof client.pendingSnapshot === 'function' ? client.pendingSnapshot() : null;
    return record && record.command === 'cash.close' ? record : null;
  }

  async function settlePendingClose(client) {
    var record = pendingClose(client);
    if (!record) return null;
    if (!(record.last_status === 409 && record.last_error === 'stale_session')) {
      // Lost acknowledgements replay the original amount and operation ID.
      try { return { receipt: await client.retryPending() }; }
      catch (error) {
        record = pendingClose(client);
        if (!record || record.last_status !== 409 || record.last_error !== 'stale_session') throw error;
      }
    }
    await refreshCanonical();
    var recovered = await client.releaseRejectedCashClose();
    if (!recovered) throw new Error('CANONICAL_FINANCIAL_PENDING');
    return recovered;
  }

  async function closeCanonicalCash(countedCents) {
    var client = api(), recovered = await settlePendingClose(client);
    if (recovered && (recovered.receipt || recovered.status === 'CLOSED')) return recovered;
    var sessionId = recovered && recovered.session_id;
    if (!sessionId && typeof client.snapshot === 'function') {
      var open = (client.snapshot().cashSessions || []).filter(function (item) { return item.status === 'OPEN'; });
      if (open.length === 1) sessionId = open[0].session_id;
    }
    // Do not strand durable local sales by closing their cash session first.
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
    async function submit(processed) {
      if (processed > 0) await refreshCanonical();
      await prepare('cash.close');
      var input = { counted_cents: countedCents };
      if (sessionId) input.session_id = sessionId;
      try { return { receipt: await client.closeCash(input) }; }
      catch (error) {
        var record = pendingClose(client);
        if (!record || record.last_status !== 409 || record.last_error !== 'stale_session') throw error;
        // One bounded recovery, never an unlimited retry loop.
        recovered = await settlePendingClose(client);
        if (recovered.status === 'CLOSED') return recovered;
        input.session_id = recovered.session_id;
        return { receipt: await client.closeCash(input) };
      }
    }
    if (outbox && typeof outbox.withCashCloseBarrier === 'function') return outbox.withCashCloseBarrier(submit);
    // Compatibility for a runtime that has not loaded the updated outbox yet.
    if (outbox && outbox.snapshot().intents.length) throw new Error('CASH_CLOSE_PENDING_SALES');
    return submit(0);
  }

  root.cerrarCaja = async function () {
    if (!enabled()) return typeof original.cerrarCaja === 'function' ? original.cerrarCaja.apply(this, arguments) : undefined;
    if (closingBusy) return false;
    if (!authorizeClose()) return false;

    var countedCents = cents(root.document.getElementById('cajContado')?.value);
    if (countedCents === null) {
      notify('Ingresa el efectivo contado', 'error');
      return false;
    }

    var button = root.document.querySelector('#mCierre .mbtn-ok');
    var label = button?.textContent || '🔒 Confirmar cierre';
    closingBusy = true;
    if (button) { button.disabled = true; button.textContent = 'Procesando…'; }

    try {
      var outcome = await closeCanonicalCash(countedCents);
      refreshAfterReceipt();
      closeModal('mCierre');
      renderCash();
      var actualCount = outcome.receipt && outcome.receipt.counted_cents;
      notify(outcome.status === 'CLOSED' ? 'Esta caja ya estaba cerrada. Estado actualizado.' :
        'Caja CANON cerrada correctamente' + (Number.isSafeInteger(actualCount) && actualCount !== countedCents
          ? ' · Efectivo registrado: S/ ' + (actualCount / 100).toFixed(2) : ''), 'success');
      return true;
    } catch (error) {
      var code = clean(error && error.message);
      notify(code === 'CASH_CLOSE_PENDING_SALES' ? 'Hay ventas pendientes de sincronizar. La caja sigue abierta; revisa la conexión y vuelve a confirmar.' :
        code === 'CANONICAL_FINANCIAL_PENDING' ? 'Hay una operación financiera pendiente de confirmar. Se conservó el registro; la caja sigue abierta.' :
        'No se pudo cerrar la caja CANON: ' + code, 'error');
      return false;
    } finally {
      closingBusy = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };

  root.NuevoAmanecerCanonicalCashBridge = Object.freeze({
    enabled: enabled,
    originalHandlers: function () { return Object.assign({}, original); }
  });
})(globalThis);
