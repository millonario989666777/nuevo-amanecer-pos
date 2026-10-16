/* Nuevo Amanecer — proyección de deuda de solo lectura, exclusiva del dueño. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageReporteDeuda';
  var doc = root.document;
  var sortMode = 'saldo';
  var refreshTimer = null;
  var initialized = false;
  var renderedReport = null;

  function amount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        !Number.isSafeInteger(Math.round(value * 100))) throw new Error('Saldo no disponible');
    return value;
  }

  function calendarDate(value) {
    var day = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    var parsed = new Date(day + 'T12:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : '';
  }

  // Fecha registrada, luego día del timestamp en Lima, independiente del aparato.
  // No usar vence: es el vencimiento, no la fecha de creación del crédito.
  function creditDate(credit) {
    var direct = calendarDate(credit && credit.fecha);
    if (direct) return direct;
    var timestamp = String(credit && credit.timestamp || '');
    if (!calendarDate(timestamp)) return '';
    if (timestamp.length === 10) return timestamp;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return '';
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) timestamp += '-05:00';
    var instant = Date.parse(timestamp);
    return Number.isFinite(instant) ? new Date(instant - 5 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
  }

  // Mismo redondeo que _naCreditOutstanding; no delegar en helpers mutables.
  function outstanding(credit) {
    return Math.max(0, Number(((Number(credit.monto) || 0) - (Number(credit.pagado) || 0)).toFixed(2)));
  }

  // Este módulo no escribe sus entradas. V2 es la única autoridad del saldo;
  // su ruta readOnly todavía requiere corregir el índice legacy compartido.
  // Únicamente se suman los saldos finales de las filas para el pie.
  function buildReport(clients, api, pending, order) {
    if (!api || typeof api.summarizeClient !== 'function' || !api.debtFilter ||
        typeof api.debtFilter.effectiveBalance !== 'function') {
      throw new Error('Resumen de créditos no disponible');
    }
    var rows = [];
    (Array.isArray(clients) ? clients : []).forEach(function (client) {
      if (!client) return;
      var summary = api.summarizeClient(client, true);
      // effectiveBalance convierte deudas no finitas en cero: no ocultar una
      // fuente financiera inválida como si fuera un cliente sin deuda.
      amount(summary && summary.debt);
      var balance = amount(api.debtFilter.effectiveBalance(summary, pending));
      if (balance === 0) return;
      // summary.active de V2 ya excluye créditos cancelados (pendiente <= 0,001 según
      // _naCreditOutstanding = monto − pagado). No usar credit.saldo: puede quedar desfasado.
      var active = (Array.isArray(summary.active) ? summary.active : []).filter(function (credit) {
        return credit && outstanding(credit) > 0.001;
      });
      var oldest = '';
      active.forEach(function (credit) {
        var date = creditDate(credit);
        if (date && (!oldest || date < oldest)) oldest = date;
      });
      rows.push({ clientId:client.id, name:String(client.nombre || 'Cliente'), balance:balance,
        // La deuda vencida nunca supera el saldo efectivo (pagos en cola incluidos).
        overdueDebt:Math.min(amount(summary.overdueDebt), balance), oldestDate:oldest, openCredits:active.length });
    });
    var key = order === 'vencida' ? 'overdueDebt' : 'balance';
    rows.sort(function (a, b) { return b[key] - a[key] || b.balance - a.balance; });
    var cents = rows.reduce(function (sum, row) { return sum + Math.round(row.balance * 100); }, 0);
    if (!Number.isSafeInteger(cents)) throw new Error('Saldo no disponible');
    return { rows:rows, total:cents / 100, count:rows.length };
  }

  function isOwner() {
    try { return !!(root.NA_ROLES && root.NA_ROLES.isOwner() === true); }
    catch (_) { return false; }
  }

  function pendingSnapshot() {
    var canonical = root.NuevoAmanecerCanonical;
    // Ausencia de CANON (modo local) permite null. Un error de lectura del
    // outbox no demuestra que esté vacío: no publicar saldos sin pendientes.
    return canonical && typeof canonical.pendingSnapshot === 'function' ? canonical.pendingSnapshot() : null;
  }

  function navigate(pageId) {
    if (root.NA_MENU_NAVIGATION && typeof root.NA_MENU_NAVIGATION.navigate === 'function') {
      return root.NA_MENU_NAVIGATION.navigate(pageId) !== false;
    }
    if (typeof root.goPage !== 'function') return false;
    return root.goPage(pageId) !== false;
  }

  function open() {
    if (!isOwner()) return false;
    render();
    if (!navigate(PAGE_ID)) return false;
    var page = doc && doc.getElementById(PAGE_ID);
    var back = page && page.querySelector('[data-rd-back]');
    if (back) back.focus({ preventScroll:true });
    return true;
  }

  function openClient(clientId) {
    if (!isOwner() || typeof root.naCanonOpenClientAccount !== 'function') return false;
    if (!navigate('pageClientes')) return false;
    // La misma entrada pública que usa la lista de Clientes.
    root.naCanonOpenClientAccount(clientId);
    return true;
  }

  function element(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function money(value) { return 'S/ ' + value.toFixed(2); }
  function dateLabel(value) { return value ? value.split('-').reverse().join('/') : 'Sin fecha registrada'; }

  // Criterio de «Créditos abiertos»: solo créditos con saldo pendiente mayor a
  // S/ 0,001 (monto − pagado). La tarjeta de Clientes muestra «N créditos» con
  // todos los créditos no anulados, incluidos los ya pagados; por eso puede
  // indicar más que este reporte.
  var OPEN_CREDITS_NOTE = 'Créditos abiertos cuenta solo los créditos con saldo pendiente. ' +
    'La lista de Clientes muestra todos los créditos no anulados, incluidos los ya pagados.';

  function metric(row, label, value, className, hint) {
    var cell = element('span', 'rd-cell ' + (className || ''));
    var labelNode = element('span', 'rd-label', label);
    if (hint) labelNode.title = hint;
    cell.append(labelNode, element('strong', 'rd-value', value));
    row.append(cell);
  }

  function render() {
    if (!doc) return false;
    var page = doc.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-rd-content]');
    var status = page.querySelector('[data-rd-status]');
    if (!content || !status) return false;
    var allowed = isOwner();
    page.querySelectorAll('[data-rd-owner-control]').forEach(function (control) { control.hidden = !allowed; });
    if (!allowed) {
      content.replaceChildren();
      renderedReport = null;
      status.textContent = 'Sin permiso. Este reporte está disponible solo para el dueño.';
      return false;
    }
    var report;
    try {
      report = buildReport(typeof clientes !== 'undefined' ? clientes : [],
        root.NA_CLIENT_CREDIT_ACCOUNTS_V2, pendingSnapshot(), sortMode);
    } catch (_) {
      content.replaceChildren();
      renderedReport = null;
      status.textContent = 'No se pudo cargar el reporte de deuda. Vuelve a abrirlo para reintentar.';
      return false;
    }
    status.textContent = report.count ? '' : 'No hay clientes con deuda pendiente.';
    var signature = JSON.stringify(report);
    // Eventos focus/pageshow/storage suelen traer los mismos datos. Mantener
    // botones y foco, y evitar recrear miles de nodos sin un cambio visible.
    if (signature === renderedReport) return true;
    var focused = doc.activeElement;
    var focusedId = focused && content.contains(focused) ? focused.dataset.clientId : undefined;
    var focusTarget = null;
    var list = element('ul', 'rd-list');
    list.setAttribute('aria-label', 'Clientes con deuda pendiente');
    report.rows.forEach(function (data) {
      var item = element('li', 'rd-item');
      var row = element('button', 'rd-row');
      row.type = 'button';
      row.dataset.clientId = String(data.clientId);
      if (row.dataset.clientId === focusedId) focusTarget = row;
      row.setAttribute('aria-label', 'Abrir ficha de ' + data.name + ', saldo pendiente ' + money(data.balance) +
        ', deuda vencida ' + money(data.overdueDebt) + ', crédito impago más antiguo ' + dateLabel(data.oldestDate) +
        ', créditos abiertos ' + data.openCredits);
      metric(row, 'Cliente', data.name, 'rd-client');
      metric(row, 'Saldo pendiente', money(data.balance), 'rd-balance');
      metric(row, 'Deuda vencida', money(data.overdueDebt), data.overdueDebt > 0 ? 'rd-overdue' : '');
      metric(row, 'Crédito impago más antiguo', dateLabel(data.oldestDate));
      metric(row, 'Créditos abiertos', data.openCredits, '', OPEN_CREDITS_NOTE);
      row.addEventListener('click', function () { openClient(data.clientId); });
      item.append(row);
      list.append(item);
    });
    var footer = element('footer', 'rd-footer');
    footer.setAttribute('aria-label', 'Resumen de deuda');
    var total = element('strong', '', money(report.total));
    total.dataset.rdTotal = '';
    var count = element('strong', '', report.count);
    count.dataset.rdCount = '';
    var totalBox = element('div');
    totalBox.append(element('span', '', 'Total adeudado'), total);
    var countBox = element('div');
    countBox.append(element('span', '', 'Clientes que deben'), count);
    footer.append(totalBox, countBox);
    var note = element('p', 'rd-note', OPEN_CREDITS_NOTE);
    note.dataset.rdNote = '';
    content.replaceChildren(list, footer, note);
    renderedReport = signature;
    if (focusedId !== undefined) {
      (focusTarget || page.querySelector('[data-rd-sort]')).focus({ preventScroll:true });
    }
    return true;
  }

  function syncEntry() {
    var bar = doc.querySelector('#pageClientes .filter-bar');
    if (!bar) return;
    var entry = doc.getElementById('naClientesReporteDeudaBtn');
    if (!entry && isOwner()) {
      entry = element('button', 'f-select rd-entry', 'Reporte de deuda');
      entry.id = 'naClientesReporteDeudaBtn';
      entry.type = 'button';
      entry.setAttribute('aria-controls', PAGE_ID);
      entry.addEventListener('click', open);
      // La barra móvil usa nowrap y un select fijo de 112px. Una fila propia
      // mantiene disponible la búsqueda, incluso a 390px.
      bar.parentNode.insertBefore(entry, bar.nextSibling);
    }
    if (entry) entry.hidden = !isOwner();
  }

  function refresh() {
    syncEntry();
    var page = doc.getElementById(PAGE_ID);
    if (page && page.classList.contains('active')) render();
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = root.setTimeout(function () { refreshTimer = null; refresh(); }, 0);
  }

  function init() {
    if (!doc || initialized) return;
    var page = doc.getElementById(PAGE_ID);
    if (!page) return;
    initialized = true;
    var order = page.querySelector('[data-rd-sort]');
    if (order) order.addEventListener('change', function () {
      sortMode = order.value === 'vencida' ? 'vencida' : 'saldo';
      render();
    });
    var back = page.querySelector('[data-rd-back]');
    if (back) back.addEventListener('click', function () { navigate('pageClientes'); });
    if (typeof root.MutationObserver === 'function') {
      var observer = new root.MutationObserver(scheduleRefresh);
      observer.observe(page, { attributes:true, attributeFilter:['class'] });
      var clientsPage = doc.getElementById('pageClientes');
      if (clientsPage) observer.observe(clientsPage, { attributes:true, attributeFilter:['class'] });
    }
    ['na:role', 'na:canonical-updated', 'na:canonical-payment-receipt', 'online', 'offline',
      'focus', 'pageshow', 'storage'].forEach(function (name) { root.addEventListener(name, scheduleRefresh); });
    refresh();
    // Incluso si está oculta, eliminar cualquier contenido ante un cambio de rol.
    root.addEventListener('na:role', function () { syncEntry(); if (!isOwner()) render(); });
  }

  root.NA_CLIENTES_REPORTE_DEUDA = Object.freeze({ buildReport:buildReport, render:render,
    open:open, openClient:openClient, init:init });
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once:true });
    else init();
    root.addEventListener('load', init, { once:true });
  }
})(globalThis);
