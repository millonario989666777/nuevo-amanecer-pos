/* Etapa 2 (G): revisiones del dueño.
   - Descuento de empleado bajo catálogo y cierre de caja de empleado con diferencia los marca el servidor.
   - Inicio muestra «Cierre pendiente de aprobación del dueño»; el dueño aprueba o rechaza.
   - Rechazar un descuento registra faltante del cajero; la venta nunca se cambia.
   - Cierre de empleado con diferencia: solo con internet (sin conexión no se encola nada). */
(function (root) {
  'use strict';
  var doc = root.document, CACHE = 'na_pos_reviews_cache_v1';
  var state = { reviews: [], all: null, at: 0, busy: false };
  try { var c = JSON.parse(root.localStorage.getItem(CACHE) || 'null'); if (c && Array.isArray(c.reviews)) state.reviews = c.reviews; } catch (_) {}
  function roles() { return root.NA_ROLES || null; }
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  function isOwner() { var r = roles(); return !!(r && r.role === 'owner' && r.confirmed); }
  function money(c) { var n = Number(c) / 100; try { return root.fmt(n); } catch (_) { return 'S/ ' + n.toFixed(2); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function toast(m, k) { try { root.toast(m, k || 'error'); } catch (_) {} }
  function pending(kind) { return state.reviews.filter(function (r) { return r.status === 'pendiente' && (!kind || r.kind === kind); }); }
  function flaggedIds() {
    var set = new Set(); (state.all || state.reviews).forEach(function (r) { if (r.kind === 'discount') set.add(String(r.ref_id)); }); return set;
  }
  var idsMemo = null;
  function isFlagged(sale) {
    if (!sale || !cloud()) return false;
    if (!idsMemo) idsMemo = flaggedIds();
    return idsMemo.has(String(sale.sale_id || '')) || idsMemo.has(String(sale.remote_sale_id || '')) || idsMemo.has(String(sale.id || ''));
  }
  function reviewFor(sale) { var ids = [sale.sale_id, sale.remote_sale_id, sale.id].map(String); return (state.all || state.reviews).find(function (r) { return r.kind === 'discount' && ids.indexOf(String(r.ref_id)) >= 0; }) || null; }

  async function load() {
    var r = roles(); if (!cloud() || !r || state.busy || root.navigator.onLine === false) return;
    state.busy = true;
    try {
      var out = await r.api('/auth/reviews' + (isOwner() ? '?status=todos' : ''));
      var list = Array.isArray(out && out.reviews) ? out.reviews : [];
      state.all = isOwner() ? list : null;
      state.reviews = list; state.at = Date.now(); idsMemo = null;
      try { root.localStorage.setItem(CACHE, JSON.stringify({ reviews: list.filter(function (x) { return x.status === 'pendiente'; }), at: state.at })); } catch (_) {}
      paint();
    } catch (_) { /* sin servidor: se conserva el último aviso */ } finally { state.busy = false; }
  }

  function paint() {
    var home = doc.querySelector('#pageMenu .home-shell'); if (!home) return;
    var box = doc.getElementById('naReviewNotice'), closes = pending('cash_close_diff'), discounts = pending('discount');
    var show = cloud() && (closes.length || (isOwner() && discounts.length));
    if (!show) { if (box) box.remove(); return; }
    if (!box) { box = doc.createElement('div'); box.id = 'naReviewNotice'; box.className = 'na-review-notice'; box.setAttribute('role', 'status'); home.insertBefore(box, home.children[1] || null); }
    var text = closes.length ? '⚠ Cierre pendiente de aprobación del dueño' + (closes.length > 1 ? ' (' + closes.length + ')' : '') : '';
    if (isOwner() && discounts.length) text += (text ? ' · ' : '⚠ ') + discounts.length + ' descuento' + (discounts.length > 1 ? 's' : '') + ' por autorizar';
    box.innerHTML = '<span>' + esc(text) + '</span>' + (isOwner() ? '<button type="button" class="na-review-open">Revisar</button>' : '');
    var b = box.querySelector('.na-review-open'); if (b) b.onclick = openPanel;
  }

  function label(r) {
    if (r.kind === 'cash_close_diff') { var d = Number(r.amount_cents); return 'Cierre de caja con diferencia ' + (d > 0 ? '+' : '') + money(d) + (d < 0 ? ' (faltante)' : ' (sobrante)'); }
    return 'Descuento bajo catálogo: ' + money(r.amount_cents) + ' menos';
  }
  function openPanel() {
    if (!isOwner()) { toast('Solo el dueño revisa los pendientes'); return; }
    if (root.navigator.onLine === false) { toast('Sin conexión: revisar pendientes necesita internet'); return; }
    var old = doc.getElementById('naReviewPanel'); if (old) old.remove();
    var wrap = doc.createElement('div'); wrap.id = 'naReviewPanel'; wrap.className = 'na-review-overlay';
    var rows = pending();
    wrap.innerHTML = '<div class="na-review-box" role="dialog" aria-label="Pendientes del dueño"><h3>Pendientes del dueño</h3>' +
      (rows.length ? rows.map(function (r) {
        return '<div class="na-review-row" data-flag="' + esc(r.flag_id) + '"><div><b>' + esc(label(r)) + '</b><small>' + esc(r.ref_id) + ' · ' + esc(String(r.created_at || '').slice(0, 16).replace('T', ' ')) + '</small></div>' +
          '<div class="na-review-actions"><button type="button" data-d="aprobado">Aprobar</button><button type="button" data-d="rechazado" class="danger">' + (r.kind === 'discount' ? 'Rechazar (faltante)' : 'Rechazar') + '</button></div></div>';
      }).join('') : '<p>No hay pendientes.</p>') + '<button type="button" class="na-review-close">Listo</button></div>';
    doc.body.appendChild(wrap);
    wrap.querySelector('.na-review-close').onclick = function () { wrap.remove(); };
    wrap.querySelectorAll('.na-review-row button').forEach(function (btn) {
      btn.onclick = async function () {
        var row = btn.closest('.na-review-row'); btn.disabled = true;
        try {
          var out = await roles().api('/auth/reviews/resolve', { flag_id: row.dataset.flag, decision: btn.dataset.d });
          row.remove();
          toast(out.status === 'rechazado' && out.shortage_cents ? 'Rechazado: faltante del cajero ' + money(out.shortage_cents) : 'Revisión registrada', 'success');
          await load(); rerenderVentas();
        } catch (e) { btn.disabled = false; toast(roles().message(e)); }
      };
    });
  }
  function rerenderVentas() { try { if (doc.getElementById('pageVentas')?.classList.contains('active')) root.ventasRender(); } catch (_) {} }

  // Filtro del dueño en Historial.
  function ensureFilter() {
    var sel = doc.getElementById('ventasMetodo'); if (!sel) return;
    var opt = sel.querySelector('option[value="__descuento"]');
    if (isOwner() && cloud()) { if (!opt) { opt = doc.createElement('option'); opt.value = '__descuento'; opt.textContent = '⚠ Descuento por autorizar'; sel.appendChild(opt); } }
    else if (opt) { if (sel.value === '__descuento') sel.value = ''; opt.remove(); }
  }

  // Cierre de empleado con diferencia: solo con internet.
  function expectedCents() {
    try { var api = root.NuevoAmanecerCanonical, snap = api && api.snapshot && api.snapshot(); var open = (snap && snap.cashSessions || []).filter(function (s) { return s.status === 'OPEN'; });
      if (open.length === 1 && Number.isFinite(Number(open[0].expected_cents))) return Number(open[0].expected_cents); } catch (_) {}
    try { var t = root.cajTotales(); if (t && Number.isFinite(Number(t.ef))) return Math.round(Number(t.ef) * 100); } catch (_) {}
    return null;
  }
  function guardClose() {
    var orig = root.cerrarCaja; if (typeof orig !== 'function' || orig.__naReviewGuard) return;
    var wrapped = function () {
      var r = roles();
      if (cloud() && r && r.role !== 'owner' && root.navigator.onLine === false) {
        var v = Number(String(doc.getElementById('cajContado')?.value || '').replace(',', '.')), exp = expectedCents();
        if (!Number.isFinite(v) || exp === null || Math.round(v * 100) !== exp) {
          toast('Sin conexión: un cierre con diferencia necesita internet para avisar al dueño. No se guardó nada; conéctate e intenta de nuevo.');
          return false;
        }
      }
      return orig.apply(this, arguments);
    };
    wrapped.__naReviewGuard = true; root.cerrarCaja = wrapped;
  }

  root.NA_REVIEWS = { load: load, paint: paint, isFlagged: isFlagged, reviewFor: reviewFor, openPanel: openPanel, pending: pending, ensureFilter: ensureFilter, guardClose: guardClose };
  function boot() { guardClose(); ensureFilter(); paint(); load(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
  root.addEventListener('load', function () { setTimeout(function () { guardClose(); ensureFilter(); }, 0); });
  root.addEventListener('online', load);
  root.addEventListener('na:role', function () { ensureFilter(); load(); });
  setInterval(function () { if (doc.visibilityState === 'visible') load(); }, 60000);
})(window);
