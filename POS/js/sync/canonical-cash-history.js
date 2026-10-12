// Historial de cierres de caja (CANON, solo lectura).
// Fuente: réplica canónica ya sincronizada (cash_sessions = vista canonical_cash_state,
// cash_movements con session_id, financial_events, expenses). No hace llamadas
// nuevas al Worker: usa client.snapshot() sin refrescar, así no suma subrequests.
(function (root) {
  'use strict';
  if (root.NuevoAmanecerCashHistory) return;

  var CASHIER_KEY = 'na_canonical_cash_session_cashiers';
  var LIMA_OFFSET_MS = 5 * 60 * 60 * 1000; // America/Lima: UTC-5 sin horario de verano

  function api() { return root.NuevoAmanecerCanonical; }
  function enabled() {
    var client = api();
    try { return !!(client && typeof client.enabled === 'function' && client.enabled()); } catch (_) { return false; }
  }
  function int(value) { var n = Number(value); return Number.isSafeInteger(n) ? n : 0; }
  function text(value) { return value == null ? '' : String(value); }
  function pad(v) { return String(v).padStart(2, '0'); }
  function ms(value) {
    var raw = text(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
    var t = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z').getTime();
    return Number.isFinite(t) ? t : null;
  }
  function lima(value) {
    var t = ms(value);
    if (t === null) return { date: '', time: '', label: '' };
    var d = new Date(t - LIMA_OFFSET_MS);
    var date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    var time = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return { date: date, time: time, label: pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() };
  }
  function money(cents) {
    var n = int(cents), sign = n < 0 ? '-' : '';
    return sign + 'S/ ' + (Math.abs(n) / 100).toFixed(2);
  }

  function storage() { try { return root.localStorage || null; } catch (_) { return null; } }
  function cashierMap() {
    var store = storage();
    try { var parsed = JSON.parse(store && store.getItem(CASHIER_KEY) || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch (_) { return {}; }
  }
  // Registro local (este dispositivo) de quién abrió cada sesión. El servidor no
  // guarda el cajero de la sesión; si la abrió otro equipo se muestra "No registrado".
  function rememberCashier(sessionId, cashier) {
    var store = storage();
    if (!store || !sessionId || !cashier) return;
    var map = cashierMap();
    map[String(sessionId)] = { id: text(cashier.id), nombre: text(cashier.nombre || cashier.name || cashier.id).slice(0, 80) };
    var keys = Object.keys(map);
    if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(function (k) { delete map[k]; });
    try { store.setItem(CASHIER_KEY, JSON.stringify(map)); } catch (_) {}
  }

  // Resumen por sesión: totales atribuidos por session_id; los cobros digitales
  // (sin session_id) se atribuyen por su hora dentro de [apertura, cierre].
  function summarize(snapshot, cashiers) {
    var data = snapshot || {};
    var map = cashiers || {};
    var sessions = (Array.isArray(data.cashSessions) ? data.cashSessions : []).filter(function (s) { return s && s.session_id; });
    var movements = Array.isArray(data.cashMovements) ? data.cashMovements : [];
    var events = Array.isArray(data.financialEvents) ? data.financialEvents : [];
    var expenses = Array.isArray(data.expenses) ? data.expenses : [];
    var windows = sessions.map(function (s) { return { id: s.session_id, from: ms(s.opened_at), to: s.status === 'CLOSED' ? ms(s.closed_at) : null }; });
    function windowFor(at) {
      var t = ms(at); if (t === null) return null;
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (w.from !== null && t >= w.from && (w.to === null || t <= w.to)) return w.id;
      }
      return null;
    }
    var totals = {};
    sessions.forEach(function (s) { totals[s.session_id] = { ventas: 0, ventasCount: 0, ventasEfectivo: 0, ventasDigital: 0, ventasCredito: 0, cobros: 0, cobrosCount: 0, cobrosEfectivo: 0, cobrosDigital: 0, anulaciones: 0, gastos: 0, ajustes: 0, sales: {} }; });
    movements.forEach(function (m) {
      var t = m && totals[m.session_id]; if (!t) return;
      t.ventas += int(m.amount_cents); t.ventasEfectivo += int(m.cash_cents); t.ventasDigital += int(m.digital_cents); t.ventasCredito += int(m.credit_cents);
      if (m.sale_id && !t.sales[m.sale_id]) { t.sales[m.sale_id] = true; t.ventasCount += 1; }
    });
    events.forEach(function (e) {
      if (!e) return;
      var sid = e.session_id || windowFor(e.created_at), t = totals[sid]; if (!t) return;
      if (e.event_type === 'PAYMENT') {
        var amount = -int(e.credit_delta_cents);
        t.cobros += amount; t.cobrosCount += 1;
        if (e.payment_method === 'efectivo') t.cobrosEfectivo += amount; else t.cobrosDigital += amount;
      } else if (e.event_type === 'COMPENSATION') {
        if (e.credit_id) t.anulaciones += int(e.credit_delta_cents); else t.ajustes += int(e.cash_delta_cents);
      } else if (e.event_type === 'ADJUSTMENT') {
        t.ajustes += int(e.cash_delta_cents);
      }
    });
    expenses.forEach(function (x) { var t = x && totals[x.session_id]; if (t) t.gastos += int(x.amount_cents); });
    return sessions.slice().sort(function (a, b) { return text(b.opened_at).localeCompare(text(a.opened_at)); }).map(function (s) {
      var t = totals[s.session_id], opened = lima(s.opened_at), closed = lima(s.closed_at), who = map[s.session_id];
      delete t.sales;
      return Object.assign({
        sessionId: s.session_id,
        status: s.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        fecha: opened.date,
        fechaLabel: opened.label,
        apertura: opened.time,
        cierre: closed.time,
        cierreFecha: closed.date,
        fondo: int(s.opening_cents),
        esperado: int(s.expected_cents),
        contado: s.counted_cents == null ? null : int(s.counted_cents),
        diferencia: s.difference_cents == null ? null : int(s.difference_cents),
        cajero: who && who.nombre ? who.nombre : ''
      }, t);
    });
  }

  function el(tag, cls, content, css) {
    var node = root.document.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = content;
    if (css) node.style.cssText = css;
    return node;
  }
  function line(parent, label, value, css) {
    var row = el('div', 'na-cash-hist-row', null, 'display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:2px 0');
    row.append(el('span', '', label, 'color:var(--slate)'), el('span', '', value, 'font-weight:700' + (css ? ';' + css : '')));
    parent.append(row);
  }

  function render(container) {
    var client = api();
    var rows = [];
    try { rows = summarize(client.snapshot(), cashierMap()).filter(function (r) { return r.status === 'CLOSED'; }); } catch (_) { rows = []; }
    container.replaceChildren();
    var wrap = el('div', 'na-cash-history', null, 'padding:13px;display:flex;flex-direction:column;gap:10px');
    wrap.setAttribute('data-na-cash-history', 'true');
    wrap.append(el('div', 'mov-section-title', 'Historial de cierres · ' + rows.length + (rows.length === 1 ? ' cierre' : ' cierres')));
    wrap.append(el('div', '', 'Solo lectura. Fechas y horas de Lima. Datos de la última sincronización.', 'font-size:11px;color:var(--slate)'));
    if (!rows.length) wrap.append(el('div', 'na-cash-hist-empty', 'Aún no hay cierres de caja registrados en CANON.', 'font-size:13px;color:var(--slate);padding:14px 0'));
    rows.forEach(function (r) {
      var card = el('div', 'na-cash-hist-card', null, 'border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:10px 12px;background:var(--white,#fff)');
      card.setAttribute('data-session-id', r.sessionId);
      card.append(el('div', 'na-cash-hist-title', '📅 ' + r.fechaLabel + ' · ' + r.apertura + ' → ' + (r.cierreFecha && r.cierreFecha !== r.fecha ? r.cierreFecha.split('-').reverse().join('/') + ' ' : '') + r.cierre, 'font-size:13px;font-weight:800;margin-bottom:4px'));
      line(card, 'Cajero', r.cajero || 'No registrado');
      line(card, 'Fondo inicial', money(r.fondo));
      line(card, 'Ventas (' + r.ventasCount + ')', money(r.ventas));
      if (r.ventasCredito) line(card, '   · al crédito', money(r.ventasCredito));
      line(card, 'Cobros (' + r.cobrosCount + ')', money(r.cobros));
      if (r.anulaciones) line(card, 'Abonos anulados', money(r.anulaciones));
      if (r.gastos) line(card, 'Gastos', money(r.gastos));
      line(card, 'Efectivo esperado', money(r.esperado));
      line(card, 'Efectivo contado', r.contado == null ? '—' : money(r.contado));
      var diff = r.diferencia == null ? 0 : r.diferencia;
      line(card, 'Diferencia', r.diferencia == null ? '—' : (diff > 0 ? '+' : '') + money(diff) + (diff === 0 ? ' ✅' : diff > 0 ? ' (sobrante)' : ' (faltante)'), diff < 0 ? 'color:#b91c1c' : diff > 0 ? 'color:#b45309' : 'color:#15803d');
      wrap.append(card);
    });
    container.append(wrap);
    return rows;
  }

  function currentTab() { try { return typeof cajTab !== 'undefined' ? cajTab : ''; } catch (_) { return ''; } }

  function ensureTab() {
    var doc = root.document;
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var bar = doc.querySelector('#pageCaja .tabs-wrap');
    if (!bar) return null;
    var existing = bar.querySelector('[data-na-cash-history-tab]');
    if (existing) { existing.hidden = !enabled(); return existing; }
    if (!enabled()) return null;
    var button = el('button', 'tab', '🗂️ Historial');
    button.type = 'button';
    button.setAttribute('data-na-cash-history-tab', 'true');
    button.addEventListener('click', function () { if (typeof root.cajSetTab === 'function') root.cajSetTab(button, 'historial'); });
    bar.append(button);
    return button;
  }

  function wrapRender() {
    var current = root.cajRender;
    if (typeof current !== 'function' || current.__naCashHistory) return;
    var wrapped = function () {
      ensureTab();
      if (currentTab() === 'historial' && enabled()) {
        var host = root.document && root.document.getElementById('cajContent');
        if (host) { render(host); if (typeof root.updateDashboard === 'function') { try { root.updateDashboard(); } catch (_) {} } return; }
      }
      return current.apply(this, arguments);
    };
    wrapped.__naCashHistory = true;
    root.cajRender = wrapped;
  }

  wrapRender();
  try { ensureTab(); } catch (_) {}
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('load', function () { try { wrapRender(); ensureTab(); } catch (_) {} });
    root.addEventListener('na:canonical-updated', function () { try { ensureTab(); } catch (_) {} });
  }

  root.NuevoAmanecerCashHistory = Object.freeze({ summarize: summarize, render: render, rememberCashier: rememberCashier, cashierMap: cashierMap, lima: lima, ensureTab: ensureTab });
})(globalThis);
