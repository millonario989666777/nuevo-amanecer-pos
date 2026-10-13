/*
 * canonical-status-banner.js: franja superior única de estado CANON (Etapa 1.5,
 * auditoría integral 2026-10-12).
 *
 * Una sola franja fina arriba, en lugar de avisos sueltos:
 *  - ámbar: hay operaciones esperando envío y se reintentan solas (MISMO
 *    operation_id, nunca un registro nuevo);
 *  - rojo: algo fue rechazado o está bloqueado (ventas en revisión, operación
 *    rechazada) o la caja abierta es de otro día.
 * Muestra el número y un botón «Ver». Al reconectar reintenta la operación
 * pendiente con su mismo operation_id. Solo lee estado local: no hace lecturas
 * de red periódicas (cuida el plan gratuito).
 */
(function (root) {
  'use strict';
  var ID = 'naStatusBanner';
  var DEFINITIVE = [400, 404, 409];

  function canonical() { var c = root.NuevoAmanecerCanonical; return c && typeof c.enabled === 'function' && c.enabled() ? c : null; }
  function outbox() { return root.NuevoAmanecerCanonicalSaleOutbox || null; }
  function today() {
    try { if (typeof root.obtenerHoy === 'function') return root.obtenerHoy(); } catch (_) {}
    var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  // Estado puro (sin DOM) para poder probarlo.
  function compute() {
    var c = canonical(), o = outbox();
    var state = { retrying: 0, blocked: 0, otherDay: null, offline: false, items: [] };
    if (!c) return state;
    try { state.offline = !!(root.navigator && root.navigator.onLine === false); } catch (_) {}
    try {
      var intents = o && typeof o.snapshot === 'function' ? (o.snapshot().intents || []) : [];
      if (intents.length) { state.retrying += intents.length; state.items.push(intents.length === 1 ? '1 venta por enviar' : intents.length + ' ventas por enviar'); }
    } catch (_) {}
    try {
      var held = o && typeof o.quarantine === 'function' ? (o.quarantine().entries || []).filter(function (e) { return e && e.status === 'QUARANTINED'; }) : [];
      if (held.length) { state.review = held.length; state.blocked += held.length; state.items.push(held.length === 1 ? '1 venta en revisión' : held.length + ' ventas en revisión'); }
    } catch (_) {}
    try {
      var pending = typeof c.pendingSnapshot === 'function' ? c.pendingSnapshot() : null;
      if (pending && pending.command && pending.command !== 'sale.create') {
        if (pending.last_error && DEFINITIVE.indexOf(Number(pending.last_status)) !== -1) {
          state.blocked += 1; state.items.push('1 operación rechazada (' + String(pending.command) + ')');
        } else { state.retrying += 1; state.items.push('1 operación pendiente (' + String(pending.command) + ')'); }
      }
    } catch (_) {}
    try {
      var snap = typeof c.snapshot === 'function' ? c.snapshot() : null;
      var adapter = root.NuevoAmanecerCanonicalUIAdapter;
      var cash = snap && adapter && typeof adapter.cashState === 'function' ? adapter.cashState(snap.cashSessions) : null;
      if (cash && cash.abierta && cash.fechaApertura && cash.fechaApertura !== today()) {
        state.otherDay = cash.fechaApertura; state.items.push('caja abierta del ' + cash.fechaApertura);
      }
    } catch (_) {}
    return state;
  }

  function view(state) {
    var count = state.retrying + state.blocked;
    if (!count && !state.otherDay && !state.offline) return null;
    var red = state.blocked > 0 || !!state.otherDay;
    var parts = [];
    if (state.offline) parts.push('Sin conexión · ventas guardadas aquí');
    var review = state.review || 0, otherBlocked = state.blocked - review;
    if (review) parts.push((review === 1 ? '1 venta en revisión' : review + ' ventas en revisión') + ' · no la cobres de nuevo');
    if (otherBlocked > 0) parts.push(otherBlocked === 1 ? '1 operación rechazada o bloqueada' : otherBlocked + ' operaciones rechazadas o bloqueadas');
    if (state.retrying) parts.push((state.retrying === 1 ? '1 operación pendiente' : state.retrying + ' operaciones pendientes') + ' · reintentando');
    if (state.otherDay) parts.push('La caja abierta es del ' + state.otherDay + ': ciérrala y abre la de hoy');
    return { tone: red ? 'red' : 'amber', count: count, text: parts.join(' · '), detail: state.items.join('\n'), review: state.review || 0 };
  }

  function element() {
    var doc = root.document;
    if (!doc || typeof doc.getElementById !== 'function') return null;
    var el = doc.getElementById(ID);
    if (el || !doc.body || typeof doc.createElement !== 'function') return el;
    el = doc.createElement('div');
    el.id = ID; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:sticky;top:0;left:0;right:0;z-index:9000;display:none;align-items:center;gap:8px;'
      + 'min-height:28px;padding:4px 10px;font:600 12px/1.3 system-ui,sans-serif;box-sizing:border-box';
    var text = doc.createElement('span'); text.className = 'na-sb-text'; text.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    var btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'na-sb-ver'; btn.textContent = 'Ver';
    btn.style.cssText = 'flex:none;min-height:24px;padding:2px 12px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer';
    btn.addEventListener('click', openDetail);
    el.appendChild(text); el.appendChild(btn);
    doc.body.insertBefore(el, doc.body.firstChild);
    return el;
  }

  var last = null;
  function render() {
    var v = view(compute()); last = v;
    var el = element(); if (!el) return v;
    var body = root.document.body;
    if (!v) { el.style.display = 'none'; if (body && body.classList) body.classList.remove('na-sb-on'); return v; }
    el.style.display = 'flex';
    // Reserva el alto de la franja para que no tape la barra fija de Nueva venta (☰).
    if (body && body.classList) { body.classList.add('na-sb-on'); if (body.style && body.style.setProperty) body.style.setProperty('--na-sb-h', (el.offsetHeight || 28) + 'px'); }
    el.dataset.tone = v.tone;
    el.style.background = v.tone === 'red' ? '#fee2e2' : '#fef3c7';
    el.style.color = v.tone === 'red' ? '#991b1b' : '#92400e';
    el.style.borderBottom = '1px solid ' + (v.tone === 'red' ? '#fca5a5' : '#fcd34d');
    var text = el.querySelector ? el.querySelector('.na-sb-text') : null;
    if (text) { text.textContent = (v.tone === 'red' ? '⛔ ' : '⏳ ') + v.text; text.title = v.detail; }
    var ver = el.querySelector ? el.querySelector('.na-sb-ver') : null;
    if (ver) ver.textContent = v.review ? 'Resolver' : 'Ver';
    return v;
  }

  function openDetail() {
    // Ítem 6: con ventas en revisión, «Resolver» abre directamente la lista con Verificar / Reintentar / Anular.
    var bridge = root.NuevoAmanecerCanonicalCashBridge;
    if (last && last.review && bridge && typeof bridge.showReview === 'function') { try { if (bridge.showReview()) return; } catch (_) {} }
    try { if (typeof root.goPage === 'function') root.goPage('pageCaja'); } catch (_) {}
    // toast es un const de nivel superior en inline-01 (no es propiedad de window).
    var fn = null; try { if (typeof toast === 'function') fn = toast; } catch (_) {}
    if (!fn && typeof root.toast === 'function') fn = root.toast;
    try { if (fn && last) fn(last.detail.replace(/\n/g, ' · '), last.tone === 'red' ? 'error' : 'warning'); } catch (_) {}
  }

  // Reconexión: reintenta la operación pendiente (no venta) con su MISMO
  // operation_id. Las ventas las reintenta la cola de ventas.
  var retrying = false;
  async function retryOnReconnect() {
    var c = canonical();
    if (!c || retrying || typeof c.retryPending !== 'function' || typeof c.pendingSnapshot !== 'function') return render();
    var pending = null; try { pending = c.pendingSnapshot(); } catch (_) {}
    if (!pending || pending.command === 'sale.create' || pending.command === 'cash.close' || pending.invalid
      || (pending.last_error && DEFINITIVE.indexOf(Number(pending.last_status)) !== -1)) return render();
    retrying = true;
    try { await c.retryPending(); if (typeof c.refresh === 'function') await c.refresh(); } catch (_) {}
    finally { retrying = false; }
    return render();
  }

  var timer = null;
  function start() {
    if (timer || typeof root.addEventListener !== 'function') return;
    root.addEventListener('na:canonical-updated', render);
    root.addEventListener('offline', render);
    root.addEventListener('online', function () { setTimeout(retryOnReconnect, 1500); });
    timer = setInterval(render, 5000);
    render();
  }

  root.NuevoAmanecerStatusBanner = Object.freeze({ compute: compute, view: view, render: render, retryOnReconnect: retryOnReconnect, start: start });
  if (root.document && typeof root.document.addEventListener === 'function' && root.document.body !== undefined) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(globalThis);
