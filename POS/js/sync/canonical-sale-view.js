(function (root) {
  'use strict';

  var VERSION = 1;
  var last = null;
  var confirmedReceipts = new Map();

  function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function sameId(a, b) { return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b); }
  function enabled(canonical) {
    return !!(canonical && typeof canonical.enabled === 'function' && canonical.enabled());
  }
  function validBase(base) {
    return !!(base && Array.isArray(base.products) && Array.isArray(base.customers) && Array.isArray(base.credits));
  }
  // canonical.snapshot() returns an empty placeholder until the first replica
  // (cache or remote) is published, and legacySnapshot() throws until then.
  // At boot this view's DOMContentLoaded hook runs before startPOS() finishes,
  // so treat "not loaded yet" as nothing to rebuild; na:canonical-updated
  // rebuilds once the replica is published.
  function replicaLoaded(canonical) {
    if (typeof canonical.sourceState !== 'function') return true;
    var state = canonical.sourceState();
    return !!(state && state.source && state.source !== 'none');
  }
  function failureCode(error) {
    return error && (error.code || error.message) || 'CANONICAL_VIEW_REBUILD_FAILED';
  }
  function projectionBase(snapshot) {
    return { products: snapshot.products, customers: snapshot.customers, credits: snapshot.credits, sales: Array.isArray(snapshot.sales) ? snapshot.sales : [] };
  }
  function clearPanel(id) {
    var panel = root.document && root.document.getElementById(id);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }
  function text(parent, tag, value, className) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    parent.appendChild(node);
    return node;
  }
  function section(targetId, id, title) {
    clearPanel(id);
    var target = root.document && root.document.getElementById(targetId);
    if (!target) return null;
    var panel = root.document.createElement('section');
    panel.id = id;
    panel.setAttribute('aria-label', title);
    panel.className = 'na-canonical-pending';
    text(panel, 'h3', title);
    target.appendChild(panel);
    return panel;
  }
  function confirmedOperationIds() { return new Set(Array.from(confirmedReceipts.keys())); }
  function confirmedSaleIds() {
    return new Set(Array.from(confirmedReceipts.values()).map(function (entry) { return String(entry.receipt.sale_id || entry.payload.sale_id || ''); }).filter(Boolean));
  }
  function acceptConfirmedReceipt(detail) {
    var payload = detail && detail.payload, receipt = detail && detail.receipt;
    if (!detail || detail.version !== 1 || detail.command !== 'sale.create' || !payload || !receipt) return false;
    if (payload.operation_id !== receipt.operation_id || payload.sale_id !== receipt.sale_id ||
        !payload.operation_id || !payload.sale_id || !Array.isArray(payload.items) || !payload.items.length ||
        !Number.isSafeInteger(payload.total_cents) || payload.total_cents <= 0 ||
        !['created','already_processed'].includes(String(receipt.status || ''))) return false;
    confirmedReceipts.set(String(payload.operation_id), { payload: copy(payload), receipt: copy(receipt) });
    return true;
  }
  function reconcileConfirmedReceipts(base) {
    var sales = base && Array.isArray(base.sales) ? base.sales : [];
    confirmedReceipts.forEach(function (_entry, operationId) {
      if (sales.some(function (sale) { return sale && String(sale.operation_id || '') === operationId; })) confirmedReceipts.delete(operationId);
    });
  }
  function localParts(value) {
    var raw = String(value || ''), parsed = raw ? new Date(raw) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) return { date:raw.slice(0,10), time:raw.slice(11,16), timestamp:raw || null };
    function pad(v) { return String(v).padStart(2,'0'); }
    return { date:parsed.getFullYear()+'-'+pad(parsed.getMonth()+1)+'-'+pad(parsed.getDate()), time:pad(parsed.getHours())+':'+pad(parsed.getMinutes()), timestamp:raw };
  }
  function confirmedLegacySale(entry, legacy) {
    var payload = entry.payload, when = localParts(payload.created_at);
    var products = legacy && Array.isArray(legacy.products) ? legacy.products : [];
    var customers = legacy && Array.isArray(legacy.customers) ? legacy.customers : [];
    var items = payload.items.map(function (row) {
      var generic = row.generic_line && typeof row.generic_line === 'object';
      var product = generic ? null : products.find(function (candidate) {
        return candidate && sameId(candidate.product_id !== undefined ? candidate.product_id : candidate.id, row.product_id);
      });
      var name = generic ? String(row.generic_line.name || 'VARIOS') : String(product && (product.name || product.nombre) || 'Producto');
      var code = generic ? String(row.generic_line.code || '') : String(product && (product.sku || product.barcode) || '');
      return {
        id:row.product_id, product_id:row.product_id, name:name, nombre:name, sku:code, barcode:code, codigoIngresado:code,
        icon:generic?'📋':String(product && (product.icon || product.icono) || '📦'),
        qty:Number(row.quantity), cantidad:Number(row.quantity),
        precio:Number(row.unit_price_cents)/100, precioUnitario:Number(row.unit_price_cents)/100,
        subtotal:Number(row.line_total_cents)/100,
        costo:generic?0:Number(product && product.costo || 0),
        ventaLibre:!!generic, tipoLinea:generic?'venta_libre':'producto',
        controlInventario:generic?false:(product ? product.controlInventario !== false : true),
        canonical:true
      };
    });
    var customer = customers.find(function (candidate) { return candidate && sameId(candidate.id !== undefined ? candidate.id : candidate.customer_id, payload.customer_id); });
    var payment = payload.payment || {}, breakdown = null;
    if (payload.payment_method === 'mixto') {
      breakdown = { efectivo:Number(payment.cash_cents||0)/100, digital:Number(payment.digital_cents||0)/100,
        digitalMethod:String(payment.digital_method||''), reference:String(payment.reference||'') };
    }
    return {
      id:payload.sale_id, sale_id:payload.sale_id, operation_id:payload.operation_id, operation:payload.operation_id,
      fecha:when.date, hora:when.time, hora24:when.time, timestamp:when.timestamp,
      total:Number(payload.total_cents)/100, metodo:payload.payment_method, metodoPago:payload.payment_method,
      estado:payload.payment_method==='credito'?'credito':'completada',
      paymentRef:String(payment.reference||''), paymentBreakdown:breakdown, anulada:false,
      clienteId:payload.customer_id||null, customer_id:payload.customer_id||null,
      clienteNombre:customer ? (customer.nombre || customer.name || String(payload.customer_id||'')) : (payload.customer_id ? String(payload.customer_id) : 'Consumidor final'),
      clienteDni:customer ? (customer.dni || customer.document || '') : '',
      cantidadLineas:items.length,
      unidadesFisicas:items.reduce(function (sum,item) { return sum + Number(item.qty||0); },0),
      items:items, canonical:true, canonicalReadOnly:true, canonicalReceiptProjection:true, source:'CANONICAL_RECEIPT'
    };
  }
  function applyConfirmedProductProjection(projected, pendingOperations) {
    if (!projected || !Array.isArray(projected.products)) return;
    confirmedReceipts.forEach(function (entry, operationId) {
      if (pendingOperations.has(operationId)) return;
      entry.payload.items.forEach(function (item) {
        if (item.generic_line) return;
        var product = projected.products.find(function (candidate) {
          return candidate && sameId(candidate.product_id !== undefined ? candidate.product_id : candidate.id, item.product_id);
        });
        if (!product || product.tracks_inventory === 0 || product.tracks_inventory === false || product.controlInventario === false) return;
        var current = product.projected_stock !== undefined ? product.projected_stock :
          (product.current_stock_quantity !== undefined ? product.current_stock_quantity : product.stock);
        if (typeof current !== 'number' || !Number.isFinite(current)) return;
        product.projected_stock = Math.max(0, current - Number(item.quantity || 0));
      });
    });
  }
  function applyConfirmedSalesRuntime(legacy) {
    var visualSales = copy(legacy && Array.isArray(legacy.sales) ? legacy.sales : []);
    var existing = new Set(visualSales.map(function (sale) { return String(sale && (sale.operation_id || sale.operation) || ''); }).filter(Boolean));
    confirmedReceipts.forEach(function (entry, operationId) {
      if (!existing.has(operationId)) visualSales.push(confirmedLegacySale(entry, legacy || {}));
    });
    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    if (runtime && typeof runtime.setSales === 'function') runtime.setSales(visualSales);
    else if (typeof ventas !== 'undefined') ventas = visualSales;
    else root.ventas = visualSales;
    return visualSales;
  }
  function renderSalesNow() {
    var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
    if (runtime && typeof runtime.renderSales === 'function') return runtime.renderSales();
    if (typeof root.ventasRender === 'function') return root.ventasRender();
  }

  function pendingDate(value) {
    // A credit due date is a calendar day, not a UTC instant.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
      var parts = String(value).split('-');
      return parts[2] + '/' + parts[1] + '/' + parts[0];
    }
    var date = new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return String(value || '');
    try {
      return new Intl.DateTimeFormat('es-PE', {
        timeZone: 'America/Lima', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true
      }).format(date);
    } catch (_) { return String(value || ''); }
  }
  function pendingAmount(cents) { return 'S/ ' + (Number(cents) / 100).toFixed(2); }
  function pendingCard(panel, title, amount, method, when, status) {
    var card = root.document.createElement('article');
    card.className = 'na-canonical-pending-item';
    var top = root.document.createElement('div');
    top.className = 'na-canonical-pending-item-top';
    text(top, 'strong', title);
    text(top, 'strong', pendingAmount(amount), 'na-canonical-pending-amount');
    card.appendChild(top);
    var detail = root.document.createElement('div');
    detail.className = 'na-canonical-pending-item-detail';
    text(detail, 'span', method);
    text(detail, 'time', pendingDate(when));
    card.appendChild(detail);
    text(card, 'p', status, 'na-canonical-pending-status');
    panel.appendChild(card);
    return card;
  }
  function pendingSales(view) {
    var confirmedOps = confirmedOperationIds(), confirmedSales = confirmedSaleIds();
    var sales = (view.sales || []).filter(function (sale) {
      return sale && (sale.status === 'PENDING_SYNC' || sale.source === 'CANONICAL_OUTBOX') &&
        !confirmedOps.has(String(sale.operation_id || '')) && !confirmedSales.has(String(sale.sale_id || sale.id || ''));
    });
    if (!sales.length) { clearPanel('naCanonicalPendingSales'); return; }
    var panel = section('ventasContent', 'naCanonicalPendingSales', 'Ventas pendientes');
    if (!panel) return;
    sales.forEach(function (sale) {
      var card = pendingCard(panel, String(sale.sale_id || sale.id || ''), sale.total_cents,
        sale.payment_method || '', sale.created_at, 'Pendiente de sincronización · guardada localmente');
      if (sale.conflict === true) text(card, 'p', 'Conflicto pendiente: ' + String(sale.reason || 'CONFLICT'), 'na-canonical-conflict');
    });
  }
  function pendingCredits(view) {
    var confirmedSales = confirmedSaleIds();
    var credits = (view.credits || []).filter(function (credit) {
      return credit && credit.source === 'CANONICAL_OUTBOX' && !confirmedSales.has(String(credit.sale_id || ''));
    });
    if (!credits.length) { clearPanel('naCanonicalPendingCredits'); return; }
    var panel = section('cliList', 'naCanonicalPendingCredits', 'Créditos pendientes');
    if (!panel) return;
    credits.forEach(function (credit) {
      pendingCard(panel, String(credit.sale_id || ''), credit.amount_cents,
        'Cliente: ' + String(credit.customer_id || ''), credit.due,
        'Crédito pendiente de sincronización');
    });
  }
  function rebuild() {
    var canonical = root.NuevoAmanecerCanonical;
    if (!enabled(canonical)) {
      clearPanel('naCanonicalPendingSales'); clearPanel('naCanonicalPendingCredits');
      return null;
    }
    try {
      var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
      var projector = root.NuevoAmanecerCanonicalSaleProjection;
      if (typeof canonical.snapshot !== 'function' || typeof canonical.legacySnapshot !== 'function' ||
          !outbox || typeof outbox.snapshot !== 'function' || !projector || typeof projector.project !== 'function') throw new Error('CANONICAL_VIEW_UNAVAILABLE');
      if (!replicaLoaded(canonical)) return null;
      var base = canonical.snapshot();
      reconcileConfirmedReceipts(base);
      var legacy = canonical.legacySnapshot();
      if (!validBase(base) || !legacy || !Array.isArray(legacy.products)) throw new Error('CANONICAL_VIEW_BASE_INVALID');
      var outboxSnapshot = outbox.snapshot();
      var projected = projector.project(projectionBase(base), outboxSnapshot);
      if (!projected || !Array.isArray(projected.products) || !Array.isArray(projected.sales) || !Array.isArray(projected.credits)) throw new Error('CANONICAL_VIEW_PROJECTION_INVALID');
      var pendingOperations = new Set((outboxSnapshot.intents || []).map(function (intent) { return String(intent && intent.operation_id || ''); }).filter(Boolean));
      applyConfirmedProductProjection(projected, pendingOperations);
      var visualProducts = copy(legacy.products);
      visualProducts.forEach(function (product) {
        if (!product) return;
        var id = product.product_id !== undefined ? product.product_id : product.id;
        var match = projected.products.find(function (candidate) {
          return candidate && (sameId(id, candidate.product_id) || sameId(id, candidate.id));
        });
        if (match && typeof match.projected_stock === 'number' && Number.isFinite(match.projected_stock)) {
          var remoteStock = Number(product.stock);
          product._canonicalRemoteStock = remoteStock;
          product._canonicalProjectedStock = match.projected_stock;
          product._canonicalPendingDelta = Math.max(0, remoteStock - match.projected_stock);
          product._canonicalPendingStock = product._canonicalPendingDelta > 0 || !!(outboxSnapshot.intents && outboxSnapshot.intents.length);
          // Availability uses projected stock; labels must show CANON + pending badge.
          product.stock = match.projected_stock;
        }
      });
      last = copy(projected);
      var runtime = root.NuevoAmanecerCanonicalUIAdapter && root.NuevoAmanecerCanonicalUIAdapter.runtime;
      if (runtime) runtime.setProducts(visualProducts);
      else if (typeof productos !== 'undefined') productos = visualProducts;
      else root.productos = visualProducts;
      applyConfirmedSalesRuntime(legacy);
      if (typeof root.posRender === 'function') root.posRender();
      if (typeof root.invRender === 'function') root.invRender();
      pendingSales(last);
      pendingCredits(last);
      return copy(last);
    } catch (error) {
      if (root.console && typeof root.console.error === 'function') root.console.error('[Vista de ventas canónicas]', failureCode(error));
      return null;
    }
  }
  function lastView() { return copy(last); }

  var api = Object.freeze({ VERSION: VERSION, rebuild: rebuild, lastView: lastView });
  root.NuevoAmanecerCanonicalSaleView = api;

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('na:canonical-sale-receipt', function (event) {
      if (!acceptConfirmedReceipt(event && event.detail)) return;
      rebuild();
      renderSalesNow();
    });
    root.addEventListener('na:canonical-sale-projection', rebuild);
    root.addEventListener('na:canonical-updated', rebuild);
    root.addEventListener('na:sales-rendered', function () { if (last) pendingSales(last); });
    root.addEventListener('na:clients-rendered', function () { if (last) pendingCredits(last); });
    root.addEventListener('storage', function (event) {
      var outbox = root.NuevoAmanecerCanonicalSaleOutbox;
      if (outbox && event && event.key === outbox.KEY) rebuild();
    });
  }
  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('DOMContentLoaded', function () {
      var canonical = root.NuevoAmanecerCanonical;
      if (!enabled(canonical) || typeof canonical.snapshot !== 'function' || !replicaLoaded(canonical)) return;
      try { if (validBase(canonical.snapshot())) rebuild(); }
      catch (error) {
        if (root.console && typeof root.console.error === 'function') root.console.error('[Vista de ventas canónicas]', failureCode(error));
      }
    });
  }
})(globalThis);
