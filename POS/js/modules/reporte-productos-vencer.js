/* Productos por vencer: consulta de los lotes ya cargados, sin reconstruir ni escribir estado. */
(function (root) {
  'use strict';
  var PAGE_ID = 'pageReporteProductosVencer', FEATURE_ID = 'reporte-productos-vencer';
  var DAY_MS = 86400000;
  function text(value) { return String(value == null ? '' : value); }
  function horizonRange(days, now) {
    var core = root.NA_STOCK_LOTS;
    var count = [30, 60, 90].indexOf(Number(days)) >= 0 ? Number(days) : 30;
    // Una fecha de lote es un día calendario; un instante se convierte al día de Lima.
    var today = core.validDate(now) ? now : core.businessDate(now === undefined ? undefined :
      typeof now === 'number' || now instanceof Date ? new Date(now).toISOString() : now);
    return { days: count, today: today, through: new Date(Date.parse(today) + count * DAY_MS).toISOString().slice(0, 10) };
  }
  function buildReport(products, options) {
    options = options || {};
    var core = root.NA_STOCK_LOTS, range = horizonRange(options.days, options.now);
    var readable = (Array.isArray(products) ? products : []).filter(function (product) { return product && typeof product === 'object'; }).map(function (product) {
      var lots;
      try { lots = core.lots(product); } catch (_) { lots = []; }
      // No sustituir ni sanear el registro original: solo una proyección para la consulta.
      return Object.assign({}, product, { lots: lots.filter(function (lot) {
        return lot && typeof lot === 'object' && typeof lot.quantity === 'number' && Number.isFinite(lot.quantity);
      }) });
    });
    var rows = core.report(readable, 'expired', range.today).concat(core.report(readable, range.days, range.today));
    rows = rows.map(function (row) {
      return Object.assign({}, row, { name: text(row.name) || 'Producto sin nombre', lot_code: text(row.lot_code), expired: row.days < 0 });
    });
    return { range: range, rows: rows, expired: rows.filter(function (row) { return row.expired; }).length };
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() && permissions &&
      typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID));
  }
  function available() {
    var permissions = root.NA_PERMISSIONS;
    return ownerAllowed() && !!(permissions && typeof permissions.featureLocked === 'function' && !permissions.featureLocked(FEATURE_ID));
  }
  function currentProducts() {
    var canonical = root.NuevoAmanecerCanonical, view = root.NuevoAmanecerCanonicalSaleView;
    if (canonical && typeof canonical.enabled === 'function' && canonical.enabled()) {
      // lastView() incluye lotes reservados y recibos ACK. rebuild()/currentProducts() cambian el runtime.
      var projected = view && typeof view.lastView === 'function' ? view.lastView() : null;
      if (projected && Array.isArray(projected.products)) return projected.products;
      var snapshot = typeof canonical.snapshot === 'function' ? canonical.snapshot() : null;
      return snapshot && Array.isArray(snapshot.products) ? snapshot.products : [];
    }
    return typeof productos !== 'undefined' ? productos : root.productos;
  }
  function currentReport(page) {
    var horizon = page.querySelector('[data-rpv-horizon]');
    return buildReport(currentProducts(), { days: horizon ? horizon.value : 30 });
  }
  function dateLabel(day) { return root.NA_STOCK_LOTS.displayDate(day); }
  function filterLabel(range) {
    return 'Filtro: próximos ' + range.days + ' días (' + dateLabel(range.today) + ' al ' + dateLabel(range.through) + ') + vencidos · día de Lima';
  }
  function csvCell(value) {
    var raw = text(value);
    // Números negativos son cantidades, pero todo texto con estos prefijos se protege.
    if (typeof value === 'string' && /^[=+@\t\r\n-]/.test(raw.replace(/^ +/, ''))) raw = "'" + raw;
    return /[",\r\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
  }
  function toCsv(report) {
    var lines = [[filterLabel(report.range)], ['Producto', 'Lote', 'Fecha vencimiento', 'Días restantes', 'Stock']];
    report.rows.forEach(function (row) { lines.push([row.name, row.lot_code, dateLabel(row.expiry_date), row.days, row.quantity]); });
    return '\uFEFF' + lines.map(function (line) { return line.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-rpv-content]'), status = page.querySelector('[data-rpv-status]');
    if (!content || !status) return false;
    var controls = page.querySelector('[data-rpv-controls]'), authorized = available();
    if (controls) controls.hidden = !authorized;
    content.replaceChildren();
    if (!authorized) { status.textContent = ownerAllowed() ? 'Función en preparación. Disponible cuando el dueño la habilite.' : 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var report;
    try { report = currentReport(page); }
    catch (_) { status.textContent = 'No se pudo leer los lotes cargados. Actualiza el reporte.'; return false; }
    status.textContent = filterLabel(report.range) + ' · ' + report.rows.length + ' lotes · ' + report.expired + ' vencidos';
    if (!report.rows.length) { content.appendChild(element('p', 'rpv-empty', 'No hay lotes con stock vencidos o por vencer en este horizonte.')); return true; }
    var section = element('section', 'rpv-results'), table = element('table', 'rpv-table');
    table.appendChild(element('caption', 'rpv-sr-only', 'Lotes vencidos primero, luego por fecha de vencimiento'));
    var head = element('thead'), headers = element('tr');
    ['Producto', 'Lote', 'Fecha vencimiento', 'Días restantes', 'Stock'].forEach(function (label, index) {
      var cell = element('th', index >= 3 ? 'rpv-num' : '', label); cell.scope = 'col'; headers.appendChild(cell);
    });
    head.appendChild(headers); table.appendChild(head);
    var body = element('tbody');
    report.rows.forEach(function (row) {
      var line = element('tr'); line.setAttribute('data-rpv-expired', String(row.expired));
      var name = element('th', 'rpv-product', row.name); name.scope = 'row'; line.appendChild(name);
      [['Lote', row.lot_code], ['Fecha vencimiento', dateLabel(row.expiry_date)],
        ['Días restantes', row.expired ? 'Vencido (' + row.days + ')' : row.days],
        ['Stock', row.quantity.toLocaleString('es-PE', { maximumFractionDigits: 9 })]].forEach(function (pair, index) {
        var cell = element('td', index >= 2 ? 'rpv-num' : '', pair[1]); cell.setAttribute('data-label', pair[0]); line.appendChild(cell);
      });
      body.appendChild(line);
    });
    table.appendChild(body); section.appendChild(table); content.appendChild(section); return true;
  }
  function exportCsv() {
    // Comprobar rol y bloqueo antes de leer lotes o crear el archivo.
    if (!available()) return false;
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var report = currentReport(page);
    var url = root.URL.createObjectURL(new root.Blob([toCsv(report)], { type: 'text/csv;charset=utf-8' }));
    var link = element('a'); link.href = url;
    link.download = 'productos-por-vencer-' + report.range.today + '-' + report.range.days + '-dias.csv';
    try { page.appendChild(link); link.click(); }
    finally { link.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000); }
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naReporteProductosVencerBound) return;
    page.__naReporteProductosVencerBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    var refresh = page.querySelector('[data-rpv-refresh]'), exportButton = page.querySelector('[data-rpv-export]');
    if (refresh) refresh.addEventListener('click', update);
    if (exportButton) exportButton.addEventListener('click', exportCsv);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!available()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'na:canonical-sale-receipt', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_REPORTE_PRODUCTOS_VENCER = Object.freeze({ buildReport: buildReport, horizonRange: horizonRange,
    toCsv: toCsv, csvCell: csvCell, ownerAllowed: ownerAllowed, render: render, exportCsv: exportCsv, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
