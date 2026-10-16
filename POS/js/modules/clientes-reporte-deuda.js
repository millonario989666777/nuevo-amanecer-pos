/* Nuevo Amanecer — proyección de deuda de solo lectura, exclusiva del dueño. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageReporteDeuda';
  var doc = root.document;
  var sortMode = 'saldo';
  var refreshTimer = null;
  var initialized = false;

  function amount(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('Saldo no disponible');
    return number;
  }

  // Misma regla visual que labCreditVisualDate de V2: fecha, luego timestamp.
  // No usar vence: es el vencimiento, no la fecha de creación del crédito.
  function creditDate(credit) {
    var direct = String(credit && credit.fecha || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    var fallback = String(credit && credit.timestamp || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : '';
  }

  // Mismo criterio que V2 (labCreditPending): _naCreditOutstanding o monto − pagado.
  function outstanding(credit) {
    try { if (typeof _naCreditOutstanding === 'function') return Math.max(0, Number(_naCreditOutstanding(credit)) || 0); } catch (_) {}
    return Math.max(0, (Number(credit.monto) || 0) - (Number(credit.pagado) || 0));
  }

  // Pura respecto de sus entradas. V2 es la única autoridad del saldo;
  // únicamente se suman los saldos finales de las filas para el pie.
  function buildReport(clients, api, pending, order) {
    if (!api || typeof api.summarizeClient !== 'function' || !api.debtFilter ||
        typeof api.debtFilter.effectiveBalance !== 'function') {
      throw new Error('Resumen de créditos no disponible');
    }
    var rows = [];
    (Array.isArray(clients) ? clients : []).forEach(function (client) {
      if (!client) return;
      var summary = api.summarizeClient(client, true);
      var balance = amount(api.debtFilter.effectiveBalance(summary, pending));
      if (balance === 0) return;
      // summary.active de V2 ya excluye créditos cancelados (pendiente <= 0,001 según
      // _naCreditOutstanding = monto − pagado). No usar credit.saldo: puede quedar desfasado.
      var active = (Array.isArray(summary.active) ? summary.active : []).filter(function (credit) {
        return credit && outstanding(credit) > 0.001;
      });
      var dates = active.map(creditDate).filter(Boolean).sort();
      rows.push({ clientId:client.id, name:String(client.nombre || 'Cliente'), balance:balance,
        overdueDebt:amount(summary.overdueDebt), oldestDate:dates[0] || '', openCredits:active.length });
    });
    var key = order === 'vencida' ? 'overdueDebt' : 'balance';
    rows.sort(function (a, b) { return b[key] - a[key] || b.balance - a.balance; });
    var cents = rows.reduce(function (sum, row) { return sum + Math.round(row.balance * 100); }, 0);
    return { rows:rows, total:cents / 100, count:rows.length };
  }

  function isOwner() {
    try { return !!(root.NA_ROLES && root.NA_ROLES.isOwner() === true); }
    catch (_) { return false; }
  }

  function pendingSnapshot() {
    try {
      var canonical = root.NuevoAmanecerCanonical;
      return canonical && typeof canonical.pendingSnapshot === 'function' ? canonical.pendingSnapshot() : null;
    } catch (_) { return null; }
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
    return navigate(PAGE_ID);
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

  function metric(row, label, value, className) {
    var cell = element('span', 'rd-cell ' + (className || ''));
    cell.append(element('span', 'rd-label', label), element('strong', 'rd-value', value));
    row.append(cell);
  }

  function render() {
    if (!doc) return false;
    var page = doc.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-rd-content]');
    var status = page.querySelector('[data-rd-status]');
    if (!content || !status) return false;
    content.replaceChildren();
    var allowed = isOwner();
    page.querySelectorAll('[data-rd-owner-control]').forEach(function (control) { control.hidden = !allowed; });
    if (!allowed) {
      status.textContent = 'Sin permiso. Este reporte está disponible solo para el dueño.';
      return false;
    }
    var report;
    try {
      report = buildReport(typeof clientes !== 'undefined' ? clientes : [],
        root.NA_CLIENT_CREDIT_ACCOUNTS_V2, pendingSnapshot(), sortMode);
    } catch (_) {
      status.textContent = 'No se pudo cargar el reporte de deuda. Vuelve a abrirlo para reintentar.';
      return false;
    }
    status.textContent = report.count ? '' : 'No hay clientes con deuda pendiente.';
    var list = element('ul', 'rd-list');
    list.setAttribute('aria-label', 'Clientes con deuda pendiente');
    report.rows.forEach(function (data) {
      var item = element('li', 'rd-item');
      var row = element('button', 'rd-row');
      row.type = 'button';
      row.dataset.clientId = String(data.clientId);
      row.setAttribute('aria-label', 'Abrir ficha de ' + data.name + ', saldo pendiente ' + money(data.balance) +
        ', deuda vencida ' + money(data.overdueDebt) + ', crédito impago más antiguo ' + dateLabel(data.oldestDate) +
        ', créditos abiertos ' + data.openCredits);
      metric(row, 'Cliente', data.name, 'rd-client');
      metric(row, 'Saldo pendiente', money(data.balance), 'rd-balance');
      metric(row, 'Deuda vencida', money(data.overdueDebt), data.overdueDebt > 0 ? 'rd-overdue' : '');
      metric(row, 'Crédito impago más antiguo', dateLabel(data.oldestDate));
      metric(row, 'Créditos abiertos', data.openCredits);
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
    content.append(list, footer);
    return true;
  }

  function syncEntry() {
    var bar = doc.querySelector('#pageClientes .filter-bar');
    if (!bar) return;
    var entry = doc.getElementById('naClientesReporteDeudaBtn');
    if (!entry && isOwner()) {
      entry = element('button', 'f-select', 'Reporte de deuda');
      entry.id = 'naClientesReporteDeudaBtn';
      entry.type = 'button';
      entry.style.minHeight = '44px';
      entry.style.whiteSpace = 'normal';
      entry.setAttribute('aria-controls', PAGE_ID);
      entry.addEventListener('click', open);
      bar.append(entry);
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
