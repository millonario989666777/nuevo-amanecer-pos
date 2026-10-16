/*
 * CANON: "Anular abono" (P1-4).
 *
 * Annuls one LIVE credit payment with the canonical compensation.create
 * command. Nothing is deleted: the original payment stays in the history as
 * REVERTED ("Anulado el …"), the credit balance is restored by the Worker and,
 * for a cash payment, the money leaves the CURRENTLY OPEN till as a traceable
 * outflow. One durable operation_id per annulment: a lost ACK is replayed with
 * the same id, never as a second compensation.
 *
 * The Yape/Plin/transfer reference of the annulled payment stays registered on
 * the server (canonical_payment_references is append-only), so that voucher
 * number cannot be reused for another payment.
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  var busy = false;
  var legacyRevert = typeof root.revertirPagoCredito === 'function' ? root.revertirPagoCredito : null;

  function api() { return root.NuevoAmanecerCanonical; }
  function enabled() {
    var client = api();
    try { return !!(client && typeof client.enabled === 'function' && client.enabled()); } catch (_) { return false; }
  }
  function clean(value) { return String(value == null ? '' : value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  // inline scripts declare several helpers as top-level const/let (global
  // lexical bindings, not window properties): resolve them explicitly.
  var LEXICAL = {
    toast: function () { return typeof toast !== 'undefined' ? toast : undefined; },
    _naAudit: function () { return typeof _naAudit !== 'undefined' ? _naAudit : undefined; },
    _naF10CurrentCashier: function () { return typeof _naF10CurrentCashier !== 'undefined' ? _naF10CurrentCashier : undefined; },
    _naSecurity: function () { return typeof _naSecurity !== 'undefined' ? _naSecurity : undefined; },
    _naF10MasterOverride: function () { return typeof _naF10MasterOverride !== 'undefined' ? _naF10MasterOverride : undefined; },
    _naConfirmAction: function () { return typeof _naConfirmAction !== 'undefined' ? _naConfirmAction : undefined; },
    cliRender: function () { return typeof cliRender !== 'undefined' ? cliRender : undefined; },
    cajRender: function () { return typeof cajRender !== 'undefined' ? cajRender : undefined; },
    abrirDetalleCredito: function () { return typeof abrirDetalleCredito !== 'undefined' ? abrirDetalleCredito : undefined; },
    prompt: function () { return typeof prompt !== 'undefined' ? prompt : undefined; },
    confirm: function () { return typeof confirm !== 'undefined' ? confirm : undefined; }
  };
  function lexical(name) {
    var value;
    try { value = LEXICAL[name] ? LEXICAL[name]() : undefined; } catch (_) { value = undefined; }
    return value !== undefined ? value : root[name];
  }
  function notify(message, tone) {
    var fn = lexical('toast');
    if (typeof fn === 'function') fn(message, tone || 'error');
  }
  function audit(action, detail) {
    var fn = lexical('_naAudit');
    try { if (typeof fn === 'function') fn(action, detail); } catch (_) {}
  }
  function money(cents) { return 'S/ ' + (Number(cents) / 100).toFixed(2); }

  // Owner decision: an administrator (owner role) may annul with a reason; any
  // other cashier needs the master PIN. Without a PIN and without the owner
  // role the action is refused (no silent bypass).
  function authorize(label) {
    var current = lexical('_naF10CurrentCashier'), cashier = null;
    try { cashier = typeof current === 'function' ? current() : null; } catch (_) {}
    if (cashier && cashier.activo !== false && cashier.role === 'admin') return true;
    var security = lexical('_naSecurity');
    var override = lexical('_naF10MasterOverride');
    if (security && security.pinEnabled && security.pinHash && typeof override === 'function') return override(label) === true;
    notify('Anular un abono requiere el PIN maestro (configúralo en Seguridad) o un usuario administrador.', 'error');
    return false;
  }

  function askReason(paymentLabel) {
    var ask = lexical('prompt');
    if (typeof ask !== 'function') return null;
    var raw = ask('Motivo de la anulación del abono ' + paymentLabel + ' (mínimo 8 caracteres):');
    if (raw === null || raw === undefined) return null;
    var reason = clean(raw).slice(0, 500);
    if (reason.length < 8) { notify('Escribe el motivo de la anulación (mínimo 8 caracteres). No se anuló nada.', 'error'); return null; }
    return reason;
  }

  async function confirmAction(message) {
    var fn = lexical('_naConfirmAction');
    if (typeof fn === 'function') {
      return !!(await fn(message, { title: 'Anular abono', subtitle: 'El abono quedará en el historial como ANULADO; no se borra.', icon: '↩️', danger: true, okText: 'Anular abono' }));
    }
    var ask = lexical('confirm');
    return typeof ask === 'function' ? !!ask(message) : false;
  }

  var FRIENDLY = {
    already_compensated: 'Ese abono ya fue anulado (quizá desde otro equipo). No se hizo nada más.',
    credit_voided: 'Este crédito está anulado: no se pueden anular sus abonos. No se anuló nada.',
    compensation_target_not_found: 'Ese abono no existe en CANON. Actualiza la pantalla.',
    compensation_credit_mismatch: 'Ese abono no pertenece a este crédito. No se anuló nada.',
    stale_credit: 'El crédito cambió en otro equipo. Se actualizó la pantalla: revisa y vuelve a intentar.',
    credit_balance_conflict: 'El saldo del crédito no permite esta anulación. Revisa el crédito.',
    stale_session: 'La caja cambió (se cerró o se movió en otro equipo). Revisa la caja y vuelve a intentar.',
    cash_balance_conflict: 'La caja abierta no tiene efectivo suficiente para devolver este abono.',
    invalid_compensation_session: 'Para anular un abono en efectivo la caja debe estar abierta.',
    unexpected_field: 'El servidor CANON todavía no tiene la función "Anular abono". No se anuló nada.',
    stale_authority: 'La autorización del equipo cambió. Recarga la app. No se anuló nada.'
  };

  function pending() {
    var client = api();
    try { return client && typeof client.pendingSnapshot === 'function' ? client.pendingSnapshot() : null; } catch (_) { return { invalid: true }; }
  }

  async function refreshView(creditId) {
    var client = api();
    try { await client.refresh(); } catch (_) {}
    try { var render = lexical('cliRender'); if (typeof render === 'function') render(); } catch (_) {}
    try { var cash = lexical('cajRender'); if (typeof cash === 'function') cash(); } catch (_) {}
    try {
      var open = root.document.getElementById('mCreditoDetalle');
      var detail = lexical('abrirDetalleCredito');
      if (open && open.classList && open.classList.contains('open') && typeof detail === 'function') detail(creditId);
    } catch (_) {}
  }

  // Definitive 4xx rejection: nothing was written. Archive the intent so the
  // single pending slot is free again. Lost ACK / 5xx stay pending.
  async function settleFailure(operationId, creditId) {
    var record = pending();
    var code = clean(record && record.last_error);
    var status = Number(record && record.last_status);
    if (record && record.command === 'compensation.create' && status >= 400 && status < 500 && status !== 429 && code) {
      var client = api();
      try { if (typeof client.releaseRejectedFinancial === 'function') await client.releaseRejectedFinancial(operationId || record.payload && record.payload.operation_id); } catch (_) {}
      await refreshView(creditId);
      return (FRIENDLY[code] || ('CANON rechazó la anulación (' + code + ').')) + (FRIENDLY[code] && /No se/.test(FRIENDLY[code]) ? '' : ' No se anuló nada.');
    }
    if (record && record.command === 'compensation.create') {
      return 'La anulación se envió pero CANON no confirmó la recepción. NO la registres de otra forma: pulsa "Anular abono" otra vez para reintentar la MISMA operación.';
    }
    return 'No se anuló el abono.';
  }

  async function replayPending(record, creditId) {
    var client = api();
    try {
      await client.retryPending();
      notify('Anulación pendiente CONFIRMADA (no se registró otra).', 'success');
      await refreshView(creditId);
      return true;
    } catch (_) {
      notify(await settleFailure(record.payload && record.payload.operation_id, creditId), 'error');
      return false;
    }
  }

  async function annul(creditId, paymentId) {
    if (!enabled()) return legacyRevert ? legacyRevert.apply(this, arguments) : undefined;
    if (busy) return false;
    busy = true;
    var client = api();
    try {
      var record = pending();
      if (record) {
        if (!record.invalid && record.command === 'compensation.create') return await replayPending(record, creditId);
        notify('Hay otra operación en curso. Termínala antes de anular un abono.', 'error');
        return false;
      }
      try { await client.refresh(); } catch (error) { notify('No se pudo leer CANON (' + clean(error && error.message) + '). No se anuló nada.', 'error'); return false; }
      var view = client.legacySnapshot();
      var credit = (view.credits || []).find(function (item) { return item && String(item.id) === String(creditId); });
      if (!credit) { notify('No se encontró el crédito.', 'error'); return false; }
      var payment = (credit.pagos || []).find(function (item) { return item && String(item.pagoId || item.id) === String(paymentId); });
      if (!payment) { notify('No se encontró el abono en este crédito.', 'error'); return false; }
      if (payment.status === 'REVERTED') { notify('Ese abono ya fue anulado.', 'error'); return false; }
      if (!payment.canonicalLive || !payment.operationId) { notify('Este abono es histórico (importado) y no se puede anular desde la app.', 'error'); return false; }
      if (payment.creditoId !== undefined && payment.creditoId !== null && String(payment.creditoId) !== String(credit.id)) { notify('Ese abono no pertenece a este crédito.', 'error'); return false; }

      var raw = client.snapshot();
      var event = (raw.financialEvents || []).find(function (item) {
        return item && item.event_type === 'PAYMENT' && String(item.operation_id) === String(payment.operationId);
      });
      if (!event || String(event.credit_id) !== String(credit.id)) { notify('Ese abono no pertenece a este crédito en CANON. No se anuló nada.', 'error'); return false; }
      if ((raw.financialEvents || []).some(function (item) { return item && String(item.compensates_operation_id) === String(event.operation_id); })) {
        notify('Ese abono ya fue anulado.', 'error'); return false;
      }
      var amountCents = -Number(event.credit_delta_cents);
      var isCash = Number(event.cash_delta_cents) !== 0;
      var session = null;
      if (isCash) {
        session = (raw.cashSessions || []).filter(function (item) { return item && item.status === 'OPEN'; })[0] || null;
        if (!session) { notify('Abre la caja antes de anular un abono en efectivo: el dinero se devuelve desde la caja abierta.', 'error'); return false; }
        if (Number(session.expected_cents) < Number(event.cash_delta_cents)) { notify('La caja abierta no tiene ' + money(event.cash_delta_cents) + ' en efectivo para devolver este abono.', 'error'); return false; }
      }
      var label = money(amountCents) + ' (' + clean(payment.metodo || event.payment_method) + (payment.referencia ? ' · op. ' + clean(payment.referencia) : '') + ')';
      var reason = askReason(label);
      if (!reason) return false;
      if (!authorize('Anular abono ' + label + ' del crédito ' + credit.id)) return false;
      var balanceAfter = Math.round(Number(credit.saldo) * 100) + amountCents;
      var message = 'Se anulará el abono de ' + label + '. El saldo del crédito volverá a ' + money(balanceAfter) + '.' +
        (isCash ? ' Saldrán ' + money(event.cash_delta_cents) + ' en efectivo de la caja abierta.' : '') +
        (event.reference ? ' El número de operación seguirá registrado y no podrá usarse en otro abono.' : '');
      if (!await confirmAction(message)) return false;

      var input = { compensates_operation_id: String(event.operation_id), reason: reason, credit_id: String(credit.id) };
      if (isCash) input.session_id = session.session_id;
      try {
        var receipt = await client.createCompensation(input);
        audit('Anular abono', credit.id + ' · ' + label + ' · ' + reason + ' · operación ' + clean(receipt && receipt.operation_id));
        notify('Abono anulado · saldo del crédito ' + money(balanceAfter) + (isCash ? ' · salida de caja ' + money(event.cash_delta_cents) : ''), 'success');
        await refreshView(credit.id);
        return true;
      } catch (error) {
        notify(await settleFailure(null, credit.id), 'error');
        return false;
      }
    } finally { busy = false; }
  }

  root.revertirPagoCredito = annul;
  root.NuevoAmanecerCanonicalPaymentAnnul = Object.freeze({ annul: annul, authorize: authorize, FRIENDLY: FRIENDLY });
})(globalThis);
