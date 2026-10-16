/* Kardex: proyección de solo lectura de movimientos y ventas ya cargados. */
(function (root) {
  'use strict';
  var PAGE_ID = 'pageKardex', DAY_MS = 86400000, selectedId = '', lastReport = null;
  var purchases = [], purchaseState = 'idle', purchaseTicket = 0, purchasesTruncated = false;
  function text(value) { return String(value == null ? '' : value).trim(); }
  function numeric(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || text(value) === '') return null;
    var n = Number(value); return Number.isFinite(n) ? n : null;
  }
  function round(value) { return Math.round(value * 1000000) / 1000000; }
  function normalized(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function productId(product) { return text(product && (product.id != null ? product.id : product.product_id)); }
  function productName(product) { return text(product && (product.name || product.nombre)) || 'Producto sin nombre'; }
  function productCode(product) { return text(product.sku) || text(product.barcode) || text(product.codigo); }
  function uniqueProducts(products) {
    var byId = new Map();
    function updated(p) { return timestamp(p.updated_at || p.updatedAt || p.modified_at || p.modifiedAt || p.created_at || p.createdAt); }
    function completeness(p) {
      return Object.keys(p).filter(function (key) { return p[key] != null && text(p[key]) !== ''; }).length;
    }
    (Array.isArray(products) ? products : []).forEach(function (p) {
      if (!p || !productId(p)) return;
      var id = productId(p), previous = byId.get(id);
      var at = updated(p), before = previous ? updated(previous) : null;
      var revision = numeric(p.metadata_revision != null ? p.metadata_revision : p.metadataRevision);
      var priorRevision = previous ? numeric(previous.metadata_revision != null ? previous.metadata_revision : previous.metadataRevision) : null;
      // Fecha/revisión más reciente; a igualdad, el registro más completo y luego el último cargado.
      var newer = at !== before ? (at != null && (before == null || at > before)) :
        revision !== priorRevision ? (revision != null && (priorRevision == null || revision > priorRevision)) :
        !previous || completeness(p) >= completeness(previous);
      if (!previous || newer) byId.set(id, p);
    });
    return Array.from(byId.values());
  }
  function searchProducts(products, query) {
    var words = normalized(query).split(/\s+/).filter(Boolean);
    return uniqueProducts(products).filter(function (p) {
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
  function unitCost(record) {
    var cents = numeric(record && record.unit_cost_cents);
    if (cents != null) return cents >= 0 && Number.isSafeInteger(cents) ? cents / 100 : null;
    var cost = numeric(record && (record.unitCost != null ? record.unitCost : record.costo));
    return cost != null && cost >= 0 ? cost : null;
  }
  function purchaseCosts(records, pid) {
    var costs = new Map();
    (Array.isArray(records) ? records : []).forEach(function (purchase) {
      if (!purchase || !purchase.purchase_id) return;
      (Array.isArray(purchase.lines) ? purchase.lines : []).forEach(function (line) {
        if (!line || text(line.product_id) !== pid || !Number.isSafeInteger(Number(line.line_number))) return;
        costs.set(text(purchase.purchase_id) + ':' + Number(line.line_number), unitCost(line));
      });
    });
    return costs;
  }
  function documentNumber(record) {
    if (!record) return '';
    function first(fields) {
      for (var i = 0; i < fields.length; i++) {
        var value = record[fields[i]];
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        value = text(value);
        if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
      }
      return '';
    }
    var number = first(['purchase_number', 'purchaseNumber', 'numeroCompra', 'receipt_number', 'receiptNumber',
      'ticket_number', 'ticketNumber', 'numeroTicket', 'document_number', 'documentNumber', 'numeroComprobante', 'numero_comprobante']);
    if (number) return number;
    var series = first(['serie', 'series', 'document_series', 'documentSeries']);
    var sequence = first(['correlativo', 'numero', 'number']);
    return (series && sequence ? series + '-' + sequence : '') || first(['document_ref', 'documentRef', 'document', 'comprobante', 'ticket']) || sequence;
  }
  function documentIndex(records, fields) {
    var byId = new Map();
    (Array.isArray(records) ? records : []).forEach(function (record) {
      var number = documentNumber(record);
      if (!number) return;
      fields.forEach(function (field) { var id = text(record[field]); if (id) byId.set(id, number); });
    });
    return byId;
  }
  function saleDocument(sale) {
    var number = documentNumber(sale), id = text(sale.id != null ? sale.id : sale.sale_id);
    // El ticket local usa el id V-000001; una operación UUID no debe ocultarlo.
    return number || documentNumber({ ticket: id }) || documentNumber({ ticket: sale.operation }) || id || text(sale.operation) || 'Sin referencia';
  }
  function movementDocument(move, kind, purchaseDocuments, saleDocuments) {
    var direct = documentNumber(move);
    if (direct) return direct;
    var saleId = text(move.sale_id || move.saleId || (kind === 'Venta' || kind === 'Anulación' ? move.referenceId : ''));
    if (saleDocuments.has(saleId)) return saleDocuments.get(saleId);
    var purchaseId = text(move.purchase_id || move.purchaseId);
    var operationId = text(move.operation_id || move.operationId || move.referenceId);
    var purchaseNumber = purchaseDocuments.get(purchaseId) || purchaseDocuments.get(operationId) || purchaseDocuments.get(operationId.replace(/:\d+$/, ''));
    return purchaseNumber || text(move.document || saleId || purchaseId || move.operation_id || move.operationId || move.referenceId) || 'Sin referencia';
  }
  // Solo las unidades con costo participan en el promedio. El stock inicial sin
  // historia de costo no se revaloriza usando el último costo del catálogo.
  function valueRows(rows, initialStock) {
    var average = null, valued = 0, balance = initialStock;
    return rows.map(function (row) {
      var entry = Math.max(0, row.delta), exit = Math.max(0, -row.delta);
      var cost = entry ? row.entryUnitCost : average, status = '';
      if (entry && cost == null) { cost = average; status = cost == null ? 'sin costo' : 'costo estimado'; }
      if (exit && cost == null) status = 'sin costo';
      if (entry && cost != null) {
        average = valued > 0 ? (valued * average + entry * cost) / (valued + entry) : cost;
        // Una entrada que cubre stock negativo no crea unidades en el saldo.
        valued += Math.max(0, entry + Math.min(0, balance == null ? 0 : balance));
      }
      if (exit) valued = Math.max(0, valued - exit);
      if (balance != null) balance = round(balance + row.delta);
      var value = cost == null ? null : (entry || exit) * cost;
      return Object.assign({}, row, { unitCost: cost, costStatus: status, averageCost: average,
        incomingValue: entry ? value : 0, outgoingValue: exit ? value : 0,
        balanceValue: balance == null ? null : valued * (average == null ? 0 : average),
        uncostedBalance: balance == null ? null : Math.max(0, round(balance - valued)) });
    });
  }
  function buildLedger(product, movements, sales, options) {
    options = options || {};
    var defaults = periodRange(options.now), today = defaults.to;
    var from = options.from === undefined ? defaults.from : validDay(options.from);
    var to = options.to === undefined ? today : validDay(options.to);
    if (!from || !to || from > to || to > today) throw new RangeError('Elige un rango válido hasta hoy.');
    var stock = numeric(product && (product.stock != null ? product.stock : product.current_stock_quantity));
    var pid = productId(product), rows = [], seen = new Set(), representedSales = new Set(), skipped = 0;
    var costs = purchaseCosts(options.purchases, pid);
    var purchaseDocuments = documentIndex(options.purchases, ['purchase_id', 'purchaseId', 'id', 'operation_id', 'operationId']);
    var saleDocuments = new Map();
    (Array.isArray(sales) ? sales : []).forEach(function (sale) {
      if (!sale) return;
      var number = saleDocument(sale);
      ['id', 'sale_id', 'saleId'].forEach(function (field) { var id = text(sale[field]); if (id) saleDocuments.set(id, number); });
    });
    (Array.isArray(movements) ? movements : []).forEach(function (move, index) {
      if (!move || !pid || text(move.product_id != null ? move.product_id : move.productId) !== pid) return;
      var at = recordTime(move), delta = movementDelta(move), id = text(move.movement_id || move.movementId || move.id);
      if (!at || delta == null) { skipped++; return; }
      if (at.day > today || !delta || (id && seen.has(id))) return;
      if (id) seen.add(id);
      var kind = movementKind(move), saleId = text(move.sale_id || move.saleId || (kind === 'Venta' ? move.referenceId : ''));
      if (kind === 'Venta' && saleId) representedSales.add(saleId);
      rows.push({ id: id || 'movement:' + index, day: at.day, timestamp: at.timestamp, type: kind,
        reference: movementDocument(move, kind, purchaseDocuments, saleDocuments),
        delta: round(delta), source: 'movement', entryUnitCost: costs.has(text(move.operation_id || move.operationId || move.referenceId))
          ? costs.get(text(move.operation_id || move.operationId || move.referenceId)) : unitCost(move) });
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
        reference: saleDocument(sale), delta: -round(units), source: 'sale' });
    });
    rows.sort(function (a, b) { return a.day.localeCompare(b.day) || a.timestamp - b.timestamp || a.id.localeCompare(b.id); });
    var initialStock = stock == null ? null : round(stock - rows.reduce(function (sum, r) { return sum + r.delta; }, 0));
    rows = valueRows(rows, initialStock);
    var prior = rows.filter(function (r) { return r.day < from; }).pop();
    var openingValue = prior ? prior.balanceValue : (stock == null ? null : 0);
    var openingUnknown = prior ? prior.uncostedBalance : (initialStock == null ? null : Math.max(0, initialStock));
    var lastPurchase = rows.filter(function (r) { return r.type === 'Compra' && r.delta > 0; }).pop();
    var lastSale = rows.filter(function (r) { return r.type === 'Venta'; }).pop();
    var lastCostRow = rows.filter(function (r) { return r.delta > 0 && r.entryUnitCost != null; }).pop();
    var catalogCents = numeric(product && product.cost_cents), catalogCost = numeric(product && product.costo);
    var lastCost = lastCostRow ? lastCostRow.entryUnitCost : catalogCents != null && catalogCents >= 0 ? catalogCents / 100 : catalogCost != null && catalogCost >= 0 ? catalogCost : null;
    // Anclaje al stock actual: también resta los movimientos posteriores al filtro.
    var opening = stock == null ? null : round(stock - rows.filter(function (r) { return r.day >= from; }).reduce(function (sum, r) { return sum + r.delta; }, 0));
    var balance = opening, incoming = 0, outgoing = 0;
    var filtered = rows.filter(function (r) { return r.day >= from && r.day <= to; }).map(function (r) {
      if (balance != null) balance = round(balance + r.delta);
      var entry = Math.max(0, r.delta), exit = Math.max(0, -r.delta);
      incoming += entry; outgoing += exit;
      return Object.assign({}, r, { incoming: entry, outgoing: exit, balance: balance });
    });
    var closingValue = filtered.length ? filtered[filtered.length - 1].balanceValue : openingValue;
    var closingUnknown = filtered.length ? filtered[filtered.length - 1].uncostedBalance : openingUnknown;
    var uncosted = filtered.filter(function (r) { return r.costStatus === 'sin costo'; }).length;
    filtered.unshift({ id: 'opening', day: from, type: 'Saldo inicial', reference: 'Calculado desde stock e historial disponibles', incoming: 0, outgoing: 0, balance: opening,
      incomingValue: 0, outgoingValue: 0, balanceValue: openingValue, uncostedBalance: openingUnknown,
      averageCost: prior ? prior.averageCost : null, unitCost: null, costStatus: '' });
    return { product: { id: pid, name: productName(product), code: product ? productCode(product) : '' },
      range: { from: from, to: to }, rows: filtered, opening: opening, closing: balance, currentStock: stock,
      incoming: round(incoming), outgoing: round(outgoing), skipped: skipped,
      openingValue: openingValue, closingValue: closingValue, uncostedBalance: closingUnknown, uncosted: uncosted,
      lastCost: lastCost, lastPurchase: lastPurchase ? lastPurchase.day : '', lastSale: lastSale ? lastSale.day : '' };
  }
  function toCsv(report) {
    function cell(value) {
      var raw = value == null ? '' : String(value);
      if (typeof value === 'string' && /^[=+@\t\r\n-]/.test(raw.replace(/^ +/, ''))) raw = "'" + raw;
      return /[",\r\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
    }
    var permitted = costsAllowed();
    var labels = ['Producto', 'Código', 'Fecha (Lima)', 'Movimiento', 'Documento / referencia', 'Entrada'];
    if (permitted) labels.push('Costo entrada (S/)');
    labels.push('Salida');
    if (permitted) labels.push('Costo salida (S/)');
    labels.push('Saldo');
    if (permitted) labels.push('Valor saldo (S/)', 'Costo unitario (S/)', 'Costo promedio (S/)', 'Observación costo', 'Último costo (S/)', 'Última compra', 'Última venta');
    var lines = [labels];
    function amount(value) { return value == null ? '' : value.toFixed(2); }
    report.rows.forEach(function (r) {
      var cells = [report.product.name, report.product.code, r.day, r.type, r.reference, r.incoming];
      if (permitted) cells.push(amount(r.incomingValue));
      cells.push(r.outgoing);
      if (permitted) cells.push(amount(r.outgoingValue));
      cells.push(r.balance);
      if (permitted) cells.push(amount(r.balanceValue), amount(r.unitCost), amount(r.averageCost), r.costStatus, amount(report.lastCost), report.lastPurchase, report.lastSale);
      lines.push(cells);
    });
    return '\uFEFF' + lines.map(function (line) { return line.map(cell).join(','); }).join('\r\n') + '\r\n';
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() && permissions &&
      typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen(roles.role, PAGE_ID));
  }
  function costsAllowed() {
    return !!(ownerAllowed() && typeof root.NA_PERMISSIONS.canDo === 'function' && root.NA_PERMISSIONS.canDo(root.NA_ROLES.role, 'purchases.costs.view'));
  }
  function discardPurchases() { purchaseTicket++; purchases = []; purchaseState = 'idle'; purchasesTruncated = false; }
  function renderPurchases() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    var heading = page && page.querySelector('[data-kardex-content] h2');
    var focused = heading && root.document.activeElement === heading;
    render();
    if (focused) {
      heading = page.querySelector('[data-kardex-content] h2');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
  }
  function loadPurchases() {
    if (!costsAllowed() || !selectedId || purchaseState !== 'idle') return;
    if (!root.NA_ROLES || typeof root.NA_ROLES.api !== 'function') { purchaseState = 'unavailable'; return; }
    purchaseState = 'loading'; var ticket = ++purchaseTicket;
    root.NA_ROLES.api('/auth/purchases', undefined, 'GET').then(function (result) {
      if (ticket !== purchaseTicket || !costsAllowed()) return;
      if (!result || !Array.isArray(result.purchases)) throw new Error('Respuesta no válida');
      purchases = result.purchases; purchasesTruncated = result.truncated === true || (result.truncated === undefined && purchases.length >= 300);
      purchaseState = result.ready === false ? 'unavailable' : 'loaded'; renderPurchases();
    }).catch(function () {
      if (ticket !== purchaseTicket || !costsAllowed()) return;
      purchases = []; purchaseState = 'unavailable'; renderPurchases();
    });
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
  function money(value) { return value == null ? 'sin costo' : 'S/ ' + value.toFixed(2); }
  function movementValue(row, incoming) {
    if (!(incoming ? row.incoming : row.outgoing)) return '—';
    return money(incoming ? row.incomingValue : row.outgoingValue) +
      (row.unitCost == null ? '' : ' · ' + money(row.unitCost) + '/u') +
      (row.costStatus && row.unitCost != null ? ' · ' + row.costStatus : '');
  }
  function dayLabel(day) { return day.split('-').reverse().join('/'); }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-kardex-content]'), status = page.querySelector('[data-kardex-status]');
    var controls = page.querySelector('[data-kardex-controls]'), matches = page.querySelector('[data-kardex-products]');
    var search = page.querySelector('[data-kardex-search]'), from = page.querySelector('[data-kardex-from]'), to = page.querySelector('[data-kardex-to]');
    var exportButton = page.querySelector('[data-kardex-export]');
    content.replaceChildren(); matches.replaceChildren(); lastReport = null; exportButton.disabled = true;
    var costMethod = page.querySelector('[data-kardex-cost-method]');
    if (costMethod) costMethod.hidden = true;
    var allowed = ownerAllowed(); controls.hidden = !allowed;
    if (!allowed) { discardPurchases(); selectedId = ''; search.value = ''; status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var showCosts = costsAllowed();
    if (costMethod) costMethod.hidden = !showCosts;
    if (!showCosts) discardPurchases();
    var defaults = periodRange();
    if (!from.value) from.value = defaults.from;
    if (!to.value) to.value = defaults.to;
    from.max = to.max = defaults.to;
    var data = sources(), catalog = uniqueProducts(data.products), products = searchProducts(catalog, search.value);
    products.slice(0, 30).forEach(function (p) {
      var button = element('button', 'kardex-product'); button.type = 'button';
      button.setAttribute('data-product-id', productId(p)); button.setAttribute('aria-pressed', String(selectedId === productId(p)));
      var shortId = productId(p).slice(0, 6);
      if (catalog.some(function (other) { return productId(other) !== productId(p) && productId(other).slice(0, 6) === shortId; })) shortId = productId(p);
      button.appendChild(element('strong', '', productName(p))); button.appendChild(element('small', '', productCode(p) || 'ID ' + shortId));
      button.addEventListener('click', function () {
        if (ownerAllowed()) selectedId = productId(p);
        render();
        // El botón pulsado se recrea al renderizar: llevar el foco al encabezado del kardex (o a la búsqueda).
        var heading = page.querySelector('[data-kardex-content] h2');
        if (heading && typeof heading.focus === 'function') { heading.tabIndex = -1; heading.focus(); } else if (search && typeof search.focus === 'function') search.focus();
      });
      matches.appendChild(button);
    });
    if (!products.length) matches.appendChild(element('p', 'kardex-note', 'No se encontraron productos.'));
    if (products.length > 30) matches.appendChild(element('p', 'kardex-note', 'Mostrando 30 de ' + products.length + ' productos. Afina la búsqueda por nombre o código.'));
    status.textContent = 'Elige un producto para consultar sus movimientos.';
    var product = catalog.find(function (p) { return productId(p) === selectedId; });
    if (!product) { selectedId = ''; return true; }
    if (product.controlInventario === false || product.tracks_inventory === false || product.tracks_inventory === 0) {
      status.textContent = 'Este producto no controla inventario.'; return true;
    }
    loadPurchases();
    var report;
    try { report = buildLedger(product, data.movements, data.sales, { from: from.value, to: to.value, purchases: showCosts ? purchases : [] }); }
    catch (_) { status.textContent = 'Elige un rango válido: desde no puede superar hasta, ni hasta superar hoy.'; return false; }
    lastReport = report; exportButton.disabled = showCosts && purchaseState === 'loading';
    status.textContent = dayLabel(report.range.from) + ' al ' + dayLabel(report.range.to) + ' · hora de Lima · historial cargado en este dispositivo';
    content.appendChild(element('h2', '', report.product.name));
    var summary = element('div', 'kardex-summary');
    [['Entradas del período', report.incoming], ['Salidas del período', report.outgoing], ['Saldo al cierre del período', report.closing], ['Stock actual', report.currentStock]].forEach(function (pair) {
      var card = element('div', 'kardex-summary-card'); card.appendChild(element('span', '', pair[0]));
      card.appendChild(element('strong', '', quantity(pair[1]))); summary.appendChild(card);
    });
    content.appendChild(summary);
    if (showCosts) {
      var details = element('div', 'kardex-summary'); details.setAttribute('data-kardex-cost-summary', '');
      [['Valor del saldo al cierre', money(report.closingValue)], ['Último costo del producto', money(report.lastCost)],
        ['Última compra registrada', report.lastPurchase ? dayLabel(report.lastPurchase) : 'Sin compras registradas'],
        ['Última venta registrada', report.lastSale ? dayLabel(report.lastSale) : 'Sin ventas registradas']].forEach(function (pair) {
        var card = element('div', 'kardex-summary-card'); card.appendChild(element('span', '', pair[0]));
        card.appendChild(element('strong', '', pair[1])); details.appendChild(card);
      });
      content.appendChild(details);
      if (purchaseState === 'loading') content.appendChild(element('p', 'kardex-note', 'Consultando costos de compras…'));
      if (purchaseState === 'unavailable') content.appendChild(element('p', 'kardex-note', 'Costos de compras no disponibles. Se usan los costos del historial cargado; pulsa Actualizar Kardex para reintentar.'));
      if (purchasesTruncated) content.appendChild(element('p', 'kardex-note', 'La consulta contiene las últimas 300 compras y las incompletas. Las entradas anteriores sin costo registrado pueden usar costo estimado.'));
    }
    if (report.currentStock <= 0 && report.currentStock != null) content.appendChild(element('p', 'kardex-note', 'Sin stock'));
    if (report.currentStock == null) content.appendChild(element('p', 'kardex-note', 'Stock actual no disponible. No se pueden calcular saldos.'));
    if (product._canonicalPendingStock) content.appendChild(element('p', 'kardex-note', 'El stock incluye cambios pendientes, igual que Inventario. El saldo inicial los incluye.'));
    if (report.skipped) content.appendChild(element('p', 'kardex-note', report.skipped + ' registro(s) sin fecha o cantidad válida omitidos del detalle. El saldo inicial se calcula desde el stock disponible.'));
    if (report.rows.length === 1) content.appendChild(element('p', 'kardex-note', 'Sin movimientos registrados en el período.'));
    var table = element('table', 'kardex-table'), head = element('thead'), header = element('tr'), body = element('tbody');
    table.appendChild(element('caption', 'kardex-sr-only', 'Kardex de ' + report.product.name + ' · unidades físicas'));
    var labels = ['Fecha (Lima)', 'Movimiento', 'Documento / referencia', 'Entrada'];
    if (showCosts) labels.push('Costo entrada');
    labels.push('Salida');
    if (showCosts) labels.push('Costo salida');
    labels.push('Saldo');
    if (showCosts) labels.push('Valor saldo');
    labels.forEach(function (label, index) { var th = element('th', index >= 3 ? 'kardex-num' : '', label); th.scope = 'col'; header.appendChild(th); }); head.appendChild(header);
    report.rows.forEach(function (r) {
      var line = element('tr'); line.setAttribute('data-kardex-row', r.id);
      var values = [dayLabel(r.day), r.type, r.reference, quantity(r.incoming)];
      if (showCosts) values.push(movementValue(r, true));
      values.push(quantity(r.outgoing));
      if (showCosts) values.push(movementValue(r, false));
      values.push(quantity(r.balance));
      if (showCosts) values.push(money(r.balanceValue) + (r.uncostedBalance > 0 ? ' · ' + quantity(r.uncostedBalance) + ' u sin costo' : ''));
      values.forEach(function (value, index) {
        var cell = element('td', index >= 3 ? 'kardex-num' : '', value); cell.setAttribute('data-label', labels[index]); line.appendChild(cell);
      }); body.appendChild(line);
    });
    table.appendChild(head); table.appendChild(body);
    var tableWrap = element('div', 'kardex-table-wrap'); tableWrap.tabIndex = 0;
    tableWrap.setAttribute('role', 'region'); tableWrap.setAttribute('aria-label', 'Detalle de movimientos del Kardex');
    tableWrap.appendChild(table); content.appendChild(tableWrap);
    if (showCosts) {
      var footer = element('p', 'kardex-note', report.uncosted + ' sin costo · movimientos del período sin promedio disponible.');
      footer.setAttribute('data-kardex-cost-footer', ''); content.appendChild(footer);
    }
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
    page.querySelector('[data-kardex-refresh]').addEventListener('click', function () { discardPurchases(); update(); });
    page.querySelector('[data-kardex-export]').addEventListener('click', function () {
      if (!ownerAllowed() || !page.classList.contains('active')) return;
      render(); if (!lastReport || page.querySelector('[data-kardex-export]').disabled) return;
      var url = root.URL.createObjectURL(new root.Blob([toCsv(lastReport)], { type: 'text/csv;charset=utf-8' }));
      var link = element('a'); link.href = url; link.download = 'kardex-' + lastReport.range.from + '-a-' + lastReport.range.to + '.csv';
      root.document.body.appendChild(link); link.click(); link.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000);
    });
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { discardPurchases(); if (!ownerAllowed()) render(); else update(); });
    root.addEventListener('na:canonical-updated', function () { discardPurchases(); update(); });
    ['na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_KARDEX = Object.freeze({ searchProducts: searchProducts, timestamp: timestamp, limaDay: limaDay, periodRange: periodRange,
    buildLedger: buildLedger, toCsv: toCsv, ownerAllowed: ownerAllowed, costsAllowed: costsAllowed, render: render, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  }
})(globalThis);
