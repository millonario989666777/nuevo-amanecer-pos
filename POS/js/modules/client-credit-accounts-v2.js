/*
 * Nuevo Amanecer CANON — Ficha Financiera / Cuentas y Créditos V2.
 * Promoción selectiva del comportamiento aprobado en POS-LAB.
 * El ledger, pagos, FIFO, Caja, saldos y evaluación financiera existentes
 * continúan siendo la única autoridad financiera.
 */
(function (root) {
  'use strict';
// ===== CANON: CUENTAS Y CRÉDITOS POR CLIENTE V2 =====
  // CANON. El ledger financiero sigue siendo el existente; esta capa añade
  // organización, navegación y metadata opcional sin duplicar pagos/caja/FIFO.
  var NA_SMALL_ACCOUNT_ID = 'small';
  var NA_SMALL_ACCOUNT_NAME = 'Créditos pequeños';
  var labClientScreenState = { clientId:null, route:'home', categoryId:null, creditId:null, purchaseId:null };
  var labSaleCreditState = { clientId:null, categoryId:NA_SMALL_ACCOUNT_ID, installmentCount:1 };
  var naClientListMotionTimer = 0;
  var naClientListMotionReady = false;
  var naClientListMotionEpoch = 0;
  var naClientWorkspaceCleanupTimer = 0;
  var naClientWorkspaceEpoch = 0;
  var naClientViewTimer = 0;
  var naClientViewCancel = null;
  var naClientViewEpoch = 0;
  var naClientMotionBound = false;
  var labBatchSubmitInFlight = false;
  var labBatchAwaitingReconcile = false;
  // Ephemeral, post-commit UI projection. Entries exist only after a durable
  // CANON receipt and are removed once the authoritative replica contains them.
  var labPaymentReceiptOverlays = new Map();
  var NA_CLIENT_INTERACTIVE_SELECTOR = 'button,input,textarea,select,option,a,label,[contenteditable="true"],[role="button"]';

  function labEsc(value) {
    if (typeof _naEsc === 'function') return _naEsc(String(value ?? ''));
    return String(value ?? '').replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
  }

  function labClientDisplayName(client) {
    return String(client && client.nombre || 'Cliente').toUpperCase();
  }

  function labMoney(value) {
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
    if (typeof fmt === 'function') return fmt(Number(value));
    return 'S/ ' + Number(value).toFixed(2);
  }

  function labCreditPending(cr) {
    if (typeof _naCreditOutstanding === 'function') return Math.max(0, Number(_naCreditOutstanding(cr)) || 0);
    return Math.max(0, (Number(cr && cr.monto) || 0) - (Number(cr && cr.pagado) || 0));
  }

  function labCreditStatus(cr) {
    if (typeof _naSyncCreditStatus === 'function') {
      try { _naSyncCreditStatus(cr); } catch {}
    }
    return String((cr && (cr.status || cr.estado)) || '').toLowerCase();
  }

  function labIsCanceled(cr) {
    var status = labCreditStatus(cr);
    return !!(cr && !cr.anulado && status !== 'anulado' && (status === 'cancelado' || labCreditPending(cr) <= 0.001));
  }

  function labDueDays(value) {
    if (!value) return null;
    if (typeof diasHasta === 'function') {
      var result = diasHasta(value);
      return Number.isFinite(result) ? result : null;
    }
    var due = new Date(String(value).slice(0, 10) + 'T23:59:59');
    if (!Number.isFinite(due.getTime())) return null;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.ceil((due - today) / 86400000);
  }

  function localDay(value) {
    var parsed = new Date(String(value || ''));
    if (!Number.isFinite(parsed.getTime())) return String(value || '').slice(0, 10);
    function pad(v) { return String(v).padStart(2, '0'); }
    return parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate());
  }

  function labPaymentIdentity(pay) {
    return String(pay && (pay.operation_id || pay.operationId || pay.pagoId || pay.id) || '');
  }

  function labReceiptVisualPayment(entry, credit) {
    var payload = entry.payload, receipt = entry.receipt;
    var timestamp = String(payload.created_at || '');
    var reference = String(payload.reference || '');
    var operationId = String(receipt.operation_id || payload.operation_id || '');
    return {
      id: operationId,
      pagoId: operationId,
      operation_id: operationId,
      creditoId: String(receipt.credit_id || payload.credit_id || ''),
      clienteId: credit && (credit.cliId ?? credit.clienteId),
      monto: Number(payload.amount_cents) / 100,
      montoPagado: Number(payload.amount_cents) / 100,
      // P1-3: business-local calendar day (same rule as the canonical adapter and Caja).
      fecha: /^\d{4}-\d{2}-\d{2}T/.test(timestamp) ? localDay(timestamp) : '',
      timestamp: timestamp || null,
      canonicalDateKnown: !!timestamp,
      datePrecision: timestamp ? 'TIMESTAMP' : 'UNKNOWN',
      metodo: String(payload.payment_method || 'efectivo'),
      operacion: reference,
      numeroOperacion: reference,
      referencia: reference,
      cajero: '',
      cajeroNombre: '',
      canonical: true,
      canonicalReceiptProjection: true
    };
  }

  function labApplyPaymentReceiptOverlays(rows) {
    if (!labPaymentReceiptOverlays.size) return rows;
    return rows.map(function (cr) {
      var creditId = String(cr && (cr.credit_id ?? cr.id) || '');
      var overlays = Array.from(labPaymentReceiptOverlays.values()).filter(function (entry) {
        return String(entry.receipt.credit_id || entry.payload.credit_id || '') === creditId;
      });
      if (!overlays.length) return cr;

      var copy = Object.assign({}, cr);
      copy.pagos = (Array.isArray(cr.pagos) ? cr.pagos : []).slice();
      var existing = new Set(copy.pagos.map(labPaymentIdentity).filter(Boolean));
      overlays.sort(function (a, b) {
        return String(a.payload.created_at || '').localeCompare(String(b.payload.created_at || ''));
      }).forEach(function (entry) {
        var operationId = String(entry.receipt.operation_id || entry.payload.operation_id || '');
        if (operationId && !existing.has(operationId)) {
          copy.pagos.push(labReceiptVisualPayment(entry, copy));
          existing.add(operationId);
        }
        var balance = Number(entry.receipt.current_balance_cents);
        if (Number.isSafeInteger(balance) && balance >= 0) {
          copy.saldo = balance / 100;
          copy.pagado = Math.max(0, Number(((Number(copy.monto) || 0) - copy.saldo).toFixed(2)));
          if (balance === 0) {
            copy.status = 'cancelado';
            copy.estado = 'cancelado';
          }
        }
      });
      return copy;
    });
  }

  function labClientCredits(clientId) {
    var rows = null;
    if (typeof _naClientCreditsFast === 'function') {
      try { rows = _naClientCreditsFast(clientId); } catch (_) {}
    }
    if (!Array.isArray(rows)) {
      rows = (Array.isArray(creditos) ? creditos : []).filter(function (cr) {
        return String(cr && (cr.cliId ?? cr.clienteId)) === String(clientId) && !cr.anulado && labCreditStatus(cr) !== 'anulado';
      });
    }
    return labApplyPaymentReceiptOverlays(rows);
  }

  function labReconcilePaymentReceiptOverlays() {
    if (!labPaymentReceiptOverlays.size) return false;
    var rows = Array.isArray(creditos) ? creditos : [];
    var changed = false;
    labPaymentReceiptOverlays.forEach(function (entry, operationId) {
      var creditId = String(entry.receipt.credit_id || entry.payload.credit_id || '');
      var credit = rows.find(function (row) {
        return String(row && (row.credit_id ?? row.id) || '') === creditId;
      });
      var committed = credit && (Array.isArray(credit.pagos) ? credit.pagos : []).some(function (pay) {
        return labPaymentIdentity(pay) === operationId;
      });
      if (committed) {
        labPaymentReceiptOverlays.delete(operationId);
        changed = true;
      }
    });
    return changed;
  }

  function labAcceptPaymentReceipt(detail) {
    var payload = detail && detail.payload, receipt = detail && detail.receipt;
    if (!detail || detail.version !== 1 || detail.command !== 'payment.create' || !payload || !receipt) return false;
    var operationId = String(payload.operation_id || '');
    if (!operationId || operationId !== String(receipt.operation_id || '') ||
        String(payload.credit_id || '') !== String(receipt.credit_id || '') ||
        !Number.isSafeInteger(Number(payload.amount_cents)) || Number(payload.amount_cents) <= 0 ||
        !Number.isSafeInteger(Number(receipt.current_balance_cents)) || Number(receipt.current_balance_cents) < 0 ||
        !['created','already_processed'].includes(String(receipt.status || ''))) return false;
    labPaymentReceiptOverlays.set(operationId, {
      payload: JSON.parse(JSON.stringify(payload)),
      receipt: JSON.parse(JSON.stringify(receipt))
    });
    return true;
  }

  function labNormalizeCategory(raw, fallbackIndex) {
    if (!raw || typeof raw !== 'object') return null;
    var name = String(raw.name || raw.nombre || '').trim();
    if (!name) return null;
    var mode = raw.mode === 'accumulated' ? 'accumulated' : 'separate';
    var id = String(raw.id || ('labcat_' + fallbackIndex)).trim();
    if (!id || id === NA_SMALL_ACCOUNT_ID) return null;
    return { id:id, name:name.slice(0, 60), mode:mode, createdAt:raw.createdAt || null };
  }

  function labCustomCategories(client) {
    var seen = new Set();
    return (Array.isArray(client && client.creditCategories) ? client.creditCategories : [])
      .map(labNormalizeCategory)
      .filter(function (cat) {
        if (!cat || seen.has(cat.id)) return false;
        seen.add(cat.id);
        return true;
      });
  }

  function creditAccountMeta(cr) {
    var raw = cr && cr.creditAccount;
    if (raw && typeof raw === 'object' && raw.categoryId && raw.categoryId !== NA_SMALL_ACCOUNT_ID) {
      return {
        categoryId:String(raw.categoryId),
        categoryName:String(raw.categoryName || 'Categoría').slice(0, 60),
        mode:raw.mode === 'accumulated' ? 'accumulated' : 'separate',
        source:raw.source || 'legacy'
      };
    }
    return { categoryId:NA_SMALL_ACCOUNT_ID, categoryName:NA_SMALL_ACCOUNT_NAME, mode:'accumulated', source:'default' };
  }

  function labCategoriesForClient(client) {
    var result = [{ id:NA_SMALL_ACCOUNT_ID, name:NA_SMALL_ACCOUNT_NAME, mode:'accumulated', builtin:true }];
    var seen = new Set([NA_SMALL_ACCOUNT_ID]);
    labCustomCategories(client).forEach(function (cat) {
      if (!seen.has(cat.id)) { seen.add(cat.id); result.push(cat); }
    });
    labClientCredits(client && client.id).forEach(function (cr) {
      var meta = creditAccountMeta(cr);
      if (meta.categoryId !== NA_SMALL_ACCOUNT_ID && !seen.has(meta.categoryId)) {
        seen.add(meta.categoryId);
        result.push({ id:meta.categoryId, name:meta.categoryName, mode:meta.mode, recovered:true });
      }
    });
    return result;
  }

  function labCreditsForCategory(clientId, categoryId) {
    return labClientCredits(clientId).filter(function (cr) {
      return creditAccountMeta(cr).categoryId === String(categoryId || NA_SMALL_ACCOUNT_ID);
    });
  }

  function labCreditVisualDate(cr) {
  var direct = String(cr && cr.fecha || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  var timestampDate = String(cr && cr.timestamp || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(timestampDate) ? timestampDate : '';
}

function labCreditVisualTimestamp(cr) {
  var raw = String(cr && cr.timestamp || '');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return Number.NEGATIVE_INFINITY;
  var parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function labSortCreditsNewestFirst(rows) {
  return (Array.isArray(rows) ? rows : []).slice().sort(function (a, b) {
    var dateOrder = labCreditVisualDate(b).localeCompare(labCreditVisualDate(a));
    if (dateOrder) return dateOrder;
    var aTime = labCreditVisualTimestamp(a), bTime = labCreditVisualTimestamp(b);
    if (aTime !== bTime) return bTime - aTime;
    return String(b && (b.ventaId || b.id) || '').localeCompare(
      String(a && (a.ventaId || a.id) || ''), 'es', { numeric:true, sensitivity:'base' }
    );
  });
}

function labCategorySummary(client, category) {
  var all = labCreditsForCategory(client.id, category.id);
  var active = labSortCreditsNewestFirst(all.filter(function (cr) { return !labIsCanceled(cr); }));
  var closed = labSortCreditsNewestFirst(all.filter(labIsCanceled));
    var pending = active.reduce(function (sum, cr) { return sum + labCreditPending(cr); }, 0);
    var purchaseCount = active.length;
    return {
      category:category, all:all, active:active, closed:closed,
      pending:Number(pending.toFixed(2)),
      purchaseCount:purchaseCount,
      activeCount:active.length
    };
  }

  function labEffectivePayments(cr) {
    return (Array.isArray(cr && cr.pagos) ? cr.pagos : [])
      .filter(function (pay) {
        return String(pay && pay.status || '').toUpperCase() !== 'REVERTED' && !(pay && pay.reversalId);
      })
      .slice()
      .sort(function (a,b) {
        return new Date(a.timestamp || (a.fecha || '') + 'T' + (a.hora24 || a.hora || '00:00:00')) -
               new Date(b.timestamp || (b.fecha || '') + 'T' + (b.hora24 || b.hora || '00:00:00'));
      });
  }

  function labSplitInstallmentAmounts(total, count) {
    var cents = Math.max(0, Math.round((Number(total) || 0) * 100));
    count = Math.max(1, Math.min(60, Math.floor(Number(count) || 1)));
    var base = Math.floor(cents / count), remainder = cents - base * count;
    return Array.from({length:count}, function (_, index) {
      return (base + (index < remainder ? 1 : 0)) / 100;
    });
  }

  function labInstallmentPlan(cr) {
    var raw = labInstallmentRawPlan(cr);
    var originalAmount = Math.max(0, Number(cr && cr.monto) || 0);
    var fallbackAmounts = labSplitInstallmentAmounts(originalAmount, raw.length);
    var normalizedAmounts = raw.map(function (item, index) {
      var amount = Number(item && item.amount);
      if (!Number.isFinite(amount) || amount < 0) amount = fallbackAmounts[index];
      return Number(amount.toFixed(2));
    });
    var scheduleTotal = normalizedAmounts.reduce(function (sum, amount) { return sum + amount; }, 0);
    var paidTotal = Math.min(originalAmount, Math.max(0, Number(cr && cr.pagado) || 0));
    var historicalBaseline = Math.max(0, Number((originalAmount - scheduleTotal).toFixed(2)));
    var schedulePaid = Math.max(0, Math.min(scheduleTotal, Number((paidTotal - historicalBaseline).toFixed(2))));
    var payments = labEffectivePayments(cr), runningPayments = 0, paymentIndex = 0;
    var cumulativeDue = 0;

    return raw.map(function (item, index) {
      var amount = normalizedAmounts[index];
      var previousDue = cumulativeDue;
      cumulativeDue += amount;
      var paidAmount = Math.max(0, Math.min(amount, Number((schedulePaid - previousDue).toFixed(2))));
      var completionTarget = historicalBaseline + cumulativeDue;
      while (paymentIndex < payments.length && runningPayments + 0.001 < completionTarget) {
        runningPayments += Math.max(0, Number(payments[paymentIndex].monto ?? payments[paymentIndex].montoPagado) || 0);
        paymentIndex += 1;
      }
      var isPaid = paidAmount + 0.001 >= amount;
      var isPartial = paidAmount > 0.001 && !isPaid;
      var completionPayment = isPaid && paymentIndex > 0 ? payments[paymentIndex - 1] : null;
      return {
        number:Number(item && item.number) || index + 1,
        due:String(item && item.due || item && item.fecha || cr && cr.vence || '').slice(0, 10),
        amount:Number(amount.toFixed(2)),
        paid:isPaid,
        partial:isPartial,
        paidAmount:Number(paidAmount.toFixed(2)),
        remaining:Number(Math.max(0, amount - paidAmount).toFixed(2)),
        visualDerived:!!(item && item.visualDerived),
        paidAt:completionPayment ? (completionPayment.timestamp || ((completionPayment.fecha || '') + 'T' + (completionPayment.hora24 || completionPayment.hora || ''))) : null,
        paymentId:completionPayment ? (completionPayment.pagoId || completionPayment.id || null) : null
      };
    });
  }

  function labInstallmentSummary(cr) {
    var plan = labInstallmentPlan(cr), paid = plan.filter(function (x) { return x.paid; });
    var pending = plan.filter(function (x) { return !x.paid; });
    return { plan:plan, paid:paid, pending:pending, paidCount:paid.length, pendingCount:pending.length };
  }

  function labLastPaymentDate(cr) {
    var rows = labEffectivePayments(cr);
    var pay = rows[rows.length - 1];
    if (!pay) return cr && cr.fecha ? cr.fecha : '—';
    return pay.fecha || (pay.timestamp ? String(pay.timestamp).slice(0,10) : '—');
  }

  function labClientFinancialSummary(client) {
    var all = labClientCredits(client.id);
    var active = all.filter(function (cr) { return !labIsCanceled(cr); });
    var closed = all.filter(labIsCanceled);
    var debt = active.reduce(function (sum, cr) { return sum + labCreditPending(cr); }, 0);
    var overdueDebt = active.filter(function (cr) {
      return labCreditPending(cr) > 0.001 && labDueDays(cr.vence) !== null && labDueDays(cr.vence) < 0;
    }).reduce(function (sum, cr) { return sum + labCreditPending(cr); }, 0);
    var evaluation = null;
    if (typeof _naEvaluateClientCredit === 'function') {
      try { evaluation = _naEvaluateClientCredit(client.id); } catch {}
    }
    return { all:all, active:active, closed:closed, debt:Number(debt.toFixed(2)), overdueDebt:Number(overdueDebt.toFixed(2)), evaluation:evaluation };
  }

  function labClassifyClient(client) {
    var summary = labClientFinancialSummary(client), e = summary.evaluation || {}, h = e.history || {};
    var punctual = Number(h.punctual || 0);
    var late = Number(h.late || 0);
    var completed = Number(h.completed || 0);
    var partial = Number(h.partial || 0);
    var overdueActive = Number(h.overdueActive || 0);
    var behavior = String(h.behavior || '').toLowerCase();
    var hasBehaviorHistory = punctual > 0 || late > 0 || completed > 0 || partial > 0;
    var label = 'NUEVO', tone = 'slate', reasons = [];

    if (summary.overdueDebt > 0.001 || overdueActive > 0 || behavior === 'impuntual') {
      label = 'PELIGRO'; tone = 'red';
      if (summary.overdueDebt > 0.001 || overdueActive > 0) reasons.push('Mantiene deuda vencida o mora activa');
      if (late > 0 || behavior === 'impuntual') reasons.push('Registra pagos tardíos o comportamiento impuntual');
    } else if (e.eligible === false) {
      label = 'SIN REQUISITOS'; tone = 'slate';
      reasons.push('No cumple actualmente los requisitos de la evaluación financiera vigente');
      reasons.push('Sin deuda vencida activa');
    } else if (!hasBehaviorHistory || behavior === 'sin_historial') {
      label = 'NUEVO'; tone = 'slate';
      reasons.push('Historial financiero insuficiente para clasificar su comportamiento');
      reasons.push('Aún no hay pagos suficientes para asignar una categoría de comportamiento');
    } else if (punctual > 0 && late === 0) {
      label = 'ESTABLE'; tone = 'green';
      reasons.push('Pagos registrados mayormente puntuales');
      reasons.push('Sin deuda vencida actual');
      if (completed > 0) reasons.push('Tiene créditos finalizados');
    } else {
      label = 'REGULAR'; tone = 'amber';
      if (late > 0 || behavior === 'irregular') reasons.push('El historial incluye atrasos o comportamiento irregular');
      else reasons.push('El historial financiero está todavía en evaluación');
      reasons.push('Sin deuda vencida activa');
    }
    return { label:label, tone:tone, reasons:reasons, summary:summary };
  }

  function labProductSummary(cr) {
    var items = Array.isArray(cr && cr.items) ? cr.items : [];
    if (!items.length) return String(cr && cr.desc || 'Compra a crédito');
    var first = items[0] && (items[0].nombre || items[0].name) || 'Producto';
    return items.length > 1 ? first + ' + ' + (items.length - 1) + (items.length - 1 === 1 ? ' producto' : ' productos') : first;
  }

  function labCategoryVisual(category) {
    var name = String(category && category.name || '').toLowerCase();
    if (String(category && category.id || '') === NA_SMALL_ACCOUNT_ID) return { tone:'teal', icon:'🧾' };
    if (/tecnolog|celular|equipo|electr/.test(name)) return { tone:'blue', icon:'📱' };
    if (/pr[eé]stamo|dinero|efectivo/.test(name)) return { tone:'amber', icon:'S/' };
    return { tone:'slate', icon:'◈' };
  }

  function labNavRow(icon, tone, title, subtitle, action) {
    var behaviorClass = title === 'COMPORTAMIENTO' ? ' na-v2-behavior-nav' : '';
    return '<button type="button" class="na-v2-row na-v2-nav-card na-v2-tone-' + labEsc(tone) + behaviorClass + '" onclick="' + action + '">' +
      '<span class="na-v2-row-main"><span class="na-v2-module-icon" aria-hidden="true">' + labEsc(icon) + '</span>' +
      '<span class="na-v2-row-copy"><strong>' + labEsc(title) + '</strong><small>' + labEsc(subtitle) + '</small></span></span><b>›</b></button>';
  }

  function labDisplayDate(value) {
    var iso = String(value || '').slice(0,10);
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return match ? match[3] + '/' + match[2] + '/' + match[1] : (iso || 'Fecha no registrada');
  }

  function labTodayIso() {
    var now = new Date();
    var y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2,'0'), d = String(now.getDate()).padStart(2,'0');
    return y + '-' + m + '-' + d;
  }

  function labInstallmentVisualState(item, nextPendingNumber, todayIso) {
    if (item && item.paid) return { key:'paid', label:'Pagada', next:false };
    if (item && item.partial) return { key:'partial', label:'Parcial', next:true };
    var due = String(item && item.due || '').slice(0,10);
    var today = todayIso || labTodayIso();
    var isNext = Number(item && item.number) === Number(nextPendingNumber);
    if (due && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today) return { key:'overdue', label:'Vencida', next:isNext };
    if (due && due === today) return { key:'today', label:'Hoy', next:isNext };
    if (isNext) return { key:'next', label:'Próxima', next:true };
    return { key:'pending', label:'Pendiente', next:false };
  }

  function labDescriptionInstallmentHint(cr) {
    var text = String(cr && cr.desc || '').trim();
    if (!text) return { count:null, amount:null, firstDue:'', dueDay:null };
    var countMatch = /(\d{1,2})\s+cuotas?\s+mensuales?/i.exec(text);
    var amountMatch = /cuotas?\s+mensuales?\s+de\s+S\/\s*([\d.,]+)/i.exec(text);
    var dateMatch = /desde\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
    var isoMatch = /desde\s+(\d{4})-(\d{2})-(\d{2})/i.exec(text);
    var dayMatch = /cada\s+d[ií]a\s+(\d{1,2})/i.exec(text);
    var amount = null;
    if (amountMatch) {
      var rawAmount = String(amountMatch[1] || '').trim();
      if (rawAmount.includes('.') && rawAmount.includes(',')) rawAmount = rawAmount.replace(/,/g,'');
      else if (!rawAmount.includes('.') && rawAmount.includes(',')) rawAmount = rawAmount.replace(',','.');
      amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) amount = null;
    }
    var firstDue = '';
    if (dateMatch) {
      firstDue = dateMatch[3] + '-' + String(dateMatch[2]).padStart(2,'0') + '-' + String(dateMatch[1]).padStart(2,'0');
    } else if (isoMatch) {
      firstDue = isoMatch[1] + '-' + isoMatch[2] + '-' + isoMatch[3];
    }
    var count = countMatch ? Math.floor(Number(countMatch[1])) : null;
    if (!Number.isFinite(count) || count < 2 || count > 60) count = null;
    var dueDay = dayMatch ? Math.floor(Number(dayMatch[1])) : null;
    if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31) dueDay = null;
    return { count:count, amount:amount, firstDue:firstDue, dueDay:dueDay };
  }

  function labInstallmentCountHint(cr) {
    var candidates = [
      cr && cr.labInstallmentCount,
      cr && cr.installmentCount,
      cr && cr.numeroCuotas,
      cr && cr.cantidadCuotas,
      cr && cr.cuotasTotal,
      cr && cr.nroCuotas,
      cr && (typeof cr.cuotas === 'number' ? cr.cuotas : null)
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var count = Math.floor(Number(candidates[i]));
      if (Number.isFinite(count) && count > 1 && count <= 60) return count;
    }
    return labDescriptionInstallmentHint(cr).count || 1;
  }

  function labFirstInstallmentDue(cr) {
    var direct = [
      cr && cr.primerVencimiento,
      cr && cr.fechaPrimeraCuota,
      cr && cr.firstDue,
      cr && cr.firstInstallmentDate
    ];
    for (var i = 0; i < direct.length; i += 1) {
      var value = String(direct[i] || '').slice(0,10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    }
    var descHint = labDescriptionInstallmentHint(cr);
    if (/^\d{4}-\d{2}-\d{2}$/.test(descHint.firstDue || '')) return descHint.firstDue;
    var legacyDue = String(cr && cr.vence || '').slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(legacyDue)) return legacyDue;
    var start = String(cr && (cr.fechaInicioCuotas || cr.fechaInicial || cr.fechaInicio || cr.fecha) || '').slice(0,10);
    var startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
    var dueDay = Math.floor(Number(cr && (cr.diaVencimiento || cr.diaCuota || cr.installmentDay)));
    if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31) dueDay = descHint.dueDay;
    if (!startMatch || !Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31) return '';
    var year = Number(startMatch[1]), monthIndex = Number(startMatch[2]) - 1, startDay = Number(startMatch[3]);
    if (dueDay < startDay) monthIndex += 1;
    var target = new Date(year, monthIndex + 1, 0);
    var day = Math.min(dueDay, target.getDate());
    var resolved = new Date(year, monthIndex, day, 12, 0, 0, 0);
    return resolved.toISOString().slice(0,10);
  }

  function labInstallmentRawPlan(cr) {
    if (Array.isArray(cr && cr.installments) && cr.installments.length) return cr.installments.slice();
    var count = labInstallmentCountHint(cr);
    var firstDue = labFirstInstallmentDue(cr);
    if (count > 1 && firstDue) {
      var total = Number(cr && cr.monto) || 0;
      var structuredAmount = cr && (cr.montoCuota ?? cr.cuotaMonto ?? cr.montoPorCuota ?? cr.installmentAmount);
      var explicitAmount = Number(structuredAmount);
      if (!Number.isFinite(explicitAmount) || explicitAmount <= 0) explicitAmount = Number(labDescriptionInstallmentHint(cr).amount);
      var useExplicit = Number.isFinite(explicitAmount) && explicitAmount > 0 &&
        (!total || Math.abs(explicitAmount * count - total) < 0.02);
      var amounts = useExplicit ? Array.from({length:count}, function () { return explicitAmount; }) : labSplitInstallmentAmounts(total, count);
      return labMonthlyDates(firstDue, count).map(function (due,index) {
        return { number:index + 1, due:due, amount:Number((amounts[index] ?? 0).toFixed(2)), visualDerived:true };
      });
    }
    return [{ number:1, due:cr && cr.vence || '', amount:Number(cr && cr.monto) || 0 }];
  }

  function naClientNow() {
    try { return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now(); }
    catch (_) { return Date.now(); }
  }

  function naMotionCore() {
    return root.NA_MOTION && root.NA_MOTION.core ? root.NA_MOTION.core : null;
  }

  function naClientSetMotionState(element, state) {
    var core = naMotionCore();
    if (core && typeof core.setState === 'function') return core.setState(element, state);
    if (element && element.dataset) element.dataset.naMotionState = state || 'idle';
    return state || 'idle';
  }

  function naClientGetMotionState(element) {
    var core = naMotionCore();
    if (core && typeof core.getState === 'function') return core.getState(element);
    return element && element.dataset ? (element.dataset.naMotionState || 'idle') : 'idle';
  }

  function naClientSetMotionProgress(element, value) {
    var core = naMotionCore();
    if (core && typeof core.setProgress === 'function') return core.setProgress(element, value);
    var progress = Math.max(0, Math.min(1, Number(value) || 0));
    if (element && element.style) element.style.setProperty('--na-motion-progress', progress.toFixed(4));
    return progress;
  }

  function naClientCssTimeMs(element, propertyName, fallback) {
    var core = naMotionCore();
    if (core && typeof core.cssTimeMs === 'function') return core.cssTimeMs(element, propertyName, fallback);
    try {
      if (!element || typeof root.getComputedStyle !== 'function') return fallback;
      var raw = String(root.getComputedStyle(element).getPropertyValue(propertyName) || '').trim();
      if (!raw) return fallback;
      if (/ms$/i.test(raw)) return Math.max(0, Number.parseFloat(raw) || fallback);
      if (/s$/i.test(raw)) return Math.max(0, (Number.parseFloat(raw) || 0) * 1000);
    } catch (_) {}
    return fallback;
  }

  function naClientWatchTransition(element, propertyName, fallbackMs, callback) {
    var core = naMotionCore();
    if (core && typeof core.whenTransitionEnds === 'function') {
      return core.whenTransitionEnds(element, {
        propertyName:propertyName || '',
        fallbackMs:Math.max(0, Number(fallbackMs) || 0)
      }, callback);
    }

    var done = false;
    var timer = null;
    function cleanup() {
      if (timer !== null) root.clearTimeout(timer);
      if (element && element.removeEventListener) element.removeEventListener('transitionend', onEnd);
    }
    function finish() {
      if (done) return;
      done = true;
      cleanup();
      if (typeof callback === 'function') callback();
    }
    function onEnd(event) {
      if (!event || event.target !== element) return;
      if (propertyName && event.propertyName !== propertyName) return;
      finish();
    }
    if (element && element.addEventListener) element.addEventListener('transitionend', onEnd);
    timer = root.setTimeout(finish, Math.max(0, Number(fallbackMs) || 0));
    return function () {
      if (done) return;
      done = true;
      cleanup();
    };
  }

  function naClientWorkspacePanel(screen) {
    return screen && screen.querySelector ? screen.querySelector('.na-client-account-shell') : null;
  }

  function naClientClearWorkspaceCleanup() {
    if (naClientWorkspaceCleanupTimer) root.clearTimeout(naClientWorkspaceCleanupTimer);
    naClientWorkspaceCleanupTimer = 0;
  }

  function naClientResetWorkspaceVisual(screen) {
    if (!screen) return;
    naClientClearWorkspaceCleanup();
    screen.classList.remove('na-client-workspace-dragging','na-client-workspace-settling','na-client-workspace-opening','na-client-workspace-closing');
    screen.style.removeProperty('--na-client-workspace-drag-y');
    screen.style.removeProperty('--na-client-workspace-panel-opacity');
    screen.style.removeProperty('--na-client-workspace-backdrop-alpha');
    naClientSetMotionProgress(screen, 0);
    naClientSetMotionState(screen, screen.hidden ? 'closed' : 'open');
  }

  function naClientWorkspaceTravel(panel) {
    var height = panel && panel.getBoundingClientRect ? Number(panel.getBoundingClientRect().height) || Number(panel.offsetHeight) || 1 : 1;
    return Math.min(640, Math.max(360, height * 0.58));
  }

  function naClientSetWorkspaceVisual(screen, panel, distance) {
    var progress = naClientSetMotionProgress(screen, distance / naClientWorkspaceTravel(panel));
    screen.style.setProperty('--na-client-workspace-drag-y', Number(distance).toFixed(1) + 'px');
    screen.style.setProperty('--na-client-workspace-panel-opacity', (1 - progress * 0.94).toFixed(3));
    screen.style.setProperty('--na-client-workspace-backdrop-alpha', (1 - progress).toFixed(3));
    naClientSetMotionState(screen, 'dragging');
  }

  function naClientWatchWorkspaceCleanup(screen, panel, callback) {
    naClientClearWorkspaceCleanup();
    var epoch = ++naClientWorkspaceEpoch;
    var settled = false;
    var finish = function () {
      if (settled || epoch !== naClientWorkspaceEpoch) return;
      settled = true;
      if (panel && panel.removeEventListener) panel.removeEventListener('transitionend', onTransitionEnd);
      naClientClearWorkspaceCleanup();
      callback();
    };
    var onTransitionEnd = function (event) {
      if (!event || event.target !== panel || event.propertyName === 'transform') finish();
    };
    if (panel && panel.addEventListener) panel.addEventListener('transitionend', onTransitionEnd);
    var fallback = naClientReducedMotion() ? 24 : naClientCssTimeMs(screen, '--na-client-workspace-settle-duration', 350) + 100;
    naClientWorkspaceCleanupTimer = root.setTimeout(finish, fallback);
  }

  function naClientBeginWorkspaceSettle(screen, panel, target, state, done) {
    naClientClearWorkspaceCleanup();
    screen.classList.remove('na-client-workspace-dragging');
    screen.classList.add('na-client-workspace-settling');
    naClientSetMotionState(screen, state || 'settling');
    if (typeof screen.offsetWidth === 'number') void screen.offsetWidth;
    root.requestAnimationFrame(function () { target(); });
    naClientWatchWorkspaceCleanup(screen, panel, function () {
      screen.classList.remove('na-client-workspace-settling','na-client-workspace-opening','na-client-workspace-closing');
      if (done) done();
    });
  }

  function naClientSettleWorkspaceBack(screen, panel) {
    naClientBeginWorkspaceSettle(screen, panel, function () {
      screen.style.setProperty('--na-client-workspace-drag-y', '0px');
      screen.style.setProperty('--na-client-workspace-panel-opacity', '1');
      screen.style.setProperty('--na-client-workspace-backdrop-alpha', '1');
    }, 'settling', function () { naClientResetWorkspaceVisual(screen); });
  }

  function naClientFinishWorkspaceClose(screen) {
    screen.hidden = true;
    document.getElementById('pageClientes')?.classList.remove('na-client-detail-open');
    labClientScreenState = { clientId:null, route:'home', categoryId:null, creditId:null, purchaseId:null };
    naClientResetWorkspaceVisual(screen);
  }

  function naClientDismissWorkspace(screen) {
    var panel = naClientWorkspacePanel(screen);
    if (!screen || !panel) return naClientFinishWorkspaceClose(screen);
    if (naClientReducedMotion()) return naClientFinishWorkspaceClose(screen);
    screen.classList.add('na-client-workspace-closing');
    naClientBeginWorkspaceSettle(screen, panel, function () {
      var panelHeight = panel.getBoundingClientRect ? Number(panel.getBoundingClientRect().height) || Number(panel.offsetHeight) || 0 : 0;
      var exitDistance = Math.max(Number(root.innerHeight) || 0, panelHeight + 80) + 32;
      screen.style.setProperty('--na-client-workspace-drag-y', exitDistance + 'px');
      screen.style.setProperty('--na-client-workspace-panel-opacity', '0');
      screen.style.setProperty('--na-client-workspace-backdrop-alpha', '0');
    }, 'closing', function () { naClientFinishWorkspaceClose(screen); });
  }

  function naClientOpenWorkspace(screen) {
    var page = document.getElementById('pageClientes');
    var panel = naClientWorkspacePanel(screen);
    // P2-3: reset the scroll while the layout is still clean (before showing the
    // panel). Writing scrollTop after hidden=false forced a synchronous layout of
    // the whole detail (~120 ms with 45 credits on a mid-range phone).
    if (screen.scrollTop) screen.scrollTop = 0;
    screen.hidden = false;
    page?.classList.add('na-client-detail-open');
    if (!panel || naClientReducedMotion()) {
      naClientResetWorkspaceVisual(screen);
      return;
    }
    screen.classList.add('na-client-workspace-opening');
    screen.style.setProperty('--na-client-workspace-drag-y', '26px');
    screen.style.setProperty('--na-client-workspace-panel-opacity', '.96');
    screen.style.setProperty('--na-client-workspace-backdrop-alpha', '.72');
    naClientBeginWorkspaceSettle(screen, panel, function () {
      screen.style.setProperty('--na-client-workspace-drag-y', '0px');
      screen.style.setProperty('--na-client-workspace-panel-opacity', '1');
      screen.style.setProperty('--na-client-workspace-backdrop-alpha', '1');
    }, 'opening', function () { naClientResetWorkspaceVisual(screen); });
  }

  function naClientResetViewMotion(content) {
    if (naClientViewCancel) {
      naClientViewCancel();
      naClientViewCancel = null;
    }
    if (naClientViewTimer) root.clearTimeout(naClientViewTimer);
    naClientViewTimer = 0;
    if (!content) return;
    content.classList.remove('na-client-view-transitioning');
    naClientSetMotionState(content, 'idle');
    var current = content.firstElementChild;
    if (current && current.classList) {
      current.classList.remove('na-client-view-exit-forward','na-client-view-exit-back','na-client-view-enter-forward','na-client-view-enter-back');
    }
  }

  // Al redibujar la ficha se conservan monto, método y referencia del abono que se está escribiendo
  // (mismo cliente). Tras confirmar un abono no se restauran: el formulario vuelve vacío.
  var NA_V2_DRAFT_IDS = ['naV2BatchAmount', 'naV2BatchMethod', 'naV2BatchReference'];
  var naV2DraftSkip = false;
  function naV2DraftCapture(content) {
    if (!content || naV2DraftSkip || labBatchSubmitInFlight) return null;
    var out = { clientId:labClientScreenState.clientId, values:{} }, any = false;
    NA_V2_DRAFT_IDS.forEach(function (id) { var el = content.querySelector('#' + id); if (el && el.value !== '' && el.value != null) { out.values[id] = el.value; if (id !== 'naV2BatchMethod') any = true; } });
    return any ? out : null;
  }
  // Borrador del abono guardado en el aparato (monto, método, referencia y deudas elegidas): sobrevive a una
  // recarga (p. ej. la actualización automática). Se borra cuando el servidor confirma el abono. Si la recarga
  // ocurrió con el abono ya enviado, NO se restaura: ese abono conserva su id de operación en la cola y la ficha
  // lo muestra en ámbar; restaurarlo invitaría a cobrarlo dos veces.
  var NA_V2_DRAFT_KEY = 'na_v2_abono_draft_v1', NA_V2_DRAFT_TTL = 24 * 3600 * 1000;
  function naV2StoredRead() { try { var d = JSON.parse(root.localStorage.getItem(NA_V2_DRAFT_KEY) || 'null'); return d && d.clientId && d.values ? d : null; } catch (_) { return null; } }
  function naV2StoredWrite(d) { try { if (d) root.localStorage.setItem(NA_V2_DRAFT_KEY, JSON.stringify(d)); else root.localStorage.removeItem(NA_V2_DRAFT_KEY); } catch (_) {} }
  var naV2Restoring = false;
  // Códigos del puente en los que NO salió nada al servidor: el borrador vuelve a ser editable.
  var NA_V2_LOCAL_CODES = /^(CANONICAL_PAYMENT_DISABLED|CANONICAL_PAYMENT_BUSY|INVALID_BATCH_\w+|EMPTY_BATCH|CANONICAL_OFFLINE|BATCH_REFERENCE_ALREADY_USED|BATCH_CREDIT_BALANCE_CHANGED|BATCH_CASH_SESSION_REQUIRED)$/;
  function naV2PendingBatch() {
    try { var c = root.NuevoAmanecerCanonical, p = c && c.pendingSnapshot && c.pendingSnapshot(); return p && p.command === 'payment.batch' ? p : null; } catch (_) { return null; }
  }
  function naV2DraftPersist() {
    if (naV2Restoring || naV2DraftSkip || labBatchSubmitInFlight || !labClientScreenState.clientId) return;
    // Un abono ya enviado nunca se pisa (re-render, eventos sintéticos): solo se borra cuando el servidor confirma.
    var prev = naV2StoredRead(); if (prev && prev.submitted) return;
    var screen = labScreen(); if (!screen || !screen.querySelector) return;
    var d = naV2DraftCapture(screen);
    if (!d) { var old = naV2StoredRead(); if (old && old.clientId === labClientScreenState.clientId && !old.submitted) naV2StoredWrite(null); return; }
    d.checks = Array.from(screen.querySelectorAll('.na-v2-batch-check:checked')).map(function (i) { return String(i.value || ''); });
    d.at = Date.now(); d.submitted = false;
    naV2StoredWrite(d);
  }
  function naV2DraftMarkSubmitted() { var d = naV2StoredRead(); if (d) { d.submitted = true; d.at = Date.now(); naV2StoredWrite(d); } }
  function naV2DraftClear() { naV2StoredWrite(null); }
  function naV2DraftFromStore() {
    var d = naV2StoredRead(); if (!d) return null;
    if (d.submitted || !(Date.now() - Number(d.at || 0) < NA_V2_DRAFT_TTL)) { naV2StoredWrite(null); return null; }
    return d.clientId === labClientScreenState.clientId ? d : null;
  }
  function naV2DraftRestore(content, draft) {
    if (!draft) draft = naV2DraftFromStore();
    if (!content || !draft || draft.clientId !== labClientScreenState.clientId) return;
    if (naV2PendingBatch()) return; // hay un lote de abonos sin confirmar: no se ofrece cobrarlo otra vez
    naV2Restoring = true;
    try {
    var touched = null;
    NA_V2_DRAFT_IDS.forEach(function (id) { var el = content.querySelector('#' + id); if (el && draft.values[id] != null && el.value !== draft.values[id]) { el.value = draft.values[id]; touched = touched || el; } });
    if (touched) { try { touched.dispatchEvent(new Event('input', { bubbles:true })); touched.dispatchEvent(new Event('change', { bubbles:true })); } catch (_) {} }
    // Deudas elegidas: después del monto (que autoselecciona) para respetar la elección del cajero.
    if (Array.isArray(draft.checks) && draft.checks.length) {
      var want = new Set(draft.checks.map(String)), boxes = Array.from(content.querySelectorAll('.na-v2-batch-check'));
      if (boxes.length) { boxes.forEach(function (i) { i.checked = want.has(String(i.value || '')); }); try { labBatchUpdatePreview(); } catch (_) {} }
    }
    } finally { root.setTimeout(function () { naV2Restoring = false; }, 0); }
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('input', function (e) { var t = e && e.target; if (t && t.isTrusted !== false && t.id && NA_V2_DRAFT_IDS.indexOf(t.id) >= 0 && e.isTrusted) naV2DraftSkip = false; }, true);
  if (typeof document !== 'undefined' && document.addEventListener) ['input', 'change'].forEach(function (ev) { document.addEventListener(ev, function (e) { var t = e && e.target; if (t && ((t.id && NA_V2_DRAFT_IDS.indexOf(t.id) >= 0) || (t.classList && t.classList.contains('na-v2-batch-check')))) root.setTimeout(naV2DraftPersist, 0); }, true); });

  function naClientRenderSubview(screen, content, html, direction) {
    direction = direction || 'replace';
    if (!content) return;
    var naV2Draft = naV2DraftCapture(content);
    if (direction === 'replace' || naClientReducedMotion() || !content.firstElementChild) {
      naClientViewEpoch += 1;
      naClientResetViewMotion(content);
      if (screen.scrollTop) screen.scrollTop = 0;
      content.innerHTML = html;
      naV2DraftRestore(content, naV2Draft);
      naClientSetMotionState(content, 'open');
      return;
    }

    var epoch = ++naClientViewEpoch;
    naClientResetViewMotion(content);
    content.classList.add('na-client-view-transitioning');
    naClientSetMotionState(content, 'closing');
    var current = content.firstElementChild;
    var isBack = direction === 'back';
    current.classList.add(isBack ? 'na-client-view-exit-back' : 'na-client-view-exit-forward');
    var duration = naClientCssTimeMs(content, '--na-client-view-duration', 220);

    naClientViewCancel = naClientWatchTransition(current, 'transform', duration + 90, function () {
      if (epoch !== naClientViewEpoch) return;
      naClientViewCancel = null;
      if (screen.scrollTop) screen.scrollTop = 0;
      content.innerHTML = html;
      naV2DraftRestore(content, naV2Draft);
      var incoming = content.firstElementChild;
      if (!incoming) {
        naClientResetViewMotion(content);
        return;
      }

      incoming.classList.add(isBack ? 'na-client-view-enter-back' : 'na-client-view-enter-forward');
      naClientSetMotionState(content, 'opening');

      root.requestAnimationFrame(function () {
        if (epoch !== naClientViewEpoch) return;
        root.requestAnimationFrame(function () {
          if (epoch !== naClientViewEpoch) return;
          incoming.classList.remove('na-client-view-enter-back','na-client-view-enter-forward');
          naClientViewCancel = naClientWatchTransition(incoming, 'transform', duration + 90, function () {
            if (epoch !== naClientViewEpoch) return;
            naClientViewCancel = null;
            content.classList.remove('na-client-view-transitioning');
            naClientSetMotionState(content, 'open');
          });
        });
      });
    });
  }

  function naBindClientWorkspaceSwipe(screen) {
    if (!screen || screen.dataset.naSwipeBound === 'true') return false;
    var panel = naClientWorkspacePanel(screen);
    if (!panel || !panel.addEventListener) return false;
    screen.dataset.naSwipeBound = 'true';

    var tracking = false, dragging = false, startX = 0, startY = 0, startAt = 0, lastDistance = 0;
    var reset = function () { tracking=false;dragging=false;startX=0;startY=0;startAt=0;lastDistance=0; };
    var interactive = function (target) { return !!(target && target.closest && target.closest(NA_CLIENT_INTERACTIVE_SELECTOR)); };

    panel.addEventListener('touchstart', function (event) {
      if (naClientReducedMotion() || !event.touches || event.touches.length !== 1 || screen.hidden || screen.scrollTop > 0 || interactive(event.target)) return;
      var motionState = naClientGetMotionState(screen);
      if (motionState === 'settling' || motionState === 'closing') return;
      naClientClearWorkspaceCleanup();
      var touch = event.touches[0];
      tracking = true; dragging = false; startX = touch.clientX; startY = touch.clientY; startAt = naClientNow(); lastDistance = 0;
    }, {passive:true});

    panel.addEventListener('touchmove', function (event) {
      if (!tracking || !event.touches || event.touches.length !== 1) return;
      var touch = event.touches[0], dx = touch.clientX - startX, dy = touch.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) { reset(); return; }
        if (dy <= 6) return;
        if (screen.scrollTop > 0) { reset(); return; }
        dragging = true;
        screen.classList.add('na-client-workspace-dragging');
        naClientSetMotionState(screen, 'dragging');
      }
      if (dy <= 0) return;
      if (event.preventDefault) event.preventDefault();
      lastDistance = dy;
      naClientSetWorkspaceVisual(screen, panel, dy);
    }, {passive:false});

    var finish = function (cancelled) {
      if (!tracking) return;
      var wasDragging = dragging, distance = lastDistance, elapsed = Math.max(1, naClientNow() - startAt);
      var velocity = distance / elapsed;
      var panelHeight = panel.getBoundingClientRect ? Number(panel.getBoundingClientRect().height) || Number(panel.offsetHeight) || 1 : 1;
      var threshold = Math.min(190, Math.max(110, panelHeight * .22));
      var dismiss = !cancelled && wasDragging && (distance >= threshold || (distance >= 60 && velocity >= .85));
      reset();
      if (!wasDragging) return;
      if (dismiss) naClientDismissWorkspace(screen);
      else naClientSettleWorkspaceBack(screen, panel);
    };
    panel.addEventListener('touchend', function () { finish(false); }, {passive:true});
    panel.addEventListener('touchcancel', function () { finish(true); }, {passive:true});
    return true;
  }

  function labScreen() {
    var page = document.getElementById('pageClientes');
    if (!page) return null;
    var screen = page.querySelector('.na-client-account-screen');
    if (!screen) {
      screen = document.createElement('section');
      screen.className = 'na-client-account-screen';
      screen.hidden = true;
      naClientSetMotionState(screen, 'closed');
      screen.innerHTML = '<div class="na-client-account-shell"><div class="na-client-account-content"></div></div>';
      page.appendChild(screen);
      naBindClientWorkspaceSwipe(screen);
    }
    return screen;
  }

  function labClientById(clientId) {
    return Array.isArray(clientes) ? clientes.find(function (c) { return String(c.id) === String(clientId); }) : null;
  }

  function labRenderScreen(html, direction) {
    var screen = labScreen();
    if (!screen) return;
    var content = screen.querySelector('.na-client-account-content');
    naSyncClientDialogVisibility();
    var wasHidden = screen.hidden;
    if (wasHidden) {
      if (content) content.innerHTML = html;
      naClientOpenWorkspace(screen);
      return;
    }
    naClientRenderSubview(screen, content, html, direction || 'replace');
  }

  function labCloseScreen(immediate) {
    var screen = labScreen();
    if (!screen) return;
    if (immediate || naClientReducedMotion() || screen.hidden) return naClientFinishWorkspaceClose(screen);
    naClientDismissWorkspace(screen);
  }

  function labResetClientNavigationForMenu() {
    var page = document.getElementById('pageClientes');
    if (!page || !page.classList.contains('active')) return false;
    labCloseScreen(true);
    return true;
  }

  function labBindClientMenuReset() {
    var button = document.getElementById('backBtn');
    if (!button) return false;
    if (button.dataset.labClientMenuReset === 'true') return true;

    button.dataset.labClientMenuReset = 'true';
    button.addEventListener('click', function () {
      labResetClientNavigationForMenu();
    }, true);
    return true;
  }

  function labBackButton(label) {
    return '<button type="button" class="na-v2-back" onclick="naCanonClientBack()">← ' + labEsc(label || 'Clientes') + '</button>';
  }

  function labAccountRow(client, category) {
    var summary = labCategorySummary(client, category), visual = labCategoryVisual(category);
    var detail = category.mode === 'accumulated'
      ? summary.purchaseCount + (summary.purchaseCount === 1 ? ' compra' : ' compras')
      : summary.activeCount + (summary.activeCount === 1 ? ' crédito activo' : ' créditos activos');
    return '<button type="button" class="na-v2-row na-v2-account-card na-v2-tone-' + visual.tone + '" onclick="naCanonOpenCreditCategory(\'' + labEsc(String(category.id)) + '\')">' +
      '<span class="na-v2-row-main"><span class="na-v2-module-icon" aria-hidden="true">' + labEsc(visual.icon) + '</span>' +
      '<span class="na-v2-row-copy"><strong>' + labEsc(category.name) + '</strong><small>' + labEsc(detail) + '</small></span></span>' +
      '<span class="na-v2-row-value"><strong>' + labMoney(summary.pending) + '</strong><small>pendiente</small></span><b>›</b>' +
    '</button>';
  }

  function labHomeHtml(client) {
    var c = labClassifyClient(client), s = c.summary, e = s.evaluation || {};
    var categories = labCategoriesForClient(client);
    var paymentCount = s.all.reduce(function (n, cr) { return n + labEffectivePayments(cr).length; }, 0);
    var line = Number.isFinite(Number(e.assignedLine)) ? Number(e.assignedLine) : null;
    var available = Number.isFinite(Number(e.available)) ? Number(e.available) : null;
    return '<div class="na-v2-screen">' +
      labBackButton('Clientes') +
      '<header class="na-v2-client-head na-v2-tone-' + c.tone + '">' +
        '<div class="na-v2-client-identity"><span class="na-v2-eyebrow">Ficha financiera</span>' +
          '<div class="na-v2-name-line"><h2>' + labEsc(labClientDisplayName(client)) + '</h2>' +
          '<button type="button" class="na-v2-risk na-v2-risk-' + c.tone + '" onclick="naCanonOpenClientBehavior()">● ' + labEsc(c.label) + '</button></div>' +
          '<p>' + (client.dni ? 'DNI ' + labEsc(client.dni) : 'Sin DNI') + (client.tel ? ' · ' + labEsc(client.tel) : '') + '</p>' +
        '</div>' +
        '<div class="na-v2-head-money"><span>Deuda total</span><strong>' + labMoney(s.debt) + '</strong>' +
          '<small>Línea ' + labMoney(line) + (available !== null ? ' · ' + labMoney(available) + ' disponible' : '') + '</small></div>' +
      '</header>' +
      '<section class="na-v2-section na-v2-accounts-section"><div class="na-v2-section-title"><span>CUENTAS Y CRÉDITOS</span><small>Organizado por tipo</small></div>' +
        '<div class="na-v2-list na-v2-card-list">' + categories.map(function (cat) { return labAccountRow(client, cat); }).join('') + '</div></section>' +
      '<section class="na-v2-section"><div class="na-v2-section-title"><span>GESTIÓN DEL CLIENTE</span><small>Consulta y seguimiento</small></div>' +
        '<div class="na-v2-list na-v2-card-list na-v2-nav-grid">' +
          '<button type="button" class="na-v2-row na-v2-nav-card" data-edit-contact="' + labEsc(String(client.id)) + '"><span><strong>DATOS DEL CLIENTE</strong><small>Nombre, WhatsApp, DNI/RUC y dirección</small></span><b>›</b></button>' +
          labNavRow('↺','slate','HISTORIAL DE PAGOS',paymentCount + ' pagos / cuotas canceladas','naCanonOpenClientPaymentHistory()') +
          labNavRow('✓','green','CRÉDITOS CANCELADOS',s.closed.length + ' créditos finalizados','naCanonOpenCanceledCredits()') +
          labNavRow('S/','blue','LÍNEA DE CRÉDITO',available === null ? 'Evaluación disponible' : labMoney(available) + ' disponible','naCanonOpenCreditLine()') +
          labNavRow('●',c.tone,'COMPORTAMIENTO',c.label,'naCanonOpenClientBehavior()') +
        '</div></section>' +
    '</div>';
  }

  function labBatchMoneyCents(value) {
    var amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    var cents = Math.round(amount * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function labBatchCreditDate(cr) {
    var value = String(cr && (cr.fecha || cr.vence) || '').slice(0,10);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '9999-12-31';
  }

  function labBatchAllocationPlan(credits, totalCents) {
    credits = Array.isArray(credits) ? credits.slice() : [];
    totalCents = Number(totalCents);
    var ordered = credits.filter(function (cr) {
      return cr && !labIsCanceled(cr) && labCreditPending(cr) > 0.001;
    }).sort(function (a,b) {
      var dateCompare = labBatchCreditDate(a).localeCompare(labBatchCreditDate(b));
      return dateCompare || String(a.id || '').localeCompare(String(b.id || ''));
    });
    var selectedCents = ordered.reduce(function (sum, cr) {
      var cents = Math.max(0, Math.round(labCreditPending(cr) * 100));
      return Number.isSafeInteger(sum + cents) ? sum + cents : Number.MAX_SAFE_INTEGER;
    }, 0);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      return { allocations:[], requested_cents:0, selected_cents:selectedCents, unallocated_cents:0, valid:false };
    }
    var remaining = totalCents;
    var allocations = [];
    ordered.forEach(function (cr) {
      if (remaining <= 0) return;
      var pendingCents = Math.max(0, Math.round(labCreditPending(cr) * 100));
      var amountCents = Math.min(remaining, pendingCents);
      if (amountCents > 0) {
        allocations.push({ credit_id:String(cr.id), amount_cents:amountCents });
        remaining -= amountCents;
      }
    });
    return {
      allocations:allocations,
      requested_cents:totalCents,
      selected_cents:selectedCents,
      unallocated_cents:Math.max(0, remaining),
      valid:allocations.length > 0 && remaining === 0
    };
  }

  function labBatchRow(cr, rowHtml) {
    var id = labEsc(String(cr && cr.id || ''));
    return '<div class="na-v2-batch-row" data-na-batch-credit-id="' + id + '">' +
      '<label class="na-v2-batch-check-wrap" title="Seleccionar esta deuda">' +
        '<input type="checkbox" class="na-v2-batch-check" value="' + id + '" onchange="naCanonBatchSelectionChanged()">' +
        '<span class="na-v2-batch-check-ui" aria-hidden="true">✓</span>' +
      '</label>' +
      '<div class="na-v2-batch-row-body">' + rowHtml +
        '<div class="na-v2-batch-allocation" data-na-batch-allocation="' + id + '" aria-live="polite"></div>' +
      '</div>' +
    '</div>';
  }

  function labBatchPanelHtml(summary) {
    if (!summary || !Array.isArray(summary.active) || !summary.active.length) return '';
    return '<section class="na-v2-batch-pay" aria-label="Cobro múltiple">' +
      '<div class="na-v2-batch-head"><div><span class="na-v2-eyebrow">Cobro múltiple</span><strong>Paga varias deudas en una sola acción</strong></div>' +
        '<button type="button" class="na-v2-batch-selectall" id="naV2BatchToggleAllBtn" onclick="naCanonBatchToggleAll()">Seleccionar todo</button></div>' +
      '<label class="na-v2-batch-amount"><span>Monto total que está abonando</span><input id="naV2BatchAmount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" oninput="naCanonBatchAmountChanged()"></label>' +
      '<div class="na-v2-batch-actions"><button type="button" class="na-v2-batch-auto" onclick="naCanonBatchAutoSelect()">Aplicar automáticamente</button></div>' +
      '<div class="na-v2-batch-method-row"><label><span>Método de pago</span><select id="naV2BatchMethod" onchange="naCanonBatchMethodChanged()">' +
        '<option value="efectivo">Efectivo</option><option value="yape">Yape</option><option value="plin">Plin</option><option value="transferencia">Transferencia</option>' +
      '</select></label><label id="naV2BatchReferenceWrap" hidden><span>Número de operación</span><input id="naV2BatchReference" maxlength="80" autocomplete="off" placeholder="Ej: 00078257" oninput="naCanonBatchPaymentChanged()"></label></div>' +
      '<div class="na-v2-batch-summary" id="naV2BatchSummary">Selecciona las deudas que deseas pagar.</div>' +
      '<button type="button" class="na-v2-batch-submit" id="naV2BatchSubmit" onclick="naCanonSubmitBatchPayment()" disabled>Registrar pago</button>' +
    '</section>';
  }

  function labBatchCurrentCredits() {
    var client = labClientById(labClientScreenState.clientId);
    if (!client || labClientScreenState.route !== 'category') return [];
    return labCreditsForCategory(client.id, labClientScreenState.categoryId).filter(function (cr) {
      return cr && !labIsCanceled(cr) && labCreditPending(cr) > 0.001;
    });
  }

  function labBatchSelectedCredits() {
    var screen = labScreen();
    if (!screen || !screen.querySelectorAll) return [];
    var ids = new Set(Array.from(screen.querySelectorAll('.na-v2-batch-check:checked')).map(function (input) {
      return String(input.value || '');
    }));
    return labBatchCurrentCredits().filter(function (cr) { return ids.has(String(cr.id)); });
  }

  function labBatchSelectedTotalCents(selected) {
    return (Array.isArray(selected) ? selected : []).reduce(function (sum, cr) {
      var cents = Math.max(0, Math.round(labCreditPending(cr) * 100));
      return Number.isSafeInteger(sum + cents) ? sum + cents : Number.MAX_SAFE_INTEGER;
    }, 0);
  }

  function labBatchAmountInput() {
    var screen = labScreen();
    return screen && screen.querySelector ? screen.querySelector('#naV2BatchAmount') : null;
  }

  function labBatchSetAutoAmountFromSelection() {
    var input = labBatchAmountInput();
    if (!input) return 0;
    var selected = labBatchSelectedCredits();
    var totalCents = labBatchSelectedTotalCents(selected);
    input.dataset.naBatchAmountMode = 'auto';
    input.value = totalCents > 0 && totalCents !== Number.MAX_SAFE_INTEGER
      ? (totalCents / 100).toFixed(2)
      : '';
    return totalCents;
  }

  function labBatchSyncAutoAmountIfNeeded() {
    var input = labBatchAmountInput();
    if (!input) return 0;
    var mode = String(input.dataset.naBatchAmountMode || '');
    var current = labBatchMoneyCents(input.value);
    if (mode === 'auto' || !current) return labBatchSetAutoAmountFromSelection();
    return current;
  }

  function labBatchUpdatePreview() {
    var screen = labScreen();
    if (!screen || !screen.querySelector) return null;
    var selected = labBatchSelectedCredits();
    var amountInput = screen.querySelector('#naV2BatchAmount');
    var amountCents = labBatchMoneyCents(amountInput && amountInput.value);
    var plan = labBatchAllocationPlan(selected, amountCents);
    var summary = screen.querySelector('#naV2BatchSummary');
    var submit = screen.querySelector('#naV2BatchSubmit');
    var toggle = screen.querySelector('#naV2BatchToggleAllBtn');
    var method = String(screen.querySelector('#naV2BatchMethod')?.value || 'efectivo');
    var reference = String(screen.querySelector('#naV2BatchReference')?.value || '').trim();
    var allChecks = Array.from(screen.querySelectorAll('.na-v2-batch-check'));

    Array.from(screen.querySelectorAll('[data-na-batch-allocation]')).forEach(function (node) { node.textContent = ''; });
    plan.allocations.forEach(function (allocation) {
      var node = Array.from(screen.querySelectorAll('[data-na-batch-allocation]')).find(function (candidate) {
        return String(candidate.getAttribute('data-na-batch-allocation')) === String(allocation.credit_id);
      });
      if (node) node.textContent = 'Se aplicará ' + labMoney(allocation.amount_cents / 100);
    });

    if (toggle) toggle.textContent = allChecks.length && allChecks.every(function (input) { return input.checked; }) ? 'Quitar selección' : 'Seleccionar todo';

    var referenceOk = method === 'efectivo' || reference.length >= 4;
    if (!selected.length) {
      if (summary) summary.textContent = 'Selecciona las deudas que deseas pagar.';
    } else if (!amountCents) {
      if (summary) summary.textContent = selected.length + (selected.length === 1 ? ' deuda seleccionada · ' : ' deudas seleccionadas · ') +
        labMoney(plan.selected_cents / 100) + ' pendiente.';
    } else if (plan.unallocated_cents > 0) {
      if (summary) summary.textContent = 'El monto supera en ' + labMoney(plan.unallocated_cents / 100) + ' el saldo de las deudas seleccionadas.';
    } else if (!referenceOk) {
      if (summary) summary.textContent = 'Ingresa el número de operación para continuar.';
    } else {
      var closesAll = amountCents === plan.selected_cents;
      if (summary) summary.textContent = labMoney(amountCents / 100) + ' se distribuirá en ' + plan.allocations.length +
        (plan.allocations.length === 1 ? ' deuda.' : ' deudas.') + (closesAll ? ' Las seleccionadas quedarán pagadas.' : '');
    }

    if (submit) {
      submit.disabled = labBatchSubmitInFlight || !(plan.valid && referenceOk);
      submit.textContent = labBatchSubmitInFlight
        ? 'Procesando…'
        : (plan.valid ? 'Registrar pago ' + labMoney(amountCents / 100) : 'Registrar pago');
    }
    return { selected:selected, amount_cents:amountCents, plan:plan, method:method, reference:reference, valid:!!(plan.valid && referenceOk) };
  }

  root.naCanonBatchPaymentChanged = function () { return labBatchUpdatePreview(); };

  root.naCanonBatchAmountChanged = function () {
    var input = labBatchAmountInput();
    if (input) input.dataset.naBatchAmountMode = 'manual';
    return labBatchUpdatePreview();
  };

  root.naCanonBatchSelectionChanged = function () {
    labBatchSyncAutoAmountIfNeeded();
    return labBatchUpdatePreview();
  };

  root.naCanonBatchMethodChanged = function () {
    var screen = labScreen();
    if (!screen) return;
    var method = String(screen.querySelector('#naV2BatchMethod')?.value || 'efectivo');
    var wrap = screen.querySelector('#naV2BatchReferenceWrap');
    if (wrap) wrap.hidden = method === 'efectivo';
    labBatchUpdatePreview();
  };

  root.naCanonBatchToggleAll = function () {
    var screen = labScreen();
    if (!screen || !screen.querySelectorAll) return;
    var checks = Array.from(screen.querySelectorAll('.na-v2-batch-check'));
    var allSelected = checks.length && checks.every(function (input) { return input.checked; });
    checks.forEach(function (input) { input.checked = !allSelected; });
    labBatchSetAutoAmountFromSelection();
    labBatchUpdatePreview();
  };

  root.naCanonBatchAutoSelect = function () {
    var screen = labScreen();
    if (!screen || !screen.querySelectorAll) return;
    var amountInput = screen.querySelector('#naV2BatchAmount');
    var amountCents = labBatchMoneyCents(amountInput && amountInput.value);
    if (!amountCents) {
      if (typeof toast === 'function') toast('Primero ingresa el monto total que está abonando','error');
      return;
    }
    if (amountInput) amountInput.dataset.naBatchAmountMode = 'manual';
    var credits = labBatchCurrentCredits().slice().sort(function (a,b) {
      var dateCompare = labBatchCreditDate(a).localeCompare(labBatchCreditDate(b));
      return dateCompare || String(a.id || '').localeCompare(String(b.id || ''));
    });
    var needed = amountCents;
    var selectedIds = new Set();
    credits.forEach(function (cr) {
      if (needed <= 0) return;
      selectedIds.add(String(cr.id));
      needed -= Math.round(labCreditPending(cr) * 100);
    });
    Array.from(screen.querySelectorAll('.na-v2-batch-check')).forEach(function (input) {
      input.checked = selectedIds.has(String(input.value || ''));
    });
    labBatchUpdatePreview();
  };

  function labBatchShowConfirmed(result, state) {
    var screen = labScreen();
    if (!screen || !result || !Array.isArray(result.completed) || !result.completed.length) return false;

    var currentCredits = labClientCredits(labClientScreenState.clientId);
    var completedCents = 0;
    var fullyPaid = 0;

    result.completed.forEach(function (item) {
      var creditId = String(item && item.credit_id || '');
      var amountCents = Math.max(0, Number(item && item.amount_cents) || 0);
      if (!creditId || !Number.isSafeInteger(amountCents) || amountCents <= 0) return;
      completedCents += amountCents;

      var credit = currentCredits.find(function (row) { return String(row && row.id) === creditId; });
      var pendingCents = credit ? Math.max(0, Math.round(labCreditPending(credit) * 100)) : amountCents;
      var paidInFull = pendingCents === 0;
      if (paidInFull) fullyPaid += 1;

      var row = Array.from(screen.querySelectorAll('[data-na-batch-credit-id]')).find(function (candidate) {
        return String(candidate.getAttribute('data-na-batch-credit-id') || '') === creditId;
      });
      if (!row) return;
      row.classList.add('na-v2-batch-row-confirmed');
      if (paidInFull) row.classList.add('na-v2-batch-row-paid');

      var check = row.querySelector('.na-v2-batch-check');
      if (check) { check.checked = true; check.disabled = true; }

      var allocation = row.querySelector('[data-na-batch-allocation]');
      if (allocation) allocation.textContent = paidInFull
        ? '✓ Pagado ' + labMoney(amountCents / 100)
        : '✓ Abono confirmado ' + labMoney(amountCents / 100);

      var value = row.querySelector('.na-v2-row-value');
      if (value) {
        var status = value.querySelector('small');
        if (!status) {
          status = document.createElement('small');
          value.appendChild(status);
        }
        status.textContent = paidInFull ? 'Pagado ✓' : 'Abono confirmado ✓';
      }
    });

    if (!completedCents) return false;

    var panel = screen.querySelector('.na-v2-batch-pay');
    if (panel) panel.classList.add('na-v2-batch-confirmed');

    var summary = screen.querySelector('#naV2BatchSummary');
    if (summary) {
      summary.textContent = fullyPaid === result.completed.length
        ? '✓ Pagado: ' + labMoney(completedCents / 100) + ' · ' + fullyPaid + (fullyPaid === 1 ? ' deuda pagada.' : ' deudas pagadas.')
        : '✓ Pago confirmado: ' + labMoney(completedCents / 100) + '.';
    }

    var submit = screen.querySelector('#naV2BatchSubmit');
    if (submit) {
      submit.disabled = true;
      submit.textContent = fullyPaid === result.completed.length ? '✓ Pagado' : '✓ Pago confirmado';
    }

    var amount = screen.querySelector('#naV2BatchAmount');
    if (amount) amount.disabled = true;
    var toggle = screen.querySelector('#naV2BatchToggleAllBtn');
    if (toggle) toggle.disabled = true;
    var auto = screen.querySelector('.na-v2-batch-auto');
    if (auto) auto.disabled = true;

    var client = labClientById(labClientScreenState.clientId);
    var category = client && labCategoriesForClient(client).find(function (entry) {
      return String(entry.id) === String(labClientScreenState.categoryId);
    });
    if (client && category) {
      var currentSummary = labCategorySummary(client, category);
      var balance = screen.querySelector('.na-v2-category-balance strong');
      if (balance) balance.textContent = labMoney(currentSummary.pending);
    }

    labBatchAwaitingReconcile = true;
    return true;
  }

  root.naCanonSubmitBatchPayment = async function () {
    if (labBatchSubmitInFlight) return false;
    var state = labBatchUpdatePreview();
    if (!state || !state.valid) {
      if (typeof toast === 'function') toast('Revisa el monto y las deudas seleccionadas','error');
      return false;
    }
    var bridge = root.NuevoAmanecerCanonicalCreditPaymentBridge;
    if (!bridge || typeof bridge.confirmBatch !== 'function') {
      if (typeof toast === 'function') toast('El cobro múltiple CANON no está disponible','error');
      return false;
    }
    // Abono anterior enviado sin respuesta: se reenvía EL MISMO lote (mismos operation_id) y no uno nuevo.
    var prior = naV2StoredRead(), canon = root.NuevoAmanecerCanonical;
    if (prior && prior.submitted && prior.batch && prior.clientId === labClientScreenState.clientId && canon && typeof canon.resumePaymentBatch === 'function') {
      labBatchSubmitInFlight = true;
      try {
        await canon.resumePaymentBatch(prior.batch);
        naV2DraftSkip = true; naV2DraftClear();
        try { if (typeof canon.refresh === 'function') await canon.refresh(); } catch (_) {}
        if (typeof toast === 'function') toast('El abono anterior ya quedó registrado. No se cobró dos veces.','success');
        return true;
      } catch (error) {
        var msg = String(error && error.message || error || '');
        var network = root.navigator.onLine === false || /fetch|network|timeout|abort|OFFLINE|PENDING/i.test(msg) || (error && error.name === 'TypeError');
        if (!network) {
          // Rechazo definitivo del servidor (nada se registró): se libera para no bloquear la ficha.
          naV2DraftClear();
          try { if (typeof canon.releaseRejectedFinancial === 'function') await canon.releaseRejectedFinancial(prior.batch.payload && prior.batch.payload.operation_id); } catch (_) {}
          if (typeof toast === 'function') toast('El abono anterior fue rechazado por el servidor. Revise la ficha antes de cobrar de nuevo.','error');
        } else if (typeof toast === 'function') toast('Hay un abono anterior sin confirmar. Se reintentará el mismo cuando haya internet.','error');
        return false;
      } finally { labBatchSubmitInFlight = false; labBatchUpdatePreview(); }
    }
    labBatchSubmitInFlight = true;
    naV2DraftMarkSubmitted();
    labBatchUpdatePreview();
    var confirmedVisual = false, result = null;
    try {
      result = await bridge.confirmBatch({
        allocations:state.plan.allocations,
        payment_method:state.method,
        reference:state.reference
      });
      if (result && result.completed_count > 0) {
        naV2DraftSkip = true;
        naV2DraftClear();
        // Never render stale replica data after a durable receipt. Show a
        // post-commit "Pagado" projection immediately, then let the background
        // canonical reconciliation replace it with the authoritative snapshot.
        confirmedVisual = labBatchShowConfirmed(result, state);
      }
      return !!(result && result.ok);
    } catch (error) {
      console.warn('[Nuevo Amanecer] Cobro múltiple no completado.', error && error.message || error);
      if (typeof toast === 'function') toast('No se pudo completar el cobro múltiple','error');
      return false;
    } finally {
      if (!confirmedVisual && !naV2DraftSkip) {
        var sd = naV2StoredRead(), pend = naV2PendingBatch();
        if (sd && sd.submitted) {
          if (pend) { sd.batch = pend; naV2StoredWrite(sd); }                    // guarda el lote exacto para reusar sus ids
          else if (result && NA_V2_LOCAL_CODES.test(String(result.code || ''))) { sd.submitted = false; delete sd.batch; naV2StoredWrite(sd); }
        }
      }
      labBatchSubmitInFlight = false;
      // Error o respuesta perdida: el borrador queda marcado como enviado (no se restaura tras recargar) porque el
      // abono puede estar en cola con su mismo id. Si el cajero vuelve a escribir, se guarda de nuevo.
      if (!confirmedVisual) labBatchUpdatePreview();
    }
  };

function labCreditDisplayTime(cr) {
  function direct(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    var compact = raw.toLowerCase().replace(/[.\s]/g, '');
    var match = /^(\d{1,2}):(\d{2})(?::\d{2})?(am|pm)?$/.exec(compact);
    if (!match) return '';
    var hour = Number(match[1]), minute = Number(match[2]), suffix = match[3] || '';
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return '';
    if (suffix) {
      if (hour < 1 || hour > 12) return '';
      if (suffix === 'pm' && hour < 12) hour += 12;
      if (suffix === 'am' && hour === 12) hour = 0;
    } else if (hour < 0 || hour > 23) return '';
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  var exact = direct(cr && cr.hora24) || direct(cr && cr.hora);
  if (exact) return exact;

  var timestamp = String(cr && cr.timestamp || '').trim();
  if (!/[T ]\d{2}:\d{2}/.test(timestamp)) return '';
  var parsed = new Date(timestamp);
  if (Number.isFinite(parsed.getTime())) {
    return String(parsed.getHours()).padStart(2, '0') + ':' + String(parsed.getMinutes()).padStart(2, '0');
  }
  var fallback = /[T ](\d{2}):(\d{2})/.exec(timestamp);
  return fallback ? fallback[1] + ':' + fallback[2] : '';
}

function labCreditDisplayMoment(cr, fallbackDate) {
  var date = labCreditVisualDate(cr) || String(fallbackDate || '');
  var time = labCreditDisplayTime(cr);
  return date + (date && time ? ' · ' + time : '');
}

  function labPurchaseRow(cr) {
    return '<button type="button" class="na-v2-row na-v2-purchase-row" onclick="naCanonOpenSmallPurchase(\'' + labEsc(String(cr.id)) + '\')">' +
      '<span><strong>' + labEsc(labCreditDisplayMoment(cr, 'Fecha no registrada')) + '</strong><small>' + labEsc(labProductSummary(cr)) + '</small></span>' +
      '<span class="na-v2-row-value"><strong>' + labMoney(Number(cr.monto) || 0) + '</strong>' +
        (labCreditPending(cr) + 0.001 < Number(cr.monto || 0) ? '<small>' + labMoney(labCreditPending(cr)) + ' pendiente</small>' : '') + '</span><b>›</b>' +
    '</button>';
  }

  function labCreditRow(cr) {
    var ins = labInstallmentSummary(cr), pending = labCreditPending(cr);
    var next = ins.pending[0], account = creditAccountMeta(cr), visual = labCategoryVisual(account);
    return '<button type="button" class="na-v2-row na-v2-credit-row na-v2-tone-' + visual.tone + '" onclick="naCanonOpenIndividualCredit(\'' + labEsc(String(cr.id)) + '\')">' +
      '<span class="na-v2-row-main"><span class="na-v2-module-icon" aria-hidden="true">' + labEsc(visual.icon) + '</span>' +
      '<span class="na-v2-row-copy"><strong>' + labEsc(cr.desc || labProductSummary(cr) || 'Crédito') + '</strong>' +
        '<small>' + ins.paidCount + ' pagadas · ' + ins.pendingCount + ' pendientes' + (next && next.due ? ' · Próxima ' + labDisplayDate(next.due) : '') + '</small></span></span>' +
      '<span class="na-v2-row-value"><strong>' + labMoney(pending) + '</strong><small>pendiente</small></span><b>›</b>' +
    '</button>';
  }

  function labCategoryHtml(client, category) {
    var summary = labCategorySummary(client, category), visual = labCategoryVisual(category);
    var rows = summary.active.map(function (cr) {
      var row = category.mode === 'accumulated' ? labPurchaseRow(cr) : labCreditRow(cr);
      return labBatchRow(cr, row);
    });
    var detail = category.mode === 'accumulated'
      ? summary.purchaseCount + (summary.purchaseCount === 1 ? ' compra' : ' compras')
      : summary.activeCount + (summary.activeCount === 1 ? ' crédito activo' : ' créditos activos');
    return '<div class="na-v2-screen">' + labBackButton(labClientDisplayName(client)) +
      '<header class="na-v2-subhead na-v2-category-head na-v2-tone-' + visual.tone + '">' +
        '<div class="na-v2-category-title"><span class="na-v2-module-icon" aria-hidden="true">' + labEsc(visual.icon) + '</span><div><span class="na-v2-eyebrow">Cuenta</span><h2>' + labEsc(category.name) + '</h2><small>' + labEsc(detail) + '</small></div></div>' +
        '<div class="na-v2-category-balance"><span>Pendiente total</span><strong>' + labMoney(summary.pending) + '</strong></div>' +
      '</header>' +
      labBatchPanelHtml(summary) +
      '<section class="na-v2-list na-v2-card-list na-v2-batch-list">' + (rows.length ? rows.join('') : '<div class="na-v2-empty">No hay créditos activos en esta cuenta.</div>') + '</section></div>';
  }

  function labCleanInstallmentProductName(value) {
    var text = String(value || '').trim();
    if (!text) return 'Producto';
    var cleaned = text.replace(/\s*[—–-]\s*\d{1,2}\s+cuotas?\s+mensuales?[\s\S]*$/i,'').trim();
    return cleaned || text;
  }

  function labPurchasePlanLabel(cr, installments) {
    if (!installments || !Array.isArray(installments.plan) || installments.plan.length < 2) return '';
    var hint = labDescriptionInstallmentHint(cr);
    var firstDue = String(installments.plan[0] && installments.plan[0].due || hint.firstDue || '').slice(0,10);
    var dueDay = hint.dueDay;
    if ((!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31) && /^\d{4}-\d{2}-\d{2}$/.test(firstDue)) {
      dueDay = Number(firstDue.slice(8,10));
    }
    var parts = [installments.plan.length + ' cuotas mensuales'];
    if (Number.isFinite(dueDay) && dueDay >= 1 && dueDay <= 31) parts.push('vence cada día ' + dueDay);
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstDue)) parts.push('desde ' + labDisplayDate(firstDue));
    return parts.join(' · ');
  }

  function labPurchaseHtml(client, cr) {
    var items = Array.isArray(cr.items) ? cr.items : [];
    var installments = labInstallmentSummary(cr);
    var hasInstallmentSchedule = installments.plan.length > 1;
    var isSingleInstallmentItem = hasInstallmentSchedule && items.length === 1;
    var planLabel = isSingleInstallmentItem ? labPurchasePlanLabel(cr, installments) : '';
    return '<div class="na-v2-screen">' + labBackButton(NA_SMALL_ACCOUNT_NAME) +
      '<header class="na-v2-subhead na-v2-tone-teal"><span class="na-v2-eyebrow">Crédito pequeño</span><h2>VENTA ' + labEsc(labCreditDisplayMoment(cr, '')) + '</h2>' +
        (hasInstallmentSchedule ? '<small>' + installments.paidCount + ' cuotas pagadas · ' + installments.pendingCount + ' pendientes</small>' : '') + '</header>' +
      '<section class="na-v2-product-list">' +
        (items.length ? items.map(function (item) {
          var qty = Number(item.cantidad ?? item.qty) || 1, unit = Number(item.precioUnitario ?? item.precio) || 0;
          var total = Number(item.subtotal);
          if (!Number.isFinite(total)) total = qty * unit;
          var rawName = item.nombre || item.name || 'Producto';
          var displayName = isSingleInstallmentItem ? labCleanInstallmentProductName(rawName) : rawName;
          var secondary = isSingleInstallmentItem ? planLabel : (qty + ' × ' + labMoney(unit));
          var lineAmount = isSingleInstallmentItem ? '' : '<b>' + labMoney(total) + '</b>';
          return '<div class="na-v2-product"><span><strong>' + labEsc(displayName) + '</strong>' +
            (secondary ? '<small>' + labEsc(secondary) + '</small>' : '') +
            '</span>' + lineAmount + '</div>';
        }).join('') : '<div class="na-v2-empty">El crédito heredado no conserva detalle de productos.</div>') +
      '</section><div class="na-v2-total"><span>Total</span><strong>' + labMoney(Number(cr.monto) || 0) + '</strong></div>' +
      (hasInstallmentSchedule
        ? '<section class="na-v2-section na-v2-schedule-section"><div class="na-v2-section-title"><span>CRONOGRAMA DE CUOTAS</span><small>' + installments.plan.length + ' cuotas en total</small></div>' + labPendingInstallmentsHtml(installments) + '</section>'
        : '') +
      '<div class="na-v2-credit-actions">' +
        '<button type="button" class="na-receipt-history" data-share-credit="' + labEsc(String(cr.id)) + '">Compartir comprobante</button>' +
        (!labIsCanceled(cr) && labCreditPending(cr) > 0.001 ? '<button type="button" class="na-v2-pay" onclick="abrirPago(\'' + labEsc(String(cr.id)) + '\')">Registrar pago</button>' : '') +
      '</div>' +
    '</div>';
  }

  function labPendingInstallmentsHtml(summary) {
    if (!summary.plan.length) return '<div class="na-v2-empty">No hay cronograma de cuotas disponible.</div>';
    var nextPendingNumber = summary.pending[0] && summary.pending[0].number;
    var today = labTodayIso();
    return '<div class="na-v2-installment-list">' + summary.plan.map(function (item) {
      var state = labInstallmentVisualState(item, nextPendingNumber, today);
      return '<div class="na-v2-installment na-v2-installment-' + state.key + (state.next ? ' is-next' : '') + '">' +
        '<span class="na-v2-installment-index" aria-hidden="true">' + item.number + '</span>' +
        '<span class="na-v2-installment-copy"><strong>Cuota ' + item.number + '</strong><small>' + labEsc(labDisplayDate(item.due)) + '</small></span>' +
        '<strong class="na-v2-installment-amount">' + labMoney(item.amount) + '</strong>' +
        '<span class="na-v2-installment-status">' + labEsc(state.label) + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function labCreditInfoHtml(cr, account) {
    return '<div class="na-v2-credit-info" id="naV2CreditInfo" hidden>' +
      '<div><span>Monto original</span><strong>' + labMoney(cr.monto) + '</strong></div>' +
      '<div><span>Total pagado</span><strong>' + labMoney(cr.pagado) + '</strong></div>' +
      '<div><span>Saldo pendiente</span><strong>' + labMoney(labCreditPending(cr)) + '</strong></div>' +
      '<div><span>Fecha de inicio</span><strong>' + labEsc(cr.fecha || '—') + '</strong></div>' +
      '<div><span>Número total de cuotas</span><strong>' + labInstallmentPlan(cr).length + '</strong></div>' +
      '<div><span>Categoría</span><strong>' + labEsc(account.categoryName) + '</strong></div>' +
      '<div><span>Referencia / ID</span><strong>' + labEsc(String(cr.id || '—')) + '</strong></div>' +
    '</div>';
  }

  function labCreditHtml(client, cr) {
    var account = creditAccountMeta(cr), ins = labInstallmentSummary(cr);
    var total = Math.max(1, ins.plan.length), progress = Math.round(ins.paidCount / total * 100);
    var visual = labCategoryVisual(account);
    return '<div class="na-v2-screen">' + labBackButton(account.categoryName) +
      '<header class="na-v2-subhead na-v2-credit-title na-v2-tone-' + visual.tone + '">' +
        '<span class="na-v2-eyebrow">' + labEsc(account.categoryName) + '</span>' +
        '<h2>' + labEsc(cr.desc || labProductSummary(cr) || 'Crédito') + '</h2>' +
        '<p>' + ins.paidCount + ' cuotas pagadas · ' + ins.pendingCount + ' pendientes</p>' +
        '<div class="na-v2-progress-meta"><span>Avance del crédito</span><strong>' + progress + '%</strong></div>' +
        '<div class="na-v2-progress" aria-label="' + progress + '% de cuotas pagadas"><span style="width:' + progress + '%"></span></div>' +
      '</header>' +
      '<section class="na-v2-section na-v2-schedule-section"><div class="na-v2-section-title"><span>CRONOGRAMA DE CUOTAS</span><small>' + ins.plan.length + ' cuotas en total</small></div>' +
        labPendingInstallmentsHtml(ins) + '</section>' +
      '<div class="na-v2-credit-actions">' +
        (!labIsCanceled(cr) && labCreditPending(cr) > 0.001 ? '<button type="button" class="na-v2-pay" onclick="abrirPago(\'' + labEsc(String(cr.id)) + '\')">Registrar pago</button>' : '') +
        '<button type="button" class="na-v2-info-btn" aria-label="Información del crédito" onclick="naCanonToggleCreditInfo()">ⓘ</button>' +
      '</div>' +
      labCreditInfoHtml(cr, account) +
      '<button type="button" class="na-v2-row na-v2-history-link na-v2-nav-card na-v2-tone-slate" onclick="naCanonOpenCreditHistory(\'' + labEsc(String(cr.id)) + '\')">' +
        '<span class="na-v2-row-main"><span class="na-v2-module-icon" aria-hidden="true">↺</span><span class="na-v2-row-copy"><strong>Historial de este crédito</strong><small>' + ins.paidCount + ' cuotas canceladas</small></span></span><b>›</b></button>' +
    '</div>';
  }

  function labPaymentLocalTime(pay) {
    var raw = pay && pay.timestamp ? String(pay.timestamp) : '';
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return '';
    var at = new Date(raw);
    if (!isFinite(at.getTime())) return '';
    return String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  }

  var LAB_PAYMENT_METHOD_LABELS = { efectivo:'Efectivo', yape:'Yape', plin:'Plin', transferencia:'Transferencia', mixto:'Mixto' };

  function labPaymentMethodLabel(pay) {
    var method = String(pay && pay.metodo || '').toLowerCase();
    return LAB_PAYMENT_METHOD_LABELS[method] || (method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Método no registrado');
  }

  function labFormatPaymentMoment(pay) {
    var date = pay && (pay.fecha || (pay.timestamp ? String(pay.timestamp).slice(0,10) : '')) || 'Fecha no registrada';
    var time = pay && (pay.hora || pay.hora24 || labPaymentLocalTime(pay)) || '';
    return date + (time ? ' · ' + time : '') + ' · ' + labPaymentMethodLabel(pay) +
      (pay && (pay.operacion || pay.numeroOperacion) ? ' · Op. ' + String(pay.operacion || pay.numeroOperacion) : '');
  }

  // Historial de pagos: cada abono con fecha/hora, método y monto (antes solo había un conteo).
  function labPaymentDetailRows(credits) {
    var rows = [];
    credits.forEach(function (cr) {
      labEffectivePayments(cr).forEach(function (pay) { rows.push({ cr:cr, pay:pay, key:String(pay.timestamp || pay.fecha || '') }); });
    });
    rows.sort(function (a, b) { return b.key.localeCompare(a.key); });
    return rows.map(function (row) {
      return '<div class="na-receipt-payment-row na-v2-payment-detail"><span><strong>' + labMoney(row.pay.monto || row.pay.montoPagado || 0) + '</strong><small>' +
        labEsc(labFormatPaymentMoment(row.pay)) + '</small><small>' + labEsc(row.cr.desc || 'Crédito') + '</small></span></div>';
    }).join('');
  }

  function labCreditHistoryHtml(client, cr) {
    var ins = labInstallmentSummary(cr);
    return '<div class="na-v2-screen">' + labBackButton(cr.desc || 'Crédito') +
      '<header class="na-v2-subhead"><h2>CUOTAS PAGADAS</h2></header><section class="na-v2-list">' +
      (ins.paid.length ? ins.paid.map(function (item) {
        var pay = item.paymentId ? labEffectivePayments(cr).find(function (p) { return String(p.pagoId || p.id) === String(item.paymentId); }) : null;
        return '<div class="na-v2-paid-row"><span>✓</span><div><strong>Cuota ' + item.number + '</strong><small>' + labEsc(pay ? labFormatPaymentMoment(pay) : (item.paidAt || 'Pago histórico sin hora canónica')) + '</small></div></div>';
      }).join('') : '<div class="na-v2-empty">Todavía no hay cuotas pagadas.</div>') +
      '</section><section class="na-v2-section"><h3>COMPROBANTES DE ABONOS</h3>' +
      labEffectivePayments(cr).map(function(pay){return '<div class="na-receipt-payment-row"><span><strong>'+labMoney(pay.monto||pay.montoPagado||0)+'</strong><small>'+labEsc(labFormatPaymentMoment(pay))+'</small>'+((pay.cajeroNombre&&pay.cajeroNombre!=='Histórico')||pay.numeroOperacion||pay.comentario?'<small class="na-pay-meta">'+labEsc([pay.cajeroNombre&&pay.cajeroNombre!=='Histórico'?'Atendió: '+pay.cajeroNombre:'',pay.numeroOperacion?'N.º '+pay.numeroOperacion:'',pay.comentario||''].filter(Boolean).join(' · '))+'</small>':'')+'</span><button type="button" class="na-receipt-history" data-share-payment="'+labEsc(String(pay.id||pay.pagoId))+'" data-share-credit-id="'+labEsc(String(cr.id))+'">Compartir</button></div>';}).join('') + '</section></div>';
  }

  function labPaymentGroups(client) {
    return labCategoriesForClient(client).map(function (category) {
      var credits = labCreditsForCategory(client.id, category.id);
      var count = credits.reduce(function (n, cr) { return n + labEffectivePayments(cr).length; }, 0);
      return { category:category, credits:credits, paymentCount:count };
    }).filter(function (g) { return g.paymentCount > 0; });
  }

  function labGeneralHistoryHtml(client) {
    var groups = labPaymentGroups(client);
    return '<div class="na-v2-screen">' + labBackButton(labClientDisplayName(client)) +
      '<header class="na-v2-subhead"><h2>HISTORIAL DE PAGOS</h2></header>' +
      (groups.length ? groups.map(function (group) {
        var content = group.category.mode === 'accumulated'
          ? '<button type="button" class="na-v2-row" onclick="naCanonOpenCreditCategory(\'' + labEsc(group.category.id) + '\')"><span><strong>' + labEsc(group.category.name) + '</strong><small>' + group.paymentCount + ' pagos realizados</small></span><b>›</b></button>'
          : group.credits.filter(function (cr) { return labEffectivePayments(cr).length; }).map(function (cr) {
              var count = labEffectivePayments(cr).length;
              return '<button type="button" class="na-v2-row" onclick="naCanonOpenCreditHistory(\'' + labEsc(String(cr.id)) + '\')"><span><strong>' + labEsc(cr.desc || 'Crédito') + '</strong><small>' + count + ' cuotas canceladas</small></span><b>›</b></button>';
            }).join('');
        return '<section class="na-v2-section"><h3>' + labEsc(group.category.name).toUpperCase() + '</h3><div class="na-v2-list">' + content + labPaymentDetailRows(group.credits) + '</div></section>';
      }).join('') : '<div class="na-v2-empty">Todavía no hay pagos registrados.</div>') +
    '</div>';
  }

  function labCanceledHtml(client) {
    var summary = labClientFinancialSummary(client);
    return '<div class="na-v2-screen">' + labBackButton(labClientDisplayName(client)) +
      '<header class="na-v2-subhead na-v2-simple-hero na-v2-tone-green"><span class="na-v2-eyebrow">Histórico</span><h2>CRÉDITOS CANCELADOS</h2><small>' + summary.closed.length + ' créditos finalizados</small></header>' +
      '<section class="na-v2-list na-v2-card-list">' + (summary.closed.length ? summary.closed.map(function (cr) {
        var ins = labInstallmentSummary(cr);
        return '<button type="button" class="na-v2-row na-v2-nav-card na-v2-tone-green" onclick="naCanonOpenIndividualCredit(\'' + labEsc(String(cr.id)) + '\')">' +
          '<span class="na-v2-row-main"><span class="na-v2-module-icon" aria-hidden="true">✓</span><span class="na-v2-row-copy"><strong>' + labEsc(cr.desc || labProductSummary(cr) || 'Crédito') + '</strong>' +
          '<small>' + ins.paidCount + '/' + ins.plan.length + ' cuotas pagadas · Finalizado ' + labEsc(labLastPaymentDate(cr)) + '</small></span></span><b>›</b></button>';
      }).join('') : '<div class="na-v2-empty">No hay créditos finalizados.</div>') + '</section></div>';
  }

  function labLineHtml(client) {
    var summary = labClientFinancialSummary(client), e = summary.evaluation || {};
    var assigned = Number.isFinite(Number(e.assignedLine)) ? Number(e.assignedLine) : null;
    var automatic = Number.isFinite(Number(e.automaticLine)) ? Number(e.automaticLine) : null;
    var available = Number.isFinite(Number(e.available)) ? Number(e.available) : null;
    return '<div class="na-v2-screen">' + labBackButton(labClientDisplayName(client)) +
      '<header class="na-v2-line-hero"><span class="na-v2-eyebrow">Línea de crédito</span><strong>' + labMoney(assigned) + '</strong>' +
        '<small>' + (e.manualActive ? 'Línea manual vigente' : 'Línea calculada por la evaluación actual') + '</small></header>' +
      '<section class="na-v2-metrics na-v2-financial-metrics">' +
        '<div class="na-v2-metric-available"><span>Disponible</span><strong>' + labMoney(available) + '</strong></div>' +
        '<div><span>Deuda activa</span><strong>' + labMoney(summary.debt) + '</strong></div>' +
        '<div><span>Línea automática</span><strong>' + labMoney(automatic) + '</strong></div></section>' +
      '<p class="na-v2-note">Esta vista utiliza la evaluación financiera vigente del POS. La presentación visual no reemplaza ni modifica una línea manual o automática.</p>' +
      (typeof abrirEvaluacionCredito === 'function' ? '<button type="button" class="na-v2-pay secondary" onclick="abrirEvaluacionCredito(\'' + labEsc(String(client.id)) + '\')">Ver evaluación existente</button>' : '') +
    '</div>';
  }

  function labBehaviorHtml(client) {
    var c = labClassifyClient(client), summary = c.summary, e = summary.evaluation || {}, h = e.history || {};
    var assigned = Number.isFinite(Number(e.assignedLine)) ? Number(e.assignedLine) : null;
    return '<div class="na-v2-screen">' + labBackButton(labClientDisplayName(client)) +
      '<header class="na-v2-behavior-hero na-v2-tone-' + c.tone + '">' +
        '<div><span class="na-v2-eyebrow">Comportamiento financiero</span><h2>' + labEsc(c.label) + '</h2><p>Lectura basada en el historial financiero disponible.</p></div>' +
        '<span class="na-v2-risk na-v2-risk-' + c.tone + '">● ' + labEsc(c.label) + '</span></header>' +
      '<section class="na-v2-metrics na-v2-behavior-metrics">' +
        '<div><span>Pagos puntuales</span><strong>' + labEsc(String(h.punctual ?? 0)) + '</strong></div>' +
        '<div><span>Pagos atrasados</span><strong>' + labEsc(String(h.late ?? 0)) + '</strong></div>' +
        '<div><span>Créditos finalizados</span><strong>' + labEsc(String(h.completed ?? summary.closed.length)) + '</strong></div>' +
        '<div class="' + (summary.overdueDebt > 0.001 ? 'na-v2-metric-danger' : '') + '"><span>Deuda vencida</span><strong>' + labMoney(summary.overdueDebt) + '</strong></div>' +
        '<div><span>Línea actual</span><strong>' + labMoney(assigned) + '</strong></div></section>' +
      '<section class="na-v2-why"><div class="na-v2-section-title"><span>¿POR QUÉ?</span><small>Explicación visible</small></div>' +
        '<div class="na-v2-reason-list">' + c.reasons.map(function (reason) { return '<p><span>✓</span>' + labEsc(reason) + '</p>'; }).join('') +
        '<p><span>✓</span>La línea mostrada proviene de la evaluación financiera vigente del POS.</p></div></section>' +
    '</div>';
  }

  function labRenderRoute(direction) {
    var client = labClientById(labClientScreenState.clientId);
    if (!client) { labCloseScreen(false); return; }
    if (labClientScreenState.route === 'home') return labRenderScreen(labHomeHtml(client), direction);
    if (labClientScreenState.route === 'category') {
      var cat = labCategoriesForClient(client).find(function (x) { return String(x.id) === String(labClientScreenState.categoryId); });
      if (!cat) { labClientScreenState.route = 'home'; return labRenderRoute('replace'); }
      var out = labRenderScreen(labCategoryHtml(client, cat), direction);
      // Abono «no confirmado» (también tras recargar): aviso ámbar al abrir la ficha.
      try { var pb = root.NuevoAmanecerCanonicalCreditPaymentBridge; if (pb && pb.showPendingOnCard) { pb.showPendingOnCard(); setTimeout(function () { pb.showPendingOnCard(); }, 350); } } catch (_) {}
      return out;
    }
    var cr = labClientCredits(client.id).find(function (x) { return String(x.id) === String(labClientScreenState.creditId || labClientScreenState.purchaseId); });
    if (labClientScreenState.route === 'purchase' && cr) return labRenderScreen(labPurchaseHtml(client, cr), direction);
    if (labClientScreenState.route === 'credit' && cr) return labRenderScreen(labCreditHtml(client, cr), direction);
    if (labClientScreenState.route === 'creditHistory' && cr) return labRenderScreen(labCreditHistoryHtml(client, cr), direction);
    if (labClientScreenState.route === 'history') return labRenderScreen(labGeneralHistoryHtml(client), direction);
    if (labClientScreenState.route === 'canceled') return labRenderScreen(labCanceledHtml(client), direction);
    if (labClientScreenState.route === 'line') return labRenderScreen(labLineHtml(client), direction);
    if (labClientScreenState.route === 'behavior') return labRenderScreen(labBehaviorHtml(client), direction);
    labClientScreenState.route = 'home';
    return labRenderRoute('replace');
  }

  window.naCanonOpenClientAccount = function (clientId) {
    if (!labClientById(clientId)) return;
    labClientScreenState = { clientId:String(clientId), route:'home', categoryId:null, creditId:null, purchaseId:null };
    labRenderRoute('open');
  };

  window.naCanonClientBack = function () {
    if (labClientScreenState.route === 'home') return labCloseScreen(false);
    if (labClientScreenState.route === 'purchase' || labClientScreenState.route === 'credit') {
      labClientScreenState.route = 'category'; labClientScreenState.creditId = null; labClientScreenState.purchaseId = null;
    } else if (labClientScreenState.route === 'creditHistory') {
      labClientScreenState.route = 'credit';
    } else {
      labClientScreenState.route = 'home'; labClientScreenState.categoryId = null; labClientScreenState.creditId = null;
    }
    labRenderRoute('back');
  };

  window.naCanonOpenCreditCategory = function (categoryId) {
    labClientScreenState.route = 'category'; labClientScreenState.categoryId = String(categoryId || NA_SMALL_ACCOUNT_ID);
    labRenderRoute('forward');
  };
  window.naCanonOpenSmallPurchase = function (creditId) {
    labClientScreenState.route = 'purchase'; labClientScreenState.purchaseId = String(creditId); labRenderRoute('forward');
  };
  window.naCanonOpenIndividualCredit = function (creditId) {
    var client = labClientById(labClientScreenState.clientId);
    var cr = client && labClientCredits(client.id).find(function (x) { return String(x.id) === String(creditId); });
    if (!cr) return;
    labClientScreenState.categoryId = creditAccountMeta(cr).categoryId;
    labClientScreenState.route = 'credit'; labClientScreenState.creditId = String(creditId); labRenderRoute('forward');
  };
  window.naCanonOpenCreditHistory = function (creditId) {
    labClientScreenState.route = 'creditHistory'; labClientScreenState.creditId = String(creditId); labRenderRoute('forward');
  };
  window.naCanonOpenClientPaymentHistory = function () { labClientScreenState.route = 'history'; labRenderRoute('forward'); };
  window.naCanonOpenCanceledCredits = function () { labClientScreenState.route = 'canceled'; labRenderRoute('forward'); };
  window.naCanonOpenCreditLine = function () { labClientScreenState.route = 'line'; labRenderRoute('forward'); };
  window.naCanonOpenClientBehavior = function () { labClientScreenState.route = 'behavior'; labRenderRoute('forward'); };
  window.naCanonToggleCreditInfo = function () {
    var node = document.getElementById('naV2CreditInfo'); if (node) node.hidden = !node.hidden;
  };

  function naClientReducedMotion() {
    var core = naMotionCore();
    if (core && typeof core.reducedMotion === 'function') return core.reducedMotion();
    try { return !!root.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
  }

  function naClientDebt(client) {
    if (labPaymentReceiptOverlays.size) {
      var projected = labClientFinancialSummary(client);
      return Math.max(0, Number(projected.debt) || 0);
    }
    if (typeof _naClientDebtFast === 'function') {
      try { return Math.max(0, Number(_naClientDebtFast(client)) || 0); } catch (_) {}
    }
    if (typeof deudaT === 'function') {
      try { return Math.max(0, Number(deudaT(client)) || 0); } catch (_) {}
    }
    return labClientFinancialSummary(client).debt;
  }

  function naClientBusinessStatus(client) {
    if (typeof statusCli === 'function') {
      try { return String(statusCli(client) || ''); } catch (_) {}
    }
    return '';
  }

  function naClientInitials(client) {
    var name = String(client && client.nombre || 'Cliente').trim();
    if (typeof initials === 'function') {
      try { return initials(name); } catch (_) {}
    }
    return name.split(/\s+/).filter(Boolean).slice(0,2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || 'C';
  }

  function naClientAvatarColor(client) {
    if (typeof colorFor === 'function') {
      try { return colorFor(client && client.color); } catch (_) {}
    }
    return '#0f766e';
  }

  function naCreateNativeClientCard(client) {
    var classification = labClassifyClient(client);
    var credits = labClientCredits(client && client.id);
    var status = naClientBusinessStatus(client);
    var card = document.createElement('article');
    card.className = 'client-card na-v2-client-list-card';
    card.dataset.clientId = String(client && client.id || '');
    card.dataset.naV2Ready = 'true';
    card.dataset.naV2Native = 'true';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'client-header na-v2-client-list-trigger';
    trigger.setAttribute('aria-label', 'Abrir ficha financiera de ' + labClientDisplayName(client));
    trigger.addEventListener('click', function () { root.naCanonOpenClientAccount(client.id); });

    var avatar = document.createElement('span');
    avatar.className = 'c-avatar';
    avatar.textContent = naClientInitials(client);
    avatar.style.background = naClientAvatarColor(client);

    var info = document.createElement('span');
    info.className = 'c-info';
    var name = document.createElement('span');
    name.className = 'c-name';
    name.textContent = labClientDisplayName(client);
    var meta = document.createElement('span');
    meta.className = 'c-meta';
    var metaParts = [];
    var lineIcons = typeof window.NA_ICON === 'function';
    if (client && client.dni) metaParts.push(lineIcons ? String(client.dni) : '📋 ' + client.dni);
    metaParts.push(credits.length + (credits.length === 1 ? ' crédito' : ' créditos'));
    if (status) metaParts.push(status.toUpperCase());
    meta.textContent = metaParts.join(' · ');
    if (lineIcons && client && client.dni) meta.insertAdjacentHTML('afterbegin', window.NA_ICON('clip'));
    info.append(name, meta);

    var right = document.createElement('span');
    right.className = 'c-right na-v2-client-list-right';
    var debt = document.createElement('strong');
    debt.className = 'c-deuda';
    debt.textContent = labMoney(naClientDebt(client));
    var risk = document.createElement('span');
    risk.className = 'na-v2-risk na-v2-risk-' + classification.tone;
    risk.textContent = classification.label;
    right.append(debt, risk);

    var arrow = document.createElement('span');
    arrow.className = 'na-v2-client-list-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';

    trigger.append(avatar, info, right, arrow);
    card.appendChild(trigger);
    return card;
  }

  function naDrawClientList(rows, list) {
    list.replaceChildren();
    list.dataset.naV2Native = 'true';
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      var icon = document.createElement('div');
      icon.className = 'ei';
      if (typeof window.NA_ICON === 'function') icon.innerHTML = window.NA_ICON('users', 'na-li-empty'); else icon.textContent = '👥';
      var copy = document.createElement('p');
      copy.textContent = 'Sin clientes en esta vista';
      empty.append(icon, copy);
      list.appendChild(empty);
      return;
    }
    var fragment = document.createDocumentFragment();
    rows.forEach(function (client) { fragment.appendChild(naCreateNativeClientCard(client)); });
    list.appendChild(fragment);
  }

  function naRenderClientList(rows, list) {
    if (!list) return false;
    rows = Array.isArray(rows) ? rows : [];
    var page = document.getElementById('pageClientes');
    var motionEpoch = ++naClientListMotionEpoch;
    var draw = function () {
      naDrawClientList(rows, list);
      if (labClientScreenState.clientId) {
        var screen = labScreen();
        if (screen && !screen.hidden) labRenderRoute();
      }
    };
    var settleEntry = function () {
      root.requestAnimationFrame(function () {
        if (motionEpoch !== naClientListMotionEpoch) return;
        root.requestAnimationFrame(function () {
          if (motionEpoch !== naClientListMotionEpoch) return;
          page.classList.remove('na-client-refresh-in');
        });
      });
    };

    // Mientras se escribe en la búsqueda, la lista debe reflejar cada tecla al instante:
    // la animación de salida (850 ms) dejaba la lista una tecla atrás.
    var searching = document.activeElement && document.activeElement.id === 'cliSearch';
    if (!page || !page.classList.contains('active') || naClientReducedMotion() || searching) {
      clearTimeout(naClientListMotionTimer);
      naClientListMotionTimer = 0;
      page && page.classList.remove('na-client-refresh-out','na-client-refresh-in');
      draw();
      return true;
    }

    if (!naClientListMotionReady) {
      naClientListMotionReady = true;
      draw();
      page.classList.remove('na-client-refresh-out');
      page.classList.add('na-client-refresh-in');
      settleEntry();
      return true;
    }

    clearTimeout(naClientListMotionTimer);
    page.classList.remove('na-client-refresh-in');
    page.classList.add('na-client-refresh-out');
    naClientListMotionTimer = root.setTimeout(function () {
      if (motionEpoch !== naClientListMotionEpoch) return;
      draw();
      page.classList.remove('na-client-refresh-out');
      page.classList.add('na-client-refresh-in');
      naClientListMotionTimer = 0;
      settleEntry();
    }, 850);
    return true;
  }

  function labBindClientCards() {
    var list = document.getElementById('cliList');
    if (!list) return;
    Array.from(list.querySelectorAll('.client-card')).forEach(function (card) {
      if (card.dataset && card.dataset.naV2Native === 'true') return;
      var panel = card.querySelector('.client-creds');
      var id = panel && /^cc-/.test(String(panel.id || '')) ? String(panel.id).replace(/^cc-/, '') : String(card.dataset && card.dataset.clientId || '');
      if (!id) return;
      card.dataset.naV2Ready = 'true';
      if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
      var head = card.querySelector('.client-header') || card;
      if (!head.dataset.naV2Bound) {
        head.dataset.naV2Bound = 'true';
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.onclick = function (event) {
          event.preventDefault(); event.stopPropagation(); window.naCanonOpenClientAccount(id);
        };
        head.onkeydown = function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.naCanonOpenClientAccount(id); }
        };
      }
    });
  }

  function labRenderClientProfiles() {
    labBindClientCards();
    if (labClientScreenState.clientId && !labScreen()?.hidden) labRenderRoute();
  }
  function labOpenClientIds() { return []; }
  function labRestoreClientOpenState() {}

  function labSaleClient() {
    var id = document.getElementById('mCreditoCliente')?.value || '';
    return labClientById(id);
  }

  function labSelectedCategory(client) {
    var categories = client ? labCategoriesForClient(client) : [];
    var chosen = categories.find(function (cat) { return String(cat.id) === String(labSaleCreditState.categoryId); });
    return chosen || categories[0] || { id:NA_SMALL_ACCOUNT_ID, name:NA_SMALL_ACCOUNT_NAME, mode:'accumulated', builtin:true };
  }

  function labMonthlyDates(firstDate, count) {
    var base = firstDate ? new Date(String(firstDate).slice(0,10) + 'T12:00:00') : new Date();
    if (!Number.isFinite(base.getTime())) base = new Date();
    // P2-1: 31-01 + 1 month is 28/29-02 (last day of the month), never 02/03-03.
    var year = base.getFullYear(), month = base.getMonth(), day = base.getDate();
    function pad(v) { return String(v).padStart(2, '0'); }
    return Array.from({length:Math.max(1, Math.min(60, count))}, function (_, index) {
      var y = year + Math.floor((month + index) / 12), m = (month + index) % 12;
      var last = new Date(y, m + 1, 0).getDate();
      return y + '-' + pad(m + 1) + '-' + pad(Math.min(day, last));
    });
  }

  function labRenderInstallmentDates() {
    var wrap = document.getElementById('labCreditInstallmentDates');
    if (!wrap) return;
    var count = Math.max(1, Math.min(60, Number(document.getElementById('labCreditInstallmentCount')?.value) || 1));
    labSaleCreditState.installmentCount = count;
    var due = document.getElementById('mCreditoVence')?.value || '';
    var dates = labMonthlyDates(due, count);
    wrap.innerHTML = dates.map(function (date, index) {
      return '<label><span>Cuota ' + (index + 1) + '</span><input type="date" class="fi na-credit-installment-date" data-installment-number="' + (index + 1) + '" value="' + labEsc(date) + '"></label>';
    }).join('');
  }

  function labSaleDestinationHtml(client) {
    if (!client) return '<div class="na-credit-destination-empty">Selecciona primero el cliente del crédito.</div>';
    var categories = labCategoriesForClient(client), selected = labSelectedCategory(client);
    var radios = categories.map(function (cat) {
      return '<label class="na-credit-destination-option ' + (String(cat.id) === String(selected.id) ? 'selected' : '') + '">' +
        '<input type="radio" name="labCreditDestination" value="' + labEsc(cat.id) + '" ' + (String(cat.id) === String(selected.id) ? 'checked' : '') + ' onchange="naCanonSelectCreditDestination(\'' + labEsc(cat.id) + '\')">' +
        '<span><strong>' + labEsc(cat.name) + '</strong><small>' + (cat.id === NA_SMALL_ACCOUNT_ID ? 'Predeterminado' : cat.mode === 'accumulated' ? 'Cuenta acumulada' : 'Créditos separados') + '</small></span></label>';
    }).join('');
    var installment = selected.mode === 'separate'
      ? '<div class="na-credit-installment-config"><label><span>Número de cuotas</span><input id="labCreditInstallmentCount" class="fi" type="number" min="1" max="60" value="' + labSaleCreditState.installmentCount + '" oninput="naCanonRefreshInstallmentDates()"></label><div id="labCreditInstallmentDates" class="na-credit-installment-dates"></div></div>'
      : '';
    return '<div class="na-credit-destination-title"><strong>¿Dónde registrar esta venta?</strong><small>Créditos pequeños está seleccionado por defecto.</small></div>' +
      '<div class="na-credit-destination-options">' + radios + '</div>' +
      '<button type="button" class="na-credit-new-category" onclick="naCanonOpenNewCreditCategory()">+ Nueva categoría</button>' + installment;
  }

  function labEnsureSaleDestinationUi() {
    var section = document.getElementById('mCreditoSection');
    if (!section) return false;
    var wrap = section.querySelector('.na-credit-destination');
    var client = labSaleClient();
    var currentId = client ? String(client.id) : null;
    if (labSaleCreditState.clientId !== currentId) {
      labSaleCreditState = { clientId:currentId, categoryId:NA_SMALL_ACCOUNT_ID, installmentCount:1 };
    }
    if (wrap) wrap.remove();
    return true;
  }

  window.naCanonSelectCreditDestination = function (categoryId) {
    var client = labSaleClient(); if (!client) return;
    var exists = labCategoriesForClient(client).some(function (cat) { return String(cat.id) === String(categoryId); });
    labSaleCreditState.categoryId = exists ? String(categoryId) : NA_SMALL_ACCOUNT_ID;
    labSaleCreditState.installmentCount = 1;
    labEnsureSaleDestinationUi();
  };
  window.naCanonRefreshInstallmentDates = labRenderInstallmentDates;

  function labEnsureCategoryModal() {
    var modal = document.getElementById('naNewCreditCategoryModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'naNewCreditCategoryModal';
    modal.className = 'na-credit-category-modal';
    modal.hidden = true;
    modal.innerHTML = '<div class="na-credit-category-card"><div class="na-credit-category-head"><h3>NUEVA CATEGORÍA</h3><button type="button" onclick="naCanonCloseNewCreditCategory()" aria-label="Cerrar">×</button></div>' +
      '<label class="na-credit-field"><span>Nombre</span><input id="naNewCreditCategoryName" class="fi" maxlength="60" placeholder="Tecnología"></label>' +
      '<fieldset><legend>Forma de manejo</legend>' +
        '<label><input type="radio" name="naNewCreditCategoryMode" value="separate" checked><span><strong>Créditos separados</strong><small>Cada operación conserva su propio crédito y cuotas.</small></span></label>' +
        '<label><input type="radio" name="naNewCreditCategoryMode" value="accumulated"><span><strong>Cuenta acumulada</strong><small>Varias ventas se muestran dentro de una misma cuenta.</small></span></label>' +
      '</fieldset><div class="na-credit-category-actions"><button type="button" onclick="naCanonCloseNewCreditCategory()">Cancelar</button><button type="button" class="primary" onclick="naCanonCreateCreditCategory()">Crear y usar</button></div></div>';
    document.body.appendChild(modal);
    return modal;
  }

  window.naCanonOpenNewCreditCategory = function () {
    var client = labSaleClient();
    if (!client) { if (typeof toast === 'function') toast('Selecciona primero el cliente del crédito','error'); return; }
    var modal = labEnsureCategoryModal(); modal.hidden = false;
    var input = document.getElementById('naNewCreditCategoryName'); if (input) { input.value=''; setTimeout(function(){ input.focus(); }, 30); }
  };
  window.naCanonCloseNewCreditCategory = function () { var m=document.getElementById('naNewCreditCategoryModal'); if(m)m.hidden=true; };

  function labReadInstallmentDraft() {
    var client = labSaleClient(), category = labSelectedCategory(client);
    if (!client || category.mode !== 'separate') return [];
    var inputs = Array.from(document.querySelectorAll('#labCreditInstallmentDates .na-credit-installment-date'));
    var dates = inputs.map(function (input) { return String(input.value || '').slice(0,10); }).filter(Boolean);
    if (!dates.length) dates = labMonthlyDates(document.getElementById('mCreditoVence')?.value || '', labSaleCreditState.installmentCount);
    return dates.map(function (due,index) { return { number:index+1, due:due }; });
  }

  function labAttachSaleClientListener() {
    var input = document.getElementById('mCreditoCliente');
    if (input && !input.dataset.naV2Bound) {
      input.dataset.naV2Bound = 'true';
      input.addEventListener('change', function () {
        labSaleCreditState = { clientId:String(input.value || ''), categoryId:NA_SMALL_ACCOUNT_ID, installmentCount:1 };
        labEnsureSaleDestinationUi();
      });
    }
    var due = document.getElementById('mCreditoVence');
    if (due && !due.dataset.naV2Bound) {
      due.dataset.naV2Bound = 'true';
      due.addEventListener('change', function () {
        if (labSelectedCategory(labSaleClient()).mode === 'separate') labRenderInstallmentDates();
      });
    }
  }

  function naCanonicalSaleDraft() {
    var client = labSaleClient();
    if (!client) return null;
    var category = labSelectedCategory(client);
    var draft = labReadInstallmentDraft();
    return {
      account: { account_id:String(category.id || NA_SMALL_ACCOUNT_ID), name:String(category.name || NA_SMALL_ACCOUNT_NAME), mode:category.mode === 'separate' ? 'separate' : 'accumulated' },
      installment_dates: category.mode === 'separate' ? draft.map(function (row) { return String(row.due || '').slice(0,10); }).filter(Boolean) : []
    };
  }

  root.NA_CLIENT_CREDIT_ACCOUNTS_V2 = Object.freeze({
    smallAccountId:NA_SMALL_ACCOUNT_ID,
    accountMeta:creditAccountMeta,
    categoriesForClient:labCategoriesForClient,
    creditsForCategory:labCreditsForCategory,
    categorySummary:labCategorySummary,
    installments:labInstallmentSummary,
    installmentVisualState:labInstallmentVisualState,
    splitInstallmentAmounts:labSplitInstallmentAmounts,
    classifyClient:labClassifyClient,
    summarizeClient:labClientFinancialSummary,
    productSummary:labProductSummary,
    batchAllocationPlan:labBatchAllocationPlan,
    batchSelectedTotalCents:labBatchSelectedTotalCents,
    renderSaleDestination:labEnsureSaleDestinationUi,
    renderClientList:naRenderClientList,
    bindClientCards:labBindClientCards,
    saleDraft:naCanonicalSaleDraft
  });
  

  root.naCanonCreateCreditCategory = async function () {
    var client = labSaleClient(); if (!client) return;
    var name = String(document.getElementById('naNewCreditCategoryName')?.value || '').trim().replace(/\s+/g,' ');
    if (!name) { if (typeof toast === 'function') toast('Escribe un nombre para la categoría','error'); return; }
    var duplicate = labCustomCategories(client).find(function (c) { return c.name.toLowerCase() === name.toLowerCase(); });
    if (duplicate) {
      labSaleCreditState.categoryId = duplicate.id;
      root.naCanonCloseNewCreditCategory(); labEnsureSaleDestinationUi();
      if (typeof toast === 'function') toast('La categoría ya existía; se reutilizó.','success');
      return;
    }
    var mode = document.querySelector('input[name="naNewCreditCategoryMode"]:checked')?.value === 'accumulated' ? 'accumulated' : 'separate';
    var id = 'cat_' + root.crypto.randomUUID();
    try {
      if (!root.NuevoAmanecerCanonical || typeof root.NuevoAmanecerCanonical.createCreditAccount !== 'function') throw new Error('CANONICAL_CREDIT_ACCOUNT_UNAVAILABLE');
      await root.NuevoAmanecerCanonical.createCreditAccount({ customer_id:String(client.id), account_id:id, name:name.slice(0,60), mode:mode });
      await root.NuevoAmanecerCanonical.refresh();
      labSaleCreditState.categoryId=id; labSaleCreditState.installmentCount=1;
      root.naCanonCloseNewCreditCategory(); labEnsureSaleDestinationUi();
      if (typeof toast === 'function') toast('Categoría creada y seleccionada','success');
    } catch (error) {
      console.warn('[Nuevo Amanecer] No se pudo crear la categoría canónica.', error && error.message || error);
      if (typeof toast === 'function') toast('No se pudo guardar la categoría','error');
    }
  };

  function naUppercaseClientCards() {
    var list=document.getElementById('cliList'); if(!list) return;
    list.querySelectorAll('.client-card .c-name').forEach(function (node) {
      var current=String(node.textContent||'');
      var next=current.toUpperCase();
      if(current!==next) node.textContent=next;
    });
  }

  function naEnhanceClientCards() {
    labBindClientCards();
    naUppercaseClientCards();
    if (labClientScreenState.clientId) {
      var screen=labScreen();
      var paymentBridge=root.NuevoAmanecerCanonicalCreditPaymentBridge;
      var batchBusy=!!(paymentBridge && typeof paymentBridge.busy==='function' && paymentBridge.busy());
      if (screen && !screen.hidden && !batchBusy) labRenderRoute();
    }
  }

  function naResetClientNavigationForMenu() {
    var page=document.getElementById('pageClientes');
    if (page && page.classList.contains('active')) labCloseScreen();
  }

  function naEnsureClientLoadingUi() {
    var page=document.getElementById('pageClientes'), list=document.getElementById('cliList');
    if(!page||!list||!list.parentNode) return null;
    var loader=document.getElementById('naClientLoading');
    if(!loader) {
      loader=document.createElement('div'); loader.id='naClientLoading'; loader.className='na-client-loading';
      loader.setAttribute('role','status'); loader.setAttribute('aria-live','polite'); loader.hidden=true;
      var mark=document.createElement('div'); mark.className='na-client-loading-mark';
      var ring=document.createElement('span'); ring.className='na-client-loading-ring'; ring.setAttribute('aria-hidden','true');
      var logo=document.createElement('span'); logo.className='na-client-loading-logo'; logo.setAttribute('aria-hidden','true'); logo.textContent='🌅';
      var title=document.createElement('strong'); title.className='na-client-loading-title'; title.textContent='Cargando clientes…';
      var copy=document.createElement('span'); copy.className='na-client-loading-copy'; copy.textContent='Obteniendo datos, por favor espera.';
      mark.append(ring,logo); loader.append(mark,title,copy); list.parentNode.insertBefore(loader,list);
    }
    return loader;
  }

  function naSyncClientLoadingUi() {
    var page=document.getElementById('pageClientes'), loader=naEnsureClientLoadingUi();
    if(!page||!loader) return;
    var loading=false;
    try {
      if(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()) {
        var state=root.NuevoAmanecerCanonical.sourceState();
        loading=state.source==='none' && (state.validation==='pending' || state.validation==='validating');
      }
    } catch (_) {}
    page.classList.toggle('na-client-loading-active',loading);
    loader.hidden=!loading; loader.setAttribute('aria-hidden',loading?'false':'true');
  }

  function naRequestClientListRender() {
    if (typeof cliRender !== 'function') return;
    root.requestAnimationFrame(function () {
      try { cliRender(); } catch (error) { console.warn('[Nuevo Amanecer] No se pudo refrescar Clientes V2.', error && error.message || error); }
    });
  }

  function naBindClientMotion() {
    if (naClientMotionBound) return true;
    var motion = root.NA_MOTION;
    var page = document.getElementById('pageClientes');
    if (!motion || !motion.core || !page) return false;

    page.classList.add('na-motion');

    if (motion.page && typeof motion.page.bind === 'function') {
      var pageController = motion.page.bind('pageClientes', { enterClass:'na-enter-fade' });
      if (pageController && page.classList.contains('active') && typeof pageController.enter === 'function') {
        pageController.enter();
      }
    }

    if (typeof motion.core.registerController === 'function') {
      motion.core.registerController('clientes-v2', {
        inspect:function () {
          var screen = page.querySelector('.na-client-account-screen');
          return {
            pageActive:page.classList.contains('active'),
            detailOpen:!!(screen && !screen.hidden),
            workspaceState:screen ? naClientGetMotionState(screen) : 'closed',
            viewState:screen ? naClientGetMotionState(screen.querySelector('.na-client-account-content')) : 'idle',
            reducedMotion:naClientReducedMotion()
          };
        }
      });
    }

    naClientMotionBound = true;
    return true;
  }

  // Legacy credit dialogs and the V2 workspace share one navigation surface.
  // Suspend presentation/input, preserving route, scroll and financial data.
  var naClientDialogIds = ['mEvaluacionCredito','mLineaCreditoManual','mCred','mPagoCred','mCreditoDetalle'];
  var naClientObservedDialogs = new Set();

  function naSyncClientDialogVisibility() {
    var page = document.getElementById('pageClientes');
    var screen = page && page.querySelector('.na-client-account-screen');
    if (!screen) return;
    var suspended = naClientDialogIds.some(function (id) {
      var modal = document.getElementById(id);
      return !!(modal && modal.classList.contains('open'));
    });
    screen.classList.toggle('na-client-workspace-suspended', suspended);
    screen.inert = suspended;
  }

  function naBindClientDialogs() {
    if (typeof MutationObserver === 'function') {
      naClientDialogIds.forEach(function (id) {
        var modal = document.getElementById(id);
        if (!modal || naClientObservedDialogs.has(modal)) return;
        new MutationObserver(naSyncClientDialogVisibility).observe(modal, {attributes:true, attributeFilter:['class']});
        naClientObservedDialogs.add(modal);
      });
    }
    naSyncClientDialogVisibility();
  }

  function naBindRuntime() {
    naBindClientDialogs();
    if (typeof abrirCobro === 'function' && !abrirCobro.__naCreditAccountsV2) {
      var open=abrirCobro;
      abrirCobro=function(){var result=open.apply(this,arguments);setTimeout(labEnsureSaleDestinationUi,0);return result;};
      abrirCobro.__naCreditAccountsV2=true;
    }
    if (typeof selPM === 'function' && !selPM.__naCreditAccountsV2) {
      var select=selPM;
      selPM=function(){var result=select.apply(this,arguments);if(typeof posPayM!=='undefined'&&posPayM==='credito')setTimeout(labEnsureSaleDestinationUi,0);return result;};
      selPM.__naCreditAccountsV2=true;
    }
    labAttachSaleClientListener();
    var back=document.getElementById('backBtn');
    if(back && back.dataset.naClientMenuReset!=='true') {
      back.dataset.naClientMenuReset='true';
      back.addEventListener('click',naResetClientNavigationForMenu,true);
    }
    naBindClientMotion();
    naEnhanceClientCards(); naSyncClientLoadingUi();
  }

  root.addEventListener('na:canonical-payment-receipt',function(event){
    if (!labAcceptPaymentReceipt(event && event.detail)) return;
    // The Worker receipt is already durable at this point. Paint the affected
    // client immediately; the expensive full reconciliation remains background.
    if (labClientScreenState && labClientScreenState.clientId) labRenderRoute('replace');
    naEnhanceClientCards();
  });

  root.addEventListener('na:canonical-updated',function(){setTimeout(function(){
    labReconcilePaymentReceiptOverlays();
    naBindRuntime(); naEnhanceClientCards(); naSyncClientLoadingUi();
    if ((labBatchAwaitingReconcile || labPaymentReceiptOverlays.size) && labClientScreenState && labClientScreenState.clientId) {
      labBatchAwaitingReconcile = false;
      labRenderRoute('replace');
    }
  },0);});
  root.addEventListener('load',naBindRuntime);
  root.addEventListener('pageshow',naBindRuntime);
  if (typeof MutationObserver === 'function') {
    var list=document.getElementById('cliList');
    var naClientEnhanceFrame=0;
    if(list) new MutationObserver(function(){
      if(naClientEnhanceFrame) return;
      naClientEnhanceFrame=requestAnimationFrame(function(){
        naClientEnhanceFrame=0;
        naEnhanceClientCards();
      });
    }).observe(list,{childList:true,subtree:true});
  }
  // P2-2: la búsqueda de Clientes redibuja 130 ms después de la última tecla (antes
  // renormalizaba todos los créditos en cada tecla). Reemplaza el oninput del campo; el
  // marcado de index.html sigue idéntico al de LAB.
  var naCliSearchTimer = 0;
  root._naCliSearchInput = function () {
    clearTimeout(naCliSearchTimer);
    naCliSearchTimer = setTimeout(function () {
      naCliSearchTimer = 0;
      if (typeof cliRender !== 'function') return;
      cliRender();
    }, 130);
  };
  var naCliSearchField = document.getElementById('cliSearch');
  if (naCliSearchField) naCliSearchField.oninput = root._naCliSearchInput;
  naBindRuntime();

})(window);
