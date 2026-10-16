/* Rotación ABC: proyección de solo lectura del catálogo y las ventas en memoria. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageRotacionAbc';
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
    var count = Number(days) === 90 ? 90 : 30;
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
  // A closes at the first product reaching 80%; B closes at 95%. Thus a
  // dominant first product is A. Exact boundaries start the next class.
  function classify(rows) {
    var sorted = rows.slice().sort(function (a, b) {
      return b.revenueCents - a.revenueCents || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    var total = sorted.reduce(function (sum, row) { return sum + row.revenueCents; }, 0);
    var accumulated = 0;
    return sorted.map(function (row) {
      var abc = row.revenueCents <= 0 ? 'C' : accumulated * 100 < total * 80 ? 'A' : accumulated * 100 < total * 95 ? 'B' : 'C';
      accumulated += row.revenueCents;
      return Object.assign({}, row, {
        abc: abc, noSales: row.transactions === 0, revenue: row.revenueCents / 100,
        share: total ? row.revenueCents / total * 100 : 0,
        cumulative: total ? accumulated / total * 100 : 0
      });
    });
  }
  function buildReport(sales, products, options) {
    options = options || {};
    var range = periodRange(options.days, options.now);
    var catalog = new Map(), bySku = new Map(), rows = new Map();
    function createRow(item, ref) {
      var code = shortCode(item);
      var name = text(item.name != null ? item.name : item.nombre) || code || 'Producto sin nombre';
      // Toda fila sin código (VARIOS, PRÉSTAMO, VIVERES…) muestra un id corto visible, nunca 'GENERIC:'.
      if (!code) code = visibleId(ref.id);
      return { key: ref.key, id: ref.id, code: code, name: name,
        category: categoryKey(item.cat || item.categoria), revenueRaw: 0, transactions: 0 };
    }
    (Array.isArray(products) ? products : []).forEach(function (product) {
      if (!product || typeof product !== 'object') return;
      var ref = identity(product);
      if (!ref || catalog.has(ref.key)) return;
      catalog.set(ref.key, product);
      if (text(product.sku)) bySku.set(text(product.sku), ref);
      rows.set(ref.key, createRow(product, ref));
    });
    var transactions = 0;
    (Array.isArray(sales) ? sales : []).forEach(function (sale) {
      if (!sale || sale.anulada) return;
      var day = limaDay(sale.fecha || sale.timestamp);
      if (!day || day < range.from || day > range.to) return;
      transactions++;
      var seen = new Set();
      (Array.isArray(sale.items) ? sale.items : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var ref = identity(item);
        if (!ref) return;
        // SKU fallback only without a durable product id; never merge distinct ids by name.
        if (ref.key.indexOf('id:') !== 0 && bySku.has(text(item.sku))) ref = bySku.get(text(item.sku));
        var qty = number(item.qty != null ? item.qty : item.cantidad);
        var revenue = number(item.precio != null ? item.precio : item.precioUnitario) * qty;
        if (!Number.isFinite(revenue) || qty <= 0) return;
        if (!rows.has(ref.key)) rows.set(ref.key, createRow(item, ref));
        var row = rows.get(ref.key);
        // Current catalogue category keeps each known product in a single group.
        if (!row.category) row.category = categoryKey(item.cat || item.categoria);
        row.revenueRaw += revenue;
        if (!seen.has(ref.key)) { row.transactions++; seen.add(ref.key); }
      });
    });
    var groups = new Map();
    rows.forEach(function (row) {
      var projected = Object.assign({}, row, { revenueCents: Math.round(Number(row.revenueRaw.toFixed(2)) * 100) });
      delete projected.revenueRaw;
      if (!groups.has(row.category)) groups.set(row.category, []);
      groups.get(row.category).push(projected);
    });
    var categories = Array.from(groups.keys()).sort();
    var filter = options.category == null ? null : categoryKey(options.category);
    var result = categories.filter(function (cat) { return filter === null || cat === filter; }).map(function (cat) {
      var productsInCategory = classify(groups.get(cat));
      return { category: cat, rows: productsInCategory,
        revenueCents: productsInCategory.reduce(function (sum, row) { return sum + row.revenueCents; }, 0) };
    });
    var counts = { A: 0, B: 0, C: 0, noSales: 0 };
    result.forEach(function (group) { group.rows.forEach(function (row) { counts[row.abc]++; if (row.noSales) counts.noSales++; }); });
    return { range: range, categories: categories, groups: result, counts: counts, transactions: transactions,
      revenue: result.reduce(function (sum, group) { return sum + group.revenueCents; }, 0) / 100 };
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
  function money(value) { return 'S/ ' + value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function percent(value) { return value.toLocaleString('es-PE', { maximumFractionDigits: 1 }) + '%'; }
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
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-abc-content]');
    var status = page.querySelector('[data-abc-status]');
    if (!content || !status) return false;
    var authorized = ownerAllowed();
    var controls = page.querySelector('[data-abc-controls]');
    if (controls) controls.hidden = !authorized;
    content.replaceChildren();
    if (!authorized) { status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var period = page.querySelector('[data-abc-period]');
    var filter = page.querySelector('[data-abc-category]');
    var sales = typeof ventas !== 'undefined' ? ventas : root.ventas;
    var products = typeof productos !== 'undefined' ? productos : root.productos;
    var selected = filter ? filter.value : '*';
    var report = buildReport(sales, products, { days: period ? period.value : 30 });
    if (filter) {
      filter.replaceChildren();
      var all = element('option', '', 'Todas las categorías'); all.value = '*'; filter.appendChild(all);
      report.categories.forEach(function (cat) { var option = element('option', '', categoryLabel(cat)); option.value = cat; filter.appendChild(option); });
      filter.value = report.categories.indexOf(selected) >= 0 ? selected : '*';
      selected = filter.value;
    }
    if (selected !== '*') report = buildReport(sales, products, { days: report.range.days, now: report.range.to, category: selected });
    function dateLabel(day) { return day.split('-').reverse().join('/'); }
    status.textContent = dateLabel(report.range.from) + ' al ' + dateLabel(report.range.to) + ' · hora de Lima · ventas cargadas en este dispositivo';
    var summary = element('div', 'abc-summary');
    [['Importe vendido', money(report.revenue)], ['Clase A', report.counts.A], ['Clase B', report.counts.B], ['Clase C', report.counts.C]].forEach(function (pair) {
      var card = element('div', 'abc-summary-card'); card.appendChild(element('span', '', pair[0])); card.appendChild(element('strong', '', pair[1])); summary.appendChild(card);
    });
    content.appendChild(summary);
    if (!report.groups.length) { content.appendChild(element('p', 'abc-empty', 'No hay productos para mostrar.')); return true; }
    if (!report.revenue) content.appendChild(element('p', 'abc-empty', 'Sin importe vendido en el período. Los productos sin ventas son clase C.'));
    report.groups.forEach(function (group) {
      var section = element('section', 'abc-group'); section.setAttribute('aria-label', categoryLabel(group.category));
      section.appendChild(element('h2', '', categoryLabel(group.category)));
      section.appendChild(element('p', 'abc-group-note', group.rows.length + ' productos · ' + money(group.revenueCents / 100)));
      var table = element('table', 'abc-table');
      table.appendChild(element('caption', 'abc-sr-only', 'Clasificación ABC de ' + categoryLabel(group.category)));
      var head = element('thead'); var tr = element('tr');
      ['Producto', 'Clase', 'Importe', '% categoría', '% acumulado'].forEach(function (label) { var th = element('th', '', label); th.scope = 'col'; tr.appendChild(th); });
      head.appendChild(tr); table.appendChild(head);
      var body = element('tbody');
      group.rows.forEach(function (row) {
        var line = element('tr'); line.setAttribute('data-abc-class', row.abc);
        var name = element('th', 'abc-product', row.name); name.scope = 'row';
        if (row.code) name.appendChild(element('small', '', row.code));
        line.appendChild(name);
        var abc = element('td'); abc.setAttribute('data-label', 'Clase');
        abc.appendChild(element('span', 'abc-badge abc-' + row.abc.toLowerCase(), row.abc));
        if (row.noSales || !row.revenueCents) abc.appendChild(element('small', '', row.noSales ? 'sin ventas' : 'sin importe'));
        line.appendChild(abc);
        [['Importe', money(row.revenue)], ['% categoría', percent(row.share)], ['% acumulado', percent(row.cumulative)]].forEach(function (pair) {
          var cell = element('td', 'abc-num', pair[1]); cell.setAttribute('data-label', pair[0]); line.appendChild(cell);
        });
        body.appendChild(line);
      });
      table.appendChild(body); section.appendChild(table); content.appendChild(section);
    });
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naRotacionAbcBound) return;
    page.__naRotacionAbcBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    var refresh = page.querySelector('[data-abc-refresh]');
    if (refresh) refresh.addEventListener('click', update);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_ROTACION_ABC = Object.freeze({ limaDay: limaDay, periodRange: periodRange, buildReport: buildReport, ownerAllowed: ownerAllowed, render: render, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
