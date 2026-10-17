/* Historial de compras por cliente: consulta de solo lectura de ventas y clientes locales. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageClienteHistorial';
  var FEATURE_ID = 'cliente-historial-compras';
  var DAY_MS = 86400000;
  function text(value) { return String(value == null ? '' : value).trim(); }
  function normalized(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function number(value) { var n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
  function cents(value) { return Math.round(Number(number(value).toFixed(2)) * 100); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }
  // Como Rotación ABC: fecha || timestamp, sin zona = Lima (UTC-5).
  function limaDay(value) {
    var raw = text(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validDay(raw);
    if (!raw) return '';
    if (typeof value === 'number' || value instanceof Date) raw = value;
    else {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !validDay(raw.slice(0, 10))) return '';
      if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += '-05:00';
    }
    var date = new Date(raw);
    return Number.isFinite(date.getTime()) ? new Date(date.getTime() - 5 * 3600000).toISOString().slice(0, 10) : '';
  }
  function periodRange(days, now) {
    var count = days === 'all' ? 'all' : [30, 90, 365].includes(Number(days)) ? Number(days) : 30;
    var to = limaDay(now === undefined ? Date.now() : now);
    if (!to) throw new RangeError('Fecha de referencia inválida');
    return { days: count, from: count === 'all' ? '' : new Date(new Date(to + 'T00:00:00Z').getTime() - (count - 1) * DAY_MS).toISOString().slice(0, 10), to: to };
  }
  function customerId(customer) { return text(customer.id != null ? customer.id : customer.customer_id); }
  function searchCustomers(customers, query) {
    var needle = normalized(query), seen = new Set();
    return (Array.isArray(customers) ? customers : []).filter(function (customer) {
      if (!customer || typeof customer !== 'object') return false;
      var id = customerId(customer);
      if (!id || seen.has(id)) return false;
      seen.add(id); return true;
    }).map(function (customer) {
      return { id: customerId(customer), name: text(customer.nombre || customer.name) || 'Cliente sin nombre', dni: text(customer.dni || customer.document) };
    }).filter(function (customer) {
      return !needle || normalized(customer.name + ' ' + customer.dni).includes(needle);
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id); });
  }
  function productIdentity(item) {
    var id = text(item.id != null ? item.id : item.productoId != null ? item.productoId : item.product_id);
    var name = text(item.name || item.nombre || (item.generic_line && item.generic_line.name));
    var code = text(item.sku || item.barcode || (item.generic_line && item.generic_line.code));
    return { key: id ? 'id:' + id : code ? 'code:' + code : 'name:' + (name || 'Producto sin nombre'), name: name || code || 'Producto sin nombre' };
  }
  function buildReport(sales, selectedId, options) {
    options = options || {};
    var range = periodRange(options.days, options.now), selected = text(selectedId);
    var rows = [], products = new Map(), totalCents = 0;
    (Array.isArray(sales) ? sales : []).forEach(function (sale) {
      if (!sale || typeof sale !== 'object' || sale.anulada || ['anulada', 'anulado', 'void'].includes(normalized(sale.estado || sale.status))) return;
      // Nunca enlazar por nombre/DNI: dos clientes pueden tener el mismo nombre.
      var linkedId = text(sale.clienteId != null ? sale.clienteId : sale.customer_id);
      if (!selected || linkedId !== selected) return;
      var day = limaDay(sale.fecha || sale.timestamp);
      if (!day || (range.from && day < range.from) || day > range.to) return;
      var itemsTotal = 0;
      (Array.isArray(sale.items) ? sale.items : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var qty = number(item.qty != null ? item.qty : item.cantidad != null ? item.cantidad : item.quantity);
        if (qty <= 0) return;
        var price = item.precio != null ? item.precio : item.precioUnitario;
        var amount = item.subtotal != null ? cents(item.subtotal) : item.line_total_cents != null ? Math.round(number(item.line_total_cents)) :
          cents((price != null ? number(price) : number(item.unit_price_cents) / 100) * qty);
        var ref = productIdentity(item);
        if (!products.has(ref.key)) products.set(ref.key, { key: ref.key, name: ref.name, quantity: 0, amountCents: 0 });
        var product = products.get(ref.key);
        product.quantity += qty; product.amountCents += amount; itemsTotal += amount;
      });
      // El total de la venta ya incluye sus descuentos; no usar acumulados del cliente ni abonos.
      var amount = sale.total != null ? cents(sale.total) : sale.total_cents != null ? Math.round(number(sale.total_cents)) : itemsTotal;
      totalCents += amount;
      var receipt = typeof sale.comprobante === 'string' || typeof sale.comprobante === 'number' ? text(sale.comprobante) : '';
      rows.push({ day: day, reference: receipt || text(sale.id || sale.sale_id) || 'Sin comprobante',
        method: text(sale.metodoPago || sale.metodo || sale.payment_method) || 'Sin registrar', total: amount / 100,
        order: text(sale.timestamp || sale.hora24 || sale.hora) });
    });
    rows.sort(function (a, b) { return b.day.localeCompare(a.day) || b.order.localeCompare(a.order) || a.reference.localeCompare(b.reference); });
    return { range: range, total: totalCents / 100, purchases: rows.length, lastPurchase: rows.length ? rows[0].day : '', sales: rows,
      products: Array.from(products.values()).map(function (product) {
        return { key: product.key, name: product.name, quantity: product.quantity, amount: product.amountCents / 100 };
      }).sort(function (a, b) { return b.amount - a.amount || a.name.localeCompare(b.name, 'es') || a.key.localeCompare(b.key); }) };
  }
  function money(value) { return 'S/ ' + value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function dateLabel(day) { return day ? day.split('-').reverse().join('/') : 'Sin compras'; }
  function paymentLabel(method) {
    var labels = { efectivo: 'Efectivo', yape: 'Yape', plin: 'Plin', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito', mixto: 'Mixto' };
    return Object.prototype.hasOwnProperty.call(labels, normalized(method)) ? labels[normalized(method)] : method;
  }
  function tableHtml(title, kind, labels, rows, numeric) {
    numeric = numeric || [];
    function cls(i) { return numeric.indexOf(i) >= 0 ? ' class="ch-num"' : ''; }
    return '<section class="ch-section"><h2>' + escapeHtml(title) + '</h2><table class="ch-table" data-ch-table="' + kind + '"><caption class="ch-sr-only">' + escapeHtml(title) + '</caption><thead><tr>' +
      labels.map(function (label) { return '<th scope="col"' + cls(labels.indexOf(label)) + '>' + escapeHtml(label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (row) { return '<tr>' + row.map(function (value, i) {
        return i === 0 ? '<th scope="row">' + escapeHtml(value) + '</th>' : '<td' + cls(i) + ' data-label="' + escapeHtml(labels[i]) + '">' + escapeHtml(value) + '</td>';
      }).join('') + '</tr>'; }).join('') + '</tbody></table></section>';
  }
  function reportHtml(report, customer) {
    var html = '<h2 class="ch-customer">' + escapeHtml(customer.name) + '</h2><div class="ch-summary">';
    [['Total consumido', money(report.total)], ['Número de compras', report.purchases], ['Última compra', dateLabel(report.lastPurchase)]].forEach(function (pair) {
      html += '<div class="ch-summary-card"><span>' + escapeHtml(pair[0]) + '</span><strong>' + escapeHtml(pair[1]) + '</strong></div>';
    });
    html += '</div>';
    if (!report.purchases) return html + '<p class="ch-empty">Este cliente no tiene compras en el período.</p>';
    html += tableHtml('Ventas del cliente', 'sales', ['Fecha', 'Comprobante / ID', 'Total', 'Método de pago'], report.sales.map(function (sale) {
      return [dateLabel(sale.day), sale.reference, money(sale.total), paymentLabel(sale.method)];
    }), [2]);
    if (!report.products.length) return html + '<p class="ch-empty">Las ventas no tienen productos detallados.</p>';
    return html + tableHtml('Productos comprados', 'products', ['Producto', 'Cantidad', 'Importe'], report.products.map(function (product) {
      return [product.name, product.quantity.toLocaleString('es-PE', { maximumFractionDigits: 3 }), money(product.amount)];
    }), [1, 2]);
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() && permissions &&
      typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID) &&
      typeof permissions.featureLocked === 'function' && !permissions.featureLocked(FEATURE_ID));
  }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-ch-content]'), status = page.querySelector('[data-ch-status]');
    if (!content || !status) return false;
    var controls = page.querySelector('[data-ch-controls]'), search = page.querySelector('[data-ch-search]'), select = page.querySelector('[data-ch-customer]');
    var allowed = ownerAllowed();
    if (controls) controls.hidden = !allowed;
    content.replaceChildren();
    if (!allowed) {
      if (select) select.replaceChildren();
      if (search) search.value = '';
      status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false;
    }
    var customers = typeof clientes !== 'undefined' ? clientes : root.clientes;
    var matches = searchCustomers(customers, search ? search.value : ''), selected = select ? select.value : '';
    if (select) {
      select.replaceChildren();
      var placeholder = root.document.createElement('option'); placeholder.value = '';
      placeholder.textContent = matches.length ? 'Selecciona un cliente' : 'No se encontraron clientes'; select.appendChild(placeholder);
      matches.forEach(function (customer) {
        var option = root.document.createElement('option'); option.value = customer.id;
        option.textContent = customer.name + (customer.dni ? ' · ' + customer.dni : ''); select.appendChild(option);
      });
      select.value = matches.some(function (customer) { return customer.id === selected; }) ? selected : '';
      selected = select.value;
    }
    var period = page.querySelector('[data-ch-period]'), range = periodRange(period ? period.value : 30);
    status.textContent = (range.from ? dateLabel(range.from) + ' al ' + dateLabel(range.to) : 'Todo el historial hasta ' + dateLabel(range.to)) + ' · hora de Lima · ventas cargadas en este dispositivo';
    var customer = matches.find(function (item) { return item.id === selected; });
    if (!customer) { content.innerHTML = '<p class="ch-empty">Busca y selecciona un cliente para consultar sus compras.</p>'; return true; }
    var sales = typeof ventas !== 'undefined' ? ventas : root.ventas;
    content.innerHTML = reportHtml(buildReport(sales, customer.id, { days: range.days, now: range.to }), customer);
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naClienteHistorialBound) return;
    page.__naClienteHistorialBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    page.addEventListener('input', function (event) { if (event.target.matches('[data-ch-search]')) update(); });
    var refresh = page.querySelector('[data-ch-refresh]');
    if (refresh) refresh.addEventListener('click', update);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_CLIENTE_HISTORIAL = Object.freeze({ limaDay: limaDay, periodRange: periodRange, searchCustomers: searchCustomers,
    buildReport: buildReport, escapeHtml: escapeHtml, reportHtml: reportHtml, ownerAllowed: ownerAllowed, render: render, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
