/* Historial por producto: consulta compras y movimientos ya registrados.
 * No llama comandos, refresh de CANON, persistencia ni reconciliación del outbox.
 * GET /auth/purchases es la misma consulta que usa el historial de Compras.
 * La pantalla exige owner; la ruta existente también permite leer al empleado.
 */
(function (root) {
  'use strict';
  var READ_PATH = '/auth/purchases';
  // El servidor devuelve como máximo las 300 compras más recientes (más las incompletas).
  var PURCHASE_LIMIT = 300;
  // Avisa solo si el servidor cortó la lista. Con `truncated` (worker nuevo) manda el flag;
  // sin él (worker anterior) se cuentan solo las compras no incompletas: las «en_curso»
  // se agregan aparte del límite de 300 y no prueban que haya corte.
  function limitReached(purchases, truncated) {
    if (typeof truncated === 'boolean') return truncated;
    if (!Array.isArray(purchases)) return false;
    return purchases.filter(function (p) { return p && p.status !== 'en_curso'; }).length >= PURCHASE_LIMIT;
  }
  function text(value) { return value == null ? '' : String(value); }
  function normalize(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
  function productId(product) { return text(product && (product.id != null ? product.id : product.product_id)); }
  function productName(product) { return text(product && (product.nombre || product.name)) || productId(product); }
  function searchProducts(products, query) {
    var words = normalize(query).split(/\s+/).filter(Boolean);
    return (Array.isArray(products) ? products : []).filter(function (p) {
      if (!p || !productId(p)) return false;
      var codes = p.alternateCodes || p.alternate_codes || [];
      if (typeof codes === 'string') { try { codes = JSON.parse(codes); } catch (_) { codes = [codes]; } }
      var haystack = normalize([productName(p), productId(p), p.sku, p.codigo, p.barcode].concat(Array.isArray(codes) ? codes : []).join(' '));
      return words.every(function (word) { return haystack.indexOf(word) !== -1; });
    }).slice().sort(function (a, b) { return productName(a).localeCompare(productName(b), 'es') || productId(a).localeCompare(productId(b)); });
  }
  // Los timestamps sin zona representan hora de Lima; nunca la zona del dispositivo.
  function timestamp(value) {
    var raw = text(value).trim().replace(' ', 'T');
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += 'T00:00:00';
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += '-05:00';
    var ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  function limaLabel(value) {
    var ms = typeof value === 'number' ? value : timestamp(value);
    if (ms == null || !Number.isFinite(ms)) return 'Fecha no registrada';
    var d = new Date(ms - 5 * 60 * 60 * 1000);
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function quantity(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || text(value).trim() === '') return null;
    var n = Number(value); return Number.isFinite(n) && n > 0 ? n : null;
  }
  function cost(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || text(value).trim() === '') return null;
    var n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function operationId(move) {
    return text(move && (move.operation_id || move.operationId || (move.source === 'OCR_PURCHASE' ? move.referenceId : '')));
  }
  function purchaseMovement(move) {
    if (!move || text(move.movement_type || move.type).toUpperCase() !== 'ENTRADA') return false;
    return move.source === 'OCR_PURCHASE' || /^compra(?:\s|$)/.test(normalize(move.reason));
  }
  function row(id, at, supplier, qty, cents, source) {
    var total = cents == null ? null : Math.round(qty * cents);
    if (total != null && !Number.isSafeInteger(total)) { cents = null; total = null; }
    return { id: id, timestamp: timestamp(at), supplier: text(supplier).trim() || 'Sin proveedor registrado', quantity: qty, unitCostCents: cents, totalCents: total, source: source };
  }
  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      if (a.timestamp == null && b.timestamp != null) return 1;
      if (b.timestamp == null && a.timestamp != null) return -1;
      return (b.timestamp == null ? 0 : b.timestamp) - (a.timestamp == null ? 0 : a.timestamp) || a.id.localeCompare(b.id);
    });
  }
  // Conserva cada línea (p. ej. distintos lotes/costos del mismo producto).
  // Una compra parcial solo cuenta si el movimiento confirma su línea aplicada.
  function buildHistory(purchases, movements, selectedId) {
    var pid = text(selectedId), rows = [], seen = new Set(), registered = new Set(), applied = new Set(), excludedLines = 0;
    movements = Array.isArray(movements) ? movements : [];
    movements.forEach(function (m) {
      if (purchaseMovement(m) && quantity(m.quantity != null ? m.quantity : m.delta) != null) {
        var op = operationId(m);
        if (op) applied.add(JSON.stringify([op, text(m.product_id != null ? m.product_id : m.productId)]));
      }
    });
    (Array.isArray(purchases) ? purchases : []).forEach(function (p) {
      if (!p || !p.purchase_id) return;
      (Array.isArray(p.lines) ? p.lines : []).forEach(function (line) {
        if (!line || cost(line.line_number) == null) return;
        var linePid = text(line.product_id), op = text(p.purchase_id) + ':' + Number(line.line_number);
        var key = JSON.stringify([op, linePid]); registered.add(key);
        if (linePid !== pid || seen.has(key)) return;
        var qty = quantity(line.quantity); if (qty == null) return;
        if (p.status !== 'aplicada' && !applied.has(key)) { excludedLines++; return; }
        seen.add(key);
        rows.push(row(op, p.created_at, p.supplier, qty, cost(line.unit_cost_cents), 'purchase'));
      });
    });
    movements.forEach(function (m) {
      if (!purchaseMovement(m) || text(m.product_id != null ? m.product_id : m.productId) !== pid) return;
      var qty = quantity(m.quantity != null ? m.quantity : m.delta); if (qty == null) return;
      var op = operationId(m), identity = op || text(m.movement_id || m.id);
      // Sin identidad durable no es posible excluir duplicados con seguridad.
      if (!identity) return;
      var key = JSON.stringify([identity, pid]);
      if (registered.has(key) || seen.has(key)) return;
      // Un registro PUR fuera del límite de la API no conserva su costo/proveedor.
      seen.add(key);
      rows.push(row(identity, m.created_at || m.timestamp || (m.fecha ? m.fecha + 'T' + (m.hora24 || '00:00:00') : ''), m.supplier, qty, cost(m.unit_cost_cents), 'movement'));
    });
    rows = sortRows(rows);
    return { rows: rows, summary: summarize(rows), excludedLines: excludedLines };
  }
  function summarize(rows) {
    var totalQuantity = 0, costedQuantity = 0, totalCostCents = 0, weightedCostCents = 0, missingCostQuantity = 0;
    rows.forEach(function (r) {
      totalQuantity += r.quantity;
      if (r.totalCents == null) missingCostQuantity += r.quantity;
      else { costedQuantity += r.quantity; totalCostCents += r.totalCents; weightedCostCents += r.quantity * r.unitCostCents; }
    });
    return { totalQuantity: totalQuantity, costedQuantity: costedQuantity, missingCostQuantity: missingCostQuantity, totalCostCents: totalCostCents,
      // Promedio antes de redondear cada total monetario (también admite kg/l fraccionarios).
      weightedUnitCostCents: costedQuantity && Number.isSafeInteger(totalCostCents) && Number.isFinite(weightedCostCents) && weightedCostCents <= Number.MAX_SAFE_INTEGER ? weightedCostCents / costedQuantity : null,
      lastPurchase: sortRows(rows).find(function (r) { return r.timestamp != null; }) || null };
  }
  function money(cents) { return cents == null ? 'Sin costo registrado' : 'S/ ' + (cents / 100).toFixed(2); }
  function ownerAllowed() {
    try {
      var roles = root.NA_ROLES;
      return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner());
    } catch (_) { return false; }
  }
  async function readPurchases() {
    if (!ownerAllowed()) throw new Error('Sin permiso');
    if (!root.NA_ROLES || typeof root.NA_ROLES.api !== 'function') throw new Error('Consulta no disponible');
    var result = await root.NA_ROLES.api(READ_PATH, undefined, 'GET');
    if (!ownerAllowed()) throw new Error('Sin permiso');
    if (!result || !Array.isArray(result.purchases)) throw new Error('Respuesta de compras no válida');
    return { purchases: result.purchases, ready: result.ready !== false, truncated: typeof result.truncated === 'boolean' ? result.truncated : undefined };
  }
  root.NA_HISTORIAL_COMPRAS = Object.freeze({ searchProducts: searchProducts, timestamp: timestamp, limaLabel: limaLabel, buildHistory: buildHistory, summarize: summarize, money: money, ownerAllowed: ownerAllowed, readPurchases: readPurchases, limitReached: limitReached, PURCHASE_LIMIT: PURCHASE_LIMIT });
  if (!root.document) return;
  var doc = root.document;
  function init() {
    var page = doc.getElementById('pageHistorialCompras'); if (!page) return;
    var content = page.querySelector('[data-hc-content]'), denied = page.querySelector('[data-hc-denied]'), search = page.querySelector('[data-hc-search]'),
      matches = page.querySelector('[data-hc-products]'), status = page.querySelector('[data-hc-status]'), result = page.querySelector('[data-hc-result]'), retry = page.querySelector('[data-hc-retry]');
    var purchases = [], catalog = [], movements = [], selectedId = '', loaded = false, purchasesReady = true, purchasesTruncated, pending = false, failed = false, ticket = 0, active = false;
    function el(tag, cls, label) { var n = doc.createElement(tag); if (cls) n.className = cls; if (label != null) n.textContent = label; return n; }
    function visible() { return page.classList.contains('active'); }
    function sources() {
      var api = root.NuevoAmanecerCanonical, snap = api && typeof api.snapshot === 'function' ? api.snapshot() : {};
      snap = snap || {};
      var isCloud = api && typeof api.enabled === 'function' && api.enabled();
      // Catálogo y ledger de la misma réplica que muestra Inventario.
      catalog = typeof productos !== 'undefined' && Array.isArray(productos) ? productos.slice() : (Array.isArray(snap.products) ? snap.products : []).slice(); // eslint-disable-line no-undef
      movements = isCloud ? (Array.isArray(snap.inventoryMovements) ? snap.inventoryMovements : []).slice() : (typeof inventoryMovements !== 'undefined' && Array.isArray(inventoryMovements) ? inventoryMovements.slice() : []); // eslint-disable-line no-undef
    }
    function discard(clearSelection) {
      ticket++; purchases = []; catalog = []; movements = []; loaded = false; purchasesReady = true; purchasesTruncated = undefined; pending = false; failed = false;
      matches.replaceChildren(); result.replaceChildren(); status.textContent = ''; retry.hidden = true;
      if (clearSelection) { selectedId = ''; search.value = ''; }
    }
    function renderProducts() {
      matches.replaceChildren();
      if (!ownerAllowed() || !visible()) return;
      var products = searchProducts(catalog, search.value);
      products.slice(0, 30).forEach(function (p) {
        var b = el('button', 'hc-product'); b.type = 'button'; b.dataset.productId = productId(p);
        b.setAttribute('aria-pressed', String(selectedId === productId(p)));
        b.append(el('strong', '', productName(p)), el('span', '', text(p.sku || p.codigo || p.barcode || productId(p))));
        b.addEventListener('click', function () { if (!ownerAllowed()) return update(); selectedId = productId(p); renderProducts(); renderResult(); });
        matches.append(b);
      });
      if (!products.length) matches.append(el('p', 'hc-note', 'No se encontraron productos'));
      if (products.length > 30) matches.append(el('p', 'hc-note', 'Mostrando 30 de ' + products.length + ' productos. Escribe más para afinar la búsqueda.'));
    }
    function renderResult() {
      result.replaceChildren();
      if (!ownerAllowed() || !visible() || !loaded || !purchasesReady || !selectedId) return;
      var product = catalog.find(function (p) { return productId(p) === selectedId; }); if (!product) return;
      var history = buildHistory(purchases, movements, selectedId), summary = history.summary;
      result.append(el('h2', '', productName(product)));
      var stats = el('dl', 'hc-summary');
      [['Total comprado', String(summary.totalQuantity) + ' · ' + text(product.unidad || product.unit || 'unidad física')],
        ['Costo promedio ponderado', money(summary.weightedUnitCostCents)], ['Última compra', summary.lastPurchase ? limaLabel(summary.lastPurchase.timestamp) : 'Sin fecha registrada']].forEach(function (pair) {
        var box = el('div', 'hc-stat'); box.append(el('dt', '', pair[0]), el('dd', '', pair[1])); stats.append(box);
      });
      result.append(stats);
      if (limitReached(purchases, purchasesTruncated)) result.append(el('p', 'hc-note hc-limit', 'Mostrando las últimas ' + PURCHASE_LIMIT + ' compras'));
      if (summary.missingCostQuantity) result.append(el('p', 'hc-note', 'Promedio calculado sobre ' + summary.costedQuantity + ' unidades con costo registrado. ' + summary.missingCostQuantity + ' unidades sin costo registrado.'));
      if (history.excludedLines) result.append(el('p', 'hc-note', history.excludedLines + ' línea(s) sin aplicación confirmada excluidas del resumen.'));
      if (!history.rows.length) { result.append(el('p', 'hc-empty', 'Sin compras registradas')); return; }
      var table = el('table', 'hc-table'), head = el('thead'), header = el('tr'), body = el('tbody');
      var labels = ['Fecha (Lima)', 'Proveedor', 'Cantidad', 'Costo unitario', 'Total'];
      table.append(el('caption', '', 'Compras de ' + productName(product) + ' · más recientes primero'));
      labels.forEach(function (label) { var th = el('th', '', label); th.scope = 'col'; header.append(th); }); head.append(header);
      history.rows.forEach(function (r) {
        var tr = el('tr'); tr.dataset.purchaseId = r.id;
        [limaLabel(r.timestamp), r.supplier, String(r.quantity), money(r.unitCostCents), money(r.totalCents)].forEach(function (value, i) {
          var td = el('td', '', value); td.dataset.label = labels[i]; tr.append(td);
        }); body.append(tr);
      }); table.append(head, body); result.append(table);
    }
    async function load() {
      if (pending || !visible() || !ownerAllowed()) return;
      var ownTicket = ++ticket; pending = true; failed = false; loaded = false; result.replaceChildren(); retry.hidden = true; status.textContent = 'Cargando compras…';
      try {
        sources(); renderProducts();
        var api = root.NuevoAmanecerCanonical;
        // En modo local no existen compras de servidor; el ledger local sigue siendo consultable.
        var cloud = api && typeof api.enabled === 'function' && api.enabled();
        var response = cloud ? await readPurchases() : { purchases: [], ready: true, truncated: false };
        if (ownTicket !== ticket || !visible() || !ownerAllowed()) return;
        purchases = response.purchases; purchasesReady = response.ready; purchasesTruncated = response.truncated; loaded = true;
        if (!purchasesReady) {
          status.textContent = 'El registro de compras todavía no está disponible. Vuelve a intentar más tarde.'; retry.hidden = false;
          return;
        }
        status.textContent = cloud ? 'Registro de Compras: hasta 300 compras recientes más las incompletas; incluye ingresos de compra disponibles en Inventario. El resumen corresponde a los datos disponibles.' : 'Compras registradas en este dispositivo.';
        renderProducts(); renderResult();
      } catch (_) {
        if (ownTicket !== ticket || !visible() || !ownerAllowed()) return;
        purchases = []; failed = true; result.replaceChildren(); status.textContent = 'No se pudo cargar el historial. Revisa la conexión y vuelve a intentar.'; retry.hidden = false;
      } finally { if (ownTicket === ticket) pending = false; }
    }
    function update() {
      var isActive = visible(), permitted = ownerAllowed();
      content.hidden = !permitted; denied.hidden = permitted;
      if (!permitted) discard(true);
      else if (!isActive) discard(false);
      else if (!active || (!loaded && !pending && !failed)) load();
      active = isActive;
    }
    search.addEventListener('input', function () { if (!ownerAllowed()) return update(); renderProducts(); });
    retry.addEventListener('click', load);
    new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', update);
    root.addEventListener('na:canonical-updated', function () { if (visible() && ownerAllowed() && loaded && purchasesReady) { sources(); renderProducts(); renderResult(); } });
    root.addEventListener('offline', update);
    update();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(globalThis);
