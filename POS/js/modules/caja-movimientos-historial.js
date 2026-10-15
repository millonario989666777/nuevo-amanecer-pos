(function (root) {
  'use strict';
  const methods = ['efectivo', 'yape', 'plin', 'transferencia', 'credito'];
  const labels = { efectivo: 'Efectivo', yape: 'Yape', plin: 'Plin', transferencia: 'Transferencia', credito: 'Quedó a crédito' };
  const types = { todos: 'Todos', contado: 'Venta contado', credito: 'Venta a crédito', cob: 'Cobro de crédito', egr: 'Egreso', gas: 'Gasto', ing: 'Ingreso' };
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const cents = v => Math.round(num(v) * 100);
  const money = v => 'S/ ' + (num(v) / 100).toFixed(2);
  function lima(value) {
    const d = new Date(new Date(value).getTime() - 18000000);
    return Number.isFinite(d.getTime()) ? { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) } : { date: '', time: '' };
  }
  const limaToday = (now = new Date()) => lima(now).date;
  const addDays = (date, n) => new Date(new Date(date + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  function presetRange(preset, now) {
    const today = limaToday(now);
    if (preset === 'ayer') return { desde: addDays(today, -1), hasta: addDays(today, -1) };
    return { desde: preset === '7' ? addDays(today, -6) : preset === 'mes' ? today.slice(0, 7) + '-01' : today, hasta: today };
  }
  const openingDate = r => r.fechaApertura || r.fecha || lima(r.timestampApertura || r.opened_at).date;
  const inRangeByOpening = (r, desde, hasta) => !!openingDate(r) && openingDate(r) >= desde && openingDate(r) <= hasta;
  const filterClosesByOpening = (rows, desde, hasta) => rows.filter(r => inRangeByOpening(r, desde, hasta));
  function salesPerDay(rows, desde, hasta) {
    const result = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return result;
    for (let day = desde; day <= hasta; day = addDays(day, 1)) result.push({ date: day, total: rows.filter(r => openingDate(r) === day).reduce((s, r) => s + num(r.ventas), 0) });
    return result;
  }
  function isSale(m) { return typeof root._naIsSaleIncomeMove === 'function' ? root._naIsSaleIncomeMove(m) : m.tipo === 'ing' && (m.ventaId != null || /\bventa\b/i.test((m.cat || '') + ' ' + (m.desc || ''))); }
  function reversal(m) { return typeof root._naIsSaleReversalMove === 'function' ? root._naIsSaleReversalMove(m) : m.tipo === 'egr' && m.reversal === true && m.ventaId != null && String(m.reversalOf || '') === String(m.ventaId); }
  function classifyMove(m) { return isSale(m) ? m.metodo === 'credito' ? 'credito' : 'contado' : types[m.tipo] ? m.tipo : 'ing'; }
  function paymentParts(m) {
    const p = Object.fromEntries(methods.map(k => [k, 0]));
    if (m.metodo === 'mixto') {
      const d = m.detallePago || {};
      p.efectivo = cents(d.efectivo ?? d.cash ?? m.efectivo);
      p.credito = cents(d.credito);
      ['yape', 'plin', 'transferencia'].forEach(k => { p[k] = cents(d[k]); });
      if (d.digital != null) p[['yape', 'plin', 'transferencia'].includes(d.digitalMethod) ? d.digitalMethod : 'transferencia'] += cents(d.digital);
      if (!m.detallePago) p.transferencia = Math.max(0, cents(m.monto) - p.efectivo);
    } else p[methods.includes(m.metodo) ? m.metodo : 'efectivo'] = cents(m.monto);
    return p;
  }
  function movementTotals(moves) {
    const t = { ventas: 0, entrada: 0, salidas: 0, neto: 0, cobros: 0, gastos: 0, metodos: Object.fromEntries(methods.map(k => [k, 0])), salesMethods: Object.fromEntries(methods.map(k => [k, 0])) };
    moves.forEach(m => {
      const p = paymentParts(m), sale = isSale(m), rev = reversal(m), amount = cents(m.monto);
      if (sale || rev) { t.ventas += (rev ? -1 : 1) * amount; methods.forEach(k => { t.salesMethods[k] += (rev ? -1 : 1) * p[k]; }); }
      if (m.tipo === 'ing' || m.tipo === 'cob') { t.entrada += methods.filter(k => k !== 'credito').reduce((s, k) => s + p[k], 0); methods.forEach(k => { t.metodos[k] += p[k]; }); }
      if (m.tipo === 'cob') t.cobros += amount;
      if (m.tipo === 'egr' || m.tipo === 'gas') t.salidas += rev && m.metodo === 'credito' ? 0 : amount;
      if (m.tipo === 'gas') t.gastos += amount;
    });
    t.neto = t.entrada - t.salidas;
    return t;
  }
  function sortMoves(moves) { const key = m => Number.isFinite(Date.parse(m.timestamp)) ? Date.parse(m.timestamp) : Date.parse((m.fecha || '2000-01-01') + 'T' + (m.hora24 || '00:00') + ':00-05:00'); return moves.slice().sort((a, b) => key(b) - key(a)); }
  function localRows(closes, moves) {
    return closes.map(r => {
      const date = openingDate(r);
      const matched = moves.filter(m => r.sessionId != null && m.sessionId != null && String(m.sessionId) === String(r.sessionId));
      const selected = matched.length ? matched : moves.filter(m => m.sessionId == null && m.fecha === date);
      const t = movementTotals(selected), o = lima(r.timestampApertura), c = lima(r.timestampCierre);
      return { sessionId: r.sessionId || r.id, fecha: date, apertura: r.hora24 || o.time, cierre: r.horaCierre24 || c.time, cierreFecha: r.fechaCierre || c.date, cajero: r.cajeroNombre || r.cajero || '', ventas: selected.length ? t.ventas : null, cobros: selected.length ? t.cobros : null, gastos: selected.length ? t.gastos : null, metodos: t.metodos, salesMethods: t.salesMethods, fondo: cents(r.fondo), esperado: cents(r.esperado), contado: r.contado == null ? null : cents(r.contado), diferencia: r.diferencia == null ? null : cents(r.diferencia), localMissing: !selected.length };
    });
  }
  root.NuevoAmanecerCajaViews = { classifyMove, lima, limaToday, presetRange, openingDate, inRangeByOpening, filterClosesByOpening, salesPerDay, movementTotals, paymentParts, sortMoves, localRows };
  if (!root.document) return;
  const doc = root.document;
  function el(tag, cls, text) { const n = doc.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; }
  function button(text, action, cls) { const b = el('button', cls || 'cv-chip', text); b.type = 'button'; b.addEventListener('click', action); return b; }
  function line(parent, label, value) { const row = el('div', 'cv-line'); row.append(el('span', '', label), el('strong', '', value)); parent.append(row); }
  function svg(tag, attrs) { const n = doc.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; }
  function donut(parent, parts) {
    const values = [parts.efectivo, parts.yape + parts.plin + parts.transferencia, parts.credito].map(v => Math.max(0, v));
    const chart = svg('svg', { viewBox: '0 0 120 120', class: 'cv-donut', role: 'img', 'aria-label': 'Distribución de ventas por forma de pago' });
    chart.append(svg('circle', { cx: 60, cy: 60, r: 44, fill: 'none', stroke: 'var(--line)', 'stroke-width': 18 }));
    let offset = 0; const total = values.reduce((s, v) => s + v, 0), colors = ['#16a34a', '#0284c7', '#a855f7'];
    values.forEach((v, i) => { const length = total ? v / total * 276.46 : 0; chart.append(svg('circle', { cx: 60, cy: 60, r: 44, fill: 'none', stroke: colors[i], 'stroke-width': 18, 'stroke-dasharray': length + ' ' + (276.46 - length), 'stroke-dashoffset': -offset, transform: 'rotate(-90 60 60)' })); offset += length; });
    const box = el('div', 'cv-donut-wrap'), legend = el('div', 'cv-legend'); ['Efectivo', 'Yape/Plin · Transferencia', 'Crédito'].forEach((l, i) => { const item = el('div', 'cv-legend-item'), swatch = el('span', 'cv-swatch'); swatch.style.background = colors[i]; swatch.setAttribute('aria-hidden', 'true'); const text = el('div'); text.append(el('span', '', l), el('strong', '', money(values[i]) + ' · ' + (total ? Math.round(values[i] / total * 100) : 0) + '%')); item.append(swatch, text); legend.append(item); }); box.append(chart, legend); parent.append(box);
  }
  let filter = 'todos', activePreset = '7', range = presetRange('7'), rangeMode = true;
  function movesNow() { return typeof cajMovs !== 'undefined' ? cajMovs : []; }
  function renderMoves(host) {
    const moves = movesNow(), wrap = el('div', 'cv-view'), summary = el('section', 'cv-card'), t = movementTotals(moves.filter(m => (m.timestamp ? lima(m.timestamp).date : m.fecha) === limaToday()));
    summary.append(el('h3', '', 'Ventas del día')); donut(summary, t.salesMethods);
    const totals = el('div', 'cv-summary-kpis');
    [['Total vendido', t.ventas], ['Entró a caja', t.entrada], ['Salidas', t.salidas], ['Neto en caja', t.neto]].forEach(([l, v]) => line(totals, l, money(v))); summary.append(totals);
    wrap.append(summary); const chips = el('div', 'cv-chips');
    Object.keys(types).forEach(k => { const count = moves.filter(m => k === 'todos' || classifyMove(m) === k).length; if (k === 'ing' && !count) return; const b = button(types[k] + ' (' + count + ')', () => { filter = k; renderMoves(host); }); b.setAttribute('aria-pressed', String(filter === k)); b.dataset.filter = k; chips.append(b); });
    wrap.append(chips, el('div', 'mov-section-title', moves.length + ' movimientos'));
    const list = el('div', 'mov-list cv-moves');
    sortMoves(moves).filter(m => filter === 'todos' || classifyMove(m) === filter).forEach(m => {
      const type = classifyMove(m), row = el('div', 'cv-move cv-' + type), body = el('div', 'cv-move-body'); row.dataset.moveId = m.id || '';
      body.append(el('span', 'cv-pill', types[type]), el('div', 'cv-description', m.desc || ''), el('small', '', (labels[m.metodo] || m.metodo || '') + (type === 'credito' ? ' · no entra a caja' : '')));
      row.append(el('time', '', m.timestamp ? lima(m.timestamp).time : m.hora24 || m.hora || ''), body, el('strong', 'cv-amount', (type === 'credito' ? '' : type === 'egr' || type === 'gas' ? '−' : '+') + money(cents(m.monto)))); list.append(row);
    });
    if (!list.children.length) list.append(el('p', '', 'Sin movimientos para este filtro.')); wrap.append(list); host.replaceChildren(wrap);
  }
  function canonicalEnabled() { try { return !!root.NuevoAmanecerCanonical?.enabled(); } catch (_) { return false; } }
  function historyRows() {
    if (canonicalEnabled()) { try { const h = root.NuevoAmanecerCashHistory; const snapshot = root.NuevoAmanecerCanonical.snapshot(); return h.summarize(snapshot, h.cashierMap()).filter(r => r.status === 'CLOSED').map(r => { r.salesMethods = Object.fromEntries(methods.map(k => [k, 0])); (snapshot.cashMovements || []).filter(m => m.session_id === r.sessionId).forEach(m => { r.salesMethods.efectivo += num(m.cash_cents); r.salesMethods.credito += num(m.credit_cents); r.salesMethods[['yape', 'plin', 'transferencia'].includes(m.digital_method) ? m.digital_method : 'transferencia'] += num(m.digital_cents); }); return r; }); } catch (_) { return []; } }
    return localRows(typeof cashClosures !== 'undefined' ? cashClosures : [], movesNow());
  }
  function renderHistory(host) {
    const wrap = el('div', 'cv-view na-cash-history'); wrap.dataset.naCashHistory = 'true';
    wrap.append(el('h3', '', 'Historial de cierres'), el('p', 'cv-note', canonicalEnabled() ? 'Datos del servidor (última sincronización)' : 'Datos locales de este dispositivo'), el('p', 'cv-note', 'Cada turno cuenta en la fecha en que se abrió.'));
    const controls = el('div', 'cv-card cv-date-controls');
    const modes = el('div', 'cv-chips cv-modes');
    [['Fecha', false], ['Rango', true]].forEach(([label, mode]) => { const b = button(label, () => { rangeMode = mode; activePreset = null; if (!mode) range.hasta = range.desde; renderHistory(host); }); b.setAttribute('aria-pressed', String(rangeMode === mode)); modes.append(b); }); controls.append(modes);
    function input(label, key) { const l = el('label', '', label), i = el('input'); i.type = 'date'; i.value = range[key]; i.dataset.range = key; i.addEventListener('change', () => { activePreset = null; range[key] = i.value; if (!rangeMode) range.hasta = range.desde; renderHistory(host); }); l.append(i); controls.append(l); }
    input(rangeMode ? 'Desde' : 'Fecha', 'desde'); if (rangeMode) input('Hasta', 'hasta');
    const presets = el('div', 'cv-chips'); [['Hoy', 'hoy'], ['Ayer', 'ayer'], ['7 días', '7'], ['Mes', 'mes']].forEach(([l, k]) => { const b = button(l, () => { activePreset = k; range = presetRange(k); rangeMode = range.desde !== range.hasta; renderHistory(host); }); b.setAttribute('aria-pressed', String(activePreset === k)); presets.append(b); }); controls.append(presets); wrap.append(controls);
    const rows = filterClosesByOpening(historyRows(), range.desde, range.hasta).sort((a, b) => (b.fecha + b.apertura).localeCompare(a.fecha + a.apertura));
    const kpi = el('div', 'cv-card cv-kpis'); [['Turnos', rows.length], ['Total vendido', rows.some(r => r.localMissing) ? '—' : money(rows.reduce((s, r) => s + num(r.ventas), 0))], ['Total diferencia', money(rows.reduce((s, r) => s + num(r.diferencia), 0))]].forEach(([l, v]) => line(kpi, l, v)); wrap.append(kpi);
    const charts = el('section', 'cv-card'); charts.append(el('h4', '', 'Ventas por fecha de apertura'));
    const days = salesPerDay(rows, range.desde, range.hasta), chart = svg('svg', { viewBox: '0 0 600 180', class: 'cv-sales-chart', role: 'img', 'aria-label': 'Ventas por día de apertura' }), max = Math.max(1, ...days.map(d => d.total));
    chart.append(svg('line', { x1: 20, x2: 580, y1: 140, y2: 140, stroke: 'currentColor', 'stroke-opacity': '.45' }));
    const tallest = days.findIndex(d => d.total === max);
    days.forEach((d, i) => { const width = 560 / days.length, height = Math.max(0, d.total) / max * 105, x = 20 + i * width; const bar = svg('rect', { x: x + width * .15, y: 140 - height, width: width * .7, height, rx: 3, fill: '#0284c7' }); const title = svg('title', {}); title.textContent = d.date + ': ' + money(d.total); bar.append(title); chart.append(bar); if (i % Math.max(1, Math.ceil(days.length / 7)) === 0) { const label = svg('text', { x: x + width / 2, y: 164, 'text-anchor': 'middle', 'font-size': 16, fill: 'currentColor' }); label.textContent = d.date.slice(8) + '/' + d.date.slice(5, 7); chart.append(label); } if (i === tallest && d.total > 0) { const label = svg('text', { x: Math.max(65, Math.min(535, x + width / 2)), y: 140 - height - 10, 'text-anchor': 'middle', 'font-size': 16, fill: 'currentColor' }); label.textContent = money(d.total); chart.append(label); } });
    if (!days.some(d => d.total > 0)) charts.append(el('p', 'cv-empty', rows.some(r => r.localMissing) ? 'Sin datos de ventas: faltan los movimientos locales de estos turnos.' : 'Sin ventas en estas fechas.'));
    charts.append(chart, el('h4', '', 'Distribución de ventas'));
    const breakdown = Object.fromEntries(methods.map(k => [k, rows.reduce((s, r) => s + num(r.salesMethods[k]), 0)]));
    // Sales charts exclude credit collections.
    charts.append(el('p', 'cv-note', 'Ventas por forma de pago, con crédito separado.'));
    const top = Math.max(1, ...methods.map(k => breakdown[k])); methods.forEach(k => { line(charts, labels[k], rows.some(r => r.localMissing) ? '—' : money(breakdown[k])); const track = el('div', 'cv-track'), fill = el('div', k === 'credito' ? 'cv-credit-fill' : ''); fill.style.width = Math.max(0, breakdown[k]) / top * 100 + '%'; track.append(fill); charts.append(track); }); wrap.append(charts);
    rows.forEach(r => {
      const card = el('article', 'cv-card na-cash-hist-card'); card.dataset.sessionId = r.sessionId;
      const toggle = button('', () => { const expanded = toggle.getAttribute('aria-expanded') === 'true'; toggle.setAttribute('aria-expanded', String(!expanded)); detail.hidden = expanded; }, 'cv-close-toggle'); toggle.setAttribute('aria-expanded', 'false');
      toggle.append(el('strong', '', r.fecha.split('-').reverse().join('/') + ' · ' + r.apertura + ' → ' + (r.cierreFecha !== r.fecha ? r.cierreFecha + ' ' : '') + r.cierre)); line(toggle, 'Cajero', r.cajero || 'No registrado'); line(toggle, 'Total vendido', r.localMissing ? '—' : money(r.ventas));
      toggle.append(el('span', 'cv-pill ' + (r.diferencia == null ? '' : r.diferencia === 0 ? 'cv-ok' : 'cv-bad'), 'Diferencia: ' + (r.diferencia == null ? 'No registrada' : money(r.diferencia) + (r.diferencia === 0 ? ' · Cuadrado' : r.diferencia > 0 ? ' · sobrante' : ' · faltante'))));
      const detail = el('div', 'cv-close-detail'); detail.hidden = true;
      const received = el('section', 'cv-detail-block'), credit = el('section', 'cv-detail-block cv-credit-block');
      received.append(el('h4', '', 'Dinero recibido')); methods.filter(k => k !== 'credito').forEach(k => line(received, labels[k], r.localMissing ? '—' : money(r.metodos[k]))); line(received, 'Cobros (incluidos arriba)', r.localMissing ? '—' : money(r.cobros));
      credit.append(el('h4', '', 'Quedó a crédito')); line(credit, 'No entra a caja', r.localMissing ? '—' : money(r.salesMethods.credito)); detail.append(received, credit);
      [['Fondo inicial', r.fondo], ['Gastos', r.gastos], ['Esperado', r.esperado], ['Contado', r.contado]].forEach(([l, v]) => line(detail, l, v == null ? 'No registrado' : money(v))); if (r.localMissing) detail.append(el('p', 'cv-note', 'Sin movimientos locales asociados; el desglose no está disponible.')); card.append(toggle, detail); wrap.append(card);
    });
    if (!rows.length) wrap.append(el('p', '', 'No hay cierres en estas fechas.')); host.replaceChildren(wrap);
  }
  function install() {
    const bar = doc.querySelector('#pageCaja .tabs-wrap'); if (!bar || typeof root.cajRender !== 'function') return;
    let tab = bar.querySelector('[data-na-cash-history-tab]'); if (!tab) { tab = button('Historial', () => root.cajSetTab(tab, 'historial'), 'tab'); tab.dataset.naCashHistoryTab = 'true'; bar.append(tab); } tab.hidden = false;
    if (root.cajRender.__cv) return;
    const previous = root.cajRender;
    const wrapped = function () { const current = typeof cajTab !== 'undefined' ? cajTab : ''; const host = doc.getElementById('cajContent'); if (host && current === 'movimientos') return renderMoves(host); if (host && current === 'historial') return renderHistory(host); const result = previous.apply(this, arguments); tab.hidden = false; return result; }; wrapped.__cv = true; root.cajRender = wrapped;
  }
  root.addEventListener('load', install);
  root.addEventListener('na:canonical-updated', () => { install(); if (typeof cajTab !== 'undefined' && cajTab === 'historial') root.cajRender(); });
})(globalThis);
