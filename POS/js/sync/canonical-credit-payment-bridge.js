(function (root) {
  'use strict';

  if (!root || !root.document) return;

  var busy = false;

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

  function clean(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  function moneyCents(value) {
    var amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    var cents = Math.round(amount * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function selectedCreditId() {
    try {
      return typeof pagoCredId !== 'undefined' && pagoCredId !== null && pagoCredId !== undefined
        ? String(pagoCredId)
        : '';
    } catch (_) {
      return '';
    }
  }

  // inline-01 declares `toast` and `cerrarModal` as top-level `const`, so they
  // are global lexical bindings and NOT properties of window. Resolve the
  // lexical binding first; fall back to a window property for other shells.
  function notify(message, tone) {
    var fn = null;
    try { if (typeof toast === 'function') fn = toast; } catch (_) {}
    if (!fn && typeof root.toast === 'function') fn = root.toast;
    if (fn) fn(message, tone || 'error');
  }

  function closeModal() {
    var fn = null;
    try { if (typeof cerrarModal === 'function') fn = cerrarModal; } catch (_) {}
    if (!fn && typeof root.cerrarModal === 'function') fn = root.cerrarModal;
    if (fn) fn('mPagoCred');
    else root.document.getElementById('mPagoCred')?.classList.remove('open');
  }

  async function refreshCanonical() {
    var client = api();
    if (!client || typeof client.refresh !== 'function' || typeof client.legacySnapshot !== 'function') {
      throw new Error('CANONICAL_CLIENT_UNAVAILABLE');
    }
    await client.refresh();
    return client.legacySnapshot();
  }

  function currentPaymentSnapshot() {
    var client = api();
    if (!client || typeof client.sourceState !== 'function' || typeof client.legacySnapshot !== 'function' ||
        typeof client.assertAction !== 'function') return null;
    try {
      var state = client.sourceState();
      if (!state || state.validation !== 'current') return null;
      client.assertAction('payment.create');
      return client.legacySnapshot();
    } catch (_) {
      return null;
    }
  }

  async function paymentSnapshot() {
    var current = currentPaymentSnapshot();
    return current || await refreshCanonical();
  }

  function pendingRecord() {
    var client = api();
    if (!client || typeof client.pendingSnapshot !== 'function') return null;
    try { return client.pendingSnapshot(); } catch (_) { return { command: 'unknown', invalid: true }; }
  }

  function findCredit(snapshot, id) {
    return (snapshot && Array.isArray(snapshot.credits) ? snapshot.credits : []).find(function (credit) {
      return credit && String(credit.id !== undefined ? credit.id : credit.credit_id) === String(id);
    }) || null;
  }

  // Same scope as legacy _naCreditPaymentOperationUsed (credit payments, sales
  // and cash movements). A payment reversed by a canonical COMPENSATION no
  // longer consumes its bank reference, so it is not a duplicate.
  function referenceUsed(snapshot, reference) {
    var key = clean(reference).toLowerCase();
    if (!key) return false;
    var reversed = new Set();
    (snapshot && Array.isArray(snapshot.payments) ? snapshot.payments : []).forEach(function (row) {
      if (row && row.compensates_operation_id) reversed.add(String(row.compensates_operation_id));
    });
    (snapshot && Array.isArray(snapshot.cashMovements) ? snapshot.cashMovements : []).forEach(function (row) {
      if (row && row.reversalOf) reversed.add(String(row.reversalOf));
    });
    function same(value) { value = clean(value); return !!value && value.toLowerCase() === key; }
    var inCredits = (snapshot && Array.isArray(snapshot.credits) ? snapshot.credits : []).some(function (credit) {
      return Array.isArray(credit && credit.pagos) && credit.pagos.some(function (payment) {
        if (!payment || reversed.has(String(payment.id))) return false;
        return [payment.numeroOperacion, payment.operacion, payment.referencia].some(same);
      });
    });
    if (inCredits) return true;
    var inSales = (snapshot && Array.isArray(snapshot.sales) ? snapshot.sales : []).some(function (sale) {
      return sale && !sale.anulada && same(sale.paymentRef);
    });
    if (inSales) return true;
    return (snapshot && Array.isArray(snapshot.cashMovements) ? snapshot.cashMovements : []).some(function (row) {
      if (!row || row.reversal || reversed.has(String(row.operationId)) || reversed.has(String(row.id))) return false;
      return same(row.referencia || row.numeroOperacion);
    });
  }

  // Once the Worker returns a durable receipt, the payment is authoritative.
  // Do not keep the cashier waiting for a full CANON reconciliation: close and
  // acknowledge immediately, then refresh the wider UI in the background.
  function reconcileAfterCommit(receipt, amountCents) {
    var operation = clean(receipt && receipt.operation_id);
    var amount = typeof amountCents === 'number' ? ' de S/ ' + (amountCents / 100).toFixed(2) : '';
    Promise.resolve()
      .then(refreshCanonical)
      .catch(function (error) {
        notify('Pago CANON' + amount + ' CONFIRMADO (operación ' + operation + '). No se pudo actualizar la vista: ' +
          clean(error && error.message) + '. NO repitas el pago; recarga la pantalla para ver el saldo.', 'success');
      });
  }

  async function afterCommit(receipt, amountCents, replayed) {
    closeModal();
    var amount = typeof amountCents === 'number' ? ' de S/ ' + (amountCents / 100).toFixed(2) : '';
    notify(replayed
      ? 'Pago CANON pendiente' + amount + ' CONFIRMADO (no se registró otro pago).'
      : 'Pago CANON' + amount + ' CONFIRMADO', 'success');
    reconcileAfterCommit(receipt, amountCents);
    return true;
  }

  // Plain-language reasons for definitive Worker rejections (nothing was charged).
  var FRIENDLY_REJECTIONS = {
    reference_already_used: 'Ese número de operación ya fue usado en otro abono. Revisa el voucher.',
    stale_credit: 'El saldo de este crédito cambió en otro equipo. Se actualizó la pantalla: revisa el saldo y vuelve a confirmar.',
    credit_balance_conflict: 'El monto supera el saldo pendiente actual del crédito. Se actualizó la pantalla: revisa el saldo.',
    stale_session: 'La caja cambió (se cerró o se movió en otro equipo). Revisa la caja y vuelve a confirmar.'
  };
  function describePendingFailure(error) {
    var pending = pendingRecord();
    var code = clean(error && error.message);
    if (pending && pending.command === 'payment.create' && !pending.invalid) {
      if (pending.last_error) {
        var friendly = FRIENDLY_REJECTIONS[clean(pending.last_error)];
        if (friendly) return friendly + ' No se registró ningún abono.';
        return 'CANON rechazó el pago (' + clean(pending.last_error) + '). No se registró ningún abono.';
      }
      return 'El pago se envió pero CANON no confirmó la recepción (' + code + '). NO lo registres de nuevo con otro monto: ' +
        'pulsa Confirmar otra vez para reintentar la MISMA operación.';
    }
    return 'No se registró el pago CANON' + (code ? ': ' + code : '');
  }

  // P2-3: a definitive, well-understood rejection (nothing was charged) frees the
  // payment slot and refreshes the balances right away, so the cashier does not
  // need a second tap. Unknown errors and lost ACKs keep the pending operation.
  async function releaseDefinitiveRejection(client) {
    var pending = pendingRecord();
    if (!pending || pending.command !== 'payment.create' || pending.invalid || !FRIENDLY_REJECTIONS[clean(pending.last_error)]) return false;
    if (!client || typeof client.discardRejectedPayment !== 'function') return false;
    try {
      if (!await client.discardRejectedPayment()) return false;
    } catch (_) { return false; }
    try { await refreshCanonical(); } catch (_) {}
    return true;
  }


  // ── Avisos dentro del modal de abono (no toasts) ─────────────────────────────
  // Caso A (sin red antes de enviar): rojo, persistente; Confirmar desactivado mientras no haya red.
  // Caso B (se envió y no llegó la respuesta): ámbar "No confirmado, revisando…"; al volver la red se
  // reintenta la MISMA operación (mismo operation_id: el servidor no crea un segundo abono) y se
  // releen saldos y abonos antes de permitir otro cobro.
  var netState = null, reviewTimer = null;
  function netBox() {
    try { return netBoxUnsafe(); } catch (_) { return null; }
  }
  function netBoxUnsafe() {
    var modal = root.document.getElementById('mPagoCred'); if (!modal || typeof modal.querySelector !== 'function' || typeof root.document.createElement !== 'function') return null;
    var box = modal.querySelector('#naPayNet');
    if (!box) {
      box = root.document.createElement('div'); box.id = 'naPayNet'; box.className = 'na-pay-net'; box.hidden = true;
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
      var btn = root.document.getElementById('pagoConfirmBtn'), host = btn && btn.parentElement;
      // Dentro de la barra fija del botón: siempre visible junto a Confirmar.
      if (host && typeof host.insertBefore === 'function') host.insertBefore(box, host.firstChild);
      else (modal.querySelector('.mbody') || modal).appendChild(box);
    }
    return box;
  }
  function showNet(kind, text) {
    netState = kind || null;
    var box = netBox(), btn = root.document.getElementById('pagoConfirmBtn');
    if (box) try {
      box.hidden = !kind; box.className = 'na-pay-net' + (kind ? ' ' + kind : '');
      box.textContent = '';
      if (kind) {
        var mark = root.document.createElement('span'); mark.setAttribute('aria-hidden', 'true');
        if (kind === 'checking') mark.className = 'na-pay-spin'; else mark.textContent = kind === 'done' ? '✓' : '⚠';
        var label = root.document.createElement('span'); label.textContent = text;
        box.append(mark, label);
      }
    } catch (_) {}
    if (btn) {
      if (!btn.dataset) btn.dataset = {};
      if (!btn.dataset.naLabel) btn.dataset.naLabel = btn.textContent;
      if (kind === 'checking') { btn.disabled = true; btn.textContent = 'Revisando…'; }
      else if (kind === 'offline') { btn.disabled = true; btn.textContent = btn.dataset.naLabel; }
      else { btn.disabled = false; btn.textContent = btn.dataset.naLabel; }
    }
  }
  async function online(client) {
    if (root.navigator && root.navigator.onLine === false) return false;
    if (client && typeof client.ping === 'function') { try { return await client.ping(2500); } catch (_) { return false; } }
    return true;
  }
  function scheduleReview(ms) {
    if (reviewTimer) root.clearTimeout(reviewTimer);
    reviewTimer = root.setTimeout(reviewPending, ms || 5000);
    try { if (reviewTimer && typeof reviewTimer.unref === 'function') reviewTimer.unref(); } catch (_) {}
  }
  async function reviewPending() {
    reviewTimer = null;
    if (netState !== 'checking' || busy) return;
    var client = api(), pending = pendingRecord();
    if (!pending || pending.command !== 'payment.create' || pending.invalid) { showNet(null); try { await refreshCanonical(); } catch (_) {} return; }
    if (!(await online(client))) { scheduleReview(5000); return; }
    var amount = pending.payload && pending.payload.amount_cents, replay;
    busy = true;
    try { replay = await client.retryPending(); }
    catch (error) {
      busy = false;
      var after = pendingRecord();
      if (after && after.last_error) {
        await releaseDefinitiveRejection(client);
        try { await refreshCanonical(); } catch (_) {}
        showNet('rejected', describePendingFailure(error));
        var btn = root.document.getElementById('pagoConfirmBtn'); if (btn) btn.disabled = false;
        return;
      }
      scheduleReview(5000); return;
    }
    busy = false;
    var same = matchesPending(pending);
    showNet(null);
    try { await refreshCanonical(); } catch (_) {}
    if (!same) {
      try { root.NAReceiptShare?.onPayment(findCredit(api().legacySnapshot(), pending.payload.credit_id), replay, amount, pending.payload.payment_method, pending.payload.reference, pending.payload.created_at); } catch (_) {}
      previousSettledNotice(pending); return;
    }
    try { root.NAReceiptShare?.onPayment(findCredit(api().legacySnapshot(), pending.payload.credit_id), replay, amount, pending.payload.payment_method, pending.payload.reference, pending.payload.created_at); } catch (_) {}
    await afterCommit(replay, amount, true);
  }
  root.addEventListener && root.addEventListener('online', function () {
    if (netState === 'checking') scheduleReview(300);
    else if (netState === 'offline') online(api()).then(function (ok) { if (ok && netState === 'offline') showNet(null); });
  });
  // Al abrir el modal: si hay un abono enviado sin confirmar, se muestra "revisando"; si no hay red, el aviso rojo.
  function onModalOpen() {
    if (!enabled()) return;
    var pending = pendingRecord();
    if (pending && pending.command === 'payment.create' && !pending.invalid && !pending.last_error) { showNet('checking', 'No confirmado, revisando…'); scheduleReview(500); return; }
    if (root.navigator && root.navigator.onLine === false) showNet('offline', 'Sin conexión: el abono no se registró');
    else if (netState !== 'checking') showNet(null);
  }
  function watchModal() {
    var modal = root.document && root.document.getElementById('mPagoCred');
    if (!modal || typeof root.MutationObserver !== 'function') return;
    var was = modal.classList.contains('open');
    new root.MutationObserver(function () { var now = modal.classList.contains('open'); if (now && !was) onModalOpen(); was = now; }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', watchModal); else watchModal();
  root.addEventListener && root.addEventListener('offline', function () {
    var modal = root.document.getElementById('mPagoCred');
    if (modal && modal.classList.contains('open') && netState !== 'checking') showNet('offline', 'Sin conexión: el abono no se registró');
  });

  function batchNotice(kind, text) {
    try { batchNoticeUnsafe(kind, text); } catch (_) {}
  }
  function batchNoticeUnsafe(kind, text) {
    var btn = root.document.getElementById('naV2BatchSubmit'); if (!btn || !btn.parentElement || typeof btn.parentElement.querySelector !== 'function') return;
    var box = btn.parentElement.querySelector('.na-pay-net-batch');
    if (!box) { box = root.document.createElement('div'); box.className = 'na-pay-net na-pay-net-batch'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); btn.parentElement.insertBefore(box, btn); }
    box.hidden = !kind; box.className = 'na-pay-net na-pay-net-batch' + (kind ? ' ' + kind : ''); box.textContent = '';
    if (kind) { var m = root.document.createElement('span'); m.setAttribute('aria-hidden', 'true'); if (kind === 'checking') m.className = 'na-pay-spin'; else m.textContent = '⚠'; var t = root.document.createElement('span'); t.textContent = text; box.append(m, t); }
  }

  // Un abono "no confirmado" queda atado a su crédito, monto, método y n.º de operación. Si el formulario ya es
  // otro (otro monto, otro cliente, o se reabrió para un abono nuevo), primero se resuelve el anterior con su
  // MISMO id y se avisa en el modal; el abono nuevo usa un id nuevo en el siguiente toque.
  function matchesPending(pending) {
    try {
      var p = pending && pending.payload; if (!p) return false;
      var doc = root.document, amount = moneyCents(doc.getElementById('pagoMonto')?.value);
      var method = clean(doc.getElementById('pagoMetodo')?.value) || 'efectivo', ref = clean(doc.getElementById('pagoOperacion')?.value);
      var cid = selectedCreditId(), pc = String(p.credit_id);
      var sameCredit = cid === pc;
      if (!sameCredit) { try { var c = findCredit(api().legacySnapshot(), cid); sameCredit = !!c && String(c.credit_id !== undefined ? c.credit_id : c.id) === pc; } catch (_) {} }
      return sameCredit && amount === Number(p.amount_cents) && method === p.payment_method && (method === 'efectivo' || ref === clean(p.reference));
    } catch (_) { return false; }
  }
  function pendingBlockText(pending) {
    var amt = Number(pending && pending.payload && pending.payload.amount_cents) || 0, now = 0;
    try { now = moneyCents(root.document.getElementById('pagoMonto')?.value) || 0; } catch (_) {}
    return 'Revisando el abono anterior de S/ ' + (amt / 100).toFixed(2) + '. Este abono' + (now ? ' de S/ ' + (now / 100).toFixed(2) : '') + ' NO se registró todavía.';
  }
  function previousSettledNotice(pending) {
    var amt = Number(pending && pending.payload && pending.payload.amount_cents) || 0;
    var now = 0; try { now = moneyCents(root.document.getElementById('pagoMonto')?.value) || 0; } catch (_) {}
    showNet('done', 'El abono anterior de S/ ' + (amt / 100).toFixed(2) + ' sí se registró.' +
      (now ? ' Este abono de S/ ' + (now / 100).toFixed(2) + ' todavía NO se registró: revisa y toca Confirmar para enviarlo.' : ' Saldo actualizado.'));
    var b = root.document.getElementById('pagoConfirmBtn'); if (b) b.disabled = false;
  }

  async function confirm() {
    if (!enabled()) return false;
    if (busy) return false;

    var client = api();
    var pending = pendingRecord();
    var forceRefresh = false;
    if (pending) {
      if (pending.invalid || !['payment.create','payment.batch'].includes(pending.command)) {
        notify('Hay otra operación en curso. Termínala antes de registrar el pago.', 'error');
        return false;
      }
      if (pending.last_error) {
        if (!client || typeof client.discardRejectedPayment !== 'function') {
          notify('No se pudo liberar el pago anterior. Recarga la página y vuelve a intentar.', 'error');
          return false;
        }
        try {
          if (!await client.discardRejectedPayment()) {
            notify('El pago anterior necesita revisión antes de continuar.', 'error');
            return false;
          }
        } catch (error) {
          notify('No se pudo liberar el pago anterior: ' + clean(error && error.message), 'error');
          return false;
        }
        pending = null;
        forceRefresh = true;
      } else if (pending.command === 'payment.batch') {
        if (!client || typeof client.retryPending !== 'function') {
          notify('No se pudo recuperar el cobro anterior. Recarga la página y vuelve a intentar.', 'error');
          return false;
        }
        try {
          await client.retryPending();
          await refreshCanonical();
        } catch (error) {
          notify(describePendingFailure(error), 'error');
          return false;
        }
        notify('El cobro anterior ya quedó confirmado. Saldos actualizados; revisa el monto y confirma de nuevo.', 'success');
        return false;
      }
    }

    var amountCents = moneyCents(root.document.getElementById('pagoMonto')?.value);
    var method = clean(root.document.getElementById('pagoMetodo')?.value) || 'efectivo';
    var reference = clean(root.document.getElementById('pagoOperacion')?.value);
    var creditId = selectedCreditId();

    if (!pending) {
      if (!creditId) {
        notify('No se encontró el crédito seleccionado', 'error');
        return false;
      }
      if (!amountCents) {
        notify('Ingresa un monto válido', 'error');
        return false;
      }
      if (!['efectivo', 'yape', 'plin', 'transferencia'].includes(method)) {
        notify('Método de pago inválido', 'error');
        return false;
      }
      if (method !== 'efectivo' && reference.length < 4) {
        notify('Ingresa al menos 4 caracteres del número de operación', 'error');
        root.document.getElementById('pagoOperacion')?.focus?.();
        return false;
      }
    }

    if (!(await online(client))) {
      if (pending) { showNet('checking', matchesPending(pending) ? 'No confirmado, revisando…' : pendingBlockText(pending)); scheduleReview(5000); }
      else showNet('offline', 'Sin conexión: el abono no se registró');
      return false;
    }
    if (netState) showNet(null);

    var button = root.document.getElementById('pagoConfirmBtn');
    var label = button?.dataset?.naLabel || button?.textContent || '✅ Confirmar';
    busy = true;
    if (button) {
      button.disabled = true;
      button.textContent = 'Procesando…';
    }

    try {
      if (pending) {
        // ACK lost earlier: retry the SAME operation_id. The Worker replays the
        // stored receipt if the server already committed it; it never creates a second payment.
        if (!client || typeof client.retryPending !== 'function') throw new Error('CANONICAL_PAYMENT_UNAVAILABLE');
        var pendingAmount = pending.payload && pending.payload.amount_cents;
        var replay;
        var samePayment = matchesPending(pending);
        try {
          replay = await client.retryPending();
        } catch (error) {
          var after = pendingRecord();
          if (after && after.last_error) {
            await releaseDefinitiveRejection(client);
            var why = describePendingFailure(error); notify(why, 'error'); showNet('rejected', why);
          } else { showNet('checking', samePayment ? 'No confirmado, revisando…' : pendingBlockText(pending)); scheduleReview(5000); }
          return false;
        }
        if (!samePayment) {
          try { await refreshCanonical(); } catch (_) {}
          try { root.NAReceiptShare?.onPayment(findCredit(client.legacySnapshot(), pending.payload.credit_id), replay, pendingAmount, pending.payload.payment_method, pending.payload.reference, pending.payload.created_at); } catch (_) {}
          previousSettledNotice(pending);
          return false;
        }
        try {
          var retrySnapshot=client.legacySnapshot(),retryCredit=findCredit(retrySnapshot,pending.payload.credit_id);
          if(retryCredit&&Number.isFinite(Number(replay.current_balance_cents)))retryCredit=Object.assign({},retryCredit,{saldo:(Number(replay.current_balance_cents)+Number(pendingAmount))/100});
          root.NAReceiptShare?.onPayment(retryCredit,replay,pendingAmount,pending.payload.payment_method,pending.payload.reference,pending.payload.created_at);
        }catch(_){}
        return await afterCommit(replay, pendingAmount, true);
      }

      var snapshot;
      try {
        snapshot = forceRefresh ? await refreshCanonical() : await paymentSnapshot();
      } catch (error) {
        notify('No se registró el pago: CANON no disponible (' + clean(error && error.message) + ')', 'error');
        return false;
      }
      var credit = findCredit(snapshot, creditId);
      if (!credit) {
        notify('No se encontró el crédito CANON seleccionado', 'error');
        return false;
      }

      var outstandingCents = Math.round(Number(credit.saldo || 0) * 100);
      if (!Number.isSafeInteger(outstandingCents) || outstandingCents <= 0) {
        notify('Este crédito ya está pagado completamente', 'error');
        return false;
      }
      if (amountCents > outstandingCents) {
        notify('El abono supera el saldo pendiente', 'error');
        return false;
      }
      if (method !== 'efectivo' && referenceUsed(snapshot, reference)) {
        notify('Ese número de operación ya fue registrado', 'error');
        return false;
      }

      // expected_credit_revision is derived by canonical-client from the fresh
      // canonical replica; the bridge never supplies revisions itself.
      var input = {
        credit_id: String(credit.credit_id !== undefined ? credit.credit_id : credit.id),
        amount_cents: amountCents,
        payment_method: method
      };

      if (method === 'efectivo') {
        var cash = snapshot.cashState;
        if (!cash || !cash.abierta || !cash.sessionId) {
          notify('Abre la caja antes de registrar un cobro en efectivo', 'error');
          return false;
        }
        input.session_id = String(cash.sessionId);
      } else {
        input.reference = reference;
      }

      if (!client || typeof client.createPayment !== 'function') {
        notify('No se registró el pago CANON: CANONICAL_PAYMENT_UNAVAILABLE', 'error');
        return false;
      }
      var receipt;
      try {
        receipt = await client.createPayment(input);
      } catch (error) {
        var lost = pendingRecord();
        if (lost && lost.command === 'payment.create' && !lost.invalid && !lost.last_error) {
          // Enviado sin respuesta: no se sabe si quedó. Se revisa con la MISMA operación.
          busy = false; showNet('checking', 'No confirmado, revisando…'); scheduleReview(3000);
          return false;
        }
        var why = describePendingFailure(error);
        if (await releaseDefinitiveRejection(client)) { notify(why, 'error'); showNet('rejected', why); return false; }
        if (!(await online(client))) { showNet('offline', 'Sin conexión: el abono no se registró'); return false; }
        notify(why, 'error'); showNet('rejected', why);
        return false;
      }
      try { root.NAReceiptShare?.onPayment(credit,receipt,amountCents,method,reference,client.pendingSnapshot?.()?.payload?.created_at||new Date().toISOString()); } catch(_){}
      return await afterCommit(receipt, amountCents, false);
    } finally {
      busy = false;
      if (button && netState !== 'checking' && netState !== 'offline') {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }

  function batchFailure(message, requestedCents, completed, code) {
    var completedCents = completed.reduce(function (sum, item) { return sum + item.amount_cents; }, 0);
    var partial = completed.length > 0;
    // Respuesta perdida (pendiente sin rechazo): aviso ámbar "revisando", no rojo. Se resuelve con el MISMO id.
    var unconfirmed = null; try { unconfirmed = pendingRecord(); } catch (_) {}
    if (unconfirmed && /^payment\.(batch|create)$/.test(unconfirmed.command) && !unconfirmed.last_error && !unconfirmed.invalid) {
      batchNotice('checking', 'No confirmado, revisando… No repitas el cobro.');
      notify('Cobro no confirmado todavía: se está revisando. No lo repitas.', 'warning');
      return { ok:false, partial:partial, unconfirmed:true, code:'BATCH_UNCONFIRMED', requested_cents:requestedCents, completed_cents:completedCents, completed_count:completed.length, completed:completed.slice(), remaining_cents:Math.max(0, requestedCents - completedCents) };
    }
    if (partial) {
      notify('Lote detenido. S/ ' + (completedCents / 100).toFixed(2) + ' ya quedó CONFIRMADO en ' +
        completed.length + (completed.length === 1 ? ' crédito. ' : ' créditos. ') +
        'NO repitas ese monto. ' + message, 'error');
    } else {
      notify(message, 'error');
    }
    return {
      ok:false,
      partial:partial,
      code:code || 'BATCH_PAYMENT_FAILED',
      requested_cents:requestedCents,
      completed_cents:completedCents,
      completed_count:completed.length,
      completed:completed.slice(),
      remaining_cents:Math.max(0, requestedCents - completedCents)
    };
  }

  function reconcileBatchAfterCommit(requestedCents, completedCount) {
    Promise.resolve().then(refreshCanonical).catch(function (error) {
      notify('Cobro múltiple CANON CONFIRMADO por S/ ' + (requestedCents / 100).toFixed(2) +
        ' en ' + completedCount + (completedCount === 1 ? ' deuda. ' : ' deudas. ') +
        'No se pudo actualizar la vista todavía: ' + clean(error && error.message) +
        '. NO repitas el pago; recarga la pantalla para ver los saldos.', 'success');
    });
  }

  async function confirmBatch(request) {
    if (!enabled()) return { ok:false, partial:false, code:'CANONICAL_PAYMENT_DISABLED', completed:[] };
    if (busy) return { ok:false, partial:false, code:'CANONICAL_PAYMENT_BUSY', completed:[] };

    request = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
    var rawAllocations = Array.isArray(request.allocations) ? request.allocations : [];
    var method = clean(request.payment_method) || 'efectivo';
    var reference = clean(request.reference);
    var seen = new Set();
    var allocations = [];

    for (var i = 0; i < rawAllocations.length; i += 1) {
      var row = rawAllocations[i] && typeof rawAllocations[i] === 'object' ? rawAllocations[i] : {};
      var creditId = clean(row.credit_id);
      var amountCents = Number(row.amount_cents);
      if (!creditId || seen.has(creditId) || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
        notify('La selección del cobro múltiple no es válida', 'error');
        return { ok:false, partial:false, code:'INVALID_BATCH_ALLOCATION', completed:[] };
      }
      seen.add(creditId);
      allocations.push({ credit_id:creditId, amount_cents:amountCents });
    }

    if (!allocations.length) {
      notify('Selecciona al menos una deuda para registrar el pago', 'error');
      return { ok:false, partial:false, code:'EMPTY_BATCH', completed:[] };
    }
    if (!['efectivo', 'yape', 'plin', 'transferencia'].includes(method)) {
      notify('Método de pago inválido', 'error');
      return { ok:false, partial:false, code:'INVALID_BATCH_METHOD', completed:[] };
    }
    if (method !== 'efectivo' && reference.length < 4) {
      notify('Ingresa al menos 4 caracteres del número de operación', 'error');
      return { ok:false, partial:false, code:'INVALID_BATCH_REFERENCE', completed:[] };
    }

    var requestedCents = allocations.reduce(function (sum, row) {
      return Number.isSafeInteger(sum + row.amount_cents) ? sum + row.amount_cents : Number.MAX_SAFE_INTEGER;
    }, 0);
    if (!Number.isSafeInteger(requestedCents) || requestedCents <= 0 || requestedCents === Number.MAX_SAFE_INTEGER) {
      notify('El monto total del cobro múltiple no es válido', 'error');
      return { ok:false, partial:false, code:'INVALID_BATCH_TOTAL', completed:[] };
    }

    var client = api();
    var pending = pendingRecord();
    var forceBatchRefresh = false;
    // Caso A también en el cobro desde la ficha del cliente: sin red no se envía nada y se avisa junto al botón.
    if (!(await online(client))) {
      batchNotice(pending ? 'checking' : 'offline', pending ? 'No confirmado, revisando… vuelve a pulsar cuando haya internet; se reintenta la misma operación.' : 'Sin conexión: el abono no se registró');
      return { ok:false, partial:false, code:'CANONICAL_OFFLINE', completed:[] };
    }
    batchNotice(null);
    if (pending) {
      if (pending.invalid || !['payment.create','payment.batch'].includes(pending.command)) {
        return batchFailure('Hay otra operación en curso. Termínala antes de cobrar.',
          requestedCents, [], 'CANONICAL_OTHER_PENDING');
      }
      if (pending.last_error) {
        if (!client || typeof client.discardRejectedPayment !== 'function') {
          return batchFailure('No se pudo liberar el pago anterior. Recarga la página y vuelve a intentar.',
            requestedCents, [], 'CANONICAL_REJECTED_PENDING_LOCKED');
        }
        try {
          if (!await client.discardRejectedPayment()) {
            return batchFailure('El pago anterior necesita revisión antes de continuar.',
              requestedCents, [], 'CANONICAL_REJECTED_PENDING_REVIEW');
          }
        } catch (error) {
          return batchFailure('No se pudo liberar el pago anterior (' + clean(error && error.message) + ').',
            requestedCents, [], 'CANONICAL_REJECTED_PENDING_RELEASE_FAILED');
        }
        forceBatchRefresh = true;
      } else {
        if (!client || typeof client.retryPending !== 'function') {
          return batchFailure('No se pudo recuperar el pago anterior. Recarga la página y vuelve a intentar.',
            requestedCents, [], 'CANONICAL_PENDING_RECOVERY_UNAVAILABLE');
        }
        busy = true;
        try {
          await client.retryPending();
          await refreshCanonical();
        } catch (error) {
          return batchFailure(describePendingFailure(error), requestedCents, [], 'CANONICAL_PENDING_RECOVERY_FAILED');
        } finally {
          busy = false;
        }
        notify('El pago anterior ya quedó confirmado. Saldos actualizados; revisa el monto y pulsa Registrar pago.', 'success');
        return {
          ok:false,
          partial:false,
          recovered:true,
          code:'PRIOR_CANONICAL_PAYMENT_CONFIRMED',
          requested_cents:requestedCents,
          completed_cents:0,
          completed_count:0,
          completed:[],
          remaining_cents:requestedCents
        };
      }
    }

    var snapshot;
    try {
      snapshot = forceBatchRefresh ? await refreshCanonical() : await paymentSnapshot();
    } catch (error) {
      return batchFailure('No se pudo iniciar el lote: CANON no está disponible (' + clean(error && error.message) + ').',
        requestedCents, [], 'CANONICAL_BATCH_SNAPSHOT_FAILED');
    }

    if (method !== 'efectivo' && referenceUsed(snapshot, reference)) {
      return batchFailure('Ese número de operación ya fue registrado.', requestedCents, [], 'BATCH_REFERENCE_ALREADY_USED');
    }

    for (var j = 0; j < allocations.length; j += 1) {
      var initialCredit = findCredit(snapshot, allocations[j].credit_id);
      var initialOutstanding = initialCredit ? Math.round(Number(initialCredit.saldo || 0) * 100) : 0;
      if (!initialCredit || !Number.isSafeInteger(initialOutstanding) || initialOutstanding <= 0 ||
          allocations[j].amount_cents > initialOutstanding) {
        return batchFailure('La deuda seleccionada cambió o el monto supera su saldo actual.',
          requestedCents, [], 'BATCH_CREDIT_BALANCE_CHANGED');
      }
    }

    if (method === 'efectivo' && (!snapshot.cashState || !snapshot.cashState.abierta || !snapshot.cashState.sessionId)) {
      return batchFailure('Abre la caja antes de registrar un cobro en efectivo.',
        requestedCents, [], 'BATCH_CASH_SESSION_REQUIRED');
    }

    if (client && typeof client.createPaymentBatch === 'function') {
      busy = true;
      var fastCompleted = [];
      try {
        var fastInputs = allocations.map(function (allocation) {
          var credit = findCredit(snapshot, allocation.credit_id);
          var input = {
            credit_id:String(credit.credit_id !== undefined ? credit.credit_id : credit.id),
            amount_cents:allocation.amount_cents,
            payment_method:method
          };
          if (method === 'efectivo') input.session_id = String(snapshot.cashState.sessionId);
          else input.reference = reference;
          return input;
        });

        var batchResult = await client.createPaymentBatch(fastInputs);
        var receipts = batchResult && Array.isArray(batchResult.receipts) ? batchResult.receipts : [];
        receipts.forEach(function (receipt, index) {
          var allocation = allocations[index];
          if (!allocation) return;
          fastCompleted.push({
            credit_id:allocation.credit_id,
            amount_cents:allocation.amount_cents,
            operation_id:clean(receipt && receipt.operation_id)
          });
        });

        try { root.NAReceiptShare?.onPayments(receipts.map(function(receipt,index){var allocation=allocations[index];return {receipt:receipt,credit:findCredit(snapshot,allocation.credit_id),amount_cents:allocation.amount_cents};}),method,reference,new Date().toISOString()); }catch(_){}
        if (!batchResult || batchResult.ok !== true) {
          if (fastCompleted.length) reconcileBatchAfterCommit(requestedCents, fastCompleted.length);
          if (batchResult && batchResult.pending_unresolved) {
            return batchFailure('Existe una operación pendiente sin confirmar. Reintenta esa operación antes de continuar; no vuelvas a ingresar el total.',
              requestedCents, fastCompleted, 'BATCH_PENDING_UNRESOLVED');
          }
          return batchFailure(describePendingFailure(new Error(clean(batchResult && batchResult.error) || 'CANONICAL_FINANCIAL_REJECTED')),
            requestedCents, fastCompleted, 'BATCH_PAYMENT_REJECTED');
        }

        notify('Cobro múltiple CANON CONFIRMADO: S/ ' + (requestedCents / 100).toFixed(2) +
          ' aplicado a ' + fastCompleted.length + (fastCompleted.length === 1 ? ' deuda.' : ' deudas.'), 'success');
        reconcileBatchAfterCommit(requestedCents, fastCompleted.length);
        return {
          ok:true,
          partial:false,
          reconciling:true,
          requested_cents:requestedCents,
          completed_cents:requestedCents,
          completed_count:fastCompleted.length,
          completed:fastCompleted.slice(),
          remaining_cents:0
        };
      } catch (error) {
        return batchFailure(describePendingFailure(error), requestedCents, fastCompleted, 'BATCH_PAYMENT_REJECTED');
      } finally {
        busy = false;
      }
    }

    busy = true;
    var completed = [];
    var shareEntries = [];
    try {
      for (var index = 0; index < allocations.length; index += 1) {
        var allocation = allocations[index];
        var credit = findCredit(snapshot, allocation.credit_id);
        var outstandingCents = credit ? Math.round(Number(credit.saldo || 0) * 100) : 0;
        if (!credit || !Number.isSafeInteger(outstandingCents) || outstandingCents <= 0 ||
            allocation.amount_cents > outstandingCents) {
          return batchFailure('El saldo cambió antes de aplicar la siguiente deuda. Revisa lo pendiente antes de continuar.',
            requestedCents, completed, 'BATCH_CREDIT_CHANGED_DURING_RUN');
        }

        var input = {
          credit_id:String(credit.credit_id !== undefined ? credit.credit_id : credit.id),
          amount_cents:allocation.amount_cents,
          payment_method:method
        };
        if (method === 'efectivo') {
          var cash = snapshot.cashState;
          if (!cash || !cash.abierta || !cash.sessionId) {
            return batchFailure('La caja dejó de estar disponible durante el lote.',
              requestedCents, completed, 'BATCH_CASH_SESSION_CHANGED');
          }
          input.session_id = String(cash.sessionId);
        } else {
          // One external transfer/Yape reference can fund several selected debts.
          // It is validated once before the batch and then kept identical on each
          // canonical allocation so the audit trail points to the real operation.
          input.reference = reference;
        }

        var receipt;
        try {
          if (!client || typeof client.createPayment !== 'function') throw new Error('CANONICAL_PAYMENT_UNAVAILABLE');
          receipt = await client.createPayment(input);
        } catch (error) {
          var retryable = pendingRecord();
          if (retryable && retryable.command === 'payment.create' && !retryable.invalid && !retryable.last_error &&
              client && typeof client.retryPending === 'function') {
            try {
              // Exactly one replay of the SAME operation_id. Never manufacture a
              // second command when the ACK outcome is uncertain.
              receipt = await client.retryPending();
            } catch (retryError) {
              return batchFailure('Existe una operación pendiente sin confirmar. Reintenta esa operación antes de continuar; no vuelvas a ingresar el total.',
                requestedCents, completed, 'BATCH_PENDING_UNRESOLVED');
            }
          } else {
            return batchFailure(describePendingFailure(error),
              requestedCents, completed, 'BATCH_PAYMENT_REJECTED');
          }
        }

        shareEntries.push({credit:Object.assign({},credit),receipt:receipt,amount_cents:allocation.amount_cents});
        completed.push({
          credit_id:allocation.credit_id,
          amount_cents:allocation.amount_cents,
          operation_id:clean(receipt && receipt.operation_id)
        });

        // createPayment marks the canonical replica stale. Refresh before the
        // next allocation so its revision and cash state are current.
        try {
          snapshot = await refreshCanonical();
        } catch (refreshError) {
          if (index < allocations.length - 1) {
            return batchFailure('La última asignación quedó confirmada, pero no se pudo refrescar CANON para continuar. Recarga y cobra solo el saldo restante.',
              requestedCents, completed, 'BATCH_REFRESH_FAILED');
          }
          notify('Cobro múltiple CONFIRMADO por S/ ' + (requestedCents / 100).toFixed(2) +
            '. La vista no pudo actualizarse; recarga la pantalla y NO repitas el pago.', 'success');
          return {
            ok:true,
            partial:false,
            refresh_failed:true,
            requested_cents:requestedCents,
            completed_cents:requestedCents,
            completed_count:completed.length,
            completed:completed.slice(),
            remaining_cents:0
          };
        }
      }

      notify('Cobro múltiple CANON CONFIRMADO: S/ ' + (requestedCents / 100).toFixed(2) +
        ' aplicado a ' + completed.length + (completed.length === 1 ? ' deuda.' : ' deudas.'), 'success');
      return {
        ok:true,
        partial:false,
        requested_cents:requestedCents,
        completed_cents:requestedCents,
        completed_count:completed.length,
        completed:completed.slice(),
        remaining_cents:0
      };
    } finally {
      try { root.NAReceiptShare?.onPayments(shareEntries,method,reference,new Date().toISOString()); }catch(_){}
      busy = false;
    }
  }

  // Al abrir la ficha del cliente (también tras recargar): un abono «no confirmado» se dibuja en ámbar
  // junto al botón de cobro y se revisa con el servidor con su MISMO id. Devuelve true si lo dibujó.
  function showPendingOnCard() {
    if (!enabled()) return false;
    var p = null; try { p = pendingRecord(); } catch (_) {}
    if (!p || !/^payment\.(batch|create)$/.test(p.command) || p.last_error || p.invalid) return false;
    var pl = p.payload || {}, amt = Number(pl.amount_cents || 0);
    if (!amt) Object.keys(pl).forEach(function (k) { if (Array.isArray(pl[k])) pl[k].forEach(function (x) { amt += Number(x && x.amount_cents || 0); }); });
    batchNotice('checking', 'Abono' + (amt ? ' de S/ ' + (amt / 100).toFixed(2) : '') + ' no confirmado, revisando… No lo repitas.');
    var b = root.document && root.document.getElementById('naV2BatchSubmit'), box = b && b.parentElement && b.parentElement.querySelector('.na-pay-net-batch');
    if (!box || box.hidden || !/checking/.test(box.className)) return false;
    scheduleReview(800);
    return true;
  }
  root.NuevoAmanecerCanonicalCreditPaymentBridge = Object.freeze({
    showPendingOnCard: showPendingOnCard,
    enabled: enabled,
    confirm: confirm,
    confirmBatch: confirmBatch,
    busy: function () { return busy; },
    netState: function () { return netState; },
    clearNotice: function () { if (netState !== 'checking') showNet(null); }
  });
})(globalThis);
