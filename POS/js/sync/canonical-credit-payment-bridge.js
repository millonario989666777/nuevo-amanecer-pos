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
      if (!['efectivo', 'yape', 'transferencia'].includes(method)) {
        notify('Método de pago inválido', 'error');
        return false;
      }
      if (method !== 'efectivo' && reference.length < 4) {
        notify('Ingresa al menos 4 caracteres del número de operación', 'error');
        root.document.getElementById('pagoOperacion')?.focus?.();
        return false;
      }
    }

    var button = root.document.getElementById('pagoConfirmBtn');
    var label = button?.textContent || '✅ Confirmar';
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
        try {
          replay = await client.retryPending();
        } catch (error) {
          notify(describePendingFailure(error), 'error');
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
        notify(describePendingFailure(error), 'error');
        await releaseDefinitiveRejection(client);
        return false;
      }
      try { root.NAReceiptShare?.onPayment(credit,receipt,amountCents,method,reference,client.pendingSnapshot?.()?.payload?.created_at||new Date().toISOString()); } catch(_){}
      return await afterCommit(receipt, amountCents, false);
    } finally {
      busy = false;
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }

  function batchFailure(message, requestedCents, completed, code) {
    var completedCents = completed.reduce(function (sum, item) { return sum + item.amount_cents; }, 0);
    var partial = completed.length > 0;
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
    if (!['efectivo', 'yape', 'transferencia'].includes(method)) {
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

  root.NuevoAmanecerCanonicalCreditPaymentBridge = Object.freeze({
    enabled: enabled,
    confirm: confirm,
    confirmBatch: confirmBatch,
    busy: function () { return busy; }
  });
})(globalThis);
