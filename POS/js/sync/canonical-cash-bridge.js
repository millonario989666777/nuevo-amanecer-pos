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
    try { renderReview(); } catch (_) {}
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

  function closeStatus(message) {
    var node = root.document.getElementById('cajCloseStatus');
    if (!node) {
      var body = root.document.querySelector('#mCierre .mbody');
      if (!body) return;
      node = root.document.createElement('div');
      node.id = 'cajCloseStatus';
      node.setAttribute('role', 'alert');
      node.style.cssText = 'padding:10px;margin:10px 0;border:1px solid #fecaca;border-radius:10px;background:#fef2f2;color:#991b1b;font-size:13px;overflow-wrap:anywhere';
      body.insertBefore(node, body.querySelector('.mbtns'));
    }
    node.textContent = message || '';
    node.hidden = !message;
  }

  function blockingSale(error, record) {
    var saleId = error && error.sale_id || record && record.command === 'sale.create' && record.payload && record.payload.sale_id;
    if (!saleId) return '';
    var reason = error && error.reason || record && record.last_error;
    return ' Venta bloqueante: ' + clean(saleId) + (reason ? ' · ' + clean(reason) : '') +
      (error && error.remaining > 1 ? ' (+' + (error.remaining - 1) + ' detrás)' : '') + '. No la cobres de nuevo.';
  }

  // Compact review list inside Caja (and the close dialog). Nothing is deleted.
  // Verify asks the server; retry resends the same operation_id (only for
  // causes that can clear); annul appears only after the server confirms the
  // sale is not registered, and keeps the record archived.
  function renderReview() {
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox, doc = root.document;
    if (!doc || !outbox || typeof outbox.quarantine !== 'function') return;
    var entries = [];
    try { entries = outbox.quarantine().entries.filter(function (entry) { return entry.status === 'QUARANTINED'; }); } catch (_) { return; }
    ['cajContent', 'cajCloseStatus'].forEach(function (hostId) {
      var host = doc.getElementById(hostId);
      if (!host || typeof host.appendChild !== 'function') return;
      var old = doc.getElementById(hostId + 'Review');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      if (!entries.length) return;
      var box = doc.createElement('div');
      box.id = hostId + 'Review';
      box.style.cssText = 'margin:8px;padding:10px;border:1px solid #fcd34d;border-radius:10px;background:#fffbeb;color:#78350f;font-size:13px';
      var title = doc.createElement('div');
      title.style.fontWeight = '800';
      title.textContent = '⚠ Ventas en revisión (' + entries.length + '). No las cobres de nuevo. La caja no se cierra hasta conciliarlas.';
      box.appendChild(title);
      entries.forEach(function (entry) {
        var intent = entry.intent, row = doc.createElement('div');
        row.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center';
        var info = doc.createElement('span');
        info.textContent = clean(intent.sale_id) + ' · S/ ' + ((Number(intent.total_cents) || 0) / 100).toFixed(2) + ' · ' + clean(intent.payment_method) +
          ' · motivo: ' + clean(entry.reason) + ' · estado: ' + (entry.verified_absent_at ? 'no registrada en el servidor' : 'sin confirmar en el servidor');
        row.appendChild(info);
        function action(label, kind, run) {
          var el = doc.createElement('button');
          el.type = 'button'; el.className = 'btn'; el.textContent = label;
          el.setAttribute('data-review', kind + ':' + intent.operation_id);
          el.onclick = async function () {
            el.disabled = true;
            try { closeStatus(await run()); } catch (failure) { closeStatus('No se pudo resolver ' + clean(intent.sale_id) + ': ' + clean(failure && (failure.code || failure.message))); }
            finally { el.disabled = false; renderReview(); }
          };
          row.appendChild(el);
        }
        action('Verificar en servidor', 'verify', async function () {
          var done = await outbox.resolveQuarantined(intent.operation_id, 'verify');
          return done.status === 'CONFIRMED_REMOTE' ? 'Venta ' + clean(intent.sale_id) + ' ya está registrada en el servidor. Conciliada.'
            : 'Venta ' + clean(intent.sale_id) + ' NO está registrada en el servidor. No la cobres de nuevo sin hablar con el cliente.';
        });
        if (typeof outbox.quarantineRetryable === 'function' && outbox.quarantineRetryable(entry.reason)) action('Reintentar', 'retry', async function () {
          await outbox.resolveQuarantined(intent.operation_id, 'retry');
          var outcome = await outbox.sync();
          return 'Venta ' + clean(intent.sale_id) + ' reenviada con el mismo identificador: ' + clean(outcome.status) + (outcome.reason ? ' · ' + clean(outcome.reason) : '') + '.';
        });
        if (entry.verified_absent_at && typeof outbox.quarantineAnnullable === 'function' && outbox.quarantineAnnullable(entry)) action('Anular venta no registrada', 'archive', async function () {
          if (typeof root._naAuthorize === 'function' && !root._naAuthorize('anularVenta', 'Anular venta no registrada ' + clean(intent.sale_id))) return 'Anulación cancelada.';
          if (typeof root.confirm !== 'function' || !root.confirm('¿Anular ' + clean(intent.sale_id) + '? No está en el servidor. El registro se conserva archivado.')) return 'Anulación cancelada.';
          var who = root.cajEstado && (root.cajEstado.cajero || root.cajEstado.cashier_id) || null;
          await outbox.resolveQuarantined(intent.operation_id, 'archive', { by: who });
          if (typeof root._naAudit === 'function') root._naAudit('Anulación de venta no registrada', clean(intent.sale_id) + ' · ' + clean(intent.operation_id));
          return 'Venta ' + clean(intent.sale_id) + ' anulada como no registrada (registro conservado).';
        });
        box.appendChild(row);
      });
      host.insertBefore && host.firstChild ? host.insertBefore(box, host.firstChild) : host.appendChild(box);
    });
  }
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('na:canonical-sale-projection', function () { try { renderReview(); } catch (_) {} });
    root.addEventListener('na:canonical-updated', function () { try { renderReview(); } catch (_) {} });
  }

  function closeFailure(error) {
    var code = clean(error && error.message), record;
    try { record = api().pendingSnapshot(); } catch (_) {}
    if (record) return 'Operación pendiente: ' + clean(record.command) +
      (record.last_status ? ' · HTTP ' + record.last_status : '') +
      (record.last_error ? ' · ' + clean(record.last_error) : ' · sin confirmación del servidor') +
      '. Se conservó el registro. Revisa esta operación antes de cerrar.' + blockingSale(error, record) + ' ' + code;
    if (code === 'CASH_CLOSE_QUARANTINED_SALES') return 'Hay ventas en revisión que impiden cerrar esta caja hasta conciliarlas. Las demás ventas, abonos y egresos siguen funcionando.' +
      blockingSale(error, null);
    if (code === 'CASH_CLOSE_PENDING_SALES') return 'Hay ventas pendientes de sincronizar. La caja sigue abierta; revisa la conexión y vuelve a confirmar.' +
      blockingSale(error, null);
    return 'No se pudo cerrar la caja CANON: ' + code;
  }

  async function settleOtherFinancialPending(client) {
    var record = typeof client.pendingSnapshot === 'function' ? client.pendingSnapshot() : null;
    if (!record || record.command === 'cash.close' || record.command === 'sale.create') return;
    // Finish only the exact durable financial operation previously authorized.
    // Definitive rejects need their own module; never discard/rebuild them here.
    if (!['payment.create','payment.batch','adjustment.create','expense.create','compensation.create'].includes(record.command) ||
        (record.last_status && record.last_status < 500 && record.last_status !== 429)) throw new Error('CANONICAL_FINANCIAL_PENDING');
    await client.retryPending();
    await refreshCanonical();
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
    await settleOtherFinancialPending(client);
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
    closeStatus('');
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
      var message = closeFailure(error);
      closeStatus(message);
      if (error && error.code === 'CASH_CLOSE_QUARANTINED_SALES') { try { renderReview(); } catch (_) {} }
      notify(message, 'error');
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
