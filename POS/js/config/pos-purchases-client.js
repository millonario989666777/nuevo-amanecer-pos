/* Etapa 2 (ítem 11): registro de compras con proveedor y costo.
   - «Compras» abre: Nueva compra (proveedor, documento, productos, cantidad, costo unitario) e Historial.
   - Una sola llamada al servidor (POST /auth/purchases) registra la compra y suma el stock.
   - Reintentar con el mismo número de compra nunca duplica stock (cada línea tiene su operation_id).
   - Solo con internet. Un empleado necesita el PIN del dueño (igual que ajustar inventario).
   - También lo usa la compra por OCR (NA_PURCHASES.submit) para no hacer una llamada por línea. */
(function (root) {
  'use strict';
  var doc = root.document, OPS = 'na_purchase_pending_op_v1', busy = false;
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  function toast(m, k) { try { root.toast(m, k || 'error'); } catch (_) {} }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { var n = Number(c || 0) / 100; try { return root.fmt(n); } catch (_) { return 'S/ ' + n.toFixed(2); } }
  function products() { try { return Array.isArray(productos) ? productos : []; } catch (_) { return []; } } // eslint-disable-line no-undef
  var ERR = {
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
  function opFor() {
    var op = null; try { op = root.localStorage.getItem(OPS); } catch (_) {}
    if (!op) { op = 'PUR-' + root.crypto.randomUUID(); try { root.localStorage.setItem(OPS, op); } catch (_) {} }
    return op;
  }
  function openNew() {
    var opts = products().slice(0, 3000).map(function (p) { return '<option value="' + esc(p.nombre || p.name || p.id) + '"></option>'; }).join('');
    var w = overlay('naPurchaseDialog', '<h3>Nueva compra</h3>' +
      '<div class="na-pur-head"><input id="naPurSupplier" maxlength="120" placeholder="Proveedor (opcional)"><input id="naPurDoc" maxlength="80" placeholder="Factura o boleta (opcional)"></div>' +
      '<datalist id="naPurProducts">' + opts + '</datalist><div class="na-pur-lines">' + lineHtml(0) + '</div>' +
      '<button type="button" class="na-pur-add">+ Agregar producto</button><div class="na-pur-total">Total costo: S/ 0.00</div>' +
      '<p class="na-pur-hint">Suma el stock al registrar. Necesita internet.</p>' +
      '<div class="na-review-actions" style="justify-content:space-between"><button type="button" class="na-pur-hist" style="background:#64748b">Historial</button>' +
      '<span><button type="button" class="na-pur-cancel" style="background:#64748b">Cancelar</button> <button type="button" class="na-pur-ok">Registrar compra</button></span></div>');
    var lines = w.querySelector('.na-pur-lines');
    w.querySelector('.na-pur-add').onclick = function () { lines.insertAdjacentHTML('beforeend', lineHtml(lines.children.length)); };
    lines.addEventListener('click', function (ev) { var b = ev.target.closest('.na-pur-del'); if (b && lines.children.length > 1) { b.parentElement.remove(); total(w); } });
    w.addEventListener('input', function () { total(w); });
    w.querySelector('.na-pur-cancel').onclick = function () { w.remove(); };
    w.querySelector('.na-pur-hist').onclick = function () { w.remove(); openHistory(); };
    w.querySelector('.na-pur-ok').onclick = async function () {
      if (busy) return;
      if (!cloud()) { toast('El registro de compras funciona con la nube activa.'); return; }
      if (root.navigator.onLine === false) { toast('Sin conexión: registrar una compra necesita internet. No se guardó nada.'); return; }
      var r = readLines(w);
      if (r.bad.length) { toast('Revisa la línea ' + r.bad.join(', ') + ': elige un producto de la lista y una cantidad mayor que 0.'); return; }
      if (!r.lines.length) { toast(ERR.invalid_lines); return; }
      busy = true; var btn = this; btn.disabled = true; btn.textContent = 'Registrando…';
      try {
        var out = await submit(opFor(), r.lines, { supplier: w.querySelector('#naPurSupplier').value.trim(), documentRef: w.querySelector('#naPurDoc').value.trim() });
        try { root.localStorage.removeItem(OPS); } catch (_) {}
        toast('Compra registrada: ' + (out.applied || []).length + ' producto(s) sumaron stock' + (out.total_cost_cents ? ' · costo ' + money(out.total_cost_cents) : '') + '.', 'success');
        w.remove();
      } catch (e) {
        if (!e.cancelled) {
          var code = e && (e.data && e.data.error || e.message);
          toast(ERR[code] || (e && e.status ? 'No se pudo registrar la compra (' + code + '). Puedes reintentar: no se duplicará.' : 'No se pudo conectar con el servidor. Revisa internet y vuelve a pulsar «Registrar compra»; no se duplicará.'));
        }
      } finally { busy = false; btn.disabled = false; btn.textContent = 'Registrar compra'; }
    };
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
      list.innerHTML = rows.length ? rows.map(function (p) {
        return '<details class="na-pur-item"><summary><strong>' + esc(p.supplier || 'Sin proveedor') + '</strong> · ' + esc((p.created_at || '').slice(0, 10)) + ' · ' + money(p.total_cost_cents) +
          (p.status !== 'aplicada' ? ' · <em>incompleta</em>' : '') + (p.document_ref ? '<small>' + esc(p.document_ref) + '</small>' : '') + '</summary>' +
          (p.lines || []).map(function (l) { return '<div class="na-pur-row"><span>' + esc(byId[l.product_id] || l.product_id) + '</span><span>' + esc(l.quantity) + ' × ' + (l.unit_cost_cents == null ? '—' : money(l.unit_cost_cents)) + '</span></div>'; }).join('') + '</details>';
      }).join('') : '<p>Todavía no hay compras registradas.</p>';
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
  root.NA_PURCHASES = { open: openNew, history: openHistory, submit: submit };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', installButtons); else installButtons();
})(window);
