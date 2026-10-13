/* Etapa 2 (ítem 11): registro de compras con proveedor y costo.
   - «Compras» abre: Nueva compra (proveedor, documento, productos, cantidad, costo unitario) e Historial.
   - Una sola llamada al servidor (POST /auth/purchases) registra la compra y suma el stock.
   - Reintentar con el mismo número de compra nunca duplica stock (cada línea tiene su operation_id).
   - Solo con internet. Un empleado necesita el PIN del dueño (igual que ajustar inventario).
   - También lo usa la compra por OCR (NA_PURCHASES.submit) para no hacer una llamada por línea. */
(function (root) {
  'use strict';
  var doc = root.document, OPS = 'na_purchase_pending_ops_v2', OPS_V1 = 'na_purchase_pending_op_v1', busy = false;
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  function toast(m, k) { try { root.toast(m, k || 'error'); } catch (_) {} }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { var n = Number(c || 0) / 100; try { return root.fmt(n); } catch (_) { return 'S/ ' + n.toFixed(2); } }
  function products() { try { return Array.isArray(productos) ? productos : []; } catch (_) { return []; } } // eslint-disable-line no-undef
  var ERR = {
    purchase_payload_mismatch: 'Esta compra cambió respecto del intento anterior. Pulsa «Registrar compra» de nuevo: se registrará como compra nueva.',
    purchase_line_failed: 'Una línea no se pudo aplicar. Las líneas anteriores ya sumaron stock; pulsa «Registrar compra» de nuevo para completar (no se duplicará).',
    purchase_schema_not_ready: 'El registro de compras aún no está activo en el servidor.',
    owner_approval_required: 'Hace falta el PIN del dueño.',
    invalid_line: 'Revisa las líneas: producto, cantidad mayor que 0 y costo válido.',
    invalid_lines: 'Agrega al menos un producto.'
  };

  // Envía una compra en una sola llamada. lines: [{line, product_id, quantity, unit_cost_cents|null}]
  async function submit(operationId, lines, meta) {
    var R = root.NA_ROLES, api = root.NuevoAmanecerCanonical;
    if (!R || !api || typeof api.commandContext !== 'function') { var e0 = new Error('purchase_unavailable'); e0.status = 0; throw e0; }
    if (typeof api.prepareCommand === 'function') await api.prepareCommand('inventory.adjust');
    var ctx = api.commandContext(), headers = {};
    if (R.role !== 'owner') {
      var approval = await R.approve('inventory.adjust', operationId, 'Autorización del dueño', 'Registrar compra: pide al dueño que escriba su PIN.');
      if (!approval) { var e1 = new Error('OWNER_APPROVAL_CANCELLED'); e1.status = 0; e1.cancelled = true; throw e1; }
      headers['x-owner-approval'] = String(approval).slice(0, 80);
    }
    var body = { operation_id: operationId, promotion_id: ctx.promotion_id, authority_epoch: ctx.authority_epoch, expected_control_revision: ctx.expected_control_revision,
      client_contract: ctx.client_contract, created_at: ctx.created_at, lines: lines };
    if (meta && meta.supplier) body.supplier = String(meta.supplier).slice(0, 120);
    if (meta && meta.documentRef) body.document_ref = String(meta.documentRef).slice(0, 80);
    var out = await R.api('/auth/purchases', body, 'POST', headers);
    try { await api.refresh(); } catch (_) {}
    try { if (typeof root.invRender === 'function') root.invRender(); } catch (_) {}
    return out;
  }

  function overlay(id, html) {
    var old = doc.getElementById(id); if (old) old.remove();
    var w = doc.createElement('div'); w.className = 'na-review-overlay na-pur-overlay'; w.id = id;
    w.innerHTML = '<div class="na-review-box na-pur-box" role="dialog" aria-label="Compras">' + html + '</div>';
    doc.body.appendChild(w);
    w.addEventListener('click', function (ev) { if (ev.target === w) w.remove(); });
    return w;
  }
  function productByLabel(label) {
    var v = String(label || '').trim().toLowerCase(); if (!v) return null;
    var list = products();
    return list.find(function (p) { return String(p.id).toLowerCase() === v || String(p.nombre || p.name || '').trim().toLowerCase() === v; }) || null;
  }
  function lineHtml(i) {
    return '<div class="na-pur-line" data-i="' + i + '"><input class="na-pur-prod" list="naPurProducts" placeholder="Producto" autocomplete="off">' +
      '<input class="na-pur-qty" type="number" min="0" step="any" inputmode="decimal" placeholder="Cant.">' +
      '<input class="na-pur-cost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Costo S/">' +
      '<button type="button" class="na-pur-del" aria-label="Quitar línea">✕</button></div>';
  }
  function readLines(w) {
    var out = [], bad = [];
    [].slice.call(w.querySelectorAll('.na-pur-line')).forEach(function (row, idx) {
      var label = row.querySelector('.na-pur-prod').value, qty = Number(row.querySelector('.na-pur-qty').value), costRaw = row.querySelector('.na-pur-cost').value;
      if (!label && !row.querySelector('.na-pur-qty').value) return;
      var p = productByLabel(label);
      if (!p || !(qty > 0)) { bad.push(idx + 1); return; }
      var cost = costRaw === '' ? null : Math.round(Number(costRaw) * 100);
      if (cost != null && !(cost >= 0)) { bad.push(idx + 1); return; }
      out.push({ line: out.length + 1, product_id: String(p.id), quantity: qty, unit_cost_cents: cost });
    });
    return { lines: out, bad: bad };
  }
  function total(w) {
    var r = readLines(w), t = r.lines.reduce(function (s, l) { return s + (l.unit_cost_cents == null ? 0 : l.unit_cost_cents * l.quantity); }, 0);
    var el = w.querySelector('.na-pur-total'); if (el) el.textContent = 'Total costo: ' + money(Math.round(t)) + ' · ' + r.lines.length + ' producto(s)';
  }
  // El id de una compra sin confirmar queda atado a su contenido (líneas, cantidades, costos, proveedor y
  // comprobante). Si el contenido cambió o es una compra nueva, primero se pregunta al servidor por el id viejo.
  function fingerprint(lines, meta) {
    return JSON.stringify({ l: (lines || []).map(function (x) { return [x.line, String(x.product_id), Number(x.quantity), x.unit_cost_cents == null ? null : Number(x.unit_cost_cents)]; }),
      s: String(meta && meta.supplier || '').trim(), d: String(meta && meta.documentRef || '').trim() });
  }
  // Compras sin confirmar: un mapa por id ({ id: { fp, at, noted } }). Una segunda respuesta perdida no borra la
  // primera; cada una se verifica con el servidor por su id (nunca se reenvía a ciegas ni en lugar del formulario).
  function readOps() {
    var m = {}; try { m = JSON.parse(root.localStorage.getItem(OPS) || '{}') || {}; } catch (_) { m = {}; }
    try { var raw = root.localStorage.getItem(OPS_V1); if (raw) { var o = null; try { o = JSON.parse(raw); } catch (_) {} o = o && o.id ? o : { id: raw, fp: null }; if (!m[o.id]) m[o.id] = { fp: o.fp || null, at: Date.now() }; root.localStorage.removeItem(OPS_V1); writeOps(m); } } catch (_) {}
    return m;
  }
  function writeOps(m) { try { if (Object.keys(m).length) root.localStorage.setItem(OPS, JSON.stringify(m)); else root.localStorage.removeItem(OPS); } catch (_) {} }
  function dropOp(id) { var m = readOps(); if (id && m[id]) { delete m[id]; writeOps(m); } }
  function pendingOps() { var m = readOps(); return Object.keys(m).map(function (id) { return { id: id, fp: m[id].fp, noted: !!m[id].noted }; }); }
  var UNVERIFIED = 'No se pudo comprobar la compra anterior. Vuelve a intentar con internet; no se guardó nada nuevo.';
  function nameOf(pid) { var p = products().find(function (x) { return String(x.id) === String(pid); }); return p ? (p.nombre || p.name || pid) : pid; }
  // Devuelve { id } para enviar, o { stop: mensaje } si antes hay que avisar algo al dueño.
  // { finish: {...} } = compra anterior a medias que se puede terminar con su MISMO id (solo suma lo que falta).
  async function opFor(lines, meta) {
    var fp = fingerprint(lines, meta), m = readOps(), ids = Object.keys(m);
    for (var i = 0; i < ids.length; i++) if (m[ids[i]].fp === fp) return { id: ids[i] };
    var applied = 0, half = 0;
    var newProducts = (lines || []).map(function (x) { return String(x.product_id); });
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j]; if (m[id].noted) continue;
      var st;
      try { st = await root.NA_ROLES.api('/auth/purchases?id=' + encodeURIComponent(id)); }
      catch (_) { return { stop: UNVERIFIED }; }
      // Solo se acepta una respuesta de estado de ESTA compra; cualquier otra cosa (lista, error) = no comprobado.
      if (!st || st.purchase_id !== id || ['applied', 'in_progress', 'not_found'].indexOf(st.status) === -1) return { stop: UNVERIFIED };
      if (st.status === 'applied') { applied++; delete m[id]; }
      else if (st.status === 'in_progress') {
        var old = Array.isArray(st.lines) ? st.lines : [];
        var overlap = old.some(function (l) { return newProducts.indexOf(String(l.product_id)) !== -1; });
        if (overlap && old.length) {
          writeOps(m);
          var done = old.filter(function (l) { return l.applied; }), miss = old.filter(function (l) { return !l.applied; });
          var desc = function (a) { return a.map(function (l) { return nameOf(l.product_id) + ' +' + l.quantity; }).join(', ') || 'ninguna'; };
          return { stop: 'La compra anterior quedó a medias. Ya sumaron stock: ' + desc(done) + '. Faltan: ' + desc(miss) +
            '. Para no duplicar, termínala con «Terminar compra anterior» (solo suma lo que falta). Esta compra NO se registró.',
            finish: { id: id, lines: old.map(function (l) { return { line: Number(l.line_number), product_id: String(l.product_id), quantity: Number(l.quantity), unit_cost_cents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents) }; }),
              meta: { supplier: (st.purchase && st.purchase.supplier) || '', documentRef: (st.purchase && st.purchase.document_ref) || '' } } };
        }
        half++; m[id].noted = true;
      }
      else delete m[id]; // not_found confirmado: nunca llegó al servidor, no sumó stock
    }
    writeOps(m);
    if (applied) {
      try { await root.NuevoAmanecerCanonical.refresh(); } catch (_) {}
      try { if (typeof root.invRender === 'function') root.invRender(); } catch (_) {}
      return { stop: (applied > 1 ? 'Las ' + applied + ' compras anteriores sí se registraron' : 'La compra anterior sí se registró') + ' y ya sumó stock. Esta compra todavía NO se registró: revisa el stock y, si es otra compra, pulsa «Registrar compra» de nuevo.', info: true };
    }
    if (half) return { stop: 'La compra anterior quedó a medias (algunas líneas pueden haber sumado stock). Puedes terminarla en Historial con «Terminar compra». Esta compra todavía NO se registró: se registrará como nueva al pulsar «Registrar compra» de nuevo.' };
    var nid = 'PUR-' + root.crypto.randomUUID(); m[nid] = { fp: fp, at: Date.now() }; writeOps(m);
    return { id: nid };
  }
  function openNew() {
    var opts = products().slice(0, 3000).map(function (p) { return '<option value="' + esc(p.nombre || p.name || p.id) + '"></option>'; }).join('');
    var w = overlay('naPurchaseDialog', '<h3>Nueva compra</h3>' +
      '<div class="na-pur-head"><input id="naPurSupplier" maxlength="120" placeholder="Proveedor (opcional)"><input id="naPurDoc" maxlength="80" placeholder="Factura o boleta (opcional)"></div>' +
      '<datalist id="naPurProducts">' + opts + '</datalist><div class="na-pur-lines">' + lineHtml(0) + '</div>' +
      '<button type="button" class="na-pur-add">+ Agregar producto</button><div class="na-pur-total">Total costo: S/ 0.00</div>' +
      '<p class="na-pur-hint">Suma el stock al registrar. Necesita internet.</p>' +
      '<div class="na-pur-err" role="alert" hidden></div>' +
      '<div class="na-review-actions" style="justify-content:space-between"><button type="button" class="na-pur-hist" style="background:#64748b">Historial</button>' +
      '<span><button type="button" class="na-pur-cancel" style="background:#64748b">Cancelar</button> <button type="button" class="na-pur-ok">Registrar compra</button></span></div>');
    var lines = w.querySelector('.na-pur-lines');
    w.querySelector('.na-pur-add').onclick = function () { lines.insertAdjacentHTML('beforeend', lineHtml(lines.children.length)); };
    lines.addEventListener('click', function (ev) { var b = ev.target.closest('.na-pur-del'); if (b && lines.children.length > 1) { b.parentElement.remove(); total(w); } });
    w.addEventListener('input', function () { total(w); });
    w.querySelector('.na-pur-cancel').onclick = function () { closeW(); };
    w.querySelector('.na-pur-hist').onclick = function () { closeW(); openHistory(); };
    // Errores dentro de la ventana: la compra queda en pantalla y el reintento usa la MISMA operación
    // (opFor guarda el id hasta que el servidor confirma), así el stock sube una sola vez.
    var errBox = w.querySelector('.na-pur-err');
    function fail(msg) { errBox.classList.remove('info'); errBox.textContent = '⚠ ' + msg; errBox.hidden = false; }
    // Al cerrar la ventana tras un resultado confirmado (registrada o rechazada de forma definitiva) se borra el id.
    var settled = false;
    var curId = null;
    function closeW() { if (settled && curId) dropOp(curId); w.remove(); }
    // Termina la compra anterior a medias con su MISMO id: el servidor salta las líneas ya aplicadas.
    function finishButton(f) {
      var b = doc.createElement('button'); b.type = 'button'; b.className = 'na-pur-finish'; b.textContent = 'Terminar compra anterior';
      b.style.cssText = 'display:block;margin-top:8px;min-height:40px;border-radius:10px;border:1px solid #b91c1c;background:#fff;color:#991b1b;font-weight:800;padding:0 12px';
      b.onclick = async function () {
        if (busy) return; busy = true; b.disabled = true; b.textContent = 'Terminando…';
        try {
          var out = await submit(f.id, f.lines, f.meta); dropOp(f.id);
          errBox.classList.add('info'); errBox.textContent = 'Compra anterior completa: ' + (out.applied || []).length + ' línea(s) que faltaban sumaron stock; las demás ya estaban. Ahora puedes registrar esta compra si es distinta.';
          try { await root.NuevoAmanecerCanonical.refresh(); } catch (_) {}
        } catch (e) { var c = e && (e.data && e.data.error || e.message); errBox.classList.remove('info'); errBox.textContent = '⚠ ' + (ERR[c] || 'No se pudo terminar la compra anterior. Vuelve a intentar; no se duplicará.'); }
        finally { busy = false; }
      };
      errBox.appendChild(b);
    }
    w.querySelector('.na-pur-ok').onclick = async function () {
      if (busy) return;
      errBox.hidden = true;
      if (!cloud()) { fail('El registro de compras funciona con la nube activa.'); return; }
      if (root.navigator.onLine === false) { fail('Sin conexión: registrar una compra necesita internet. No se guardó nada.'); return; }
      var r = readLines(w);
      if (r.bad.length) { fail('Revisa la línea ' + r.bad.join(', ') + ': elige un producto de la lista y una cantidad mayor que 0.'); return; }
      if (!r.lines.length) { fail(ERR.invalid_lines); return; }
      busy = true; var btn = this; btn.disabled = true; btn.textContent = 'Registrando…';
      try {
        var meta = { supplier: w.querySelector('#naPurSupplier').value.trim(), documentRef: w.querySelector('#naPurDoc').value.trim() };
        var pick = await opFor(r.lines, meta);
        if (pick.stop) { fail(pick.stop); if (pick.info) errBox.classList.add('info'); if (pick.finish) finishButton(pick.finish); return; }
        curId = pick.id;
        var out = await submit(pick.id, r.lines, meta);
        dropOp(pick.id); settled = true;
        toast('Compra registrada: ' + (out.applied || []).length + ' producto(s) sumaron stock' + (out.total_cost_cents ? ' · costo ' + money(out.total_cost_cents) : '') + '.', 'success');
        w.remove();
      } catch (e) {
        if (!e.cancelled) {
          var code = e && (e.data && e.data.error || e.message);
          if (code === 'purchase_payload_mismatch') dropOp(curId);
          if (e && e.status >= 400 && e.status < 500 && code !== 'purchase_line_failed' && code !== 'purchase_payload_mismatch') settled = true;
          fail(ERR[code] || (e && e.status ? 'No se pudo registrar la compra (' + code + '). Puedes reintentar: no se duplicará.' : 'No se pudo conectar con el servidor. Revisa internet y vuelve a pulsar «Registrar compra»; no se duplicará.'));
        }
      } finally { busy = false; btn.disabled = false; btn.textContent = 'Registrar compra'; }
    };
  }
  // Terminar una compra incompleta desde el Historial: MISMO id y mismas líneas guardadas en el servidor;
  // el servidor salta las líneas que ya sumaron stock (idempotente).
  function historyFinishArgs(row) {
    return { id: String(row.purchase_id), lines: (row.lines || []).map(function (l) { return { line: Number(l.line_number), product_id: String(l.product_id), quantity: Number(l.quantity), unit_cost_cents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents) }; }),
      meta: { supplier: row.supplier || '', documentRef: row.document_ref || '' } };
  }
  async function finishPurchase(row) {
    var a = historyFinishArgs(row);
    var out = await (root.NA_PURCHASES && root.NA_PURCHASES._submitHook || submit)(a.id, a.lines, a.meta);
    dropOp(a.id);
    return out;
  }
  // Cerrar como parcial: solo el dueño; PIN comprobado con la ventana abierta (el error queda dentro de ella).
  async function closePartial(id, reason) {
    var R = root.NA_ROLES; if (!R || !R.askPin) return null;
    var done = null;
    var ok = await R.askPin('Cerrar compra como parcial', 'Escribe el PIN del dueño. Lo que ya sumó stock se conserva; lo demás queda sin aplicar.', async function (pin) {
      try { done = await R.api('/auth/purchases/close-partial', { purchase_id: id, reason: reason, pin: pin }); return { ok: true, value: true }; }
      catch (e) { if (e.message === 'owner_only') return { msg: 'Solo el aparato del dueño puede cerrar una compra como parcial.', stop: true };
        if (e.message === 'owner_pin_invalid') return { msg: R.message(e) }; return { msg: R.message(e), stop: e.message === 'owner_pin_locked' }; }
    });
    return ok ? done : null;
  }
  async function openHistory() {
    var w = overlay('naPurchaseHistory', '<h3>Compras registradas</h3><div class="na-pur-list">Cargando…</div><div class="na-review-actions" style="justify-content:space-between"><button type="button" class="na-pur-new">Nueva compra</button><button type="button" class="na-pur-close" style="background:#64748b">Cerrar</button></div>');
    w.querySelector('.na-pur-close').onclick = function () { w.remove(); };
    w.querySelector('.na-pur-new').onclick = function () { w.remove(); openNew(); };
    var list = w.querySelector('.na-pur-list');
    try {
      var out = await root.NA_ROLES.api('/auth/purchases');
      var byId = {}; products().forEach(function (p) { byId[String(p.id)] = p.nombre || p.name || p.id; });
      var rows = out.purchases || [];
      var lock = root.NA_ICON ? root.NA_ICON('lock') : '';
      var detail = function (p) { return (p.lines || []).map(function (l) { return '<div class="na-pur-row"><span>' + esc(byId[l.product_id] || l.product_id) + '</span><span>' + esc(l.quantity) + ' × ' + (l.unit_cost_cents == null ? 'sin costo' : money(l.unit_cost_cents)) + '</span></div>'; }).join(''); };
      list.innerHTML = rows.length ? rows.map(function (p) {
        var head = '<strong>' + esc(p.supplier || 'Sin proveedor') + '</strong> · ' + esc((p.created_at || '').slice(0, 10)) + ' · ' + money(p.total_cost_cents);
        if (p.status === 'en_curso') {
          // Incompleta: fila ámbar con los botones SIEMPRE visibles (fuera del detalle plegado).
          return '<div class="na-pur-item na-pur-open" data-id="' + esc(p.purchase_id) + '"><div class="na-pur-open-head">' + head + ' · <em>incompleta</em>' + (p.document_ref ? ' <small>' + esc(p.document_ref) + '</small>' : '') + '</div>' +
            '<div class="na-pur-open-actions"><button type="button" class="na-pur-finish-h">Terminar compra</button><button type="button" class="na-pur-partial-h">' + lock + ' Cerrar como parcial</button></div>' +
            '<input class="na-pur-reason" type="text" maxlength="300" placeholder="Motivo (obligatorio)" hidden><div class="na-pur-err" role="status" hidden></div>' +
            '<details><summary>Ver líneas</summary>' + detail(p) + '</details></div>';
        }
        return '<details class="na-pur-item"><summary>' + head + (p.status === 'cerrada_parcial' ? ' · <em>cerrada como parcial</em>' : '') + (p.document_ref ? '<small>' + esc(p.document_ref) + '</small>' : '') + '</summary>' +
          (p.closure ? '<div class="na-pur-row"><span>Motivo del cierre</span><span>' + esc(p.closure.reason) + '</span></div>' : '') + detail(p) + '</details>';
      }).join('') : '<p>Todavía no hay compras registradas.</p>';
      [].slice.call(list.querySelectorAll('.na-pur-open')).forEach(function (item) {
        var row = rows.find(function (r) { return String(r.purchase_id) === item.getAttribute('data-id'); });
        var b = item.querySelector('.na-pur-finish-h'), pb = item.querySelector('.na-pur-partial-h'), box = item.querySelector('.na-pur-err'), why = item.querySelector('.na-pur-reason');
        var say = function (t, ok) { box.className = 'na-pur-err' + (ok ? ' info' : ''); box.textContent = t; box.hidden = false; };
        b.onclick = async function () {
          if (busy || !row) return;
          busy = true; b.disabled = true; b.textContent = 'Terminando…';
          try {
            var out = await finishPurchase(row);
            say('Compra completa: ' + (out.applied || []).length + ' línea(s) que faltaban sumaron stock; las demás ya estaban.', true); item.querySelector('.na-pur-open-actions').remove(); item.classList.remove('na-pur-open');
            try { await root.NuevoAmanecerCanonical.refresh(); } catch (_) {}
          } catch (e) { var c = e && (e.data && e.data.error || e.message); var d = e && e.data && e.data.detail && e.data.detail.error;
            say(d === 'product_not_found' ? 'Un producto de esta compra ya no existe. Puedes cerrarla como parcial (solo el dueño).' : (ERR[c] || 'No se pudo terminar la compra. Vuelve a intentar; no se duplicará.')); b.disabled = false; b.textContent = 'Terminar compra'; }
          finally { busy = false; }
        };
        pb.onclick = async function () {
          if (busy || !row) return;
          if (why.hidden) { why.hidden = false; why.focus(); say('Escribe el motivo y vuelve a tocar «Cerrar como parcial». Se conserva lo que ya sumó stock; lo demás queda sin aplicar.', true); return; }
          var reason = why.value.trim(); if (reason.length < 3) { say('Escribe el motivo (mínimo 3 letras).'); why.focus(); return; }
          busy = true;
          try {
            var res = await closePartial(row.purchase_id, reason);
            if (!res) { say('Cierre cancelado. No se cambió nada.', true); return; }
            say('Compra cerrada como parcial: ' + res.applied_lines.length + ' línea(s) quedan aplicadas y ' + res.missing_lines.length + ' sin aplicar. El stock no cambió.', true);
            item.querySelector('.na-pur-open-actions').remove(); why.remove(); item.classList.remove('na-pur-open'); dropOp(row.purchase_id);
          } finally { busy = false; }
        };
      });
    } catch (e) { list.textContent = 'No se pudo cargar el historial (' + (e && e.message || 'sin conexión') + ').'; }
  }
  function installButtons() {
    var bar = doc.querySelector('#pageInventario .ocr-purchase-actions');
    if (bar && !bar.querySelector('.na-pur-btn')) {
      var b = doc.createElement('button'); b.type = 'button'; b.className = 'top-btn-nuevo na-pur-btn'; b.textContent = 'Compras';
      b.onclick = function () { openNew(); };
      bar.insertBefore(b, bar.firstChild);
    }
    var src = doc.querySelector('#mOcrPurchaseSource .ocr-source-options');
    if (src && !src.querySelector('.na-pur-btn')) {
      var c = doc.createElement('button'); c.type = 'button'; c.className = 'mbtn na-pur-btn'; c.textContent = 'Registrar compra a mano';
      c.onclick = function () { doc.getElementById('mOcrPurchaseSource').classList.remove('open'); openNew(); };
      src.appendChild(c);
    }
  }
  root.NA_PURCHASES = { open: openNew, history: openHistory, submit: submit, _opFor: opFor, pendingOps: pendingOps, _submit: submit, _finish: finishPurchase, _closePartial: closePartial, _historyFinishArgs: historyFinishArgs };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', installButtons); else installButtons();
})(window);
