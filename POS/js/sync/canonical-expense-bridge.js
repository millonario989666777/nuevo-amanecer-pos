(function (root) {
  'use strict';

  if (!root || !root.document) return;

  var original = {
    abrirModalGasto: root.abrirModalGasto,
    guardarGasto: root.guardarGasto,
    abrirMovCaja: root.abrirMovCaja
  };
  var busy = false;
  var editing = null;

  function expenseMessage(error){var code=String(error&&error.message||error||'');var messages={expense_locked_closed_shift:'El turno de este gasto ya está cerrado. No se puede editar ni anular.',expense_date_locked_closed_day:'Esa fecha tiene un cierre de caja. Elige otro día.',expense_date_outside_shift:'La fecha no puede ser anterior a la apertura del turno.',expense_date_out_of_range:'La fecha debe estar dentro de los últimos 31 días.',expense_date_in_future:'La fecha del gasto no puede ser futura.'};for(var key in messages)if(code.includes(key))return messages[key];return 'No se pudo guardar el gasto.';}
  function api() { return root.NuevoAmanecerCanonical; }
  function enabled() {
    var client = api();
    try { return !!(client && typeof client.enabled === 'function' && client.enabled()); }
    catch (_) { return false; }
  }
  function clean(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' '); }
  function moneyCents(value) {
    var amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    var cents = Math.round(amount * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }
  function notify(message, tone) {
    var fn; try { if (typeof toast === 'function') fn = toast; } catch (_) {}
    if (!fn) fn = root.toast;
    if (typeof fn === 'function') fn(message, tone || 'error');
  }
  function employee() { return root.NA_ROLES && root.NA_ROLES.role === 'empleado'; }
  function openShift() {
    var client = api();
    var cash = client && typeof client.legacySnapshot === 'function' && client.legacySnapshot().cashState;
    return cash && cash.abierta && cash.sessionId && cash.openedByDeviceId === root.NA_ROLES.deviceId ? cash : null;
  }
  function authorized() {
    if (employee() && (!enabled() || !openShift())) { notify('Abre tu caja para registrar una salida'); return false; }
    if (typeof root._naF10AuthorizePermission === 'function') {
      return root._naF10AuthorizePermission('cash', 'Registrar gasto') !== false;
    }
    return true;
  }
  function today() {
    return typeof root.obtenerHoy === 'function'
      ? root.obtenerHoy()
      : new Date().toLocaleDateString('en-CA');
  }
  function modalMode(edit) {
    var modal=root.document.getElementById('mGasto');if(!modal||typeof modal.querySelector!=='function')return;
    var title=modal.querySelector('.mhead-title'),ok=modal.querySelector('.mbtn-ok');
    if(title&&title.lastChild)title.lastChild.textContent=edit?' Editar gasto':' Registrar gasto';
    if(ok&&ok.lastChild)ok.lastChild.textContent=edit?' Guardar cambios':' Registrar';
  }
  function resetAndOpen() {
    editing=null;modalMode(false);
    ['gasMonto','gasMetodo'].forEach(function(id){var field=root.document.getElementById(id);if(field){field.disabled=false;field.readOnly=false;}});
    ['gasDesc','gasNota'].forEach(function (id) {
      var field = root.document.getElementById(id);
      if (field) field.value = '';
    });
    var amount = root.document.getElementById('gasMonto');
    var date = root.document.getElementById('gasFecha');
    if (amount) amount.value = '';
    if (date) date.value = today();
    if(typeof root._naDateDisplayHelp==='function')root._naDateDisplayHelp();
    root.document.getElementById('mGasto')?.classList.add('open');
  }
  function closeModal() {
    var fn; try { if (typeof cerrarModal === 'function') fn = cerrarModal; } catch (_) {}
    if (!fn) fn = root.cerrarModal;
    if (typeof fn === 'function') fn('mGasto');
    else root.document.getElementById('mGasto')?.classList.remove('open');
  }
  function renderExpenseViews() {
    if (typeof root.gasRender === 'function') root.gasRender();
    if (typeof root.cajRender === 'function') root.cajRender();
    if (typeof root.updateDashboard === 'function') root.updateDashboard();
  }
  async function refreshCanonical() {
    var client = api();
    if (!client || typeof client.refresh !== 'function') throw new Error('CANONICAL_CLIENT_UNAVAILABLE');
    await client.refresh();
    if (typeof client.legacySnapshot !== 'function') throw new Error('CANONICAL_SNAPSHOT_UNAVAILABLE');
    return client.legacySnapshot();
  }

  root.abrirModalGasto = function () {
    if (!enabled()) return typeof original.abrirModalGasto === 'function' ? original.abrirModalGasto.apply(this, arguments) : undefined;
    if (!authorized()) return;
    resetAndOpen();
    if (employee()) { var method = root.document.getElementById('gasMetodo'); if (method) method.value = 'efectivo'; }
  };

  async function revise(command, input) {
    var client=api();
    if(typeof client.prepareCommand==='function')await client.prepareCommand(command);
    try { return await (command==='expense.update'?client.updateExpense(input):client.voidExpense(input)); }
    catch(error) {
      // Release only definitive rejections of this revision intent.
      // Timeouts/5xx remain durable for replay; other financial intents stay intact.
      var pending=typeof client.pendingSnapshot==='function'&&client.pendingSnapshot();
      if(pending&&pending.command===command&&pending.payload.expense_id===input.expense_id&&
        pending.last_status>=400&&pending.last_status<500&&pending.last_status!==429&&typeof client.releaseRejectedFinancial==='function') {
        await client.releaseRejectedFinancial(pending.payload.operation_id);
        await refreshCanonical();renderExpenseViews();
      }
      throw error;
    }
  }
  function owner() { return !!(root.NA_ROLES && root.NA_ROLES.isOwner()); }
  function revisionInput(expense) { return {expense_id:expense.expenseId,expected_revision:Number(expense.revision)||0}; }
  root.NA_EXPENSES = {
    edit: function(expense) {
      if(!owner()||!enabled()||busy||expense.voided)return;
      resetAndOpen();editing=expense;modalMode(true);
      [['gasDesc',expense.desc],['gasCat',expense.cat],['gasNota',expense.nota],['gasFecha',expense.fecha],['gasMonto',expense.monto],['gasMetodo',expense.metodo]].forEach(function(pair){var field=root.document.getElementById(pair[0]);if(field)field.value=pair[1]||'';});
      if(typeof root._naDateDisplayHelp==='function')root._naDateDisplayHelp();
      ['gasMonto','gasMetodo'].forEach(function(id){var field=root.document.getElementById(id);if(field){field.readOnly=true;field.disabled=true;}});
    },
    void: async function(expense) {
      if(!owner()||!enabled()||busy||expense.voided)return false;
      if(!root.confirm('¿Eliminar este gasto? Se conservará su historial financiero.'))return false;
      busy=true;
      try { await revise('expense.void',revisionInput(expense));await refreshCanonical();renderExpenseViews();notify('Gasto eliminado','success');return true; }
      catch(error){notify(String(error.message).includes('cash_expense_void_requires_adjustment')?'Este gasto afectó la caja. Registra un ajuste de ingreso en caja para compensarlo.':expenseMessage(error));return false;}
      finally{busy=false;}
    }
  };

  root.abrirMovCaja = function (type) {
    if (!enabled() || type !== 'gas') {
      return typeof original.abrirMovCaja === 'function' ? original.abrirMovCaja.apply(this, arguments) : undefined;
    }
    return root.abrirModalGasto();
  };

  root.guardarGasto = async function () {
    if (!enabled()) return typeof original.guardarGasto === 'function' ? original.guardarGasto.apply(this, arguments) : false;
    if (busy) return false;
    if (editing) {
      if(!owner())return false;
      busy=true;
      try {
        var input=Object.assign(revisionInput(editing),{concept:clean(root.document.getElementById('gasDesc')?.value),category:clean(root.document.getElementById('gasCat')?.value),note:clean(root.document.getElementById('gasNota')?.value),expense_date:clean(root.document.getElementById('gasFecha')?.value)});
        if(input.expense_date>today()){notify('La fecha del gasto no puede ser futura.');return false;}
        await revise('expense.update',input);editing=null;closeModal();await refreshCanonical();renderExpenseViews();notify('Gasto editado','success');return true;
      }catch(error){var m=String(error&&error.message||'');notify(expenseMessage(error));return false;}finally{busy=false;}
    }
    if (!authorized()) return false;

    var description = clean(root.document.getElementById('gasDesc')?.value);
    var amountCents = moneyCents(root.document.getElementById('gasMonto')?.value);
    var method = clean(root.document.getElementById('gasMetodo')?.value);
    var date = clean(root.document.getElementById('gasFecha')?.value) || today();
    var category = clean(root.document.getElementById('gasCat')?.value);
    var note = clean(root.document.getElementById('gasNota')?.value);
    if (!description || !amountCents) {
      notify('Verifica concepto y monto', 'error');
      return false;
    }

    var button = root.document.querySelector('#mGasto .mbtn-ok');
    var label = button?.textContent || '💾 Registrar';
    busy = true;
    if (button) { button.disabled = true; button.textContent = 'Procesando…'; }

    try {
      var client = api();
      // C-P0-1: never stay frozen behind a stranded operation; never register twice.
      var stranded = typeof client.settleStrandedFinancial === 'function' ? await client.settleStrandedFinancial() : null;
      if (stranded && stranded.status === 'REPLAYED' && stranded.command === 'expense.create') {
        closeModal(); renderExpenseViews();
        notify('El gasto anterior sí llegó al servidor. Revisa la lista antes de registrar otro.', 'success');
        return true;
      }
      var snapshot = typeof client.prepareCommand === 'function' ? await client.prepareCommand('expense.create') : await refreshCanonical();
      var input = {
        amount_cents: amountCents,
        concept: description,
        category: category || 'Otro',
        payment_method: method || 'efectivo',
        expense_date: date,
        note: note
      };
      var cash = snapshot && snapshot.cashState;
      // C-P2: only the till of THAT business day takes the expense; a till left
      // open from another day never absorbs today's cash.
      var sameDayTill = cash && cash.abierta && cash.sessionId && date === today() && (!cash.fechaApertura || cash.fechaApertura === date);
      if (employee()) {
        if (!cash || !cash.abierta || !cash.sessionId || cash.openedByDeviceId !== root.NA_ROLES.deviceId || input.payment_method !== 'efectivo') throw new Error('Registra una salida en efectivo en tu caja abierta');
        input.session_id = cash.sessionId;
      }
      else if (sameDayTill) input.session_id = cash.sessionId;
      else if (cash && cash.abierta && cash.fechaApertura && cash.fechaApertura !== date && (method || 'efectivo') === 'efectivo')
        notify('La caja abierta es del ' + cash.fechaApertura + ': este gasto se guarda fuera de la caja. Cierra esa caja y abre la de hoy.', 'warning');

      var receipt = await api().createExpense(input);
      Promise.resolve().then(refreshCanonical).then(renderExpenseViews).catch(function (error) {
        if (root.console) root.console.warn('[Gasto CANON] Confirmado; actualización pendiente', error.message);
      });
      closeModal();
      renderExpenseViews();
      notify(receipt && receipt.session_id
        ? 'Gasto CANON registrado en la caja'
        : 'Gasto CANON guardado fuera de la caja', 'success');
      return true;
    } catch (error) {
      notify(expenseMessage(error), 'error');
      return false;
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };

  function updateCashExpenseButton() {
    var button = root.document.querySelector('#pageCaja .btn-cjac.gas');
    if (!button || !employee()) return;
    button.hidden = !enabled() || !openShift();
    if (button.lastChild && button.lastChild.nodeType === 3 && button.lastChild.textContent !== 'Registrar gasto / salida de caja') button.lastChild.textContent = 'Registrar gasto / salida de caja';
  }
  if (typeof root.MutationObserver === 'function') new root.MutationObserver(updateCashExpenseButton).observe(root.document.getElementById('pageCaja') || root.document.body, { childList: true, subtree: true });
  if (typeof root.addEventListener === 'function') root.addEventListener('na:canonical-refreshed', updateCashExpenseButton);
  updateCashExpenseButton();

  root.NuevoAmanecerCanonicalExpenseBridge = Object.freeze({
    enabled: enabled,
    busy: function () { return busy; }
  });
})(globalThis);
