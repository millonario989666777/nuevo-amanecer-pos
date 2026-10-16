(function (root) {
  'use strict';

  // productos uses stock (physical units), costo and precio (soles per unit).
  // stock already includes batched, unbatched and expired units, plus any pending
  // projection. Never add NA_STOCK_LOTS.lots(product) quantities to it or replace
  // it with _canonicalRemoteStock: both would overstate projected inventory.
  function number(value, fallback) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value !== 'string' || !/[0-9]/.test(value)) return fallback;
    var str = value.trim().replace(/\s/g, '');
    // Same decimal conventions as the inventory's _naNumber helper.
    if (str.includes(',') && str.includes('.')) {
      str = str.lastIndexOf(',') > str.lastIndexOf('.') ? str.replace(/\./g, '').replace(',', '.') : str.replace(/,/g, '');
    } else if (str.includes(',')) str = str.replace(',', '.');
    var result = Number(str.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(result) ? result : fallback;
  }
  function amount(value, parse) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/[0-9]/.test(value))) return null;
    var result = parse(value, NaN);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }
  function categoryKey(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').trim();
  }
  function categoryTitle(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || 'Sin categoría';
  }
  function roundUnits(value) { return Math.round(value * 1e9) / 1e9; }
  function money(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
  function formatMoney(value) { return 'S/ ' + value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function formatUnits(value) { return value.toLocaleString('es-PE', { maximumFractionDigits: 9 }); }
  function emptyRow(key, label) {
    return { key: key, category: label, products: 0, units: 0, costValue: 0, saleValue: 0,
      noCostProducts: 0, noCostUnits: 0, noPriceProducts: 0, negativeStockProducts: 0,
      invalidStockProducts: 0, pendingStockProducts: 0 };
  }
  var fields = ['products', 'units', 'costValue', 'saleValue', 'noCostProducts', 'noCostUnits',
    'noPriceProducts', 'negativeStockProducts', 'invalidStockProducts', 'pendingStockProducts'];

  // Pure: options are read-only functions/catalog labels supplied by the caller.
  // Currency rounds once per category; totals sum the displayed category amounts.
  function calculate(products, options) {
    options = options || {};
    var parse = options.number || number, keyOf = options.categoryKey || categoryKey;
    var unitsRound = options.roundUnits || roundUnits;
    var tracked = options.tracksStock || function (p) { return p.controlInventario !== false; };
    var groups = new Map(), untrackedProducts = 0;
    (Array.isArray(products) ? products : []).forEach(function (p) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return;
      if (!tracked(p)) { untrackedProducts++; return; }
      var key = keyOf(p.cat), row = groups.get(key);
      if (!row) { row = emptyRow(key, options.categoryLabel ? options.categoryLabel(key) : categoryTitle(key)); groups.set(key, row); }
      var rawStock = amount(p.stock, parse), stock = rawStock === null ? 0 : rawStock;
      var signedStock = number(p.stock, NaN);
      if (Number.isFinite(signedStock) && signedStock < 0) row.negativeStockProducts++;
      else if (rawStock === null) row.invalidStockProducts++;
      row.products++;
      row.units = unitsRound(row.units + stock);
      if (p._canonicalPendingStock) row.pendingStockProducts++;
      var cost = amount(p.costo, parse), price = amount(p.precio, parse);
      if (cost === null) { row.noCostProducts++; row.noCostUnits = unitsRound(row.noCostUnits + stock); }
      else row.costValue += stock * cost;
      if (price === null) row.noPriceProducts++;
      else row.saleValue += stock * price;
    });
    var rows = Array.from(groups.values()).sort(function (a, b) { return a.category.localeCompare(b.category, 'es'); });
    var totals = emptyRow('', 'Total');
    rows.forEach(function (row) {
      row.costValue = money(row.costValue); row.saleValue = money(row.saleValue);
      fields.forEach(function (field) { totals[field] += row[field]; });
    });
    totals.units = unitsRound(totals.units); totals.noCostUnits = unitsRound(totals.noCostUnits);
    totals.costValue = money(totals.costValue); totals.saleValue = money(totals.saleValue);
    return { rows: rows, totals: totals, untrackedProducts: untrackedProducts };
  }

  function ownerAllowed() {
    return !!(root.NA_ROLES && typeof root.NA_ROLES.isOwner === 'function' && root.NA_ROLES.isOwner()
      && root.NA_PERMISSIONS && typeof root.NA_PERMISSIONS.canAccessScreen === 'function'
      && root.NA_PERMISSIONS.canAccessScreen('owner', 'pageValorizacion'));
  }
  function memoryOptions() {
    // _naCategoryLabel -> _naAllCategories -> _naCustomCategories MUTATES appConfig.
    // Build labels directly from the same catalogs, without calling that chain.
    var labels = new Map();
    var keyOf = typeof _naCategoryKey === 'function' ? _naCategoryKey : categoryKey;
    var base = typeof _naBaseCategories !== 'undefined' ? _naBaseCategories : [];
    var custom = typeof appConfig !== 'undefined' && Array.isArray(appConfig.customCategories) ? appConfig.customCategories : [];
    base.concat(custom).forEach(function (item) {
      var key = keyOf(typeof item === 'string' ? item : item && (item.value || item.label));
      if (key && !labels.has(key)) labels.set(key, typeof item === 'string' ? item : item.label || categoryTitle(key));
    });
    return {
      number: typeof _naNumber === 'function' ? _naNumber : number,
      tracksStock: typeof _naTracksStock === 'function' ? _naTracksStock : undefined,
      categoryKey: keyOf,
      categoryLabel: function (key) { return labels.get(key) || categoryTitle(key); },
      roundUnits: root.NA_STOCK_LOTS ? root.NA_STOCK_LOTS.round : roundUnits
    };
  }
  function element(tag, className, text) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function tableRow(data) {
    var row = element('tr'), title = element('th', '', data.category);
    title.scope = 'row'; row.appendChild(title);
    [formatUnits(data.units), formatMoney(data.costValue), formatMoney(data.saleValue),
      data.noCostProducts + ' producto(s) · ' + formatUnits(data.noCostUnits) + ' unidades'].forEach(function (text, index) {
      var cell = element('td', '', text);
      cell.setAttribute('data-label', ['Unidades', 'Valor al costo', 'Valor de venta', 'Sin costo'][index]);
      if (index === 1 && data.noCostProducts) cell.appendChild(element('small', '', 'Costo incompleto'));
      row.appendChild(cell);
    });
    return row;
  }
  function render() {
    var page = root.document && root.document.getElementById('pageValorizacion');
    var host = page && page.querySelector('[data-valorizacion-report]');
    if (!host) return false;
    if (!ownerAllowed()) { host.replaceChildren(element('p', 'val-notice', 'Sin permiso. Pídele acceso al dueño.')); return false; }
    // productos is a global lexical let, not necessarily window.productos.
    var products = typeof productos !== 'undefined' ? productos : root.productos;
    var report = calculate(products, memoryOptions()), totals = report.totals;
    var summary = element('div', 'val-summary');
    [['Unidades físicas', formatUnits(totals.units)],
      ['Valor al costo' + (totals.noCostProducts ? ' (incompleto)' : ''), formatMoney(totals.costValue)],
      ['Valor de venta', formatMoney(totals.saleValue)],
      ['Productos sin costo', String(totals.noCostProducts)]].forEach(function (item) {
      var card = element('div', 'val-card');
      card.appendChild(element('span', '', item[0])); card.appendChild(element('strong', '', item[1])); summary.appendChild(card);
    });
    var notices = element('div', 'val-notices');
    function notice(text) { notices.appendChild(element('p', 'val-notice', text)); }
    if (totals.noCostProducts) notice(totals.noCostProducts + ' producto(s) sin costo (' + formatUnits(totals.noCostUnits) + ' unidades). El valor al costo incluye únicamente costos conocidos.');
    if (totals.noPriceProducts) notice(totals.noPriceProducts + ' producto(s) sin precio válido. El valor de venta está incompleto.');
    if (totals.negativeStockProducts) notice(totals.negativeStockProducts + ' producto(s) con stock negativo: no suman unidades ni valor.');
    if (totals.invalidStockProducts) notice(totals.invalidStockProducts + ' producto(s) sin stock válido: no suman unidades ni valor.');
    if (report.untrackedProducts) notice(report.untrackedProducts + ' producto(s) sin control de inventario excluidos.');
    if (totals.pendingStockProducts) notice('Hay stock con ajustes pendientes. Se muestra el stock proyectado en memoria, igual que en Inventario.');
    var table = element('table', 'val-table');
    table.appendChild(element('caption', '', 'Valorización por categoría'));
    var head = element('thead'), header = element('tr');
    ['Categoría', 'Unidades', 'Valor al costo', 'Valor de venta', 'Sin costo'].forEach(function (label) {
      var cell = element('th', '', label); cell.scope = 'col'; header.appendChild(cell);
    });
    head.appendChild(header); table.appendChild(head);
    var body = element('tbody'); report.rows.forEach(function (row) { body.appendChild(tableRow(row)); });
    table.appendChild(body);
    var foot = element('tfoot'); foot.appendChild(tableRow(totals)); table.appendChild(foot);
    host.replaceChildren(summary, notices);
    if (!report.rows.length) host.appendChild(element('p', 'val-empty', 'Sin productos con control de inventario.'));
    host.appendChild(table);
    return true;
  }
  function init() {
    var page = root.document.getElementById('pageValorizacion');
    if (!page) return;
    var refresh = page.querySelector('[data-valorizacion-refresh]');
    if (refresh) refresh.addEventListener('click', render);
    function update() {
      if (!ownerAllowed() || page.classList.contains('active')) render();
    }
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    if (typeof root.addEventListener === 'function') root.addEventListener('na:role', update);
    update();
  }
  root.NA_VALORIZACION = Object.freeze({ calculate: calculate, formatMoney: formatMoney, formatUnits: formatUnits, render: render });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NA_VALORIZACION;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(globalThis);
