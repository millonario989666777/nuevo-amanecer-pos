/* Frecuencia de compra: proyección de solo lectura de clientes y ventas en memoria. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageClientesFrecuencia';
  var DAY_MS = 86400000;
  function text(value) { return String(value == null ? '' : value).trim(); }
  function number(value) { var n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
  function searchKey(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }
  // Mismo fecha || timestamp y zona -05:00 para fechas sin zona que rotacion-abc.
  function limaDay(value) {
    var raw = text(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validDay(raw);
    if (!raw) return '';
    if (typeof value === 'number' || value instanceof Date) {
      raw = value;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !validDay(raw.slice(0, 10))) return '';
      if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += '-05:00';
    }
    if (root.NALimaTime && typeof root.NALimaTime.parts === 'function') {
      var parts = root.NALimaTime.parts(raw);
      return parts ? parts.date : '';
    }
    var date = new Date(raw);
    return Number.isFinite(date.getTime()) ? new Date(date.getTime() - 5 * 3600000).toISOString().slice(0, 10) : '';
  }
  function periodRange(days, now) {
    var count = [90, 180, 365].indexOf(Number(days)) >= 0 ? Number(days) : 90;
    var to = limaDay(now === undefined ? Date.now() : now);
    if (!to) throw new RangeError('Fecha de referencia inválida');
    var from = new Date(new Date(to + 'T00:00:00Z').getTime() - (count - 1) * DAY_MS);
    return { days: count, from: from.toISOString().slice(0, 10), to: to };
  }
  function daysBetween(from, to) { return (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS; }
  function purchaseStatus(purchases, averageDays, daysSinceLast) {
    if (daysSinceLast > 60 || (purchases > 1 && daysSinceLast > 2 * averageDays)) return 'Inactivo';
    if (purchases === 1) return 'Una sola compra';
    return daysSinceLast > averageDays ? 'Por volver' : 'Al día';
  }
  function customerId(sale) {
    var candidates = [sale.clienteId, sale.customer_id, sale.cliente_id];
    for (var i = 0; i < candidates.length; i++) if (text(candidates[i])) return text(candidates[i]);
    return '';
  }
  function saleCents(sale) {
    // Precios históricos y cantidades vendidas; nunca multiplicar por unidades físicas.
    if (Array.isArray(sale.items)) {
      var total = sale.items.reduce(function (sum, item) {
        if (!item || typeof item !== 'object') return sum;
        var amount = number(item.precio != null ? item.precio : item.precioUnitario) * number(item.qty != null ? item.qty : item.cantidad);
        return Number.isFinite(amount) ? sum + amount : sum;
      }, 0);
      return Math.round(Number(total.toFixed(2)) * 100);
    }
    return sale.total_cents != null ? Math.round(number(sale.total_cents)) : Math.round(number(sale.total) * 100);
  }
  function buildReport(sales, customers, options) {
    options = options || {};
    var range = periodRange(options.days, options.now);
    var names = new Map(), grouped = new Map();
    (Array.isArray(customers) ? customers : []).forEach(function (customer) {
      if (!customer || typeof customer !== 'object') return;
      var id = text(customer.id != null ? customer.id : customer.customer_id);
      if (id && !names.has(id)) names.set(id, text(customer.nombre || customer.name));
    });
    (Array.isArray(sales) ? sales : []).forEach(function (sale) {
      if (!sale || typeof sale !== 'object' || sale.anulada || sale.anulado || /^anulad[ao]$/.test(searchKey(sale.estado || sale.status))) return;
      var id = customerId(sale), day = limaDay(sale.fecha || sale.timestamp);
      // Sin identidad durable no agrupar por nombre: dos clientes pueden llamarse igual.
      if (!id || !day || day < range.from || day > range.to) return;
      if (!grouped.has(id)) grouped.set(id, { id: id, name: names.get(id) || text(sale.clienteNombre || sale.customer_name) || 'Cliente sin nombre', dates: [], revenueCents: 0 });
      var row = grouped.get(id);
      row.dates.push(day);
      row.revenueCents += saleCents(sale);
    });
    var query = searchKey(options.search);
    var priority = { 'Inactivo': 0, 'Por volver': 1, 'Al día': 2, 'Una sola compra': 3 };
    var rows = Array.from(grouped.values()).map(function (row) {
      var dates = row.dates.slice().sort(), purchases = dates.length;
      var lastPurchase = dates[purchases - 1];
      var averageDays = purchases > 1 ? daysBetween(dates[0], lastPurchase) / (purchases - 1) : null;
      var daysSinceLast = daysBetween(lastPurchase, range.to);
      return { id: row.id, name: row.name, purchases: purchases, averageDays: averageDays,
        lastPurchase: lastPurchase, daysSinceLast: daysSinceLast,
        status: purchaseStatus(purchases, averageDays, daysSinceLast),
        revenueCents: row.revenueCents, revenue: row.revenueCents / 100 };
    }).filter(function (row) { return !query || searchKey(row.name).indexOf(query) >= 0; });
    rows.sort(function (a, b) {
      return priority[a.status] - priority[b.status] ||
        (b.daysSinceLast - (b.averageDays == null ? 60 : b.averageDays)) - (a.daysSinceLast - (a.averageDays == null ? 60 : a.averageDays)) ||
        b.daysSinceLast - a.daysSinceLast || a.name.localeCompare(b.name, 'es-PE') || a.id.localeCompare(b.id);
    });
    return { range: range, rows: rows, purchases: rows.reduce(function (sum, row) { return sum + row.purchases; }, 0),
      overdue: rows.filter(function (row) { return row.status === 'Inactivo' || row.status === 'Por volver'; }).length,
      revenue: rows.reduce(function (sum, row) { return sum + row.revenueCents; }, 0) / 100 };
  }

  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() && permissions &&
      typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID));
  }
  // Toda etiqueta y nombre usa textContent; ningún dato del cliente se interpreta como HTML.
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function money(value) { return 'S/ ' + value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function dateLabel(day) { return day.split('-').reverse().join('/'); }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-cf-content]'), status = page.querySelector('[data-cf-status]');
    if (!content || !status) return false;
    var authorized = ownerAllowed(), controls = page.querySelector('[data-cf-controls]');
    if (controls) controls.hidden = !authorized;
    content.replaceChildren();
    if (!authorized) { status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var period = page.querySelector('[data-cf-period]'), search = page.querySelector('[data-cf-search]');
    var sales = typeof ventas !== 'undefined' ? ventas : root.ventas;
    var customers = typeof clientes !== 'undefined' ? clientes : root.clientes;
    var report = buildReport(sales, customers, { days: period ? period.value : 90, search: search ? search.value : '' });
    status.textContent = dateLabel(report.range.from) + ' al ' + dateLabel(report.range.to) + ' · hora de Lima · ventas cargadas en este dispositivo';
    var summary = element('div', 'cf-summary');
    [['Clientes', report.rows.length], ['Compras', report.purchases], ['Por volver o inactivos', report.overdue], ['Importe comprado', money(report.revenue)]].forEach(function (pair) {
      var card = element('div', 'cf-summary-card'); card.appendChild(element('span', '', pair[0])); card.appendChild(element('strong', '', pair[1])); summary.appendChild(card);
    });
    content.appendChild(summary);
    if (!report.rows.length) { content.appendChild(element('p', 'cf-empty', 'No hay compras de clientes para mostrar con estos filtros.')); return true; }
    var section = element('section', 'cf-results');
    var table = element('table', 'cf-table');
    table.appendChild(element('caption', 'cf-sr-only', 'Frecuencia de compra de clientes, primero quienes están por volver o inactivos'));
    var head = element('thead'), tr = element('tr');
    ['Cliente', 'Compras', 'Cada (días)', 'Última compra', 'Días sin comprar', 'Estado', 'Importe'].forEach(function (label) { var th = element('th', '', label); th.scope = 'col'; tr.appendChild(th); });
    head.appendChild(tr); table.appendChild(head);
    var body = element('tbody');
    report.rows.forEach(function (row) {
      var line = element('tr'); line.setAttribute('data-cf-state', row.status);
      var name = element('th', 'cf-customer', row.name); name.scope = 'row'; line.appendChild(name);
      [['Compras', row.purchases], ['Cada (días)', row.averageDays == null ? '—' : row.averageDays.toLocaleString('es-PE', { maximumFractionDigits: 1 })],
        ['Última compra', dateLabel(row.lastPurchase)], ['Días sin comprar', row.daysSinceLast]].forEach(function (pair) {
        var cell = element('td', 'cf-num', pair[1]); cell.setAttribute('data-label', pair[0]); line.appendChild(cell);
      });
      var state = element('td'); state.setAttribute('data-label', 'Estado');
      var tone = row.status === 'Inactivo' ? 'inactive' : row.status === 'Por volver' ? 'due' : row.status === 'Al día' ? 'current' : 'single';
      state.appendChild(element('span', 'cf-badge cf-' + tone, row.status)); line.appendChild(state);
      var amount = element('td', 'cf-num', money(row.revenue)); amount.setAttribute('data-label', 'Importe'); line.appendChild(amount);
      body.appendChild(line);
    });
    table.appendChild(body); section.appendChild(table); content.appendChild(section);
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naClientesFrecuenciaBound) return;
    page.__naClientesFrecuenciaBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    var search = page.querySelector('[data-cf-search]');
    if (search) search.addEventListener('input', update);
    var refresh = page.querySelector('[data-cf-refresh]');
    if (refresh) refresh.addEventListener('click', update);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_CLIENTES_FRECUENCIA = Object.freeze({ limaDay: limaDay, periodRange: periodRange, purchaseStatus: purchaseStatus,
    buildReport: buildReport, ownerAllowed: ownerAllowed, render: render, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
