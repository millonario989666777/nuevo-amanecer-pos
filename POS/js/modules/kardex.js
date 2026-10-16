/* Kardex: proyección de solo lectura de movimientos y ventas ya cargados. */
(function (root) {
  'use strict';
  var PAGE_ID = 'pageKardex', DAY_MS = 86400000, selectedId = '', lastReport = null;
  function text(value) { return String(value == null ? '' : value).trim(); }
  function numeric(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || text(value) === '') return null;
    var n = Number(value); return Number.isFinite(n) ? n : null;
  }
  function round(value) { return Math.round(value * 1000000) / 1000000; }
  function normalized(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function productId(product) { return text(product && (product.id != null ? product.id : product.product_id)); }
  function productName(product) { return text(product && (product.name || product.nombre)) || 'Producto sin nombre'; }
  function productCode(product) { return text(product.sku || product.barcode || product.codigo); }
  function searchProducts(products, query) {
    var words = normalized(query).split(/\s+/).filter(Boolean);
    return (Array.isArray(products) ? products : []).filter(function (p) {
      if (!p || !productId(p)) return false;
      var codes = p.alternateCodes || p.alternate_codes || [];
      if (typeof codes === 'string') { try { codes = JSON.parse(codes); } catch (_) { codes = [codes]; } }
      var haystack = normalized([productName(p), p.sku, p.barcode, p.codigo, p.codigoAlternativo].concat(Array.isArray(codes) ? codes : []).join(' '));
      return words.every(function (word) { return haystack.indexOf(word) >= 0; });
    }).slice().sort(function (a, b) { return productName(a).localeCompare(productName(b), 'es') || productId(a).localeCompare(productId(b)); });
  }
  function validDay(value) {
    var raw = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
    var date = new Date(raw + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : '';
  }
  function timestamp(value) {
    if (typeof value === 'number' || value instanceof Date) {
      var ms = new Date(value).getTime(); return Number.isFinite(ms) ? ms : null;
    }
    var raw = text(value).replace(' ', 'T');
    if (!validDay(raw.slice(0, 10))) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += 'T00:00:00';
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += '-05:00';
    var time = Date.parse(raw); return Number.isFinite(time) ? time : null;
  }
  function limaDay(value) {
    var ms = timestamp(value);
    return ms == null ? '' : new Date(ms - 5 * 3600000).toISOString().slice(0, 10);
  }
  function periodRange(now) {
    var to = limaDay(now === undefined ? Date.now() : now);
    if (!to) throw new RangeError('Fecha de referencia inválida');
    return { from: new Date(Date.parse(to + 'T00:00:00Z') - 29 * DAY_MS).toISOString().slice(0, 10), to: to };
  }
  function recordTime(record) {
    // fecha es el día de negocio local; timestamp conserva el orden dentro del día.
    if (record.fecha && !validDay(record.fecha)) return null;
    var ms = timestamp(record.created_at || record.timestamp || (record.fecha ? record.fecha + 'T' + (record.hora24 || '00:00:00') : ''));
    return ms == null ? null : { timestamp: ms, day: record.fecha || limaDay(ms) };
  }
  function movementKind(move) {
    var kind = text(move.movement_type || move.type).toUpperCase();
    if (kind === 'SALE_REVERSAL' || kind === 'ANULACION' || /^anulacion de venta\s/.test(normalized(move.reason))) return 'Anulación';
    if (kind === 'SALE' || kind === 'VENTA') return 'Venta';
    if (kind === 'ENTRADA' || kind === 'INGRESO' || kind === 'COMPRA') {
      return move.source === 'OCR_PURCHASE' || /^compra(?:\s|$)/.test(normalized(move.reason)) || kind === 'COMPRA' ? 'Compra' : 'Ingreso';
    }
    if (kind === 'SALIDA') return 'Salida';
    if (kind === 'ALTA') return 'Alta de producto';
    return kind === 'AJUSTE' || !kind ? 'Ajuste' : text(move.movement_type || move.type);
  }
  function movementDelta(move) {
    if (move.delta != null) return numeric(move.delta);
    // La réplica CANON exporta quantity CON signo, incluso para ajustes manuales.
    if (move.product_id != null || move.movement_source != null || move.canonical) return numeric(move.quantity);
    var before = numeric(move.before), after = numeric(move.after);
    if (before != null && after != null) return round(after - before);
    var qty = numeric(move.quantity), kind = movementKind(move);
    return qty == null ? null : (kind === 'Venta' || kind === 'Salida' ? -Math.abs(qty) : qty);
  }
  function buildLedger(product, movements, sales, options) {
    options = options || {};
    var defaults = periodRange(options.now), today = defaults.to;
    var from = options.from === undefined ? defaults.from : validDay(options.from);
    var to = options.to === undefined ? today : validDay(options.to);
    if (!from || !to || from > to || to > today) throw new RangeError('Elige un rango válido hasta hoy.');
    var stock = numeric(product && (product.stock != null ? product.stock : product.current_stock_quantity));
    var pid = productId(product), rows = [], seen = new Set(), representedSales = new Set(), skipped = 0;
    (Array.isArray(movements) ? movements : []).forEach(function (move, index) {
      if (!move || !pid || text(move.product_id != null ? move.product_id : move.productId) !== pid) return;
      var at = recordTime(move), delta = movementDelta(move), id = text(move.movement_id || move.movementId || move.id);
      if (!at || delta == null) { skipped++; return; }
      if (at.day > today || !delta || (id && seen.has(id))) return;
      if (id) seen.add(id);
      var kind = movementKind(move), saleId = text(move.sale_id || move.saleId || (kind === 'Venta' ? move.referenceId : ''));
      if (kind === 'Venta' && saleId) representedSales.add(saleId);
      rows.push({ id: id || 'movement:' + index, day: at.day, timestamp: at.timestamp, type: kind,
        reference: text(move.document || move.sale_id || move.saleId || (kind === 'Venta' || kind === 'Anulación' ? move.referenceId : '') || move.operation_id || move.operationId || move.referenceId) || 'Sin referencia',
        delta: round(delta), source: 'movement' });
    });
    // Solo se reconstruyen ventas sin un movimiento durable para este producto.
    // No se inventan devoluciones a partir de ventas anuladas.
    var seenSales = new Set();
    (Array.isArray(sales) ? sales : []).forEach(function (sale, index) {
      if (!sale || sale.anulada || normalized(sale.estado || sale.status) === 'anulada' || normalized(sale.status) === 'annulled') return;
      var id = text(sale.id != null ? sale.id : sale.sale_id), at = recordTime(sale);
      if (id && (representedSales.has(id) || seenSales.has(id))) return;
      if (id) seenSales.add(id);
      var units = 0;
      (Array.isArray(sale.items) ? sale.items : []).forEach(function (item) {
        if (!item || item.ventaLibre || item.controlInventario === false) return;
        var itemId = text(item.product_id != null ? item.product_id : item.productoId != null ? item.productoId : item.id);
        if (!pid || itemId !== pid) return;
        var qty = numeric(item.qty != null ? item.qty : item.cantidad != null ? item.cantidad : item.quantity);
        var factor = item.unitsPerQty == null ? 1 : numeric(item.unitsPerQty);
        if (qty > 0 && factor >= 1 && Number.isFinite(qty * factor)) units += qty * factor;
      });
      if (!units) return;
      if (!at) { skipped++; return; }
      if (at.day > today) return;
      rows.push({ id: 'sale:' + (id || index), day: at.day, timestamp: at.timestamp, type: 'Venta',
        reference: text(sale.document || sale.operation || id) || 'Sin referencia', delta: -round(units), source: 'sale' });
    });
    rows.sort(function (a, b) { return a.day.localeCompare(b.day) || a.timestamp - b.timestamp || a.id.localeCompare(b.id); });
    // Anclaje al stock actual: también resta los movimientos posteriores al filtro.
    var opening = stock == null ? null : round(stock - rows.filter(function (r) { return r.day >= from; }).reduce(function (sum, r) { return sum + r.delta; }, 0));
    var balance = opening, incoming = 0, outgoing = 0;
    var filtered = rows.filter(function (r) { return r.day >= from && r.day <= to; }).map(function (r) {
      if (balance != null) balance = round(balance + r.delta);
      var entry = Math.max(0, r.delta), exit = Math.max(0, -r.delta);
      incoming += entry; outgoing += exit;
      return Object.assign({}, r, { incoming: entry, outgoing: exit, balance: balance });
    });
    filtered.unshift({ id: 'opening', day: from, type: 'Saldo inicial', reference: 'Calculado desde stock e historial disponibles', incoming: 0, outgoing: 0, balance: opening });
    return { product: { id: pid, name: productName(product), code: product ? productCode(product) : '' },
      range: { from: from, to: to }, rows: filtered, opening: opening, closing: balance, currentStock: stock,
      incoming: round(incoming), outgoing: round(outgoing), skipped: skipped };
  }
  function toCsv(report) {
    function cell(value) {
      var raw = value == null ? '' : String(value);
      if (typeof value === 'string' && /^[=+@\t\r-]/.test(raw.replace(/^ +/, ''))) raw = "'" + raw;
      return /[",\r\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
    }
    var lines = [['Producto', 'Código', 'Fecha (Lima)', 'Movimiento', 'Documento / referencia', 'Entrada', 'Salida', 'Saldo']];
    report.rows.forEach(function (r) { lines.push([report.product.name, report.product.code, r.day, r.type, r.reference, r.incoming, r.outgoing, r.balance]); });
    return '\uFEFF' + lines.map(function (line) { return line.map(cell).join(','); }).join('\r\n') + '\r\n';
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() && permissions &&
      typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID));
  }
  function sources() {
    var api = root.NuevoAmanecerCanonical, cloud = api && typeof api.enabled === 'function' && api.enabled();
    var snap = cloud && typeof api.snapshot === 'function' ? api.snapshot() : {};
    return {
      products: typeof productos !== 'undefined' ? productos : root.productos,
      sales: typeof ventas !== 'undefined' ? ventas : root.ventas,
      movements: cloud ? (snap && snap.inventoryMovements) : (typeof inventoryMovements !== 'undefined' ? inventoryMovements : root.inventoryMovements)
    };
  }
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    // Todo texto del catálogo/documentos se inserta como texto, nunca como HTML.
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function quantity(value) { return value == null ? 'No disponible' : value.toLocaleString('es-PE', { maximumFractionDigits: 6 }); }
  function dayLabel(day) { return day.split('-').reverse().join('/'); }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-kardex-content]'), status = page.querySelector('[data-kardex-status]');
    var controls = page.querySelector('[data-kardex-controls]'), matches = page.querySelector('[data-kardex-products]');
    var search = page.querySelector('[data-kardex-search]'), from = page.querySelector('[data-kardex-from]'), to = page.querySelector('[data-kardex-to]');
    var exportButton = page.querySelector('[data-kardex-export]');
    content.replaceChildren(); matches.replaceChildren(); lastReport = null; exportButton.disabled = true;
    var allowed = ownerAllowed(); controls.hidden = !allowed;
    if (!allowed) { selectedId = ''; search.value = ''; status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var defaults = periodRange();
    if (!from.value) from.value = defaults.from;
    if (!to.value) to.value = defaults.to;
    from.max = to.max = defaults.to;
    var data = sources(), products = searchProducts(data.products, search.value);
    products.slice(0, 30).forEach(function (p) {
      var button = element('button', 'kardex-product'); button.type = 'button';
      button.setAttribute('data-product-id', productId(p)); button.setAttribute('aria-pressed', String(selectedId === productId(p)));
      button.appendChild(element('strong', '', productName(p))); button.appendChild(element('small', '', productCode(p)));
      button.addEventListener('click', function () { if (ownerAllowed()) selectedId = productId(p); render(); });
      matches.appendChild(button);
    });
    if (!products.length) matches.appendChild(element('p', 'kardex-note', 'No se encontraron productos.'));
    if (products.length > 30) matches.appendChild(element('p', 'kardex-note', 'Mostrando 30 de ' + products.length + ' productos. Afina la búsqueda por nombre o código.'));
    status.textContent = 'Elige un producto para consultar sus movimientos.';
    var product = (Array.isArray(data.products) ? data.products : []).find(function (p) { return productId(p) === selectedId; });
    if (!product) { selectedId = ''; return true; }
    if (product.controlInventario === false || product.tracks_inventory === false || product.tracks_inventory === 0) {
      status.textContent = 'Este producto no controla inventario.'; return true;
    }
    var report;
    try { report = buildLedger(product, data.movements, data.sales, { from: from.value, to: to.value }); }
    catch (_) { status.textContent = 'Elige un rango válido: desde no puede superar hasta, ni hasta superar hoy.'; return false; }
    lastReport = report; exportButton.disabled = false;
    status.textContent = dayLabel(report.range.from) + ' al ' + dayLabel(report.range.to) + ' · hora de Lima · historial cargado en este dispositivo';
    content.appendChild(element('h2', '', report.product.name));
    var summary = element('div', 'kardex-summary');
    [['Entradas del período', report.incoming], ['Salidas del período', report.outgoing], ['Saldo al cierre del período', report.closing], ['Stock actual', report.currentStock]].forEach(function (pair) {
      var card = element('div', 'kardex-summary-card'); card.appendChild(element('span', '', pair[0]));
      card.appendChild(element('strong', '', quantity(pair[1]))); summary.appendChild(card);
    });
    content.appendChild(summary);
    if (report.currentStock <= 0 && report.currentStock != null) content.appendChild(element('p', 'kardex-note', 'Sin stock'));
    if (report.currentStock == null) content.appendChild(element('p', 'kardex-note', 'Stock actual no disponible. No se pueden calcular saldos.'));
    if (product._canonicalPendingStock) content.appendChild(element('p', 'kardex-note', 'El stock incluye cambios pendientes, igual que Inventario. El saldo inicial los incluye.'));
    if (report.skipped) content.appendChild(element('p', 'kardex-note', report.skipped + ' registro(s) sin fecha o cantidad válida omitidos del detalle. El saldo inicial se calcula desde el stock disponible.'));
    if (report.rows.length === 1) content.appendChild(element('p', 'kardex-note', 'Sin movimientos registrados en el período.'));
    var table = element('table', 'kardex-table'), head = element('thead'), header = element('tr'), body = element('tbody');
    table.appendChild(element('caption', 'kardex-sr-only', 'Kardex de ' + report.product.name + ' · unidades físicas'));
    var labels = ['Fecha (Lima)', 'Movimiento', 'Documento / referencia', 'Entrada', 'Salida', 'Saldo'];
    labels.forEach(function (label) { var th = element('th', '', label); th.scope = 'col'; header.appendChild(th); }); head.appendChild(header);
    report.rows.forEach(function (r) {
      var line = element('tr'); line.setAttribute('data-kardex-row', r.id);
      [dayLabel(r.day), r.type, r.reference, quantity(r.incoming), quantity(r.outgoing), quantity(r.balance)].forEach(function (value, index) {
        var cell = element('td', index >= 3 ? 'kardex-num' : '', value); cell.setAttribute('data-label', labels[index]); line.appendChild(cell);
      }); body.appendChild(line);
    });
    table.appendChild(head); table.appendChild(body); content.appendChild(table);
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naKardexBound) return;
    page.__naKardexBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('input', update);
    // La búsqueda ya re-renderiza en «input»; su «change» (al perder foco) recrearía los botones
    // justo antes del clic sobre un producto y el clic se perdería.
    page.addEventListener('change', function (event) { if (event.target && event.target.matches && event.target.matches('[data-kardex-search]')) return; update(); });
    page.querySelector('[data-kardex-refresh]').addEventListener('click', update);
    page.querySelector('[data-kardex-export]').addEventListener('click', function () {
      if (!ownerAllowed() || !page.classList.contains('active')) return;
      render(); if (!lastReport) return;
      var url = root.URL.createObjectURL(new root.Blob([toCsv(lastReport)], { type: 'text/csv;charset=utf-8' }));
      var link = element('a'); link.href = url; link.download = 'kardex-' + lastReport.range.from + '-a-' + lastReport.range.to + '.csv';
      root.document.body.appendChild(link); link.click(); link.remove(); root.URL.revokeObjectURL(url);
    });
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_KARDEX = Object.freeze({ searchProducts: searchProducts, timestamp: timestamp, limaDay: limaDay, periodRange: periodRange,
    buildLedger: buildLedger, toCsv: toCsv, ownerAllowed: ownerAllowed, render: render, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  }
})(globalThis);
