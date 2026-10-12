/* Etapa 2 (G, punto 4): anular una venta CANON en el servidor.
   - Solo con internet: sin conexión se avisa y no se guarda nada en cola.
   - Pide el PIN del dueño; el servidor lo valida y ata la aprobación al operation_id.
   - El operation_id se recuerda por venta: un reintento nunca repite la devolución ni el stock.
   - Sin nube (modo local) se usa la anulación local de siempre. */
(function (root) {
  'use strict';
  var doc = root.document, CACHE = 'na_sale_annulments_v1', OPS = 'na_sale_annul_ops_v1';
  var state = { map: {}, busy: false };
  try { state.map = JSON.parse(root.localStorage.getItem(CACHE) || '{}') || {}; } catch (_) { state.map = {}; }
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  function roles() { return root.NA_ROLES || null; }
  function toast(m, k) { try { root.toast(m, k || 'error'); } catch (_) {} }
  function money(c) { var n = Number(c) / 100; try { return root.fmt(n); } catch (_) { return 'S/ ' + n.toFixed(2); } }
  function sid(sale) { return String(sale && (sale.sale_id || sale.id) || ''); }
  function getVentas() { try { return ventas; } catch (_) { return []; } } // eslint-disable-line no-undef
  function mark() {
    var list = getVentas(); if (!Array.isArray(list)) return;
    list.forEach(function (v) { var a = state.map[sid(v)]; if (a && a.status === 'anulada' && v.canonical) { v.anulada = true; v.anulacionMotivo = a.reason; } });
  }
  function save() { try { root.localStorage.setItem(CACHE, JSON.stringify(state.map)); } catch (_) {} }
  async function load() {
    var r = roles(); if (!cloud() || !r || state.busy || root.navigator.onLine === false) return;
    state.busy = true;
    try {
      var out = await r.api('/auth/sale-annulments');
      var next = {}; (out.annulments || []).forEach(function (a) { next[String(a.sale_id)] = { status: a.status, reason: a.reason }; });
      state.map = next; save(); mark(); rerender();
    } catch (_) {} finally { state.busy = false; }
  }
  function rerender() { try { if (doc.getElementById('pageVentas')?.classList.contains('active')) root.ventasRender(); } catch (_) {} }
  function canAnnul(sale) {
    return cloud() && !!sale && sale.canonical && !sale.anulada && sale.metodo !== 'credito' && !!sid(sale);
  }
  function opFor(saleId) {
    var ops = {}; try { ops = JSON.parse(root.localStorage.getItem(OPS) || '{}') || {}; } catch (_) {}
    if (!ops[saleId]) { ops[saleId] = 'annul-' + root.crypto.randomUUID(); try { root.localStorage.setItem(OPS, JSON.stringify(ops)); } catch (_) {} }
    return ops[saleId];
  }
  function askReason(sale) {
    return new Promise(function (resolve) {
      var wrap = doc.createElement('div'); wrap.className = 'na-review-overlay'; wrap.id = 'naAnnulDialog';
      wrap.innerHTML = '<div class="na-review-box" role="dialog" aria-label="Anular venta"><h3>Anular venta</h3>' +
        '<p style="margin:0 0 8px;color:#475569;font-size:14px">Se devolverá el stock' + (sale.metodo === 'efectivo' || (sale.paymentBreakdown && sale.paymentBreakdown.efectivo) ? ' y se sacará de la caja el efectivo cobrado' : '') +
        '. La venta queda en el historial como ANULADA. Pide el PIN del dueño.</p>' +
        '<textarea id="naAnnulReason" rows="2" maxlength="200" placeholder="Motivo (obligatorio)" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:8px;font:inherit"></textarea>' +
        '<div class="na-review-actions" style="margin-top:12px;justify-content:flex-end"><button type="button" class="na-annul-cancel" style="background:#64748b">Cancelar</button><button type="button" class="na-annul-ok danger">Anular venta</button></div></div>';
      doc.body.appendChild(wrap);
      var ta = wrap.querySelector('textarea'); setTimeout(function () { ta.focus(); }, 50);
      function done(v) { wrap.remove(); resolve(v); }
      wrap.querySelector('.na-annul-cancel').onclick = function () { done(null); };
      wrap.querySelector('.na-annul-ok').onclick = function () { var v = ta.value.trim(); if (!v) { toast('Escribe el motivo de la anulación'); return; } done(v); };
    });
  }
  var ERR = {
    already_annulled: 'Esta venta ya fue anulada; no se hizo ningún movimiento nuevo.',
    annul_credit_sale_unsupported: 'Una venta al crédito se corrige desde Créditos; aquí no se anula.',
    cash_session_required: 'Abre la caja para devolver el efectivo de esta venta.',
    cash_insufficient: 'No hay suficiente efectivo en la caja para devolver esta venta.',
    owner_approval_required: 'Falta la autorización del dueño.',
    annul_schema_not_ready: 'El servidor todavía no tiene activada la anulación. Intenta más tarde.',
    sale_not_found: 'El servidor no encontró esta venta.'
  };
  var busy = false;
  async function annul(saleId) {
    if (busy) return;
    var sale = getVentas().find(function (v) { return String(v.id) === String(saleId) || sid(v) === String(saleId); });
    if (!sale) { toast('Venta no encontrada'); return; }
    if (sale.anulada) { toast('La venta ya fue anulada; no se realizaron nuevos movimientos'); return; }
    if (root.navigator.onLine === false) { toast('Sin conexión: anular una venta necesita internet. No se guardó nada.'); return; }
    if (sale.metodo === 'credito') { toast(ERR.annul_credit_sale_unsupported); return; }
    var reason = await askReason(sale); if (!reason) return;
    if (root.navigator.onLine === false) { toast('Sin conexión: anular una venta necesita internet. No se guardó nada.'); return; }
    busy = true;
    try {
      var api = root.NuevoAmanecerCanonical, r = roles(), saleKey = sid(sale), op = opFor(saleKey);
      await api.prepareCommand('inventory.adjust');
      var ctx = api.commandContext();
      var approval = await r.approve('sale.annul', op, 'Anular venta', 'Anular la venta ' + sale.id + ': pide al dueño que escriba su PIN.');
      if (!approval) return;
      var out = await r.api('/commands/sale.annul', { operation_id: op, promotion_id: ctx.promotion_id, authority_epoch: ctx.authority_epoch,
        expected_control_revision: ctx.expected_control_revision, client_contract: ctx.client_contract, created_at: ctx.created_at, sale_id: saleKey, reason: reason },
        'POST', { 'x-owner-approval': String(approval).slice(0, 80) });
      state.map[saleKey] = { status: 'anulada', reason: reason }; save(); mark();
      var msg = 'Venta anulada. Stock devuelto' + (out.cash_refund_cents ? ' · efectivo devuelto ' + money(out.cash_refund_cents) : '') + (out.digital_to_refund_cents ? ' · devuelve ' + money(out.digital_to_refund_cents) + ' por Yape/Plin/transferencia' : '');
      toast(msg, 'success');
      try { await api.refresh(); } catch (_) {}
      mark(); rerender();
    } catch (e) {
      var code = e && (e.data && e.data.error || e.message);
      if (code === 'already_annulled') { await load(); }
      toast(ERR[code] || (e && e.status ? 'No se pudo anular (' + code + '). Puedes reintentar: no se repetirá nada.' : 'No se pudo conectar con el servidor. Revisa internet; no se guardó nada nuevo.'));
    } finally { busy = false; }
  }
  function install() {
    var orig = root.anularV; if (typeof orig !== 'function' || orig.__naServerAnnul) return;
    var wrapped = function (id) { if (cloud()) return annul(id); return orig.apply(this, arguments); };
    wrapped.__naServerAnnul = true; root.anularV = wrapped;
    var render = root.ventasRender;
    if (typeof render === 'function' && !render.__naAnnulMark) { var w = function () { mark(); return render.apply(this, arguments); }; w.__naAnnulMark = true; root.ventasRender = w; }
  }
  root.NA_ANNUL = { load: load, annul: annul, canAnnul: canAnnul, mark: mark, install: install };
  function boot() { install(); load(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
  root.addEventListener('load', function () { setTimeout(install, 0); });
  root.addEventListener('online', load);
  setInterval(function () { if (doc.visibilityState === 'visible') load(); }, 120000);
})(window);
