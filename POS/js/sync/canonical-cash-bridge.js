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
    try { keepReviewVisible(); } catch (_) {}
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
  // Spanish, actionable text for a failed cash command (C-P0-1).
  function commandFailureText(error) {
    var code = clean(error && (error.code || error.message));
    var record = null;
    try { record = api().pendingSnapshot(); } catch (_) {}
    if (/REJECTED_4\d\d/.test(code)) return 'CANON lo rechazó' + (record && record.last_error ? ' (' + clean(record.last_error) + ')' : '') +
      '. No se aplicó nada: vuelve a intentarlo (los datos ya se actualizaron).';
    if (code === 'CANONICAL_FINANCIAL_PENDING' || /TIMEOUT|HTTP_5|HTTP_429|Failed to fetch|NetworkError/i.test(code))
      return 'sin confirmación del servidor. Vuelve a intentarlo: se reenvía la MISMA operación y no se duplica.';
    return code;
  }
  // C-P0-1: release/replay a stranded cash operation before a new one. Returns
  // true when the replay confirmed the SAME kind of operation the cashier is
  // retrying, so the caller must not register it twice.
  async function settleStranded(command) {
    var client = api();
    if (!client || typeof client.settleStrandedFinancial !== 'function') return false;
    var settled = await client.settleStrandedFinancial();
    if (!settled || settled.status !== 'REPLAYED') return false;
    refreshAfterReceipt();
    return settled.command === command;
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
      if (await settleStranded('cash.open')) {
        closeModal('mApertura');
        renderCash();
        notify('La apertura anterior sí llegó al servidor: la caja CANON ya está abierta.', 'success');
        return true;
      }
      await prepare('cash.open');
      var client = api();
      var id = root.crypto && typeof root.crypto.randomUUID === 'function'
        ? root.crypto.randomUUID()
        : 'cash-' + Date.now().toString(36);
      await client.openCash({ session_id: id, opening_cents: openingCents });
      try { root.NuevoAmanecerCashHistory?.rememberCashier(id, cashier); } catch (_) {}
      refreshAfterReceipt();
      closeModal('mApertura');
      renderCash();
      notify('Caja CANON abierta con S/ ' + (openingCents / 100).toFixed(2), 'success');
      return true;
    } catch (error) {
      notify('No se pudo abrir la caja CANON: ' + commandFailureText(error), 'error');
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
      if (await settleStranded('adjustment.create')) {
        closeModal('mMovCaja');
        renderCash();
        notify('El movimiento anterior sí llegó al servidor. Revisa la lista antes de registrar otro.', 'success');
        return true;
      }
      await prepare('adjustment.create');
      await api().createAdjustment({ amount_cents: signed, reason: reason.slice(0, 500) });
      refreshAfterReceipt();
      closeModal('mMovCaja');
      renderCash();
      notify((type === 'ing' ? 'Ingreso' : 'Egreso') + ' CANON de S/ ' + (amountCents / 100).toFixed(2) + ' registrado', 'success');
      return true;
    } catch (error) {
      notify('No se pudo registrar el movimiento CANON: ' + commandFailureText(error), 'error');
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
    node.style.background = '#fef2f2'; node.style.borderColor = '#fecaca'; node.style.color = '#991b1b';
    node.textContent = message || '';
    node.hidden = !message;
    return node;
  }

  // Motivo en palabras simples (sin códigos técnicos).
  function saleReasonText(reason) {
    var r = clean(reason);
    if (!r) return '';
    if ((root.navigator && root.navigator.onLine === false) || /OFFLINE|Failed to fetch|NetworkError|Load failed|AUTHORITY_UNAVAILABLE|TIMEOUT|network/i.test(r)) return ' (sin conexión)';
    if (/_5\d\d\b|_5\d\d$|internal|storage|service_unavailable/i.test(r)) return ' (el servidor respondió con un error)';
    if (/429/.test(r)) return ' (servidor ocupado)';
    var out = root.NuevoAmanecerCanonicalSaleOutbox;
    try { if (out && typeof out.reasonText === 'function' && !/^[A-Z_0-9]+$/.test(r)) return ' (' + out.reasonText(r) + ')'; } catch (_) {}
    return ' (el servidor no la confirmó)';
  }
  function blockingSale(error, record) {
    var saleId = error && error.sale_id || record && record.command === 'sale.create' && record.payload && record.payload.sale_id;
    if (!saleId) return '';
    var reason = error && error.reason || record && record.last_error;
    return ' Venta pendiente: ' + clean(saleId) + saleReasonText(reason) +
      (error && error.remaining > 1 ? ' y ' + (error.remaining - 1) + ' más' : '') + '. No la cobres de nuevo.';
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
      var blocking = 0; try { blocking = typeof outbox.blocking === 'function' ? outbox.blocking().length : entries.length; } catch (_) { blocking = entries.length; }
      title.textContent = 'Ventas en revisión (' + entries.length + '). No las cobres de nuevo.' + (blocking ? ' La caja actual no se cierra hasta conciliar ' + (blocking === 1 ? 'la suya' : 'sus ' + blocking) + '.' : ' Son de una caja anterior: no impiden cerrar la caja actual.');
      box.appendChild(title);
      entries.forEach(function (entry) {
        var intent = entry.intent, row = doc.createElement('div');
        row.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center';
        var info = doc.createElement('span');
        var ses = null; try { ses = typeof outbox.sessionOf === 'function' ? outbox.sessionOf(intent) : null; } catch (_) {}
        var when = ses && ses.opened_at ? new Date(ses.opened_at) : null;
        var cajaTxt = when && !isNaN(when) ? 'Caja del ' + when.toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit' }) + ', ' + when.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }) + (ses.status === 'CLOSED' ? ' (cerrada)' : '') + ' · ' : '';
        info.textContent = cajaTxt + clean(intent.sale_id) + ' · S/ ' + ((Number(intent.total_cents) || 0) / 100).toFixed(2) + ' · ' + clean(intent.payment_method) +
          ' · motivo: ' + (entry.reason === 'credit_limit_exceeded' ? 'el crédito supera la línea disponible del cliente (cobre un abono o amplíe la línea y reintente)' : typeof outbox.reasonText === 'function' ? outbox.reasonText(entry.reason) : 'el servidor no la aceptó') + ' · estado: ' + (entry.verified_absent_at ? 'no registrada en el servidor' : 'sin confirmar en el servidor');
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
        var rebinds = typeof outbox.quarantineRebindsOnRetry === 'function' && outbox.quarantineRebindsOnRetry(entry.reason);
        var retryLabel = rebinds ? 'Registrar en la caja abierta' : entry.reason === 'promotion_changed' ? 'Reenviar en este equipo' : 'Reintentar';
        if (typeof outbox.quarantineRetryable === 'function' && outbox.quarantineRetryable(entry.reason)) action(retryLabel, 'retry', async function () {
          var meta = undefined, moved = '';
          if (rebinds) {
            var target = typeof outbox.rebindTarget === 'function' ? outbox.rebindTarget() : null;
            if (!target) return 'No hay una caja abierta en CANON. Abre la caja y vuelve a intentar; ' + clean(intent.sale_id) + ' sigue en revisión.';
            var from = intent.session_id ? 'caja ' + clean(intent.session_id).slice(0, 8) : 'sin caja registrada';
            var to = 'caja ' + clean(target.session_id).slice(0, 8) + (target.opened_at ? ' abierta el ' + clean(target.opened_at).slice(0, 10) : '');
            if (typeof root.confirm !== 'function' || !root.confirm('¿Registrar ' + clean(intent.sale_id) + ' en la ' + to + '? Pertenecía a la ' + from + ', que ya está cerrada. Su efectivo contará en la caja actual.')) return 'Reintento cancelado.';
            meta = { targetSessionId: target.session_id, by: root.cajEstado && (root.cajEstado.cajero || root.cajEstado.cashier_id) || null };
            moved = ' Pasó de la ' + from + ' a la ' + to + '.';
            if (typeof root._naAudit === 'function') root._naAudit('Venta pasada a otra caja', clean(intent.sale_id) + ' · ' + from + ' → ' + to);
          }
          await outbox.resolveQuarantined(intent.operation_id, 'retry', meta);
          var outcome = await outbox.sync();
          return 'Venta ' + clean(intent.sale_id) + ' reenviada con el mismo identificador: ' + clean(outcome.status) + (outcome.reason ? ' · ' + clean(outcome.reason) : '') + '.' + moved;
        });
        if (entry.verified_absent_at && typeof outbox.quarantineAnnullable === 'function' && outbox.quarantineAnnullable(entry)) action('Anular venta no registrada', 'archive', async function () {
          if (typeof root._naAuthorize !== 'function' || !root._naAuthorize('anularVenta', 'Anular venta no registrada ' + clean(intent.sale_id))) return 'Anulación cancelada.';
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
  // Caja is redrawn by cajRender (reassigned by several legacy scripts that
  // load after this one), which wipes #cajContent. Keep the review block
  // alive: wrap the final cajRender lazily and, in browsers, watch the node.
  var observing = false;
  function keepReviewVisible() {
    var current = root.cajRender;
    if (typeof current === 'function' && !current.__naReview) {
      var wrapped = function () { try { return current.apply(this, arguments); } finally { try { renderReview(); } catch (_) {} } };
      wrapped.__naReview = true;
      root.cajRender = wrapped;
    }
    var host = root.document && root.document.getElementById && root.document.getElementById('cajContent');
    if (!observing && host && typeof root.MutationObserver === 'function') {
      observing = true;
      new root.MutationObserver(function () {
        if (!root.document.getElementById('cajContentReview')) { try { renderReview(); } catch (_) {} }
      }).observe(host, { childList: true });
    }
  }
  function refreshReview() { try { keepReviewVisible(); renderReview(); } catch (_) {} }
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('na:canonical-sale-projection', refreshReview);
    root.addEventListener('na:canonical-updated', refreshReview);
    root.addEventListener('load', refreshReview);
  }

  function closeFailure(error) {
    var code = clean(error && error.message), record;
    try { record = api().pendingSnapshot(); } catch (_) {}
    if (record && record.command === 'cash.close') return 'El cierre de caja NO se confirmó' + (record.last_status >= 500 ? ': el servidor respondió con un error' : ' (no llegó respuesta)') +
      (lastServerCheck === 'OPEN' ? '. El servidor dice que la caja sigue abierta; no se cerrará sola: toca Confirmar cierre otra vez (no se cerrará dos veces).'
        : record.last_status >= 500 ? '. Toca Confirmar cierre otra vez para preguntarle si la caja quedó cerrada (no se cerrará dos veces).'
        : '. No se pudo comprobar con el servidor si la caja quedó cerrada. Toca Confirmar cierre otra vez para comprobarlo (no se cerrará dos veces).');
    if (record && record.last_error && record.last_status && record.last_status < 500 && record.last_status !== 429)
      return 'Antes de cerrar hay ' + plainCommand(record.command) + ' que el servidor rechazó' + plainReason(record.last_error) + '. No se aplicó; revísalo y vuelve a confirmar el cierre.' + blockingSale(error, record);
    if (record) return 'Antes de cerrar hay otra operación sin confirmar (' + plainCommand(record.command) + '). Se guardó; revísala y vuelve a confirmar el cierre.' + blockingSale(error, record);
    if (code === 'CASH_CLOSE_QUARANTINED_SALES') return 'Hay ventas en revisión que impiden cerrar esta caja hasta conciliarlas. Las demás ventas, abonos y egresos siguen funcionando.' +
      blockingSale(error, null);
    if (code === 'CASH_CLOSE_PENDING_SALES') return 'Hay ventas pendientes de sincronizar. La caja sigue abierta; revisa la conexión y vuelve a confirmar.' +
      blockingSale(error, null);
    if (/AUTHORITY_UNAVAILABLE|Failed to fetch|NetworkError|Load failed|TIMEOUT/i.test(code)) return 'Sin conexión con el servidor: la caja NO se cerró. Revisa internet y vuelve a confirmar.';
    if (/_5\d\d$|internal/i.test(code)) return 'El servidor tuvo un problema: la caja NO se cerró. Vuelve a confirmar en un momento.';
    return 'No se pudo cerrar la caja. Vuelve a intentar en un momento.';
  }
  function plainReason(r) {
    var t = ({ stale_credit: 'el saldo del crédito cambió en otro equipo', stale_session: 'la caja cambió en otro equipo', stale_stock: 'el stock cambió en otro equipo', operation_id_conflict: 'ese número de operación ya se usó con otros datos' })[clean(r)];
    return t ? ' (' + t + ')' : '';
  }
  function plainCommand(c) {
    return ({ 'sale.create': 'una venta', 'payment.create': 'un abono', 'payment.batch': 'un cobro múltiple', 'expense.create': 'un gasto', 'adjustment.create': 'un movimiento de caja', 'compensation.create': 'una compensación', 'cash.open': 'una apertura de caja' })[c] || 'otra operación';
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

  // Cierre con un cierre anterior pendiente: TODO ocurre dentro de la barrera de ventas. Antes de reenviar o
  // descartar se pregunta al servidor cómo está la caja:
  //  - abierta: el cierre anterior no se aplicó; se archiva, se envían las ventas en cola y se cierra con el
  //    monto contado que está escrito AHORA;
  //  - cerrada: se muestra el cierre real y las ventas en cola de esa caja pasan a revisión (nunca a otra caja).
  var lastServerCheck = null;
  async function resolvePendingCloseWithServer(client) {
    var record = pendingClose(client);
    if (!record) return null;
    lastServerCheck = null;
    await refreshCanonical();
    var sid = record.payload && record.payload.session_id;
    var session = (client.snapshot().cashSessions || []).find(function (item) { return item.session_id === sid; });
    lastServerCheck = session ? session.status : null;
    if (session && session.status === 'CLOSED') {
      var receipt = null;
      if (record.payload.operation_id) {
        try { receipt = await client.retryPending(); } catch (_) {
          try { if (pendingClose(client)) await client.releaseRejectedCashClose(); } catch (_) {}
        }
      }
      try { await refreshCanonical(); session = (client.snapshot().cashSessions || []).find(function (item) { return item.session_id === sid; }) || session; } catch (_) {}
      return { closedSession: session, receipt: receipt };
    }
    if (session && session.status === 'OPEN') {
      if (typeof client.releaseUncommittedCashClose !== 'function' || !(await client.releaseUncommittedCashClose())) throw new Error('CANONICAL_FINANCIAL_PENDING');
      return { reopened: session };
    }
    if (record.last_status === 409 && record.last_error === 'stale_session') {
      var recovered = await client.releaseRejectedCashClose();
      if (!recovered) throw new Error('CANONICAL_FINANCIAL_PENDING');
      return recovered.status === 'CLOSED' ? { closedSession: recovered } : { reopened: recovered };
    }
    throw new Error('CANONICAL_FINANCIAL_PENDING');
  }

  async function closeCanonicalCash(countedCents) {
    var client = api();
    var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
    var sessionId = null;
    function openSession() {
      if (sessionId || typeof client.snapshot !== 'function') return;
      var open = (client.snapshot().cashSessions || []).filter(function (item) { return item.status === 'OPEN'; });
      if (open.length === 1) sessionId = open[0].session_id;
    }
    async function before() {
      var r = await resolvePendingCloseWithServer(client);
      if (r && r.reopened) sessionId = r.reopened.session_id;
      if (r && r.closedSession) return r;
      openSession();
      await settleOtherFinancialPending(client);
      return null;
    }
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
        await refreshCanonical();
        var recovered = await client.releaseRejectedCashClose();
        if (!recovered) throw error;
        if (recovered.status === 'CLOSED') return { status: 'CLOSED', session: (client.snapshot().cashSessions || []).find(function (s) { return s.session_id === recovered.session_id; }) || recovered, left_out: [] };
        input.session_id = recovered.session_id;
        await prepare('cash.close');
        return { receipt: await client.closeCash(input) };
      }
    }
    if (outbox && typeof outbox.withCashCloseBarrier === 'function') {
      // Si la cola de ventas está ocupada (sincronizando), se espera y se reintenta: cada Confirmar consulta al
      // servidor; nunca se responde con un aviso viejo.
      for (var tries = 0; ; tries++) {
        try { return await outbox.withCashCloseBarrier(submit, before); }
        catch (e) { if (String(e && (e.code || e.message)) !== 'BUSY' || tries >= 32) throw e; await new Promise(function (r) { setTimeout(r, 250); }); }
      }
    }
    // Compatibility for a runtime that has not loaded the updated outbox yet.
    var pre = await before();
    if (pre && pre.closedSession) return { status: 'CLOSED', session: pre.closedSession, left_out: [] };
    if (outbox && outbox.snapshot().intents.length) throw new Error('CASH_CLOSE_PENDING_SALES');
    return submit(0);
  }

  function closedSummary(outcome) {
    var s = outcome.session || {}, when = s.closed_at ? new Date(s.closed_at) : null, txt = 'Esta caja ya estaba cerrada en el servidor';
    if (when && !isNaN(when)) txt += ' el ' + when.toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) + ' a las ' + when.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' });
    if (s.counted_cents != null) txt += ', con S/ ' + (Number(s.counted_cents) / 100).toFixed(2) + ' contados';
    txt += '.';
    var left = outcome.left_out || [];
    if (left.length) {
      var tot = left.reduce(function (a, x) { return a + Number(x.total_cents || 0); }, 0);
      txt += ' ' + left.length + (left.length === 1 ? ' venta quedó' : ' ventas quedaron') + ' fuera de ese cierre (S/ ' + (tot / 100).toFixed(2) + '): ' +
        left.map(function (x) { return x.sale_id + ' S/ ' + (Number(x.total_cents || 0) / 100).toFixed(2); }).join(', ') +
        '. Siguen guardadas en la lista de revisión de Caja; no se pasaron a otra caja.';
    }
    return txt;
  }

  function differenceText(difference) {
    if (!Number.isSafeInteger(difference)) return '';
    if (difference === 0) return ' · Cuadrada (sin diferencia)';
    return ' · Diferencia: ' + (difference > 0 ? '+' : '−') + 'S/ ' + (Math.abs(difference) / 100).toFixed(2) + (difference > 0 ? ' (sobrante)' : ' (faltante)');
  }
  // C-P1: the close dialog shows the expected cash of a FRESH server read and
  // keeps "Confirmar cierre" disabled until that read confirms it.
  // P1-2: a read that could not finish (red lenta) offers "Reintentar sincronización"
  // with visible progress instead of a dead end. full=true re-reads everything (the close
  // dialog totals); otherwise only what the close needs (status + cash-sessions + accounts).
  function isSyncFailure(error) {
    return /CANONICAL_READ_(?:TIMEOUT|5\d\d|429)|AUTHORITY_UNAVAILABLE|Failed to fetch|NetworkError|Load failed/i.test(clean(error && (error.code || error.message)));
  }
  function offerSyncRetry(full, onSynced) {
    var node = root.document.getElementById('cajCloseStatus');
    if (!node || typeof root.document.createElement !== 'function') return null;
    var button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'mbtn na-sync-retry';
    button.textContent = 'Reintentar sincronización';
    button.style.cssText = 'display:block;width:100%;margin-top:8px;min-height:44px;background:#fff;border:1.5px solid #fca5a5;color:#991b1b';
    button.addEventListener('click', function () {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = 'Sincronizando…';
      function progress(event) {
        var detail = event && event.detail || {};
        if (detail.total > 0) button.textContent = 'Sincronizando… ' + Math.min(detail.done, detail.total) + ' de ' + detail.total;
      }
      root.addEventListener('na:canonical-progress', progress);
      var client = api();
      var work = full || !client || typeof client.prepareCommand !== 'function' ? refreshCanonical() : client.prepareCommand('cash.close');
      Promise.resolve(work).then(function () {
        root.removeEventListener('na:canonical-progress', progress);
        var done = closeStatus('Datos de caja sincronizados. Ya puedes confirmar el cierre.');
        if (done) { done.style.background = '#f0fdf4'; done.style.borderColor = '#bbf7d0'; done.style.color = '#166534'; }
        if (typeof onSynced === 'function') onSynced();
      }, function (error) {
        root.removeEventListener('na:canonical-progress', progress);
        closeStatus('Todavía no se pudo sincronizar (' + clean(error && error.message) + '). Revisa la señal y vuelve a intentarlo.');
        offerSyncRetry(full, onSynced);
      });
    });
    node.appendChild(button);
    return button;
  }
  var basePrepCierre = root.prepCierre;
  if (typeof basePrepCierre === 'function') root.prepCierre = function () {
    var result = basePrepCierre.apply(this, arguments);
    if (!enabled()) return result;
    var modal = root.document.getElementById('mCierre');
    if (!modal || !modal.classList || !modal.classList.contains('open')) return result;
    var button = root.document.querySelector('#mCierre .mbtn-ok');
    var label = button && button.textContent || '🔒 Confirmar cierre';
    if (button) { button.disabled = true; button.textContent = 'Verificando…'; }
    Promise.resolve().then(refreshCanonical).then(function () {
      if (!modal.classList.contains('open')) return;
      if (typeof root._naRefreshClosingCashTotals === 'function' && typeof root.cajTotales === 'function') root._naRefreshClosingCashTotals(root.cajTotales());
      if (button && !closingBusy) { button.disabled = false; button.textContent = label; }
    }).catch(function () {
      closeStatus('Sin confirmar: no se pudo leer la caja del servidor. Revisa la conexión.');
      if (button && !closingBusy) button.textContent = 'Sin confirmar';
      offerSyncRetry(true, function () {
        if (!modal.classList.contains('open')) return;
        if (typeof root._naRefreshClosingCashTotals === 'function' && typeof root.cajTotales === 'function') root._naRefreshClosingCashTotals(root.cajTotales());
        if (button && !closingBusy) { button.disabled = false; button.textContent = label; }
      });
    });
    return result;
  };
  // Cada Confirmar sobre un cierre pendiente consulta al servidor (con tiempo límite). Un toque mientras otro
  // cierre sigue en curso no espera esa promesa (podría no terminar nunca): pregunta el estado y actualiza la ventana.
  var closingPromise = null, closingAt = 0, STALE_CLOSE_MS = 20000;
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (_, no) { setTimeout(function () { no(new Error('TIMEOUT')); }, ms); })]); }
  async function quickCloseCheck(fromRun) {
    var client; try { client = api(); } catch (_) { return false; }
    if (!client || typeof client.snapshot !== 'function') return false;
    var rec = typeof client.pendingSnapshot === 'function' ? pendingClose(client) : null;
    // Sin cierre pendiente local, se toma la caja que se está cerrando (la abierta más reciente de la réplica).
    var openNow = (client.snapshot().cashSessions || []).filter(function (x) { return x.status === 'OPEN'; })[0];
    closeStatus('Consultando al servidor…');
    try { await withTimeout(refreshCanonical(), 8000); }
    catch (_) { closeStatus('El servidor no respondió a tiempo. Toca Confirmar cierre otra vez para volver a preguntar (no se cerrará dos veces).'); return false; }
    var sid = rec ? rec.payload && rec.payload.session_id : openNow && openNow.session_id;
    if (!sid) { var lastC = (client.snapshot().cashSessions || []).filter(function (x) { return x.status === 'CLOSED'; }).sort(function (a, b) { return String(b.closed_at).localeCompare(String(a.closed_at)); })[0]; sid = lastC && lastC.session_id; }
    var s = sid ? (client.snapshot().cashSessions || []).find(function (x) { return x.session_id === sid; }) : null;
    lastServerCheck = s ? s.status : null;
    if (s && s.status === 'CLOSED') { closeStatus(closedSummary({ status: 'CLOSED', session: s, left_out: [] })); reconcileSoon(); return true; }
    if (fromRun && s && s.status === 'OPEN') { closeStatus(''); return 'OPEN'; }
    closeStatus(s && s.status === 'OPEN' ? 'El servidor dice que la caja sigue abierta. El cierre anterior sigue en curso; espera unos segundos y vuelve a tocar Confirmar cierre.' : 'No se pudo comprobar con el servidor si la caja quedó cerrada. Toca Confirmar cierre otra vez.');
    return false;
  }
  root.cerrarCaja = function () {
    if (closingPromise && Date.now() - closingAt < STALE_CLOSE_MS) return quickCloseCheck();
    var p = cerrarCajaRun.apply(this, arguments); closingPromise = p; closingAt = Date.now();
    var done = function () { if (closingPromise === p) closingPromise = null; };
    if (p && p.then) p.then(done, done);
    return p;
  };
  var cerrarCajaRun = async function () {
    if (!enabled()) return typeof original.cerrarCaja === 'function' ? original.cerrarCaja.apply(this, arguments) : undefined;
    closeStatus('');
    // Sin cierre pendiente y sin caja abierta en la réplica: se pregunta al servidor antes de nada. Si ya está
    // cerrada se muestra el cierre real (las ventas en cola de esa caja pasan a revisión al sincronizar).
    try { var c0 = api(); if (c0 && typeof c0.snapshot === 'function' && !pendingClose(c0) && !(c0.snapshot().cashSessions || []).some(function (x) { return x.status === 'OPEN'; })) { var q = await quickCloseCheck(true); if (q !== 'OPEN') return q; } } catch (_) {}
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
      if (outcome.status === 'CLOSED' && outcome.left_out && outcome.left_out.length) {
        var nodeC = closeStatus(closedSummary(outcome));
        if (nodeC) { nodeC.style.background = '#fffbeb'; nodeC.style.borderColor = '#fcd34d'; nodeC.style.color = '#92400e'; }
        try { renderReview(); } catch (_) {}
        renderCash();
        notify(closedSummary(outcome), 'warning');
        return true;
      }
      closeModal('mCierre');
      renderCash();
      var actualCount = outcome.receipt && outcome.receipt.counted_cents;
      var difference = outcome.receipt && outcome.receipt.difference_cents;
      notify(outcome.status === 'CLOSED' ? closedSummary(outcome) :
        'Caja CANON cerrada correctamente' + (Number.isSafeInteger(actualCount) && actualCount !== countedCents
          ? ' · Efectivo registrado: S/ ' + (actualCount / 100).toFixed(2) : '') + differenceText(difference), 'success');
      return true;
    } catch (error) {
      var message = closeFailure(error);
      var node = closeStatus(message);
      try { pendingList(node); } catch (_) {}
      if (isSyncFailure(error)) offerSyncRetry(false);
      if (error && error.code === 'CASH_CLOSE_QUARANTINED_SALES') { try { renderReview(); } catch (_) {} }
      notify(message, 'error');
      return false;
    } finally {
      closingBusy = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };

  // Lo que impide cerrar, en palabras simples y con montos: «1 abono de S/ 0.20 sin confirmar» + botón Revisar.
  var KIND = { 'payment.create': ['abono', 'abonos'], 'payment.batch': ['cobro múltiple', 'cobros múltiples'], 'expense.create': ['gasto', 'gastos'], 'adjustment.create': ['movimiento de caja', 'movimientos de caja'], 'compensation.create': ['compensación', 'compensaciones'], 'sale.create': ['venta', 'ventas'] };
  function money(c) { return 'S/ ' + (Number(c || 0) / 100).toFixed(2); }
  function pendingSummary() {
    var rows = [], client = api(), rec = null, sales = [];
    try { rec = client && client.pendingSnapshot(); } catch (_) {}
    if (rec && rec.command !== 'cash.close' && rec.command !== 'sale.create') {
      var p = rec.payload || {}, amt = p.amount_cents;
      if (amt == null && Array.isArray(p.payments)) amt = p.payments.reduce(function (s, x) { return s + Number(x.amount_cents || 0); }, 0);
      var k = KIND[rec.command] || ['operación', 'operaciones'];
      rows.push({ text: '1 ' + k[0] + (amt ? ' de ' + money(amt) : '') + (rec.last_error ? ' rechazado' : ' sin confirmar'), kind: rec.command });
    }
    try { sales = (root.NuevoAmanecerCanonicalSaleOutbox.snapshot().intents || []); } catch (_) {}
    if (sales.length) {
      var t = sales.reduce(function (s, x) { return s + Number(x && x.total_cents || 0); }, 0);
      rows.push({ text: sales.length + ' ' + (sales.length === 1 ? 'venta' : 'ventas') + ' por ' + money(t) + ' sin confirmar', kind: 'sale.create' });
    }
    return rows;
  }
  function pendingList(node) {
    if (!node) return;
    var old = node.querySelector && node.querySelector('.na-close-pending'); if (old) old.remove();
    var rows = pendingSummary(); if (!rows.length) return;
    var box = root.document.createElement('div'); box.className = 'na-close-pending';
    box.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center';
    var ul = root.document.createElement('ul'); ul.style.cssText = 'margin:0;padding-left:18px;flex:1 1 100%;font-weight:800';
    rows.forEach(function (r) { var li = root.document.createElement('li'); li.textContent = r.text; ul.appendChild(li); });
    var btn = root.document.createElement('button'); btn.type = 'button'; btn.className = 'na-close-review'; btn.textContent = 'Revisar';
    btn.style.cssText = 'min-height:40px;padding:0 14px;border-radius:10px;border:1px solid #b91c1c;background:#fff;color:#991b1b;font-weight:800';
    var sale = rows.some(function (r) { return r.kind === 'sale.create'; });
    btn.onclick = function () { closeModal('mCierre'); if (sale) showReview(); else { try { root.goPage && root.goPage('pageClientes'); } catch (_) {} } };
    box.append(ul, btn); node.appendChild(box);
  }
  root.NuevoAmanecerCashClosePending = { summary: pendingSummary };
  // Al cargar y al volver la conexión: si hay un cierre pendiente, se pregunta al servidor. Si la caja ya
  // está cerrada allá, se muestra el cierre real (nunca «La caja sigue abierta»). Si sigue abierta, no se
  // hace nada: el cajero vuelve a confirmar el cierre.
  var reconciling = false;
  async function reconcilePendingClose() {
    if (reconciling) return null;
    var client; try { client = api(); } catch (_) { return null; }
    if (!client || typeof client.pendingSnapshot !== 'function' || !pendingClose(client)) return null;
    reconciling = true;
    try {
      await refreshCanonical();
      var rec = pendingClose(client); if (!rec) return null;
      var sid = rec.payload && rec.payload.session_id;
      var s = (client.snapshot().cashSessions || []).find(function (x) { return x.session_id === sid; });
      if (!s || s.status !== 'CLOSED') return null;
      var outbox = root.NuevoAmanecerCanonicalSaleOutbox, out;
      if (outbox && typeof outbox.withCashCloseBarrier === 'function') out = await outbox.withCashCloseBarrier(function () { return null; }, function () { return resolvePendingCloseWithServer(client); });
      else { var pre = await resolvePendingCloseWithServer(client); out = pre && pre.closedSession ? { status: 'CLOSED', session: pre.closedSession, left_out: [] } : null; }
      if (out && out.status === 'CLOSED') {
        try { refreshAfterReceipt(); } catch (_) {}
        renderCash();
        notify(closedSummary(out), out.left_out && out.left_out.length ? 'warning' : 'success');
      }
      return out;
    } catch (_) { return null; }
    finally { reconciling = false; }
  }
  root.NuevoAmanecerCashClosePending.reconcile = reconcilePendingClose;
  var reconciledOps = {};
  function reconcileSoon(op) {
    if (op) { if (reconciledOps[op] && Date.now() - reconciledOps[op] < 30000) return; reconciledOps[op] = Date.now(); }
    setTimeout(function () { reconcilePendingClose().then(function (out) { if (out && out.status === 'CLOSED') closeStatus(closedSummary(out)); }); }, 0);
  }
  // Ventana de cierre abierta: si la caja figura cerrada en el servidor, la ventana lo dice (nunca queda
  // «sigue abierta» mientras Caja muestra Cerrada).
  function syncCloseWindow() {
    try {
      var m = root.document && root.document.getElementById('mCierre');
      if (!m || !m.classList.contains('open') || reconciling) return;
      var client = api(), rec = pendingClose(client);
      // Solo lee la réplica local (sin red). Concilia una vez por operación cuando la réplica ya dice CERRADA:
      // nunca reenvía en bucle al recibir su propio na:canonical-updated.
      if (rec) {
        var sid = rec.payload && rec.payload.session_id, s = (client.snapshot().cashSessions || []).find(function (x) { return x.session_id === sid; });
        if (s && s.status === 'CLOSED') { closeStatus(closedSummary({ status: 'CLOSED', session: s, left_out: [] })); reconcileSoon(rec.payload && rec.payload.operation_id); }
        return;
      }
      if (closingPromise) return;
      var st = root.document.getElementById('cajCloseStatus'), txt = st && st.textContent || '';
      if (!/sigue abierta|No se pudo comprobar/.test(txt)) return;
      var open = (client.snapshot().cashSessions || []).some(function (x) { return x.status === 'OPEN'; });
      if (!open) { var last = (client.snapshot().cashSessions || []).filter(function (x) { return x.status === 'CLOSED'; }).sort(function (a, b) { return String(b.closed_at).localeCompare(String(a.closed_at)); })[0];
        if (last) closeStatus(closedSummary({ status: 'CLOSED', session: last, left_out: [] })); }
    } catch (_) {}
  }
  if (typeof root.addEventListener === 'function') root.addEventListener('na:canonical-updated', syncCloseWindow);
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('online', function () { setTimeout(reconcilePendingClose, 1500); });
    root.addEventListener('load', function () { setTimeout(reconcilePendingClose, 4000); });
  }

  // Ítem 6: abrir la lista de ventas en revisión desde la franja de estado.
  function showReview() {
    try { if (typeof root.goPage === 'function') root.goPage('pageCaja'); } catch (_) {}
    try { renderReview(); } catch (_) {}
    var box = root.document && root.document.getElementById('cajContentReview');
    if (box) {
      try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      box.style.outline = '3px solid #f59e0b';
      setTimeout(function () { box.style.outline = ''; }, 2200);
    }
    return !!box;
  }
  root.NuevoAmanecerCanonicalCashBridge = Object.freeze({
    closing: function () { return !!closingPromise; },
    enabled: enabled,
    showReview: showReview,
    originalHandlers: function () { return Object.assign({}, original); }
  });
})(globalThis);
