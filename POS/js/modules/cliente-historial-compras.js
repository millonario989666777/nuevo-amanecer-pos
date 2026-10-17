/* Historial de compras por cliente: consulta de solo lectura de ventas y clientes locales. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageClienteHistorial';
  var FEATURE_ID = 'cliente-historial-compras';
  var DAY_MS = 86400000;
  var renderedReport = null;
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
  function dateRange(from, to) {
    from = validDay(text(from)); to = validDay(text(to));
    // Límites inclusivos; vacíos = sin límite. Desde no puede ser posterior a Hasta.
    return { from: from, to: to, invalid: !!(from && to && from > to) };
  }
  // «Período» es solo un atajo: llena Desde/Hasta. El filtro usa únicamente Desde/Hasta.
  function periodDates(value, now) {
    if (value === 'custom') return null;
    var range = periodRange(value, now);
    return range.days === 'all' ? { from: '', to: '' } : { from: range.from, to: range.to };
  }
  function periodFor(from, to, now) {
    from = text(from); to = text(to);
    var match = ['30', '90', '365', 'all'].find(function (value) { var d = periodDates(value, now); return d.from === from && d.to === to; });
    return match || 'custom';
  }
  function exportAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    var allowedRoles = permissions && permissions.FEATURE_ROLES && permissions.FEATURE_ROLES[FEATURE_ID];
    return !!(ownerAllowed() && roles && Array.isArray(allowedRoles) && allowedRoles.includes(roles.role));
  }
  function sellerName(value) { return text(value).replace(/\s+/g, ' ').toLocaleLowerCase('es'); }
  // Nombre (sin mayúsculas ni espacios extra) → id, solo si ese nombre tiene un único id en las ventas.
  function sellerIds(sales) {
    var ids = new Map();
    (Array.isArray(sales) ? sales : []).forEach(function (sale) {
      var id = text(sale && sale.cajeroId), name = sellerName(sale && (text(sale.cajeroNombre) || text(sale.cajero)));
      if (!id || !name) return;
      if (!ids.has(name)) ids.set(name, id); else if (ids.get(name) !== id) ids.set(name, null);
    });
    return ids;
  }
  function saleSeller(sale, ids) {
    var id = text(sale.cajeroId), label = text(sale.cajeroNombre) || text(sale.cajero), name = sellerName(label);
    if (!id && name && ids && ids.get(name)) id = ids.get(name);
    if (!id && name) label += ' (sin id)';
    return { value: id ? 'id:' + id : name ? 'name:' + name : 'missing:', label: label.replace(/\s+/g, ' ') || id || 'No registrado', hasId: !!text(sale.cajeroId) };
  }
  function customerSales(sales, selectedId) {
    var selected = text(selectedId);
    return (Array.isArray(sales) ? sales : []).filter(function (sale) {
      return sale && typeof sale === 'object' && !sale.anulada && !['anulada', 'anulado', 'void'].includes(normalized(sale.estado || sale.status)) &&
        selected && text(sale.clienteId != null ? sale.clienteId : sale.customer_id) === selected;
    });
  }
  function sellerOptions(sales, selectedId) {
    var sellers = new Map(), list = customerSales(sales, selectedId), ids = sellerIds(list);
    list.forEach(function (sale) {
      var seller = saleSeller(sale, ids), known = sellers.get(seller.value);
      // Preferir la etiqueta de una venta que trae id.
      if (!known || (!known.hasId && seller.hasId)) sellers.set(seller.value, seller);
    });
    return Array.from(sellers.values()).map(function (item) { return { value: item.value, label: item.label }; }).sort(function (a, b) { return a.label.localeCompare(b.label, 'es') || a.value.localeCompare(b.value); });
  }
  function filterSales(sales, selectedId, options) {
    options = options || {};
    var range = dateRange(options.from, options.to), seller = text(options.seller);
    if (range.invalid) return [];
    var list = customerSales(sales, selectedId), ids = sellerIds(list);
    return list.filter(function (sale) {
      var day = limaDay(sale.fecha || sale.timestamp);
      return day && (!range.from || day >= range.from) && (!range.to || day <= range.to) && (!seller || saleSeller(sale, ids).value === seller);
    });
  }
  function buildReport(sales, selectedId, options) {
    options = options || {};
    // Desde/Hasta son el ÚNICO filtro de fechas; «Período» solo las prellena.
    var range = dateRange(options.from, options.to);
    var rows = [], products = new Map(), totalCents = 0;
    // Nunca enlazar por nombre/DNI: dos clientes pueden tener el mismo nombre.
    filterSales(sales, selectedId, options).forEach(function (sale) {
      var day = limaDay(sale.fecha || sale.timestamp);
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
  function csvCell(value) {
    var raw = String(value == null ? '' : value);
    if (/^[=+@\t\r\n-]/.test(raw.replace(/^ +/, ''))) raw = "'" + raw;
    return '"' + raw.replace(/"/g, '""') + '"';
  }
  function toCsv(report, filters) {
    filters = filters || {};
    var rows = [['Cliente: ' + text(filters.cliente), 'Desde: ' + (filters.desde ? dateLabel(filters.desde) : 'sin límite'),
      'Hasta: ' + (filters.hasta ? dateLabel(filters.hasta) : 'sin límite'), 'Vendedor: ' + (text(filters.vendedor) || 'Todos')], ['Fecha', 'Comprobante / ID', 'Total', 'Método de pago']];
    report.sales.forEach(function (sale) { rows.push([dateLabel(sale.day), sale.reference, sale.total.toFixed(2), paymentLabel(sale.method)]); });
    rows.push([], ['Producto', 'Cantidad', 'Importe']);
    report.products.forEach(function (product) { rows.push([product.name, product.quantity, product.amount.toFixed(2)]); });
    return '\ufeff' + rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
  }
  function tableHtml(title, kind, labels, rows, numeric) {
    numeric = numeric || [];
    function cls(i) { return numeric.indexOf(i) >= 0 ? ' class="ch-num"' : ''; }
    return '<section class="ch-section"><h2>' + escapeHtml(title) + '</h2><table class="ch-table" data-ch-table="' + kind + '"><caption class="ch-sr-only">' + escapeHtml(title) + '</caption><thead><tr>' +
      labels.map(function (label) { return '<th scope="col"' + cls(labels.indexOf(label)) + '>' + escapeHtml(label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (row) { return '<tr>' + row.map(function (value, i) {
        if (i === 0 && kind === 'sales') return '<th scope="row"><span class="ch-date">' + escapeHtml(value) + '</span></th>';
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
    var seller = page.querySelector('[data-ch-seller]'), exportButton = page.querySelector('[data-ch-export]');
    renderedReport = null;
    if (exportButton) { exportButton.disabled = true; exportButton.hidden = !exportAllowed(); }
    var allowed = ownerAllowed();
    if (controls) controls.hidden = !allowed;
    content.replaceChildren();
    if (!allowed) {
      if (select) select.replaceChildren();
      if (seller) seller.replaceChildren();
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
    var period = page.querySelector('[data-ch-period]');
    var from = page.querySelector('[data-ch-from]'), to = page.querySelector('[data-ch-to]');
    // Primera vez: Desde/Hasta salen del Período elegido (por defecto, últimos 30 días de Lima).
    if (from && to && !page.dataset.chDatesInit) {
      page.dataset.chDatesInit = '1';
      var initial = periodDates(period && period.value !== 'custom' ? period.value : '30');
      if (!from.value && !to.value) { from.value = initial.from; to.value = initial.to; }
    }
    // Nunca se contradicen: el Período mostrado se deduce de las fechas.
    // «Personalizado» elegido a mano se respeta hasta que se editen las fechas.
    if (period && from && to) period.value = page.dataset.chCustomPeriod === '1' ? 'custom' : periodFor(from.value, to.value);
    var dateHint = page.querySelector('[data-ch-date-hint]');
    if (dateHint) dateHint.hidden = !period || period.value !== 'all';
    var dates = dateRange(from ? from.value : '', to ? to.value : '');
    if (from) from.setAttribute('aria-invalid', dates.invalid ? 'true' : 'false');
    if (to) to.setAttribute('aria-invalid', dates.invalid ? 'true' : 'false');
    if (status.classList) status.classList.toggle('ch-error', dates.invalid);
    status.textContent = (dates.from || dates.to ? 'Desde ' + (dates.from ? dateLabel(dates.from) : 'sin límite') + ' · Hasta ' + (dates.to ? dateLabel(dates.to) : 'sin límite') : 'Todo el historial') + ' · hora de Lima · ventas cargadas en este dispositivo';
    var sales = typeof ventas !== 'undefined' ? ventas : root.ventas;
    if (seller) {
      var selectedSeller = seller.value, sellers = sellerOptions(sales, selected);
      seller.innerHTML = '<option value="">Todos</option>' + sellers.map(function (item) {
        return '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</option>';
      }).join('');
      seller.value = sellers.some(function (item) { return item.value === selectedSeller; }) ? selectedSeller : '';
    }
    var customer = matches.find(function (item) { return item.id === selected; });
    if (dates.invalid) { status.textContent = '«Desde» no puede ser posterior a «Hasta». Corrige el rango de fechas.'; return true; }
    if (!customer) { content.innerHTML = '<p class="ch-empty">Busca y selecciona un cliente para consultar sus compras.</p>'; return true; }
    var sellerLabel = seller && seller.value ? (sellerOptions(sales, selected).find(function (item) { return item.value === seller.value; }) || {}).label : '';
    renderedReport = buildReport(sales, customer.id, { from: dates.from, to: dates.to, seller: seller ? seller.value : '' });
    renderedReport.filters = { cliente: customer.name || customer.nombre || customer.id, desde: dates.from, hasta: dates.to, vendedor: sellerLabel };
    content.innerHTML = reportHtml(renderedReport, customer);
    if (exportButton) exportButton.disabled = !exportAllowed();
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naClienteHistorialBound) return;
    page.__naClienteHistorialBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', function (event) {
      // Cambiar «Período» reinicia Desde/Hasta a ese período (Todo = sin límite).
      if (event && event.target && event.target.matches && event.target.matches('[data-ch-period]')) {
        var from = page.querySelector('[data-ch-from]'), to = page.querySelector('[data-ch-to]'), dates = periodDates(event.target.value);
        if (dates && from) from.value = dates.from;
        if (dates && to) to.value = dates.to;
        if (dates) delete page.dataset.chCustomPeriod;
        else { page.dataset.chCustomPeriod = '1'; if (from && typeof from.focus === 'function') from.focus(); }
      } else if (event && event.target && event.target.matches && event.target.matches('[data-ch-from], [data-ch-to]')) {
        delete page.dataset.chCustomPeriod;
      }
      update();
    });
    page.addEventListener('input', function (event) { if (event.target.matches('[data-ch-search]')) update(); });
    var refresh = page.querySelector('[data-ch-refresh]');
    if (refresh) refresh.addEventListener('click', update);
    var exportButton = page.querySelector('[data-ch-export]');
    if (exportButton) exportButton.addEventListener('click', exportCsv);
    function exportCsv() {
      // Guardia propia: no basta con ocultar el botón.
      if (!exportAllowed()) { render(); return false; }
      if (!render() || !renderedReport || !exportAllowed()) return false;
      var url = root.URL.createObjectURL(new root.Blob([toCsv(renderedReport, renderedReport.filters)], { type: 'text/csv;charset=utf-8' }));
      var link = root.document.createElement('a'); link.href = url; link.download = 'cliente-historial-compras.csv';
      try { page.appendChild(link); link.click(); }
      finally { link.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000); }
      return true;
    }
    page.__naClienteHistorialExport = exportCsv;
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_CLIENTE_HISTORIAL = Object.freeze({ limaDay: limaDay, periodRange: periodRange, searchCustomers: searchCustomers,
    dateRange: dateRange, sellerIds: sellerIds, periodDates: periodDates, periodFor: periodFor, exportAllowed: exportAllowed,
    exportCsv: function () { var page = root.document && root.document.getElementById(PAGE_ID); return !!(page && page.__naClienteHistorialExport && page.__naClienteHistorialExport()); }, saleSeller: saleSeller, sellerOptions: sellerOptions, filterSales: filterSales, csvCell: csvCell, toCsv: toCsv,
    buildReport: buildReport, escapeHtml: escapeHtml, reportHtml: reportHtml, ownerAllowed: ownerAllowed, render: render, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
