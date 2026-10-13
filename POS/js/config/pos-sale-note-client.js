/* Etapa 2 (ítem 10): nota opcional de venta.
   - Campo "Nota (opcional)" en Pagar. El borrador sobrevive al vaciar el carrito y a recargar; se limpia solo al confirmar una venta.
   - La nota nunca cambia el monto: viaja aparte (POST /auth/sale-notes) después de la venta.
   - Cola local: si no hay internet o la venta aún no llegó al servidor, se reintenta luego (no se pierde).
   - Se muestra en el Historial (detalle) y en el comprobante.
   - Ítem 10b: comentario opcional del abono (llave 'pay:<operation_id>'), y quién atendió cada venta y abono
     (GET /auth/record-meta: etiqueta del aparato; sin etiqueta = Dueño o Empleado). */
(function (root) {
  'use strict';
  var doc = root.document, DRAFT = 'na_sale_note_draft_v1', QUEUE = 'na_sale_note_queue_v1', CACHE = 'na_sale_notes_v1', META = 'na_record_meta_v1';
  var busy = false;
  function lsGet(k, d) { try { var v = JSON.parse(root.localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function clean(t) { return String(t || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 300); }
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  function getVentas() { try { return ventas; } catch (_) { return []; } } // eslint-disable-line no-undef
  function keys(v) { return [v && v.sale_id, v && v.id, v && v.ventaUid, v && v.operation].filter(function (x) { return x != null && x !== ''; }).map(String); }

  // El servidor llama «Dueño» al aparato del admin sin etiqueta; en pantalla se muestra «Admin».
  function who(x) { return x === 'Dueño' ? 'Admin' : x; }
  function draft() { return clean(lsGet(DRAFT, '')); }
  function ensureField() {
    var conf = doc.getElementById('mBtnConf'); if (!conf || doc.getElementById('naSaleNote')) return;
    var box = doc.createElement('div'); box.className = 'na-sale-note';
    box.innerHTML = '<label for="naSaleNote">Nota (opcional)</label><input id="naSaleNote" type="text" maxlength="300" autocomplete="off" placeholder="Ej.: entregar mañana">';
    var host = conf.closest('.pay-actions') || conf.parentElement;
    host.parentElement.insertBefore(box, host);
    var input = box.querySelector('input'); input.value = draft();
    input.addEventListener('input', function () { lsSet(DRAFT, input.value.slice(0, 300)); });
  }

  function mark() {
    var list = getVentas(); if (!Array.isArray(list)) return;
    var server = lsGet(CACHE, {}), local = {};
    lsGet(QUEUE, []).forEach(function (q) { (q.keys || []).forEach(function (k) { local[k] = q.note; }); });
    var meta = lsGet(META, { sales: {}, payments: {} });
    list.forEach(function (v) {
      var ks = keys(v), i;
      for (i = 0; i < ks.length; i++) { var w = who(meta.sales[ks[i]]); if (w) { v.cajero = v.cajeroNombre = w; break; } }
      for (i = 0; i < ks.length; i++) { var n = server[ks[i]] || local[ks[i]]; if (n) { v.nota = n; break; } }
    });
    var credits; try { credits = creditos; } catch (_) { credits = []; } // eslint-disable-line no-undef
    (Array.isArray(credits) ? credits : []).forEach(function (cr) {
      (Array.isArray(cr && cr.pagos) ? cr.pagos : []).forEach(function (p) {
        var op = String(p.operationId || p.operation_id || p.pagoId || p.id || ''); if (!op) return;
        var who = meta.payments[op]; if (who) p.cajero = p.cajeroNombre = who;
        var c = server['pay:' + op] || local['pay:' + op]; if (c) p.comentario = c;
      });
    });
  }
  async function post(saleId, note) {
    var r = root.NA_ROLES; if (!r) throw new Error('sin sesión');
    return r.api('/auth/sale-notes', { sale_id: saleId, note: note });
  }
  async function flush() {
    if (busy || !cloud() || root.navigator.onLine === false || !root.NA_ROLES) return;
    var q = lsGet(QUEUE, []); if (!q.length) return;
    busy = true;
    try {
      var cache = lsGet(CACHE, {}), rest = [];
      for (var i = 0; i < q.length; i++) {
        var item = q[i], done = false;
        // También se buscan las llaves de la venta proyectada desde el servidor (sale_id).
        var ks = (item.keys || []).slice();
        getVentas().forEach(function (v) { var vk = keys(v); if (vk.some(function (k) { return ks.indexOf(k) >= 0; })) vk.forEach(function (k) { if (ks.indexOf(k) < 0) ks.push(k); }); });
        for (var j = 0; j < ks.length && !done; j++) {
          try { await post(ks[j], item.note); cache[ks[j]] = item.note; done = true; } catch (e) { if (!/404|sale_not_found/.test(String(e && (e.status || e.message || e)))) { j = ks.length; } }
        }
        if (!done) rest.push(item);
      }
      lsSet(QUEUE, rest); lsSet(CACHE, cache);
    } finally { busy = false; }
  }
  async function load() {
    if (!cloud() || !root.NA_ROLES || root.navigator.onLine === false) return;
    try {
      var out = await root.NA_ROLES.api('/auth/sale-notes'), next = {};
      (out.notes || []).forEach(function (n) { next[String(n.sale_id)] = n.note; });
      lsSet(CACHE, next);
      try {
        var m = await root.NA_ROLES.api('/auth/record-meta'), meta = { sales: {}, payments: {} };
        (m.sales || []).forEach(function (r) { meta.sales[String(r.sale_id)] = r.cashier; });
        (m.payments || []).forEach(function (r) { meta.payments[String(r.operation_id)] = r.cashier; });
        lsSet(META, meta);
      } catch (_) {}
      mark();
    } catch (_) {}
  }

  function cashierLabel() { var r = root.NA_ROLES; if (!r) return ''; return r.label || (r.role === 'empleado' ? 'Empleado' : 'Admin'); }
  function ensurePayFields() {
    var hosts = [];
    var single = doc.querySelector('#mPagoCred .mbtns'); if (single) hosts.push(single);
    var batch = doc.getElementById('naV2BatchSubmit'); if (batch) hosts.push(batch);
    hosts.forEach(function (h) {
      var parent = h.parentElement; if (!parent || parent.querySelector('.na-pay-note')) return;
      var box = doc.createElement('div'); box.className = 'na-sale-note na-pay-note';
      box.innerHTML = '<label>Comentario del abono (opcional)</label><input type="text" maxlength="300" autocomplete="off" placeholder="Ej.: pagó su hija">';
      parent.insertBefore(box, h);
    });
  }
  // Lo llama share-receipt.js onPayments con los abonos confirmados: guarda el comentario y lo pone en el recibo.
  root.__naPayNoteTake = function (entries) {
    var inputs = [].slice.call(doc.querySelectorAll('.na-pay-note input')), note = '';
    inputs.forEach(function (i) { if (!note && clean(i.value)) note = clean(i.value); i.value = ''; });
    if (!note) return '';
    var q = lsGet(QUEUE, []);
    (entries || []).forEach(function (e) {
      var op = e && e.receipt && (e.receipt.operation_id || e.receipt.event_id || e.receipt.payment_id);
      if (op) q.push({ keys: ['pay:' + String(op)], note: note, at: new Date().toISOString() });
    });
    lsSet(QUEUE, q); setTimeout(flush, 1500);
    return note;
  };
  root.__naCashierLabel = cashierLabel;
  root.__naPaymentMeta = function (op) {
    if (!op) return null;
    var meta = lsGet(META, { sales: {}, payments: {} }), server = lsGet(CACHE, {}), c = server['pay:' + op];
    if (!c) lsGet(QUEUE, []).some(function (q) { if ((q.keys || []).indexOf('pay:' + op) >= 0) { c = q.note; return true; } return false; });
    var pw = who(meta.payments && meta.payments[op]);
    return pw || c ? { cashier: pw || '', comment: c || '' } : null;
  };
  function wrapConfirm() {
    var base = root.confirmarVenta;
    if (typeof base !== 'function' || base.__naNote) return;
    var wrapped = async function () {
      var note = draft(), before = {};
      getVentas().forEach(function (v) { keys(v).forEach(function (k) { before[k] = 1; }); });
      var captured = [];
      root.__naSaleNoteCapture = note ? { note: note, ids: captured } : null;
      var out;
      try { out = await base.apply(this, arguments); } finally { root.__naSaleNoteCapture = null; }
      if (note) {
        var attach = function () {
          var fresh = getVentas().filter(function (v) { return !keys(v).some(function (k) { return before[k]; }); });
          var ks = [];
          if (out && out.sale_id) ks.push(String(out.sale_id));
          if (out && out.operation_id) ks.push(String(out.operation_id));
          captured.forEach(function (k) { if (ks.indexOf(k) < 0) ks.push(k); });
          fresh.forEach(function (v) { v.nota = note; keys(v).forEach(function (k) { if (ks.indexOf(k) < 0) ks.push(k); }); });
          if (!ks.length) return false;
          var q = lsGet(QUEUE, []); q.push({ keys: ks, note: note, at: new Date().toISOString() });
          lsSet(QUEUE, q); lsSet(DRAFT, ''); var i = doc.getElementById('naSaleNote'); if (i) i.value = '';
          mark(); setTimeout(flush, 1500); return true;
        };
        if (!attach()) setTimeout(attach, 1200);
      }
      return out;
    };
    wrapped.__naNote = true;
    Object.keys(base).forEach(function (k) { try { wrapped[k] = base[k]; } catch (_) {} });
    root.confirmarVenta = wrapped;
  }
  // El comprobante que se abre al confirmar toma la nota de __naSaleNoteCapture (share-receipt.js onSale).
  function wrapRender() {
    var base = root.ventasRender; if (typeof base !== 'function' || base.__naNote) return;
    var w = function () { mark(); return base.apply(this, arguments); }; w.__naNote = true; root.ventasRender = w;
  }
  function init() {
    ensureField(); ensurePayFields(); wrapConfirm(); wrapRender();
    doc.addEventListener('click', function () { setTimeout(ensurePayFields, 60); }, true); mark(); load().then(flush);
    root.addEventListener('online', function () { flush(); });
    setInterval(function () { wrapConfirm(); flush(); }, 60000);
  }
  root.NA_SALE_NOTE = { flush: flush, load: load, mark: mark, draft: draft };
  if (doc.readyState === 'complete') setTimeout(init, 0); else root.addEventListener('load', function () { setTimeout(init, 0); });
})(window);
