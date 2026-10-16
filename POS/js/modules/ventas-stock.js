/* Ventas con stock: proyección de solo lectura del catálogo y las ventas en memoria. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageVentasStock';
  var DAY_MS = 86400000;
  function text(value) { return String(value == null ? '' : value).trim(); }
  function number(value) { var n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
  function categoryKey(value) {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }
  // Same fecha || timestamp and unzoned -05:00 semantics as sales-reports (inline-05).
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
    var count = Number(days) === 7 ? 7 : Number(days) === 90 ? 90 : 30;
    var to = limaDay(now === undefined ? Date.now() : now);
    if (!to) throw new RangeError('Fecha de referencia inválida');
    var from = new Date(new Date(to + 'T00:00:00Z').getTime() - (count - 1) * DAY_MS);
    return { days: count, from: from.toISOString().slice(0, 10), to: to };
  }
  // Código visible: SKU o código de barras corto. Nunca el id interno (p. ej. 'GENERIC:…').
  function shortCode(item) {
    var generic = item.generic_line && typeof item.generic_line === 'object' ? item.generic_line.code : null;
    var candidates = [item.sku, item.barcode, item.codigo, item.codigoAlternativo, item.codigoIngresado, generic];
    for (var i = 0; i < candidates.length; i++) {
      var value = text(candidates[i]);
      if (value && value.length <= 24 && !/^generic:/i.test(value)) return value;
    }
    return '';
  }
  // Segunda línea para filas sin código: prefijo corto del id sin 'GENERIC:'.
  function visibleId(id) {
    var value = text(id).replace(/^generic:/i, '').replace(/[^0-9a-z-]/gi, '');
    return value ? 'ID ' + value.slice(0, 8) : '';
  }
  function identity(item) {
    var id = item.id != null ? item.id : item.productoId;
    if (id != null && text(id)) return { key: 'id:' + text(id), id: text(id) };
    if (text(item.sku)) return { key: 'sku:' + text(item.sku), id: text(item.sku) };
    var name = text(item.name != null ? item.name : item.nombre);
    return name ? { key: 'name:' + name, id: '' } : null;
  }
  var LABELS = { sin_stock: 'Sin stock', reponer: 'Reponer', sin_movimiento: 'Sin movimiento', ok: 'OK', sin_control: 'Sin control' };
  function normalized(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function buildReport(sales, products, options) {
    options = options || {};
    var range = periodRange(options.days, options.now), rows = new Map(), bySku = new Map();
    function createRow(item, ref, catalog) {
      var stock = catalog && item.stock != null && text(item.stock) !== '' && Number.isFinite(Number(item.stock)) ? Number(item.stock) : null;
      return { key: ref.key, id: ref.id, code: shortCode(item) || visibleId(ref.id),
        name: text(item.name != null ? item.name : item.nombre) || shortCode(item) || 'Producto sin nombre',
        category: categoryKey(item.cat || item.categoria), stock: stock, stockMin: catalog ? number(item.stockMin) : 0,
        unitsSold: 0, revenueRaw: 0, transactions: 0 };
    }
    (Array.isArray(products) ? products : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var ref = identity(item); if (!ref || rows.has(ref.key)) return;
      rows.set(ref.key, createRow(item, ref, true));
      if (text(item.sku)) bySku.set(text(item.sku), ref);
    });
    (Array.isArray(sales) ? sales : []).forEach(function (sale) {
      if (!sale || sale.anulada) return;
      var day = limaDay(sale.fecha || sale.timestamp);
      if (!day || day < range.from || day > range.to) return;
      var seen = new Set();
      (Array.isArray(sale.items) ? sale.items : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var ref = identity(item); if (!ref) return;
        if (ref.key.indexOf('id:') !== 0 && bySku.has(text(item.sku))) ref = bySku.get(text(item.sku));
        var qty = number(item.qty != null ? item.qty : item.cantidad);
        var revenue = number(item.precio != null ? item.precio : item.precioUnitario) * qty;
        if (qty <= 0 || !Number.isFinite(revenue)) return;
        if (!rows.has(ref.key)) rows.set(ref.key, createRow(item, ref, false));
        var row = rows.get(ref.key);
        if (!row.category) row.category = categoryKey(item.cat || item.categoria);
        row.unitsSold += qty; row.revenueRaw += revenue;
        if (!seen.has(ref.key)) { row.transactions++; seen.add(ref.key); }
      });
    });
    var categories = Array.from(new Set(Array.from(rows.values(), function (row) { return row.category; }))).sort();
    var query = normalized(options.query), category = options.category == null ? null : categoryKey(options.category);
    var threshold = options.lowCoverageDays === undefined ? 7 : number(options.lowCoverageDays);
    var priority = Object.keys(LABELS);
    var result = Array.from(rows.values()).filter(function (row) {
      return (category === null || row.category === category) && (!query || normalized(row.name + ' ' + row.code).includes(query));
    }).map(function (row) {
      row.revenueCents = Math.round(Number(row.revenueRaw.toFixed(2)) * 100); delete row.revenueRaw;
      row.avgDaily = row.unitsSold / range.days;
      row.coverageDays = row.stock > 0 && row.avgDaily > 0 ? row.stock / row.avgDaily : null;
      row.status = row.stock === null ? 'sin_control' : row.stock <= 0 && (row.unitsSold > 0 || row.stockMin > 0) ? 'sin_stock' :
        row.stock > 0 && ((row.coverageDays !== null && row.coverageDays < threshold) || (row.stockMin > 0 && row.stock <= row.stockMin)) ? 'reponer' :
        row.unitsSold === 0 ? 'sin_movimiento' : 'ok';
      return row;
    }).sort(function (a, b) {
      return priority.indexOf(a.status) - priority.indexOf(b.status) ||
        (a.coverageDays === null ? Infinity : a.coverageDays) - (b.coverageDays === null ? Infinity : b.coverageDays) ||
        b.unitsSold - a.unitsSold || a.name.localeCompare(b.name);
    });
    var counts = { sin_stock: 0, reponer: 0, sin_movimiento: 0, ok: 0, sin_control: 0 };
    result.forEach(function (row) { counts[row.status]++; });
    return { range: range, categories: categories, rows: result, counts: counts,
      unitsSold: result.reduce(function (sum, row) { return sum + row.unitsSold; }, 0),
      revenue: result.reduce(function (sum, row) { return sum + row.revenueCents; }, 0) / 100 };
  }
  function toCsv(report) {
    function cell(value) {
      var valueText = value == null ? '' : String(value);
      // Solo texto: un número negativo (stock -2) no es una fórmula y se exporta tal cual.
      if (typeof value === 'string' && /^[=+@\t\r-]/.test(valueText)) valueText = "'" + valueText;
      return /[",\r\n]/.test(valueText) ? '"' + valueText.replace(/"/g, '""') + '"' : valueText;
    }
    var lines = [['Producto', 'Código', 'Categoría', 'Unidades vendidas', 'Importe', 'Stock', 'Promedio diario', 'Días de cobertura', 'Estado']];
    report.rows.forEach(function (row) {
      lines.push([row.name, row.code, categoryLabel(row.category), row.unitsSold, (row.revenueCents / 100).toFixed(2), row.stock,
        Number(row.avgDaily.toFixed(2)), row.coverageDays === null ? null : Number(row.coverageDays.toFixed(1)), LABELS[row.status]]);
    });
    return '\uFEFF' + lines.map(function (line) { return line.map(cell).join(','); }).join('\r\n') + '\r\n';
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() &&
      permissions && typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID));
  }
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function categoryLabel(key) {
    if (!key) return 'Sin categoría';
    // _naCategoryLabel calls _naCustomCategories, which WRITES appConfig. Read labels instead.
    var config = typeof appConfig !== 'undefined' ? appConfig : root.appConfig;
    var base = typeof _naBaseCategories !== 'undefined' ? _naBaseCategories : [];
    var custom = config && Array.isArray(config.customCategories) ? config.customCategories : [];
    var match = base.concat(custom).find(function (cat) {
      return categoryKey(typeof cat === 'string' ? cat : cat && (cat.value || cat.label)) === key;
    });
    return match ? text(typeof match === 'string' ? match : match.label || match.value) : key.replace(/_/g, ' ').replace(/^./, function (letter) { return letter.toUpperCase(); });
  }
  function currentReport(page) {
    var period = page.querySelector('[data-vs-period]'), filter = page.querySelector('[data-vs-category]'), search = page.querySelector('[data-vs-search]');
    var sales = typeof ventas !== 'undefined' ? ventas : root.ventas;
    var products = typeof productos !== 'undefined' ? productos : root.productos;
    return buildReport(sales, products, { days: period ? period.value : 30,
      category: filter && filter.value !== '*' ? filter.value : null, query: search ? search.value : '' });
  }
  function decimal(value) { return value.toLocaleString('es-PE', { maximumFractionDigits: 1 }); }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-vs-content]'), status = page.querySelector('[data-vs-status]');
    if (!content || !status) return false;
    var authorized = ownerAllowed(), controls = page.querySelector('[data-vs-controls]');
    if (controls) controls.hidden = !authorized;
    content.replaceChildren();
    if (!authorized) { status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var report = currentReport(page), filter = page.querySelector('[data-vs-category]');
    if (filter) {
      var selected = filter.value;
      filter.replaceChildren();
      var all = element('option', '', 'Todas las categorías'); all.value = '*'; filter.appendChild(all);
      report.categories.forEach(function (cat) { var option = element('option', '', categoryLabel(cat)); option.value = cat; filter.appendChild(option); });
      filter.value = report.categories.indexOf(selected) >= 0 ? selected : '*';
      report = currentReport(page);
    }
    function dateLabel(day) { return day.split('-').reverse().join('/'); }
    status.textContent = dateLabel(report.range.from) + ' al ' + dateLabel(report.range.to) + ' · hora de Lima · ventas cargadas en este dispositivo';
    var summary = element('div', 'vs-summary');
    [['Unidades vendidas', decimal(report.unitsSold)], ['Sin stock', report.counts.sin_stock], ['Reponer', report.counts.reponer], ['Sin movimiento', report.counts.sin_movimiento]].forEach(function (pair) {
      var card = element('div', 'vs-summary-card'); card.appendChild(element('span', '', pair[0])); card.appendChild(element('strong', '', pair[1])); summary.appendChild(card);
    });
    content.appendChild(summary);
    if (!report.rows.length) { content.appendChild(element('p', 'vs-empty', 'No hay productos para mostrar.')); return true; }
    var table = element('table', 'vs-table'); table.appendChild(element('caption', 'vs-sr-only', 'Ventas con stock y cobertura'));
    var head = element('thead'), tr = element('tr');
    ['Producto', 'Estado', 'Vendidas', 'Stock', 'Prom./día', 'Cobertura'].forEach(function (label) { var th = element('th', '', label); th.scope = 'col'; tr.appendChild(th); });
    head.appendChild(tr); table.appendChild(head);
    var body = element('tbody');
    report.rows.forEach(function (row) {
      var line = element('tr'); line.setAttribute('data-vs-status', row.status);
      var name = element('th', 'vs-product', row.name); name.scope = 'row';
      if (row.code) name.appendChild(element('small', '', row.code)); line.appendChild(name);
      var badge = element('td'); badge.setAttribute('data-label', 'Estado');
      badge.appendChild(element('span', 'vs-badge vs-' + row.status, LABELS[row.status])); line.appendChild(badge);
      [['Vendidas', decimal(row.unitsSold)], ['Stock', row.stock === null ? 'Sin control' : decimal(row.stock)],
        ['Prom./día', decimal(row.avgDaily)], ['Cobertura', row.coverageDays === null ? '—' : decimal(row.coverageDays) + ' días']].forEach(function (pair) {
        var cell = element('td', 'vs-num', pair[1]); cell.setAttribute('data-label', pair[0]); line.appendChild(cell);
      });
      body.appendChild(line);
    });
    table.appendChild(body); content.appendChild(table); return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naVentasStockBound) return;
    page.__naVentasStockBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    page.addEventListener('input', update);
    var exportButton = page.querySelector('[data-vs-export]');
    if (exportButton) exportButton.addEventListener('click', function () {
      if (!ownerAllowed()) return;
      var report = currentReport(page);
      var url = root.URL.createObjectURL(new root.Blob([toCsv(report)], { type: 'text/csv;charset=utf-8' }));
      var link = element('a'); link.href = url;
      link.download = 'ventas-con-stock-' + report.range.from + '-a-' + report.range.to + '.csv';
      try { page.appendChild(link); link.click(); }
      finally { link.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000); }
    });
    var refresh = page.querySelector('[data-vs-refresh]');
    if (refresh) refresh.addEventListener('click', update);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_VENTAS_STOCK = Object.freeze({ buildReport: buildReport, toCsv: toCsv, ownerAllowed: ownerAllowed, render: render, init: init, periodRange: periodRange });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NA_VENTAS_STOCK;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
